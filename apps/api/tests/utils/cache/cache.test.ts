import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { createModuleCache, moduleCache, cacheStore, type Cache } from '../../../src/utils/cache'
import { cacheFailureReporter, type CacheOperation } from '../../../src/utils/cache/report'
import { createMemoryStore, createRedisStore, type CacheStore } from '../../../src/utils/cache/store'
import { createRedis } from '../../../src/utils/redis'
import { telemetry, type EventPayloads } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { createStallingRedis, UNREACHABLE_REDIS_URL } from '../../helpers/redis'

let clock = 0
let store: CacheStore
let posts: Cache

beforeEach(() => {
  clock = 1_000_000
  store = createMemoryStore(() => clock)
  posts = createModuleCache(store, 'posts', { ttlSeconds: 60 })
})

describe('module cache on the memory store', () => {
  test('a miss is undefined', async () => {
    expect(await posts.get('list:1:20')).toBeUndefined()
  })

  test('a hit returns what was set', async () => {
    await posts.set('list:1:20', { items: [{ id: 'a' }], total: 1 })

    expect(await posts.get('list:1:20')).toEqual({ items: [{ id: 'a' }], total: 1 })
  })

  test('caches falsy values, which are hits and not misses', async () => {
    await posts.set('null', null)
    await posts.set('zero', 0)

    expect(await posts.get('null')).toBeNull()
    expect(await posts.get('zero')).toBe(0)
  })

  test('an entry is a hit up to its TTL and a miss from the moment it expires', async () => {
    await posts.set('list:1:20', 'value')

    clock += 59_999
    expect(await posts.get('list:1:20')).toBe('value')
    clock += 1
    expect(await posts.get('list:1:20')).toBeUndefined()
  })

  test('each module has its own TTL', async () => {
    const short = createModuleCache(store, 'admin', { ttlSeconds: 5 })
    await short.set('roles', 'short')
    await posts.set('roles', 'long')

    clock += 5_000

    expect(await short.get('roles')).toBeUndefined()
    expect(await posts.get('roles')).toBe('long')
  })

  test('stores keys as <module>:<key>, so modules cannot see each other', async () => {
    const admin = createModuleCache(store, 'admin', { ttlSeconds: 60 })
    await posts.set('list:1:20', 'posts')

    expect(await store.get('posts:list:1:20')).toBe('"posts"')
    expect(await admin.get('list:1:20')).toBeUndefined()
  })

  test('del removes the given keys only', async () => {
    await posts.set('a', 1)
    await posts.set('b', 2)
    await posts.set('c', 3)

    await posts.del('a', 'b')

    expect([await posts.get('a'), await posts.get('b'), await posts.get('c')]).toEqual([undefined, undefined, 3])
  })

  test('rejects a value that JSON cannot hold', async () => {
    await expect(posts.set('fn', () => 1)).rejects.toThrow('JSON-serializable')
    await expect(posts.set('missing', undefined)).rejects.toThrow('JSON-serializable')
  })

  test('rejects an empty key', async () => {
    await expect(posts.get('')).rejects.toThrow('must not be empty')
  })
})

describe('wrap', () => {
  test('on a miss calls load once, caches the result and returns it', async () => {
    let calls = 0
    const load = async () => {
      calls++
      return { items: ['a'] }
    }

    expect(await posts.wrap('list:1:20', load)).toEqual({ items: ['a'] })
    expect(await posts.wrap('list:1:20', load)).toEqual({ items: ['a'] })
    expect(calls).toBe(1)
  })

  test('calls load again once the entry expired', async () => {
    let calls = 0
    const load = () => ++calls

    await posts.wrap('count', load)
    clock += 60_000

    expect(await posts.wrap('count', load)).toBe(2)
  })

  test('a hit is exactly the miss payload, even for a Date that JSON turns into a string (R39)', async () => {
    const row = { id: 'a', createdAt: new Date('2026-11-03T00:00:00.000Z') }

    const miss = await posts.wrap('row:a', () => row)
    const hit = await posts.wrap('row:a', () => row)

    expect(hit).toEqual(miss)
    expect(miss).toEqual({ id: 'a', createdAt: '2026-11-03T00:00:00.000Z' })
  })

  // `at: string` only compiles if the type follows `toJSON()` into what it returns.
  test('follows a custom toJSON, including a Date nested in its result', async () => {
    const value = { toJSON: () => ({ at: new Date(0) }) }

    const miss = await posts.wrap('custom', () => value)
    const at: string = miss.at

    expect(at).toBe('1970-01-01T00:00:00.000Z')
    expect(await posts.wrap('custom', () => value)).toEqual(miss)
  })

  test('caches nothing when load throws', async () => {
    await expect(posts.wrap('boom', () => Promise.reject(new Error('db down')))).rejects.toThrow('db down')
    expect(await posts.get('boom')).toBeUndefined()
  })
})

describe('delPattern', () => {
  test('deletes the matching keys of the module and returns how many', async () => {
    await posts.set('list:1:20', 1)
    await posts.set('list:2:20', 2)
    await posts.set('detail:a', 3)

    expect(await posts.delPattern('list:*')).toBe(2)
    expect(await posts.get('list:1:20')).toBeUndefined()
    expect(await posts.get('detail:a')).toBe(3)
  })

  test('never touches another module with the same key shape', async () => {
    const admin = createModuleCache(store, 'admin', { ttlSeconds: 60 })
    await admin.set('list:1:20', 'admin')

    await posts.delPattern('*')

    expect(await admin.get('list:1:20')).toBe('admin')
  })

  test('does not count expired keys', async () => {
    await posts.set('list:1:20', 1)
    clock += 60_000

    expect(await posts.delPattern('list:*')).toBe(0)
  })
})

const BREAKER_MS = 5000
const failure = new Error('Redis did not reply within 1000 ms')

// The memory store behind a switch: while `down`, every call fails as Redis does when unreachable,
// and while `hold` is pending, every call waits for it. `calls` records each call that reached the
// store, failed or not.
function switchableStore() {
  const memory = createMemoryStore(() => clock)
  const calls: CacheOperation[] = []
  const state: { down: boolean; hold?: Promise<void> } = { down: true }
  function guarded<A extends unknown[], R>(operation: CacheOperation, run: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      calls.push(operation)
      if (state.down) throw failure
      await state.hold
      return run(...args)
    }
  }
  const store: CacheStore = {
    get: guarded('get', memory.get),
    set: guarded('set', memory.set),
    del: guarded('del', memory.del),
    delPattern: guarded('delPattern', memory.delPattern),
    getAndDelete: guarded('getAndDelete', memory.getAndDelete),
    increment: guarded('increment', memory.increment),
  }
  return { store, calls, state }
}

// A posts cache on a store that is down, reporting through the real reporter on the test clock.
function failingCache() {
  const { store, calls, state } = switchableStore()
  const events: EventPayloads['cache.unavailable'][] = []
  const onFailure = cacheFailureReporter('posts', (_event, payload) => events.push(payload), () => clock)
  const cache = createModuleCache(store, 'posts', { ttlSeconds: 60, onFailure, now: () => clock })
  return { cache, calls, state, events }
}

// Redis down must never fail a module route: reads go to the source, writes are skipped, and
// invalidations resolve. The failure is a rate-capped `cache.unavailable` event instead.
describe('when the store fails, the cache fails open', () => {
  test('get misses, wrap returns what load gives, and set, del and delPattern resolve', async () => {
    const { cache, calls } = failingCache()

    expect(await cache.get('a')).toBeUndefined()
    clock += BREAKER_MS
    expect(await cache.wrap('row', () => ({ id: 'a', at: new Date(0) }))).toEqual({ id: 'a', at: '1970-01-01T00:00:00.000Z' })
    clock += BREAKER_MS
    expect(await cache.set('a', 1)).toBeUndefined()
    expect(await cache.del('a', 'b')).toBeUndefined()
    expect(await cache.delPattern('list:*')).toBe(0)

    // Every one of them asked the store and was refused.
    expect(calls).toEqual(['get', 'get', 'set', 'del', 'delPattern'])
  })

  test('wrap still returns what load gives when only its write fails', async () => {
    const store: CacheStore = { ...createMemoryStore(() => clock), set: () => Promise.reject(failure) }
    const cache = createModuleCache(store, 'posts', { ttlSeconds: 60, onFailure: () => undefined, now: () => clock })
    let loads = 0

    expect(await cache.wrap('a', () => ++loads)).toBe(1)
    // Nothing was stored, so the next one loads again.
    expect(await cache.wrap('a', () => ++loads)).toBe(2)
  })

  test('a store that throws instead of rejecting fails open too', async () => {
    const throwing: CacheStore = {
      ...createMemoryStore(),
      get: () => {
        throw failure
      },
    }

    expect(await createModuleCache(throwing, 'posts', { ttlSeconds: 60, onFailure: () => undefined }).get('a')).toBeUndefined()
  })

  test('an onFailure that throws is ignored', async () => {
    const { store } = switchableStore()
    const cache = createModuleCache(store, 'posts', {
      ttlSeconds: 60,
      onFailure: () => {
        throw new Error('reporter broke')
      },
    })

    expect(await cache.get('a')).toBeUndefined()
    expect(await cache.delPattern('*')).toBe(0)
  })

  test.each<[string, CacheOperation, (cache: Cache) => Promise<unknown>]>([
    ['get', 'get', (cache) => cache.get('a')],
    ['wrap', 'get', (cache) => cache.wrap('a', () => 1)],
    ['set', 'set', (cache) => cache.set('a', 1)],
    ['del', 'del', (cache) => cache.del('a')],
    ['delPattern', 'delPattern', (cache) => cache.delPattern('list:*')],
  ])('%s: one cache.unavailable per 30 s, then one carrying how many it left out', async (_name, operation, call) => {
    const { cache, calls, events } = failingCache()
    const start = clock

    // Six failures 5 s apart: the breaker has passed before each, so every one reaches the store.
    for (let second = 0; second < 30; second += 5) {
      clock = start + second * 1000
      await call(cache)
    }
    expect(calls).toHaveLength(6)
    expect(events).toHaveLength(1)

    clock = start + 30_000
    await call(cache)

    const err = expect.objectContaining({ name: 'Error', message: failure.message })
    expect(events).toEqual([
      { source: 'posts', operation, suppressed: 0, err },
      { source: 'posts', operation, suppressed: 5, err },
    ])
  })

  test('each operation has its own 30 s window', async () => {
    const { cache, events } = failingCache()

    await cache.get('a')
    await cache.wrap('a', () => 1)
    clock += BREAKER_MS
    await cache.set('a', 1)
    await cache.del('a')
    await cache.delPattern('*')

    expect(events.map((event) => [event.operation, event.suppressed])).toEqual([
      ['get', 0],
      ['set', 0],
      ['del', 0],
      ['delPattern', 0],
    ])
  })
})

describe('the breaker', () => {
  test('for 5 s after a failure, reads and sets skip the store and invalidations still reach it', async () => {
    const { cache, calls } = failingCache()
    await cache.get('a')
    calls.length = 0

    clock += BREAKER_MS - 1
    expect(await cache.get('a')).toBeUndefined()
    expect(await cache.wrap('a', () => 'loaded')).toBe('loaded')
    await cache.set('a', 1)
    await cache.del('a')
    expect(await cache.delPattern('*')).toBe(0)

    expect(calls).toEqual(['del', 'delPattern'])
  })

  test('an invalidation that fails, and a trial that fails, start the 5 s window again', async () => {
    const { cache, calls } = failingCache()
    await cache.get('a')
    clock += 4000
    await cache.del('a')
    calls.length = 0

    clock += BREAKER_MS - 1
    await cache.get('a')
    expect(calls).toEqual([])

    clock += 1
    await cache.get('a')
    expect(calls).toEqual(['get'])

    clock += BREAKER_MS - 1
    await cache.set('a', 1)
    expect(calls).toEqual(['get'])
  })

  // On a Redis that has stopped answering, the trial waits out the reply deadline; nothing else does.
  test('after 5 s it is half-open: the next read is the one trial, and reads and writes meanwhile skip the store', async () => {
    const { cache, calls, state } = failingCache()
    await cache.get('a')
    clock += BREAKER_MS
    state.down = false
    const release = Promise.withResolvers<void>()
    state.hold = release.promise
    calls.length = 0

    const trial = cache.get('a')
    expect(await cache.get('b')).toBeUndefined()
    expect(await cache.wrap('c', () => 'loaded')).toBe('loaded')
    await cache.set('d', 1)
    expect(calls).toEqual(['get'])

    release.resolve()
    state.hold = undefined
    // A miss, but an answer: the breaker is closed again.
    expect(await trial).toBeUndefined()
    await cache.set('d', 'stored')
    expect(await cache.get('d')).toBe('stored')
  })

  test.each<[string, (cache: Cache) => Promise<unknown>]>([
    ['del', (cache) => cache.del('stale')],
    ['delPattern', (cache) => cache.delPattern('list:*')],
  ])('a successful %s closes it, and the cache works again at once', async (_name, invalidate) => {
    const { cache, calls, state } = failingCache()
    await cache.get('a')
    state.down = false

    // Redis is back, but nothing asks it until an invalidation does.
    await cache.set('a', 'skipped')
    expect(calls).toEqual(['get'])

    await invalidate(cache)
    await cache.set('a', 'stored')

    expect(await cache.get('a')).toBe('stored')
  })

  test('a clock moved back counts as the window having passed', async () => {
    const { cache, calls } = failingCache()
    await cache.get('a')
    calls.length = 0

    clock -= 1
    await cache.get('a')

    expect(calls).toEqual(['get'])
  })

  test('del with no keys sends nothing and leaves an open breaker open', async () => {
    const { cache, calls, state } = failingCache()
    await cache.get('a')
    state.down = false
    calls.length = 0

    await cache.del()
    await cache.set('a', 1)

    expect(calls).toEqual([])
  })

  test('each module has its own breaker', async () => {
    const { store, calls } = switchableStore()
    const posts = createModuleCache(store, 'posts', { ttlSeconds: 60, onFailure: () => undefined, now: () => clock })
    const admin = createModuleCache(store, 'admin', { ttlSeconds: 60, onFailure: () => undefined, now: () => clock })

    await posts.get('a')
    await admin.get('a')

    expect(calls).toEqual(['get', 'get'])
  })
})

// A fail-open cache must not hide the caller's own mistakes, whether or not the breaker is open.
describe('bugs still reject while the store fails', () => {
  test('a value JSON cannot hold', async () => {
    const { cache } = failingCache()

    await expect(cache.set('fn', () => 1)).rejects.toThrow('JSON-serializable')
    // The wrap's read fails and opens the breaker; the rest run while it is open.
    await expect(cache.wrap('missing', () => undefined)).rejects.toThrow('JSON-serializable')
    await expect(cache.wrap('big', () => 1n)).rejects.toThrow(TypeError)
    await expect(cache.set('missing', undefined)).rejects.toThrow('JSON-serializable')
  })

  test('an empty key, in every operation, before the store is asked', async () => {
    const { cache, calls } = failingCache()

    await expect(cache.get('')).rejects.toThrow('must not be empty')
    await expect(cache.set('', 1)).rejects.toThrow('must not be empty')
    await expect(cache.wrap('', () => 1)).rejects.toThrow('must not be empty')
    await expect(cache.del('a', '')).rejects.toThrow('must not be empty')
    await expect(cache.delPattern('')).rejects.toThrow('must not be empty')
    expect(calls).toEqual([])
  })

  test('a load that rejects or throws, with the breaker closed and open', async () => {
    const { cache } = failingCache()

    await expect(cache.wrap('a', () => Promise.reject(new Error('db down')))).rejects.toThrow('db down')
    await expect(
      cache.wrap('a', () => {
        throw new Error('bug in load')
      }),
    ).rejects.toThrow('bug in load')
  })
})

// The app wiring: Bun's Redis client with its 1 s reply deadline, on a Redis that is not there.
describe('on a real Redis connection that fails', () => {
  test('a refused connection is a miss, and the module reports cache.unavailable', async () => {
    const redis = createRedis(UNREACHABLE_REDIS_URL)
    const events: EventPayloads['cache.unavailable'][] = []
    try {
      const cache = createModuleCache(createRedisStore(redis.command, redis.transaction), 'posts', {
        ttlSeconds: 60,
        onFailure: cacheFailureReporter('posts', (_event, payload) => events.push(payload)),
      })

      expect(await cache.wrap('list:1:20', () => ['from the database'])).toEqual(['from the database'])
      await cache.delPattern('list:*')

      expect(events.map((event) => [event.source, event.operation])).toEqual([
        ['posts', 'get'],
        ['posts', 'delPattern'],
      ])
    } finally {
      redis.close()
    }
    // Windows retries a refused connection for about a second before giving up.
  }, 10_000)

  test('a Redis that stops answering costs the first read one deadline, then the open breaker skips it', async () => {
    const stalling = createStallingRedis()
    const redis = createRedis(stalling.url)
    try {
      stalling.stall()
      const cache = createModuleCache(createRedisStore(redis.command, redis.transaction), 'posts', {
        ttlSeconds: 60,
        onFailure: () => undefined,
      })

      const first = performance.now()
      expect(await cache.get('a')).toBeUndefined()
      expect(performance.now() - first).toBeGreaterThanOrEqual(900)

      const second = performance.now()
      expect(await cache.wrap('a', () => 'loaded')).toBe('loaded')
      expect(performance.now() - second).toBeLessThan(100)
    } finally {
      redis.close()
      stalling.stop()
    }
  })
})

describe('module options', () => {
  test.each([0, -1, 1.5, Number.NaN])('rejects a TTL of %p seconds', (ttlSeconds) => {
    expect(() => createModuleCache(store, 'posts', { ttlSeconds })).toThrow('positive whole number of seconds')
  })

  test.each(['', 'Posts', 'posts:list', 'po*ts'])('rejects the module name "%s"', (name) => {
    expect(() => createModuleCache(store, name, { ttlSeconds: 60 })).toThrow('Cache module name')
  })

  // Their `delPattern('*')` would reset rate-limit counters.
  test.each(['auth', 'ratelimit'])('reserves the module name "%s" for rate-limit counters', (name) => {
    expect(() => moduleCache(name, { ttlSeconds: 60 })).toThrow('reserved for rate-limit counters')
  })
})

describe('the app cache', () => {
  test('runs on the memory fallback when REDIS_URL is empty, as in tests', async () => {
    const demo = moduleCache('cache-test', { ttlSeconds: 60 })

    await demo.set('key', { ok: true })

    expect(await demo.get('key')).toEqual({ ok: true })
    expect(await cacheStore.get('cache-test:key')).toBe('{"ok":true}')
    await demo.del('key')
  })

  test('reports a store failure as cache.unavailable from the module, without failing the call', async () => {
    const sink = createMemorySink()
    const detach = telemetry.addSink(sink)
    const get = spyOn(cacheStore, 'get').mockRejectedValue(failure)
    try {
      const demo = moduleCache('cache-report-test', { ttlSeconds: 60 })

      expect(await demo.get('key')).toBeUndefined()
      expect(sink.find('cache.unavailable')).toEqual([
        expect.objectContaining({ level: 'warn', kind: 'app', source: 'cache-report-test', operation: 'get', suppressed: 0 }),
      ])
    } finally {
      get.mockRestore()
      detach()
    }
  })
})
