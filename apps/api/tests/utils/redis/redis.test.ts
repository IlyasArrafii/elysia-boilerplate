import { describe, expect, test } from 'bun:test'
import { createTelemetry } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { createRedis, redis, RedisTimeoutError, resolveRedis } from '../../../src/utils/redis'
import {
  createStallingRedis,
  isTestRedisRunning,
  runInApiProcess,
  TEST_REDIS_URL,
  UNREACHABLE_REDIS_URL,
} from '../../helpers/redis'

function testTelemetry() {
  const memory = createMemorySink()
  return { memory, telemetry: createTelemetry({ env: 'test', sinks: [memory] }) }
}

describe('startup', () => {
  test('NODE_ENV=production without REDIS_URL fails with a clear error', async () => {
    const result = await runInApiProcess('await import("./src/app.ts")', { NODE_ENV: 'production', REDIS_URL: '' })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('REDIS_URL is required when NODE_ENV=production')
  })

  test('production starts with REDIS_URL set, without connecting yet', async () => {
    const result = await runInApiProcess('await import("./src/app.ts"); console.log("started")', {
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
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

  test('close leaves no open connection', async () => {
    const client = createRedis(TEST_REDIS_URL)
    const name = `test-close-${crypto.randomUUID().slice(0, 8)}`
    await client.command((redis) => redis.send('CLIENT', ['SETNAME', name]))
    expect(await connectionNamed(name)).toBe(true)

    client.close()
    client.close()
    await Bun.sleep(100)

    expect(await connectionNamed(name)).toBe(false)
    expect(await client.probe()).toBe('down')
  })
})
