import { describe, expect, spyOn, test } from 'bun:test'
import { createTelemetry } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { createRedis, redis, RedisTimeoutError, resolveRedis } from '../../../src/utils/redis'
import {
  createReplyDroppingProxy,
  createStallingRedis,
  isTestRedisRunning,
  PRODUCTION_ENV,
  runInApiProcess,
  TEST_REDIS_URL,
  UNREACHABLE_REDIS_URL,
} from '../../helpers/redis'

function testTelemetry() {
  const memory = createMemorySink()
  return { memory, telemetry: createTelemetry({ env: 'test', sinks: [memory] }) }
}

// Production also requires LOG_MONGO_URL (log-storage.md §2). The driver connects lazily, so an
// unreachable URL lets startup get as far as the Redis rules these tests are about.
const UNREACHABLE_LOG_MONGO_URL = 'mongodb://127.0.0.1:1/app_logs'

describe('startup', () => {
  test('NODE_ENV=production without REDIS_URL fails with a clear error', async () => {
    const result = await runInApiProcess('await import("./src/app.ts")', {
      ...PRODUCTION_ENV,
      LOG_MONGO_URL: UNREACHABLE_LOG_MONGO_URL,
      REDIS_URL: '',
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('REDIS_URL is required when NODE_ENV=production')
  })

  test('production starts with REDIS_URL set, without connecting yet', async () => {
    const result = await runInApiProcess('await import("./src/app.ts"); console.log("started")', {
      ...PRODUCTION_ENV,
      LOG_LEVEL: 'silent',
      LOG_MONGO_URL: UNREACHABLE_LOG_MONGO_URL,
      REDIS_URL: UNREACHABLE_REDIS_URL,
    })

    expect(result.stdout.trim()).toBe('started')
    expect(result.exitCode).toBe(0)
  })

  test.each(['not a url', 'http://127.0.0.1:6379', 'postgres://user:hunter2@db:5432/app'])(
    'rejects REDIS_URL "%s" without echoing it',
    async (url) => {
      const result = await runInApiProcess('await import("./src/env.ts")', { REDIS_URL: url })

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('REDIS_URL must be a redis:// or rediss:// URL')
      expect(result.stderr).not.toContain('hunter2')
    },
  )

  test('development and test run on the memory fallback without REDIS_URL', async () => {
    for (const nodeEnv of ['development', 'test']) {
      const result = await runInApiProcess(
        'const { redis } = await import("./src/utils/redis/index.ts"); console.log(redis === null)',
        { NODE_ENV: nodeEnv, LOG_LEVEL: 'silent', REDIS_URL: '' },
      )
      expect(result.stdout.trim()).toBe('true')
    }
  })

  // The real process: the app, the cache and several cache calls together still announce it once.
  test('the fallback emits cache.fallback once per process', async () => {
    const script = `
      const { app } = await import("./src/app.ts")
      const { moduleCache } = await import("./src/utils/cache/index.ts")
      await import("./src/utils/redis/index.ts")
      const cache = moduleCache("demo", { ttlSeconds: 5 })
      await cache.wrap("a", () => 1)
      await cache.wrap("a", () => 1)
      await app.handle(new Request("http://localhost/api/health"))
      await app.handle(new Request("http://localhost/api/health"))
    `
    const result = await runInApiProcess(script, { LOG_LEVEL: 'warn', REDIS_URL: '' })
    const fallbacks = result.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line): Record<string, unknown> => JSON.parse(line))
      .filter((line) => line.event === 'cache.fallback')

    expect(result.exitCode).toBe(0)
    expect(fallbacks).toEqual([expect.objectContaining({ level: 'warn', kind: 'app', reason: 'REDIS_URL is empty' })])
  })
})

describe('resolveRedis', () => {
  test('an empty REDIS_URL is the memory fallback and emits cache.fallback once', () => {
    const { memory, telemetry } = testTelemetry()

    expect(resolveRedis(undefined, telemetry)).toBeNull()
    expect(memory.find('cache.fallback')).toEqual([
      expect.objectContaining({ level: 'warn', kind: 'app', reason: 'REDIS_URL is empty' }),
    ])
  })

  test('a REDIS_URL gives a client and no fallback event', () => {
    const { memory, telemetry } = testTelemetry()

    const client = resolveRedis(UNREACHABLE_REDIS_URL, telemetry)

    expect(client).not.toBeNull()
    expect(memory.find('cache.fallback')).toEqual([])
    client?.close()
  })

  test('the tests themselves run on the fallback', () => {
    expect(redis).toBeNull()
  })
})

describe('client construction', () => {
  // The Better Auth CLI loads utils/auth/auth.ts under Node with the root `.env`, REDIS_URL included.
  // `Bun` does not exist there, so nothing may touch it before the first command.
  test('the Bun client is built on the first command, not when the helper is created', async () => {
    const RealClient = Bun.RedisClient
    // bun:test types a spied class as uncallable (`never`), but the spy is called in its place and
    // must still build the real client.
    const constructed = spyOn(Bun, 'RedisClient').mockImplementation(
      ((...args: ConstructorParameters<typeof RealClient>) => new RealClient(...args)) as never,
    )
    try {
      const client = createRedis(UNREACHABLE_REDIS_URL)
      expect(constructed).not.toHaveBeenCalled()

      expect(await client.probe()).toBe('down')
      expect(await client.probe()).toBe('down')
      expect(constructed).toHaveBeenCalledTimes(1)
      client.close()
    } finally {
      constructed.mockRestore()
    }
  })

  test('closing a helper that never ran a command is safe, and later commands reject', async () => {
    const client = createRedis(UNREACHABLE_REDIS_URL)
    client.close()

    expect(await client.probe()).toBe('down')
    await expect(client.command((redis) => redis.ping())).rejects.toThrow('Redis client is closed')
    await expect(client.transaction([['PING']])).rejects.toThrow('Redis client is closed')
  })

  test('a transaction on an unreachable Redis rejects quickly', async () => {
    const client = createRedis(UNREACHABLE_REDIS_URL)
    const started = performance.now()

    await expect(client.transaction([['PING']])).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(1500)
    client.close()
  })
})

describe('probe', () => {
  test('is down, quickly, when Redis is unreachable', async () => {
    const client = createRedis(UNREACHABLE_REDIS_URL)
    const started = performance.now()

    expect(await client.probe()).toBe('down')
    expect(performance.now() - started).toBeLessThan(1500)
    client.close()
  })

  test('is down after close', async () => {
    const client = createRedis(UNREACHABLE_REDIS_URL)
    client.close()

    expect(await client.probe()).toBe('down')
    await expect(client.command((redis) => redis.ping())).rejects.toThrow('Redis client is closed')
  })
})

describe('a connection that stops replying', () => {
  test('a command rejects at its deadline instead of hanging', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.command((redis) => redis.ping())).toBe('PONG')
      server.stall()
      const started = performance.now()

      await expect(client.command((redis) => redis.ping(), 200)).rejects.toBeInstanceOf(RedisTimeoutError)
      expect(performance.now() - started).toBeLessThan(500)
    } finally {
      client.close()
      server.stop()
    }
  })

  test('the stalled connection is dropped, so unanswered commands do not pile up', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.probe()).toBe('up')
      server.stall()

      expect(await client.probe(100)).toBe('down')
      await Bun.sleep(50)
      expect(server.closedConnections()).toBe(1)
    } finally {
      client.close()
      server.stop()
    }
  })

  test('a stalled transaction rejects at its deadline and drops only the transaction connection', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.probe()).toBe('up')
      server.stall()
      const started = performance.now()

      await expect(client.transaction([['INCR', 'test-stall']], 200)).rejects.toBeInstanceOf(RedisTimeoutError)
      expect(performance.now() - started).toBeLessThan(500)
      await Bun.sleep(50)
      expect(server.closedConnections()).toBe(1)

      server.resume()
      expect(await client.probe()).toBe('up')
      // The shared connection was not the one dropped: the probe did not need a new one.
      expect(server.closedConnections()).toBe(1)
    } finally {
      client.close()
      server.stop()
    }
  })

  test('the next command reconnects once Redis answers again', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.probe()).toBe('up')
      server.stall()
      expect(await client.probe(100)).toBe('down')

      server.resume()

      expect(await client.probe()).toBe('up')
    } finally {
      client.close()
      server.stop()
    }
  })

  // Bun rejects the PING the deadline's own drop cut off with ERR_REDIS_CONNECTION_CLOSED too, the
  // code the probe retries on: only the deadline check stops it reconnecting here.
  test('a probe its deadline cut off is not sent again', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.probe()).toBe('up')
      server.stall()

      expect(await client.probe(100)).toBe('down')
      await Bun.sleep(50)
      expect(server.openedConnections()).toBe(1)
    } finally {
      client.close()
      server.stop()
    }
  })
})

// Redis closed the connection, but Bun had not seen the close yet when the command went out, so the
// command fails without a reply (ERR_REDIS_CONNECTION_CLOSED).
describe('a connection Redis closed before the command reached it', () => {
  test('probe sends PING again on a new connection, and is up', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.probe()).toBe('up')
      server.closeOnPing(1)

      expect(await client.probe()).toBe('up')
      expect(server.openedConnections()).toBe(2)
    } finally {
      client.close()
      server.stop()
    }
  })

  test('probe sends PING again only once, and the next probe reconnects', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.probe()).toBe('up')
      server.closeOnPing(2)

      expect(await client.probe()).toBe('down')
      expect(server.openedConnections()).toBe(2)
      expect(await client.probe()).toBe('up')
      expect(server.openedConnections()).toBe(3)
    } finally {
      client.close()
      server.stop()
    }
  })

  test('concurrent probes on the closed connection both retry, and are up', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.probe()).toBe('up')
      server.closeOnPing(1)

      expect(await Promise.all([client.probe(), client.probe()])).toEqual(['up', 'up'])
      expect(server.openedConnections()).toBe(2)
    } finally {
      client.close()
      server.stop()
    }
  })

  test('close during a probe does not reconnect', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.probe()).toBe('up')
      server.stall()

      const probe = client.probe()
      await Bun.sleep(20)
      client.close()

      expect(await probe).toBe('down')
      await Bun.sleep(50)
      expect(server.openedConnections()).toBe(1)
    } finally {
      server.stop()
    }
  })

  // `command` runs anything (INCR, SET NX), which may have run before the connection closed. This
  // test also pins Bun's error code for a command whose connection closed: the probe's retry matches
  // on it, so keep the exact code here rather than loosening it to `.toThrow()`.
  test('command is not sent again: it rejects with ERR_REDIS_CONNECTION_CLOSED, and the next command reconnects', async () => {
    const server = createStallingRedis()
    const client = createRedis(server.url)
    try {
      expect(await client.command((redis) => redis.ping())).toBe('PONG')
      server.closeOnPing(1)

      await expect(client.command((redis) => redis.ping())).rejects.toMatchObject({
        code: 'ERR_REDIS_CONNECTION_CLOSED',
      })
      expect(server.openedConnections()).toBe(1)
      expect(await client.command((redis) => redis.ping())).toBe('PONG')
      expect(server.openedConnections()).toBe(2)
    } finally {
      client.close()
      server.stop()
    }
  })
})

const redisRunning = await isTestRedisRunning()

describe.skipIf(!redisRunning)('against a real Redis (docker-compose.test.yml)', () => {
  async function connectionNamed(name: string): Promise<boolean> {
    const observer = createRedis(TEST_REDIS_URL)
    try {
      const list: string = await observer.command((redis) => redis.send('CLIENT', ['LIST']))
      return list.includes(`name=${name} `)
    } finally {
      observer.close()
    }
  }

  test('probe is up', async () => {
    const client = createRedis(TEST_REDIS_URL)

    expect(await client.probe()).toBe('up')
    client.close()
  })

  test('reconnects on the next command after the connection is lost', async () => {
    const client = createRedis(TEST_REDIS_URL)
    const bystander = createRedis(TEST_REDIS_URL)
    const killer = createRedis(TEST_REDIS_URL)
    try {
      // Kill by ID: the test Redis is shared with other runs, whose connections must survive.
      const id: number = await client.command((redis) => redis.send('CLIENT', ['ID']))
      const bystanderId: number = await bystander.command((redis) => redis.send('CLIENT', ['ID']))
      const killed: number = await killer.command((redis) => redis.send('CLIENT', ['KILL', 'ID', String(id)]))
      expect(killed).toBe(1)

      expect(await client.probe()).toBe('up')
      expect(await client.command((redis) => redis.send('CLIENT', ['ID']))).not.toBe(id)
      // Same ID: the bystander kept its connection rather than reconnecting.
      expect(await bystander.command((redis) => redis.send('CLIENT', ['ID']))).toBe(bystanderId)
    } finally {
      client.close()
      bystander.close()
      killer.close()
    }
  })

  test('close leaves no open connection, the transaction connection included', async () => {
    const client = createRedis(TEST_REDIS_URL)
    const name = `test-close-${crypto.randomUUID().slice(0, 8)}`
    const transactionName = `${name}-tx`
    await client.command((redis) => redis.send('CLIENT', ['SETNAME', name]))
    expect(await client.transaction([['CLIENT', 'SETNAME', transactionName]])).toEqual(['OK'])
    expect(await connectionNamed(name)).toBe(true)
    expect(await connectionNamed(transactionName)).toBe(true)

    client.close()
    client.close()
    await Bun.sleep(100)

    expect(await connectionNamed(name)).toBe(false)
    expect(await connectionNamed(transactionName)).toBe(false)
    expect(await client.probe()).toBe('down')
    await expect(client.transaction([['PING']])).rejects.toThrow('Redis client is closed')
  })

  test('a transaction runs on its own connection, not the one commands and probes share', async () => {
    const client = createRedis(TEST_REDIS_URL)
    try {
      const shared: number = await client.command((redis) => redis.send('CLIENT', ['ID']))
      const [own] = await client.transaction([['CLIENT', 'ID']])

      expect(typeof own).toBe('number')
      expect(own).not.toBe(shared)
    } finally {
      client.close()
    }
  })

  test('a failed command comes back as an Error element, after the others ran', async () => {
    const client = createRedis(TEST_REDIS_URL)
    const key = `test-${crypto.randomUUID().slice(0, 8)}:text`
    try {
      const [set, incr] = await client.transaction([
        ['SET', key, 'abc', 'EX', '30'],
        ['INCR', key],
      ])

      expect(set).toBe('OK')
      expect(incr).toBeInstanceOf(Error)
      expect((incr as Error).message).toContain('not an integer')
    } finally {
      await client.command((redis) => redis.del(key))
      client.close()
    }
  })

  test('transactions started together share one EXEC, and each gets its own replies', async () => {
    const client = createRedis(TEST_REDIS_URL)
    try {
      const results = await Promise.all([
        client.transaction([['PING']]),
        client.transaction([
          ['ECHO', 'a'],
          ['ECHO', 'b'],
        ]),
        client.transaction([]),
        client.transaction([['ECHO', 'c']]),
      ])

      expect(results).toEqual([['PONG'], ['a', 'b'], [], ['c']])
    } finally {
      client.close()
    }
  })

  test('one command Redis refuses to queue aborts the batch it was sent in', async () => {
    const client = createRedis(TEST_REDIS_URL)
    try {
      const [bad, good] = await Promise.allSettled([client.transaction([['INCR']]), client.transaction([['PING']])])

      const refused = {
        status: 'rejected' as const,
        reason: expect.objectContaining({ message: expect.stringContaining('wrong number of arguments') }),
      }
      expect(bad).toEqual(refused)
      expect(good).toEqual(refused)
      expect(await client.transaction([['PING']])).toEqual(['PONG'])
    } finally {
      client.close()
    }
  })

  test('a transaction whose deadline passes while queued never runs', async () => {
    const proxy = createReplyDroppingProxy(TEST_REDIS_URL)
    const client = createRedis(proxy.url)
    const observer = createRedis(TEST_REDIS_URL)
    const key = `test-${crypto.randomUUID().slice(0, 8)}:queued`
    try {
      expect(await client.transaction([['SET', key, '0', 'EX', '30']])).toEqual(['OK'])
      proxy.dropReplies()
      const inFlight = client.transaction([['INCR', key]], 1000)
      inFlight.catch(() => undefined)
      await Bun.sleep(20)
      const started = performance.now()

      // Queued behind the stalled batch, so its own deadline takes it off the queue.
      await expect(client.transaction([['INCR', key]], 100)).rejects.toBeInstanceOf(RedisTimeoutError)
      expect(performance.now() - started).toBeLessThan(300)
      proxy.resume()
      await expect(inFlight).rejects.toBeInstanceOf(RedisTimeoutError)
      expect(await client.transaction([['GET', key]])).toEqual(['0'])
    } finally {
      await observer.command((redis) => redis.del(key))
      observer.close()
      client.close()
      proxy.stop()
    }
  })

  test('a transaction Redis refuses to queue rejects and leaves no MULTI open', async () => {
    const client = createRedis(TEST_REDIS_URL)
    try {
      await expect(client.transaction([['INCR']])).rejects.toThrow('wrong number of arguments')

      // A MULTI left open would make this one fail with "MULTI calls can not be nested".
      expect(await client.transaction([['PING']])).toEqual(['PONG'])
    } finally {
      client.close()
    }
  })
})
