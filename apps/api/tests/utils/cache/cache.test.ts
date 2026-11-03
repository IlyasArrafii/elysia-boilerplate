import { beforeEach, describe, expect, test } from 'bun:test'
import { createModuleCache, moduleCache, cacheStore, type Cache } from '../../../src/utils/cache'
import { createMemoryStore, type CacheStore } from '../../../src/utils/cache/store'

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

// A configured Redis that fails is an error for the global handler (R28), not a silent cache bypass.
describe('when the store fails', () => {
  const failure = new Error('Redis did not reply within 1000 ms')
  const failing: CacheStore = {
    get: () => Promise.reject(failure),
    set: () => Promise.reject(failure),
    del: () => Promise.reject(failure),
    delPattern: () => Promise.reject(failure),
  }
  const broken = createModuleCache(failing, 'posts', { ttlSeconds: 60 })

  test('get, set, del and delPattern reject with the store error', async () => {
    await expect(broken.get('a')).rejects.toBe(failure)
    await expect(broken.set('a', 1)).rejects.toBe(failure)
    await expect(broken.del('a')).rejects.toBe(failure)
    await expect(broken.delPattern('*')).rejects.toBe(failure)
  })

  test('wrap rejects on a failed read without calling load', async () => {
    let calls = 0

    await expect(broken.wrap('a', () => ++calls)).rejects.toBe(failure)
    expect(calls).toBe(0)
  })

  test('wrap rejects on a failed write after a miss', async () => {
    const readsMiss = createModuleCache({ ...failing, get: async () => null }, 'posts', { ttlSeconds: 60 })

    await expect(readsMiss.wrap('a', () => 1)).rejects.toBe(failure)
  })
})

describe('module options', () => {
  test.each([0, -1, 1.5, Number.NaN])('rejects a TTL of %p seconds', (ttlSeconds) => {
    expect(() => createModuleCache(store, 'posts', { ttlSeconds })).toThrow('positive whole number of seconds')
  })

  test.each(['', 'Posts', 'posts:list', 'po*ts'])('rejects the module name "%s"', (name) => {
    expect(() => createModuleCache(store, name, { ttlSeconds: 60 })).toThrow('Cache module name')
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
})
