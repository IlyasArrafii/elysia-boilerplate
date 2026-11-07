import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { redisStorage } from '@better-auth/redis-storage'
import { Redis, type Command } from 'ioredis'
import { createHash } from 'node:crypto'
import {
  closeAuthRedisClient,
  createAuthRedisClient,
  createAuthStorage,
  OFFICIAL_CLIENT_OPTIONS,
  officialAuthStorage,
} from '../../../src/utils/auth/redis-driver'
import { AUTH_KEY_PREFIX, createSecondaryStorage } from '../../../src/utils/auth/storage'
import { createMemoryStore, createRedisStore, type CacheStore } from '../../../src/utils/cache/store'
import { SHUTDOWN_TIMEOUTS } from '../../../src/utils/lifecycle'
import { createMemoryCounter } from '../../../src/utils/rate-limit/counter'
import { createRedis } from '../../../src/utils/redis'
import { telemetry } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { isTestRedisRunning, runInApiProcess, TEST_REDIS_URL, UNREACHABLE_REDIS_URL } from '../../helpers/redis'

// AUTH_REDIS_DRIVER=official (DEC-057): Better Auth's `@better-auth/redis-storage` on ioredis, behind
// the same guard as the custom driver.

type Sent = [command: string, ...args: string[]]

// A real ioredis client that never touches the network: every command it would send is recorded and
// answered with `reply`, so the test sees exactly what would reach Redis.
function recordingClient(reply: (name: string) => unknown = (name) => (name === 'eval' ? 1 : 'OK')) {
  const client = new Redis({ ...OFFICIAL_CLIENT_OPTIONS })
  const sent: Sent[] = []
  spyOn(client, 'connect').mockResolvedValue(undefined)
  spyOn(client, 'sendCommand').mockImplementation((command: Command) => {
    sent.push([command.name, ...command.args.map(String)])
    command.resolve(reply(command.name))
    return command.promise
  })
  return { client, sent }
}

const quiet = { fallback: createMemoryCounter(), onFailure: () => undefined }

// Better Auth's own keys for a verification value, a session and a user's session list.
const STORED_KEYS = ['verification:x', 'tok-1', 'active-sessions-u1']

describe('the official driver behind the guard', () => {
  test.each(STORED_KEYS)('set (TTL 0, none, 600), get, getAndDelete and delete of %s never reach Redis', async (key) => {
    const { client, sent } = recordingClient()
    const storage = officialAuthStorage(client, quiet)

    await storage.set(key, 'v', 0)
    await storage.set(key, 'v')
    await storage.set(key, 'v', 600)
    expect(await storage.get(key)).toBeNull()
    expect(await storage.getAndDelete(key)).toBeNull()
    await storage.delete(key)

    expect(sent).toEqual([])
  })

  // Why the guard must stay in front of it: unguarded, the package writes a key that never expires.
  test('unguarded, the package would store set with TTL 0 or no TTL without an expiry', async () => {
    const { client, sent } = recordingClient()
    const raw = redisStorage({ client, keyPrefix: AUTH_KEY_PREFIX })

    await raw.set('x', 'v', 0)
    await raw.set('x', 'v')

    expect(sent).toEqual([
      ['set', 'auth:x', 'v'],
      ['set', 'auth:x', 'v'],
    ])
  })

  test('increment reaches the driver as one EVAL under auth:, the window rounded up to whole seconds', async () => {
    const { client, sent } = recordingClient()
    const storage = officialAuthStorage(client, quiet)

    expect(await storage.increment('10.0.0.1|/sign-in/email', 0.5)).toBe(1)
    expect(await storage.increment('10.0.0.1|/sign-in/email', 59.2)).toBe(1)

    expect(sent).toHaveLength(2)
    expect(sent.map(([name, , keyCount, key, ttl]) => [name, keyCount, key, ttl])).toEqual([
      ['eval', '1', 'auth:10.0.0.1|/sign-in/email', '1'],
      ['eval', '1', 'auth:10.0.0.1|/sign-in/email', '60'],
    ])
    // The script counts with INCR and sets the window with EXPIRE on the first hit only.
    expect(sent[0]?.[1]).toContain('redis.call("INCR", KEYS[1])')
    expect(sent[0]?.[1]).toContain('redis.call("EXPIRE", KEYS[1], ARGV[1])')
  })

  test('a key longer than 200 characters reaches Redis as auth:sha256:<hex>, the same key the custom driver uses', async () => {
    const key = `10.0.0.1|/${'a'.repeat(5000)}`
    const expected = `${AUTH_KEY_PREFIX}sha256:${createHash('sha256').update(key).digest('hex')}`

    const { client, sent } = recordingClient()
    await officialAuthStorage(client, quiet).increment(key, 60)

    const customKeys: string[] = []
    const memory = createMemoryStore()
    const recording: CacheStore = { ...memory, increment: (k, ttl) => (customKeys.push(k), memory.increment(k, ttl)) }
    await createSecondaryStorage(recording, quiet).increment(key, 60)

    expect(sent.map(([, , , sentKey]) => sentKey)).toEqual([expected])
    expect(customKeys).toEqual([expected])
  })

  test('the first increment opens the lazy connection once, however many arrive together', async () => {
    const { client } = recordingClient()
    const connect = spyOn(client, 'connect').mockResolvedValue(undefined)
    const storage = officialAuthStorage(client, quiet)

    await Promise.all([storage.increment('a', 60), storage.increment('b', 60), storage.increment('c', 60)])

    expect(connect).toHaveBeenCalledTimes(1)
  })

  test('a failing driver falls back to memory and is reported once', async () => {
    const failure = new Error('Connection is closed.')
    const { client } = recordingClient()
    spyOn(client, 'sendCommand').mockImplementation((command: Command) => {
      command.reject(failure)
      return command.promise
    })
    const failures: unknown[] = []
    const storage = officialAuthStorage(client, {
      fallback: createMemoryCounter(),
      onFailure: (operation, error) => failures.push([operation, error]),
    })

    const counts = [await storage.increment('k', 60), await storage.increment('k', 60), await storage.increment('k', 60)]

    expect(counts).toEqual([1, 2, 3])
    expect(failures).toEqual([['increment', failure]])
  })
})

describe('the ioredis client', () => {
  test('fails fast, opens nothing until used, and sends no INFO or CLIENT SETINFO on connect', () => {
    expect(OFFICIAL_CLIENT_OPTIONS).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
      connectTimeout: 1000,
      enableReadyCheck: false,
      disableClientInfo: true,
    })
    // Below the shutdown step's own budget, so a socket that never closes is destroyed inside it.
    expect(OFFICIAL_CLIENT_OPTIONS.disconnectTimeout).toBeLessThan(SHUTDOWN_TIMEOUTS.clients - SHUTDOWN_TIMEOUTS.margin)
    const client = createAuthRedisClient(UNREACHABLE_REDIS_URL, () => undefined)
    try {
      expect(client.status).toBe('wait')
    } finally {
      client.disconnect()
    }
  })

  test('connection errors go to onError, never to "Unhandled error event"', () => {
    const errors: unknown[] = []
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined)
    const client = createAuthRedisClient(UNREACHABLE_REDIS_URL, (error) => errors.push(error))
    try {
      const failure = new Error('connect ECONNREFUSED 127.0.0.1:1')
      client.emit('error', failure)

      expect(errors).toEqual([failure])
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
      client.disconnect()
    }
  })

  test('close ends a client that never connected, at once and more than once, and it never reconnects', async () => {
    const { client } = recordingClient()
    // Back to ioredis's own sendCommand, which refuses every command on an ended client.
    spyOn(client, 'sendCommand').mockRestore()
    const storage = officialAuthStorage(client, quiet)

    await closeAuthRedisClient(client)
    await closeAuthRedisClient(client)

    expect(client.status).toBe('end')
    expect(await storage.increment('k', 60)).toBe(1)
    expect(client.status).toBe('end')
  })
})

describe('AUTH_REDIS_DRIVER', () => {
  test('custom counts on the cache store under auth: and has nothing of its own to close', async () => {
    const store = createMemoryStore()
    const custom = createAuthStorage({ driver: 'custom', redisUrl: undefined, store })

    expect(await custom.storage.increment('k', 60)).toBe(1)
    expect(await store.increment(`${AUTH_KEY_PREFIX}k`, 60)).toBe(2)
    expect(custom.client).toBeUndefined()
    await custom.close()
  })

  test('official without a Redis URL is refused', () => {
    expect(() => createAuthStorage({ driver: 'official', redisUrl: undefined, store: createMemoryStore() })).toThrow(
      'AUTH_REDIS_DRIVER=official needs REDIS_URL',
    )
  })

  // The Better Auth CLI loads auth.ts on Node: the client must not dial Redis, or its reconnect loop
  // would keep the process alive.
  test('the app starts with official without connecting, and the process still ends by itself', async () => {
    const result = await runInApiProcess(
      'await import("./src/app.ts"); const { authStorage } = await import("./src/utils/auth/redis-driver.ts"); console.log(authStorage.client?.status)',
      { LOG_LEVEL: 'silent', AUTH_REDIS_DRIVER: 'official', REDIS_URL: UNREACHABLE_REDIS_URL },
      { timeoutMs: 15_000 },
    )

    expect(result.killed).toBe(false)
    expect(result.stdout.trim()).toBe('wait')
    expect(result.exitCode).toBe(0)
  }, 20_000)

  test('AUTH_REDIS_DRIVER=foo fails startup with a clear message', async () => {
    const result = await runInApiProcess('await import("./src/app.ts")', { AUTH_REDIS_DRIVER: 'foo' }, { timeoutMs: 15_000 })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('AUTH_REDIS_DRIVER must be one of custom, official, got "foo"')
  }, 20_000)

  // The app's own wiring: its reporter, its fallback and its error listener.
  test('official on an unreachable Redis counts in memory within 1.5 s, reports once, and prints no unhandled error', async () => {
    const memory = createMemorySink()
    const remove = telemetry.addSink(memory)
    const consoleError = spyOn(console, 'error')
    const official = createAuthStorage({ driver: 'official', redisUrl: UNREACHABLE_REDIS_URL, store: createMemoryStore() })
    const client = official.client
    if (client === undefined) throw new Error('the official driver has a client')
    try {
      const key = `1.2.3.4|/${crypto.randomUUID()}`
      const started = performance.now()
      expect(await official.storage.increment(key, 60)).toBe(1)
      expect(performance.now() - started).toBeLessThanOrEqual(1500)
      // The breaker is open: the next count is in memory without asking Redis.
      expect(await official.storage.increment(key, 60)).toBe(2)

      // Long enough for ioredis to retry the connection several times (50, 100, 150 ms …).
      await Bun.sleep(700)

      const output = consoleError.mock.calls.flat().map(String).join('\n')
      expect(output).not.toContain('Unhandled error event')
      const events = memory.find('cache.unavailable').filter((event) => event.source === 'auth')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ operation: 'increment', suppressed: 0 })
      expect(client.status).not.toBe('ready')
    } finally {
      await official.close()
      consoleError.mockRestore()
      remove()
    }
    // Closed between two attempts, ioredis keeps the status `reconnecting`, but the pending attempt is
    // cancelled and no other is scheduled.
    const reconnect = spyOn(client, 'connect')
    await Bun.sleep(500)
    expect(reconnect).not.toHaveBeenCalled()
  }, 10_000)
})

const redisRunning = await isTestRedisRunning()

// Keys are `auth:test-<uuid>|…`: the driver adds `auth:` itself, so the `test-` namespace follows it.
// Only the keys written here are deleted, never the database.
describe.skipIf(!redisRunning)('the official driver on a real Redis (docker-compose.test.yml)', () => {
  const admin = createRedis(TEST_REDIS_URL)
  const clients: Redis[] = []
  const written: string[] = []

  afterAll(async () => {
    for (const client of clients) await closeAuthRedisClient(client)
    if (written.length > 0) await admin.command((redis) => redis.del(...written))
    admin.close()
  })

  function official() {
    const failures: unknown[] = []
    const client = createAuthRedisClient(TEST_REDIS_URL, (error) => failures.push(error))
    clients.push(client)
    const storage = officialAuthStorage(client, { fallback: createMemoryCounter(), onFailure: (_, error) => failures.push(error) })
    return { client, storage, failures }
  }

  function custom() {
    const failures: unknown[] = []
    const storage = createSecondaryStorage(createRedisStore(admin.command, admin.transaction), {
      fallback: createMemoryCounter(),
      onFailure: (_, error) => failures.push(error),
    })
    return { storage, failures }
  }

  function testKey(): { key: string; stored: string } {
    const key = `test-${crypto.randomUUID()}|/sign-in/email`
    written.push(`${AUTH_KEY_PREFIX}${key}`)
    return { key, stored: `${AUTH_KEY_PREFIX}${key}` }
  }

  const ttlOf = (key: string) => admin.command((redis) => redis.ttl(key))
  const valueOf = (key: string) => admin.command((redis) => redis.get(key))

  test('counts 1, 2, 3 under auth: with the window as TTL', async () => {
    const { storage, failures } = official()
    const { key, stored } = testKey()

    const counts = [await storage.increment(key, 60), await storage.increment(key, 60), await storage.increment(key, 60)]

    expect(counts).toEqual([1, 2, 3])
    expect(await valueOf(stored)).toBe('3')
    const ttl = await ttlOf(stored)
    expect(ttl).toBeGreaterThan(55)
    expect(ttl).toBeLessThanOrEqual(60)
    expect(failures).toEqual([])
  })

  test('both drivers count the same key, so switching drivers keeps the counters and the window', async () => {
    const officialDriver = official()
    const customDriver = custom()
    const { key, stored } = testKey()

    const counts = [
      await customDriver.storage.increment(key, 60),
      await officialDriver.storage.increment(key, 60),
      await customDriver.storage.increment(key, 60),
      await officialDriver.storage.increment(key, 60),
    ]

    expect(counts).toEqual([1, 2, 3, 4])
    // The window set by the first count is kept: a later window length does not extend it.
    expect(await officialDriver.storage.increment(key, 600)).toBe(5)
    expect(await ttlOf(stored)).toBeLessThanOrEqual(60)
    expect([...officialDriver.failures, ...customDriver.failures]).toEqual([])
  })

  test('a key longer than 200 characters is counted under auth:sha256:<hex> by both drivers', async () => {
    const key = `test-${crypto.randomUUID()}|/${'a'.repeat(500)}`
    const stored = `${AUTH_KEY_PREFIX}sha256:${createHash('sha256').update(key).digest('hex')}`
    written.push(stored)

    expect(await official().storage.increment(key, 60)).toBe(1)
    expect(await custom().storage.increment(key, 60)).toBe(2)
    expect(await valueOf(stored)).toBe('2')
  })

  test('close ends the connection on the server too', async () => {
    const { client, storage } = official()
    await storage.increment(testKey().key, 60)
    expect(client.status).toBe('ready')
    const id = await client.client('ID')

    await closeAuthRedisClient(client)

    expect(client.status).toBe('end')
    const listed = await admin.command((redis) => redis.send('CLIENT', ['LIST', 'ID', String(id)]))
    expect(String(listed).trim()).toBe('')
  })
})
