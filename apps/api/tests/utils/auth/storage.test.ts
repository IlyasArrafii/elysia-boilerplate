import { describe, expect, test } from 'bun:test'
import { createModuleCache } from '../../../src/utils/cache'
import { createMemoryStore, type CacheStore } from '../../../src/utils/cache/store'
import { AUTH_KEY_PREFIX, createSecondaryStorage, isSessionEntry, MAX_TTL_SECONDS } from '../../../src/utils/auth/storage'

interface Call {
  method: string
  key?: string
  value?: string
  ttl?: number
}

// Records what the adapter asks of the cache store, on top of a real memory store.
function recordingStore(clock: { now: number }) {
  const inner = createMemoryStore(() => clock.now)
  const calls: Call[] = []
  const store: CacheStore = {
    get: (key) => (calls.push({ method: 'get', key }), inner.get(key)),
    set: (key, value, ttl) => (calls.push({ method: 'set', key, value, ttl }), inner.set(key, value, ttl)),
    del: (keys) => (calls.push(...keys.map((key) => ({ method: 'del', key }))), inner.del(keys)),
    delPattern: (pattern) => inner.delPattern(pattern),
    getAndDelete: (key) => (calls.push({ method: 'getAndDelete', key }), inner.getAndDelete(key)),
    increment: (key, ttl) => (calls.push({ method: 'increment', key, ttl }), inner.increment(key, ttl)),
  }
  return { store, calls, inner }
}

describe('secondary storage on the raw cache store', () => {
  test('stores Better Auth strings unchanged, under the auth prefix, with the TTL of each call', async () => {
    const clock = { now: 0 }
    const { store, calls, inner } = recordingStore(clock)
    const storage = createSecondaryStorage(store)
    const value = JSON.stringify({ identifier: 'reset-password:abc', value: 'u1' })

    await storage.set('verification:abc', value, 600)
    await storage.set('10.0.0.1/sign-in/email', '{"count":1}', 30)

    expect(calls).toEqual([
      { method: 'set', key: `${AUTH_KEY_PREFIX}verification:abc`, value, ttl: 600 },
      { method: 'set', key: `${AUTH_KEY_PREFIX}10.0.0.1/sign-in/email`, value: '{"count":1}', ttl: 30 },
    ])
    expect(await storage.get('verification:abc')).toBe(value)
    expect(await inner.get('verification:abc')).toBeNull()

    clock.now = 30_000
    expect(await storage.get('10.0.0.1/sign-in/email')).toBeNull()
    expect(await storage.get('verification:abc')).toBe(value)
  })

  // DEC-054: PostgreSQL alone decides whether a session exists.
  test('session entries are never written, and never read back', async () => {
    const { store, calls, inner } = recordingStore({ now: 0 })
    const storage = createSecondaryStorage(store)
    const entry = JSON.stringify({ session: { id: 's1', token: 'tok-1', userId: 'u1' }, user: { id: 'u1' } })

    await storage.set('tok-1', entry, 600)
    await storage.set('active-sessions-u1', '[{"token":"tok-1","expiresAt":1}]', 600)
    expect(calls).toEqual([])

    // An entry already in Redis (written before DEC-054) is ignored; the list is not even read.
    await inner.set('auth:tok-1', entry, 600)
    await inner.set('auth:active-sessions-u1', '[]', 600)
    expect(await storage.get('tok-1')).toBeNull()
    expect(await storage.get('active-sessions-u1')).toBeNull()
    expect(calls).toEqual([{ method: 'get', key: 'auth:tok-1' }])
  })

  test('only an entry whose session token is its own key counts as a session entry', () => {
    const entry = (token: unknown) => JSON.stringify({ session: { token }, user: {} })

    expect(isSessionEntry('tok-1', entry('tok-1'))).toBe(true)
    expect(isSessionEntry('active-sessions-u1', null)).toBe(true)
    expect(isSessionEntry('tok-1', entry('tok-2'))).toBe(false)
    expect(isSessionEntry('tok-1', entry(1))).toBe(false)
    expect(isSessionEntry('verification:abc', '{"session":null}')).toBe(false)
    expect(isSessionEntry('a', '{not json')).toBe(false)
    expect(isSessionEntry('a', 'x')).toBe(false)
    expect(isSessionEntry('a', null)).toBe(false)
  })

  test('a fractional TTL is cut to whole seconds; 0 or less deletes the key', async () => {
    const { store, calls } = recordingStore({ now: 0 })
    const storage = createSecondaryStorage(store)

    await storage.set('a', 'x', 59.9)
    await storage.set('b', 'x', 0)
    await storage.set('c', 'x', -5)

    expect(calls).toEqual([
      { method: 'set', key: 'auth:a', value: 'x', ttl: 59 },
      { method: 'del', key: 'auth:b' },
      { method: 'del', key: 'auth:c' },
    ])
  })

  test('a missing TTL is bounded by the session lifetime', async () => {
    const { store, calls } = recordingStore({ now: 0 })

    await createSecondaryStorage(store).set('plugin-key', 'x')

    expect(calls).toEqual([{ method: 'set', key: 'auth:plugin-key', value: 'x', ttl: MAX_TTL_SECONDS }])
    expect(MAX_TTL_SECONDS).toBe(7 * 24 * 60 * 60)
  })

  test('increment counts in a fixed window, for the rate limiter', async () => {
    const clock = { now: 0 }
    const { store, calls } = recordingStore(clock)
    const storage = createSecondaryStorage(store)

    expect(await storage.increment('10.0.0.1/sign-in/email', 60)).toBe(1)
    expect(await storage.increment('10.0.0.1/sign-in/email', 60)).toBe(2)
    clock.now = 60_000
    expect(await storage.increment('10.0.0.1/sign-in/email', 60)).toBe(1)
    // Rounded up, so a window is never shorter than asked.
    await storage.increment('other', 0.2)
    expect(calls.at(-1)).toEqual({ method: 'increment', key: 'auth:other', ttl: 1 })
  })

  test('getAndDelete returns a one-time value once', async () => {
    const storage = createSecondaryStorage(recordingStore({ now: 0 }).store)
    await storage.set('verification:abc', '{"value":"1"}', 60)

    expect(await storage.getAndDelete('verification:abc')).toBe('{"value":"1"}')
    expect(await storage.getAndDelete('verification:abc')).toBeNull()
  })

  test('delete removes the key', async () => {
    const storage = createSecondaryStorage(recordingStore({ now: 0 }).store)
    await storage.set('token', 'x', 60)
    await storage.delete('token')

    expect(await storage.get('token')).toBeNull()
  })

  test('module caches cannot reach the auth keys', async () => {
    const shared = createMemoryStore()
    const storage = createSecondaryStorage(shared)
    await storage.set('token', 'x', 60)

    await createModuleCache(shared, 'posts', { ttlSeconds: 60 }).delPattern('*')

    expect(await storage.get('token')).toBe('x')
    expect(() => createModuleCache(shared, 'auth', { ttlSeconds: 60 })).toThrow('reserved')
  })

  // Redis down must fail the auth request: answering "no session" or "not rate limited" instead
  // would let a stalled Redis switch off sign-out checks or brute-force protection.
  test('every operation rejects with the store error', async () => {
    const failure = new Error('Redis did not reply within 1000 ms')
    const failing: CacheStore = {
      get: () => Promise.reject(failure),
      set: () => Promise.reject(failure),
      del: () => Promise.reject(failure),
      delPattern: () => Promise.reject(failure),
      getAndDelete: () => Promise.reject(failure),
      increment: () => Promise.reject(failure),
    }
    const storage = createSecondaryStorage(failing)

    await expect(Promise.resolve(storage.get('a'))).rejects.toBe(failure)
    await expect(Promise.resolve(storage.set('a', 'x', 60))).rejects.toBe(failure)
    await expect(Promise.resolve(storage.delete('a'))).rejects.toBe(failure)
    await expect(Promise.resolve(storage.getAndDelete('a'))).rejects.toBe(failure)
    await expect(Promise.resolve(storage.increment('a', 60))).rejects.toBe(failure)
  })
})
