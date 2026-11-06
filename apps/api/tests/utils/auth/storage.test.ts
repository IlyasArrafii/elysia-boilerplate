import { describe, expect, test } from 'bun:test'
import type { BetterAuthOptions } from 'better-auth'
import { auth } from '../../../src/utils/auth/auth'
import { AUTH_KEY_PREFIX, createSecondaryStorage, guardAuthStorage } from '../../../src/utils/auth/storage'
import { createModuleCache } from '../../../src/utils/cache'
import { createMemoryStore, type CacheStore } from '../../../src/utils/cache/store'
import { createMemoryCounter } from '../../../src/utils/rate-limit/counter'
import { telemetry } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'

interface Call {
  method: string
  key?: string
  ttl?: number
}

// Records every call the guard makes on the cache store, on top of a real memory store.
function recordingStore(clock = { now: 0 }) {
  const inner = createMemoryStore(() => clock.now)
  const calls: Call[] = []
  const store: CacheStore = {
    get: (key) => (calls.push({ method: 'get', key }), inner.get(key)),
    set: (key, value, ttl) => (calls.push({ method: 'set', key, ttl }), inner.set(key, value, ttl)),
    del: (keys) => (calls.push(...keys.map((key) => ({ method: 'del', key }))), inner.del(keys)),
    delPattern: (pattern) => (calls.push({ method: 'delPattern', key: pattern }), inner.delPattern(pattern)),
    getAndDelete: (key) => (calls.push({ method: 'getAndDelete', key }), inner.getAndDelete(key)),
    increment: (key, ttl) => (calls.push({ method: 'increment', key, ttl }), inner.increment(key, ttl)),
  }
  return { store, calls, inner }
}

function failingStore(failure: Error): CacheStore & { calls: number } {
  const reject = () => {
    store.calls++
    return Promise.reject(failure)
  }
  const store = { calls: 0, get: reject, set: reject, del: reject, delPattern: reject, getAndDelete: reject, increment: reject }
  return store
}

const SESSION_TOKEN = 'tok-1'
const SESSION_ENTRY = JSON.stringify({ session: { id: 's1', token: SESSION_TOKEN, userId: 'u1' }, user: { id: 'u1' } })
// Better Auth's own keys for a verification value, a session and a user's session list.
const STORED_KEYS: [key: string, value: string][] = [
  ['verification:x', JSON.stringify({ identifier: 'reset-password:x', value: 'u1', expiresAt: '2099-01-01' })],
  [SESSION_TOKEN, SESSION_ENTRY],
  ['active-sessions-u1', JSON.stringify([{ token: SESSION_TOKEN, expiresAt: 4_102_444_800_000 }])],
]

describe('auth secondary storage holds rate-limit counters only', () => {
  test.each(STORED_KEYS)('get, getAndDelete, set and delete of %s never call the driver', async (key, value) => {
    const calls: string[] = []
    const storage = guardAuthStorage({ increment: (k) => (calls.push(k), 1) })

    await storage.set(key, value, 600)
    await storage.set(key, value)
    expect(await storage.get(key)).toBeNull()
    expect(await storage.getAndDelete(key)).toBeNull()
    await storage.delete(key)

    expect(calls).toEqual([])
  })

  test.each(STORED_KEYS)('on the app store, %s is neither written nor read, even when Redis still holds it', async (key, value) => {
    const { store, calls, inner } = recordingStore()
    // Left over from before DEC-055: it may be a revoked session or a used reset token.
    await inner.set(`${AUTH_KEY_PREFIX}${key}`, value, 600)
    const storage = createSecondaryStorage(store)

    await storage.set(key, value, 600)
    expect(await storage.get(key)).toBeNull()
    expect(await storage.getAndDelete(key)).toBeNull()
    await storage.delete(key)

    expect(calls).toEqual([])
  })

  test('a failing store does not fail them either', async () => {
    const store = failingStore(new Error('Redis did not reply within 1000 ms'))
    const storage = createSecondaryStorage(store)

    await storage.set('verification:x', '{}', 600)
    expect(await storage.get('verification:x')).toBeNull()
    expect(await storage.getAndDelete('verification:x')).toBeNull()
    await storage.delete('verification:x')
    expect(store.calls).toBe(0)
  })
})

describe('rate-limit counters', () => {
  test('count on the store under the auth prefix, in a fixed window of whole seconds', async () => {
    const clock = { now: 0 }
    const { store, calls } = recordingStore(clock)
    const storage = createSecondaryStorage(store)

    expect(await storage.increment('10.0.0.1|/sign-in/email', 60)).toBe(1)
    expect(await storage.increment('10.0.0.1|/sign-in/email', 60)).toBe(2)
    clock.now = 60_000
    expect(await storage.increment('10.0.0.1|/sign-in/email', 60)).toBe(1)
    await storage.increment('other', 0.5)

    expect(calls).toEqual([
      { method: 'increment', key: `${AUTH_KEY_PREFIX}10.0.0.1|/sign-in/email`, ttl: 60 },
      { method: 'increment', key: `${AUTH_KEY_PREFIX}10.0.0.1|/sign-in/email`, ttl: 60 },
      { method: 'increment', key: `${AUTH_KEY_PREFIX}10.0.0.1|/sign-in/email`, ttl: 60 },
      { method: 'increment', key: `${AUTH_KEY_PREFIX}other`, ttl: 1 },
    ])
  })

  test('fall back to memory while the store fails: 1, 2, 3 with one failure report and one store call', async () => {
    const failure = new Error('Redis did not reply within 1000 ms')
    const store = failingStore(failure)
    const failures: unknown[] = []
    const storage = createSecondaryStorage(store, {
      fallback: createMemoryCounter(),
      onFailure: (operation, error) => failures.push([operation, error]),
    })

    const counts = [
      await storage.increment('1.2.3.4|/sign-in/email', 60),
      await storage.increment('1.2.3.4|/sign-in/email', 60),
      await storage.increment('1.2.3.4|/sign-in/email', 60),
    ]

    expect(counts).toEqual([1, 2, 3])
    expect(store.calls).toBe(1)
    expect(failures).toEqual([['increment', failure]])
  })

  test('with the defaults, a failure is reported as cache.unavailable from auth', async () => {
    const memory = createMemorySink()
    const remove = telemetry.addSink(memory)
    try {
      const key = `1.2.3.4|/${crypto.randomUUID()}`
      const storage = createSecondaryStorage(failingStore(new Error('connect ECONNREFUSED for dave@example.com')))

      expect(await storage.increment(key, 60)).toBe(1)
      expect(await storage.increment(key, 60)).toBe(2)

      const events = memory.find('cache.unavailable')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ level: 'warn', kind: 'app', source: 'auth', operation: 'increment', suppressed: 0 })
      expect(JSON.stringify(events)).not.toContain('dave@example.com')
    } finally {
      remove()
    }
  })

  test('a driver that throws synchronously falls back too', async () => {
    const storage = guardAuthStorage(
      {
        increment() {
          throw new Error('not connected')
        },
      },
      { fallback: createMemoryCounter(), onFailure: () => undefined },
    )

    expect(await storage.increment('k', 60)).toBe(1)
  })

  test('module caches cannot reach them, and the names auth and ratelimit are reserved', async () => {
    const shared = createMemoryStore()
    const storage = createSecondaryStorage(shared)
    const key = `${crypto.randomUUID()}|/sign-in/email`
    await storage.increment(key, 60)

    await createModuleCache(shared, 'posts', { ttlSeconds: 60 }).delPattern('*')

    expect(await storage.increment(key, 60)).toBe(2)
    expect(() => createModuleCache(shared, 'auth', { ttlSeconds: 60 })).toThrow('reserved')
    expect(() => createModuleCache(shared, 'ratelimit', { ttlSeconds: 60 })).toThrow('reserved')
  })
})

// The guard answers every read with "nothing stored". That is safe only while Better Auth keeps
// sessions and verification values in PostgreSQL and reads them there when the secondary storage has
// nothing: without these options every session and every reset link would stop working.
describe('the auth options the guard depends on', () => {
  test('sessions and verification values are kept in PostgreSQL, and read there', () => {
    // Widened to every option Better Auth accepts, so an option the app does not set can be checked.
    const session: BetterAuthOptions['session'] = auth.options.session

    expect(session?.storeSessionInDatabase).toBe(true)
    expect(auth.options.verification?.storeInDatabase).toBe(true)
    // With it, Better Auth 1.7.15 answers "no session" whenever the secondary storage has none.
    expect(session?.preserveSessionInDatabase).not.toBe(true)
  })

  test('rate limits count in the guarded secondary storage', async () => {
    expect(auth.options.rateLimit?.storage).toBe('secondary-storage')
    expect(await auth.options.secondaryStorage?.get('verification:x')).toBeNull()
  })
})
