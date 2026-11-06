import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { defaultOptions, type Options } from 'elysia-rate-limit'
import { createMemoryStore, createRedisStore, type CacheStore } from '../../../src/utils/cache/store'
import { createMemoryCounter } from '../../../src/utils/rate-limit/counter'
import { createRateLimitContext, RATE_LIMIT_KEY_PREFIX } from '../../../src/utils/rate-limit/context'
import { createRedis } from '../../../src/utils/redis'
import { telemetry } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { isTestRedisRunning, TEST_REDIS_URL, uniqueModule } from '../../helpers/redis'

const MINUTE = 60_000
// 15 s into window 29_000_000 of one minute.
const WINDOW = 29_000_000
const AT = WINDOW * MINUTE + 15_000

function options(duration: Options['duration']): Omit<Options, 'context'> {
  return { ...defaultOptions, duration }
}

interface Increment {
  key: string
  ttl: number
}

// Records every store call on top of a real memory store.
function recordingStore() {
  const inner = createMemoryStore()
  const increments: Increment[] = []
  const others: string[] = []
  const other = (method: string) => () => {
    others.push(method)
    return Promise.reject(new Error(`${method} is not used by the rate-limit context`))
  }
  const store: CacheStore = {
    get: other('get'),
    set: other('set'),
    del: other('del'),
    delPattern: other('delPattern'),
    getAndDelete: other('getAndDelete'),
    increment: (key, ttl) => {
      increments.push({ key, ttl })
      return inner.increment(key, ttl)
    },
  }
  return { store, increments, others }
}

function failingStore(failure = new Error('Redis did not reply within 1000 ms')): CacheStore & { calls: number } {
  const reject = () => {
    store.calls++
    return Promise.reject(failure)
  }
  const store = { calls: 0, get: reject, set: reject, del: reject, delPattern: reject, getAndDelete: reject, increment: reject }
  return store
}

describe('createRateLimitContext', () => {
  test.each(['', 'Posts', '1posts', 'posts_write', 'ratelimit:posts', 'posts write'])('refuses the name %p', (name) => {
    expect(() => createRateLimitContext({ name, store: createMemoryStore() })).toThrow('Rate-limit name must match')
  })

  test.each([0, 999, 1500, 60_000.5, -1000, Number.NaN, Number.POSITIVE_INFINITY])('refuses a %p ms window', (duration) => {
    const context = createRateLimitContext({ name: 'test-window', store: createMemoryStore() })

    expect(() => context.init(options(duration))).toThrow(RangeError)
  })

  test('refuses a window computed per request: a fixed window needs one length', () => {
    const context = createRateLimitContext({ name: 'test-window', store: createMemoryStore() })

    expect(() => context.init(options(() => 60_000))).toThrow(RangeError)
  })

  test('takes a whole number of seconds, one at least', () => {
    for (const duration of [1000, 60_000, 86_400_000]) {
      const context = createRateLimitContext({ name: 'test-window', store: createMemoryStore() })
      expect(() => context.init(options(duration))).not.toThrow()
    }
  })

  test('counts under ratelimit:<name>:<clientKey>:<window> with the window as TTL', async () => {
    const { store, increments } = recordingStore()
    const context = createRateLimitContext({ name: 'test-posts', store })
    context.init(options(MINUTE))

    expect(await context.increment('user-1', MINUTE, AT)).toEqual({
      count: 1,
      start: WINDOW * MINUTE,
      nextReset: new Date((WINDOW + 1) * MINUTE),
    })
    expect((await context.increment('user-1', MINUTE, AT + 44_999)).count).toBe(2)
    expect((await context.increment('user-2', MINUTE, AT)).count).toBe(1)
    expect(increments).toEqual([
      { key: `ratelimit:test-posts:user-1:${WINDOW}`, ttl: 60 },
      { key: `ratelimit:test-posts:user-1:${WINDOW}`, ttl: 60 },
      { key: `ratelimit:test-posts:user-2:${WINDOW}`, ttl: 60 },
    ])
  })

  test('a window starts on the clock, not on the first request: the next one counts from 1 under its own key', async () => {
    const { store, increments } = recordingStore()
    const context = createRateLimitContext({ name: 'test-posts', store })
    context.init(options(MINUTE))

    await context.increment('user-1', MINUTE, (WINDOW + 1) * MINUTE - 1)
    const next = await context.increment('user-1', MINUTE, (WINDOW + 1) * MINUTE)

    expect(next).toEqual({ count: 1, start: (WINDOW + 1) * MINUTE, nextReset: new Date((WINDOW + 2) * MINUTE) })
    expect(increments.map(({ key }) => key)).toEqual([`ratelimit:test-posts:user-1:${WINDOW}`, `ratelimit:test-posts:user-1:${WINDOW + 1}`])
  })

  test('uses the window from init when the plugin passes none', async () => {
    const { store, increments } = recordingStore()
    const context = createRateLimitContext({ name: 'test-posts', store })
    context.init(options(10_000))

    const result = await context.increment('user-1', undefined, AT)

    expect(result.nextReset).toEqual(new Date((Math.floor(AT / 10_000) + 1) * 10_000))
    expect(increments).toEqual([{ key: `ratelimit:test-posts:user-1:${Math.floor(AT / 10_000)}`, ttl: 10 }])
  })

  test('refuses to count before the plugin initialised it', async () => {
    const context = createRateLimitContext({ name: 'test-posts', store: createMemoryStore() })

    await expect(context.increment('user-1', undefined, AT)).rejects.toThrow('before the plugin initialised it')
  })

  test('a key over 200 characters is hashed by the counter, and still stored under ratelimit:<name>:', async () => {
    const { store, increments } = recordingStore()
    const context = createRateLimitContext({ name: 'test-posts', store })
    context.init(options(MINUTE))
    const clientKey = 'u'.repeat(250)
    const hash = createHash('sha256').update(`${clientKey}:${WINDOW}`).digest('hex')

    expect((await context.increment(clientKey, MINUTE, AT)).count).toBe(1)
    expect((await context.increment(clientKey, MINUTE, AT)).count).toBe(2)

    expect(increments.map(({ key }) => key)).toEqual([`ratelimit:test-posts:sha256:${hash}`, `ratelimit:test-posts:sha256:${hash}`])
  })

  test('decrement, reset and kill never touch the store', async () => {
    const { store, increments, others } = recordingStore()
    const context = createRateLimitContext({ name: 'test-posts', store })
    context.init(options(MINUTE))

    await context.decrement('user-1')
    await context.reset('user-1')
    await context.reset()
    await context.kill()

    expect(increments).toEqual([])
    expect(others).toEqual([])
  })

  test('with the store failing, counts go on in memory and one cache.unavailable names the limiter', async () => {
    const memory = createMemorySink()
    const detach = telemetry.addSink(memory)
    try {
      const store = failingStore()
      const context = createRateLimitContext({ name: 'test-outage-context', store })
      context.init(options(MINUTE))

      const counts = []
      for (let index = 0; index < 5; index++) counts.push((await context.increment('user-1', MINUTE, AT)).count)

      expect(counts).toEqual([1, 2, 3, 4, 5])
      // The breaker keeps the store out of the calls after the first failure.
      expect(store.calls).toBe(1)
      expect(memory.find('cache.unavailable').map(({ source, operation, suppressed }) => ({ source, operation, suppressed }))).toEqual([
        { source: 'ratelimit:test-outage-context', operation: 'increment', suppressed: 0 },
      ])
    } finally {
      detach()
    }
  })

  test('counter options reach the resilient counter: its fallback, reporter and breaker', async () => {
    const failures: string[] = []
    const fallback = createMemoryCounter()
    await fallback.increment(`user-1:${WINDOW}`, 60)
    const context = createRateLimitContext({
      name: 'test-posts',
      store: failingStore(),
      counter: { fallback, onFailure: (operation) => failures.push(operation), breakerMs: 2000, deadlineMs: 100 },
    })
    context.init(options(MINUTE))

    expect((await context.increment('user-1', MINUTE, AT)).count).toBe(2)
    expect(failures).toEqual(['increment'])
  })

  test('counter options the resilient counter refuses fail at construction', () => {
    expect(() => createRateLimitContext({ name: 'test-posts', store: createMemoryStore(), counter: { breakerMs: 1000, deadlineMs: 1000 } })).toThrow(
      RangeError,
    )
  })
})

const redisRunning = await isTestRedisRunning()

describe.skipIf(!redisRunning)('rate-limit context on a real Redis (docker-compose.test.yml)', () => {
  const redis = createRedis(TEST_REDIS_URL)
  const store = createRedisStore(redis.command, redis.transaction)

  afterAll(() => redis.close())

  test('counts 1..n under ratelimit:<name>:<clientKey>:<window>, and the key lives one window', async () => {
    const name = uniqueModule()
    const context = createRateLimitContext({ name, store })
    context.init(options(MINUTE))
    const at = Date.now()
    const key = `${RATE_LIMIT_KEY_PREFIX}${name}:user-1:${Math.floor(at / MINUTE)}`

    const counts = []
    for (let index = 0; index < 5; index++) counts.push((await context.increment('user-1', MINUTE, at)).count)

    expect(counts).toEqual([1, 2, 3, 4, 5])
    expect(await store.get(key)).toBe('5')
    const ttl = await redis.command((client) => client.ttl(key))
    expect(ttl).toBeGreaterThan(55)
    expect(ttl).toBeLessThanOrEqual(60)
    await store.del([key])
  })

  test('a hashed key stays under ratelimit:<name>:', async () => {
    const name = uniqueModule()
    const context = createRateLimitContext({ name, store })
    context.init(options(MINUTE))
    const clientKey = 'u'.repeat(250)
    const window = Math.floor(Date.now() / MINUTE)
    const key = `${RATE_LIMIT_KEY_PREFIX}${name}:sha256:${createHash('sha256').update(`${clientKey}:${window}`).digest('hex')}`

    await context.increment(clientKey, MINUTE, window * MINUTE)

    expect(await store.get(key)).toBe('1')
    await store.del([key])
  })
})
