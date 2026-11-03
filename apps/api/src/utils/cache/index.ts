import { redis } from '../redis'
import { createMemoryStore, createRedisStore, type CacheStore } from './store'

export type { CacheStore } from './store'

// The type a value has after a JSON round trip, which is what the cache gives back: a `Date` becomes
// a string and functions are dropped. Typing reads this way keeps `hit.createdAt.getTime()` from
// compiling when it would fail at run time.
export type Jsonified<T> = T extends { toJSON(): infer J }
  ? Jsonified<J>
  : T extends (...args: never[]) => unknown
    ? never
    : T extends readonly (infer U)[]
      ? Jsonified<U>[]
      : T extends object
        ? { [K in keyof T]: Jsonified<T[K]> }
        : T

// What a module gets. Keys are written without the module prefix (`list:1:20`) and stored as
// `<module>:<key>` (`posts:list:1:20`, apps/api R37), so one module can never read or invalidate
// another's keys. Values are stored as JSON.
export interface Cache {
  get<T>(key: string): Promise<Jsonified<T> | undefined>
  set<T>(key: string, value: T): Promise<void>
  del(...keys: string[]): Promise<void>
  // Returns the cached value, or calls `load`, caches its result and returns it. A miss returns the
  // value as it comes back from the cache, so a hit is always exactly the miss payload (R39).
  wrap<T>(key: string, load: () => T | Promise<T>): Promise<Jsonified<T>>
  // A Redis glob relative to the module prefix, e.g. `list:*`. Deletes with SCAN (R38).
  delPattern(pattern: string): Promise<number>
}

export interface CacheOptions {
  // One TTL per module (R37), in whole seconds.
  ttlSeconds: number
}

const MODULE_NAME = /^[a-z][a-z0-9-]*$/

function serialize(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('Cache values must be JSON-serializable')
  return json
}

// The cache holds only what `serialize` wrote, so the parsed value is the JSON shape of the module's type.
function deserialize<T>(json: string): Jsonified<T> {
  return JSON.parse(json) as Jsonified<T>
}

export function createModuleCache(store: CacheStore, module: string, { ttlSeconds }: CacheOptions): Cache {
  if (!MODULE_NAME.test(module)) {
    throw new Error(`Cache module name must match ${MODULE_NAME.source}, got "${module}"`)
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`Cache TTL for module "${module}" must be a positive whole number of seconds, got ${ttlSeconds}`)
  }

  function keyOf(key: string): string {
    if (key === '') throw new Error(`Cache key for module "${module}" must not be empty`)
    return `${module}:${key}`
  }

  return {
    async get<T>(key: string) {
      const json = await store.get(keyOf(key))
      return json === null ? undefined : deserialize<T>(json)
    },

    async set(key, value) {
      await store.set(keyOf(key), serialize(value), ttlSeconds)
    },

    async del(...keys) {
      await store.del(keys.map(keyOf))
    },

    async wrap<T>(key: string, load: () => T | Promise<T>) {
      const cached = await store.get(keyOf(key))
      if (cached !== null) return deserialize<T>(cached)

      const json = serialize(await load())
      await store.set(keyOf(key), json, ttlSeconds)
      return deserialize<T>(json)
    },

    async delPattern(pattern) {
      return store.delPattern(keyOf(pattern))
    },
  }
}

// Redis when REDIS_URL is set, otherwise the in-memory fallback (announced by `utils/redis`).
export const cacheStore: CacheStore = redis === null ? createMemoryStore() : createRedisStore(redis.command)

// Called once per module, next to its TTL constant or env value:
// `const postsCache = moduleCache('posts', { ttlSeconds: env.POSTS_CACHE_TTL })`.
export function moduleCache(module: string, options: CacheOptions): Cache {
  return createModuleCache(cacheStore, module, options)
}
