import { redis } from '../redis'
import { cacheFailureReporter, type CacheOperation } from './report'
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
//
// The cache fails open: a Redis outage never fails a module call, because the data it holds can
// always be loaded again from its source. A store error is reported through `onFailure` and opens
// the module's breaker for BREAKER_MS. Reads then miss and opportunistic writes are skipped without
// asking Redis. Invalidations always ask Redis, and resolve even when it fails, so cached data may
// then stay stale until it expires: at most the module's TTL. Bugs still reject: an empty key, a
// value JSON cannot hold, and a `load` that rejects.
export interface Cache {
  // A store error, or an open breaker, is a miss.
  get<T>(key: string): Promise<Jsonified<T> | undefined>
  // Skipped on a store error or while the breaker is open.
  set<T>(key: string, value: T): Promise<void>
  // Invalidation.
  del(...keys: string[]): Promise<void>
  // Returns the cached value, or calls `load`, caches its result and returns it. A miss returns the
  // value as it comes back from the cache, so a hit is always exactly the miss payload (R39). The
  // read is a `get` and the write a `set`, so with Redis down this is `load()`.
  wrap<T>(key: string, load: () => T | Promise<T>): Promise<Jsonified<T>>
  // Invalidation. A Redis glob relative to the module prefix, e.g. `list:*`. Deletes with SCAN (R38)
  // and returns how many keys it deleted, or 0 when the store failed: SCAN deletes page by page, so
  // how many went before the failure is unknown.
  delPattern(pattern: string): Promise<number>
}

export interface CacheOptions {
  // One TTL per module (R37), in whole seconds.
  ttlSeconds: number
  // Told about every store call that failed. It is the only trace of an outage, since the cache
  // carries on without the store. Defaults to a `cache.unavailable` reporter for the module
  // (at most one event per operation every 30 s). A throw from it is ignored.
  onFailure?: (operation: CacheOperation, error: unknown) => void
  // The clock the breaker reads; tests pass their own.
  now?: () => number
}

// After a store call fails, reads and opportunistic writes leave Redis alone for this long, so an
// outage does not cost every request a failed call: on a Redis that has stopped answering, a failed
// call waits out the 1 s reply deadline (`Redis.command`). Then the breaker is half-open: the next
// read or write is the one trial on Redis, and those that arrive while it is in flight skip Redis
// without waiting. So such a Redis delays one read or write per window, by at most the deadline.
// Invalidations ask Redis even while the breaker is open, so each one can still wait it out.
const BREAKER_MS = 5000

const MODULE_NAME = /^[a-z][a-z0-9-]*$/
// Rate-limit counters live under these prefixes: Better Auth's under `auth:` (utils/auth/storage.ts),
// and `ratelimit:` is kept for counters outside Better Auth. A module of either name could read them,
// and its `delPattern('*')` would reset every limit.
const RESERVED_MODULES: ReadonlySet<string> = new Set(['auth', 'ratelimit'])

function serialize(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('Cache values must be JSON-serializable')
  return json
}

// The cache holds only what `serialize` wrote, so the parsed value is the JSON shape of the module's type.
function deserialize<T>(json: string): Jsonified<T> {
  return JSON.parse(json) as Jsonified<T>
}

type Attempt<T> = { ok: true; value: T } | { ok: false }

// Keys and values are checked before the breaker and the store, so a bug rejects whether or not Redis is up.
export function createModuleCache(
  store: CacheStore,
  module: string,
  { ttlSeconds, onFailure = cacheFailureReporter(module), now = Date.now }: CacheOptions,
): Cache {
  if (!MODULE_NAME.test(module)) {
    throw new Error(`Cache module name must match ${MODULE_NAME.source}, got "${module}"`)
  }
  if (RESERVED_MODULES.has(module)) {
    throw new Error(`Cache module name "${module}" is reserved for rate-limit counters`)
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error(`Cache TTL for module "${module}" must be a positive whole number of seconds, got ${ttlSeconds}`)
  }

  function keyOf(key: string): string {
    if (key === '') throw new Error(`Cache key for module "${module}" must not be empty`)
    return `${module}:${key}`
  }

  // When the last store call failed, while the breaker is open or half-open. Only an answer clears it.
  let failedAt: number | undefined
  let trialInFlight = false

  // Whether a read or write asks the store now, and whether it is the half-open trial. A negative
  // elapsed time (the clock moved back) counts as the window having passed.
  function gate(): 'closed' | 'open' | 'trial' {
    if (failedAt === undefined) return 'closed'
    if (trialInFlight) return 'open'
    const elapsed = now() - failedAt
    return elapsed >= 0 && elapsed < BREAKER_MS ? 'open' : 'trial'
  }

  // For reads and opportunistic writes: undefined when the breaker kept the call from the store.
  async function guarded<T>(operation: 'get' | 'set', call: () => Promise<T>): Promise<Attempt<T> | undefined> {
    const state = gate()
    if (state === 'open') return undefined
    if (state === 'closed') return attempt(operation, call)
    trialInFlight = true
    try {
      return await attempt(operation, call)
    } finally {
      trialInFlight = false
    }
  }

  // Any answer from the store closes the breaker; a failure (re)opens it and is reported.
  async function attempt<T>(operation: CacheOperation, call: () => Promise<T>): Promise<Attempt<T>> {
    try {
      const value = await call()
      failedAt = undefined
      return { ok: true, value }
    } catch (error) {
      failedAt = now()
      try {
        onFailure(operation, error)
      } catch {
        // Reporting is best effort: it must never turn a cache miss into a failed request.
      }
      return { ok: false }
    }
  }

  async function read(storeKey: string): Promise<string | null> {
    const result = await guarded('get', () => store.get(storeKey))
    return result?.ok === true ? result.value : null
  }

  async function write(storeKey: string, json: string): Promise<void> {
    await guarded('set', () => store.set(storeKey, json, ttlSeconds))
  }

  return {
    async get<T>(key: string) {
      const json = await read(keyOf(key))
      return json === null ? undefined : deserialize<T>(json)
    },

    async set(key, value) {
      const storeKey = keyOf(key)
      await write(storeKey, serialize(value))
    },

    async del(...keys) {
      const storeKeys = keys.map(keyOf)
      // Nothing to send, and no answer from Redis that could close the breaker.
      if (storeKeys.length === 0) return
      await attempt('del', () => store.del(storeKeys))
    },

    async wrap<T>(key: string, load: () => T | Promise<T>) {
      const storeKey = keyOf(key)
      const cached = await read(storeKey)
      if (cached !== null) return deserialize<T>(cached)

      const json = serialize(await load())
      await write(storeKey, json)
      return deserialize<T>(json)
    },

    async delPattern(pattern) {
      const storePattern = keyOf(pattern)
      const result = await attempt('delPattern', () => store.delPattern(storePattern))
      return result.ok ? result.value : 0
    },
  }
}

// Redis when REDIS_URL is set, otherwise the in-memory fallback (announced by `utils/redis`).
export const cacheStore: CacheStore = redis === null ? createMemoryStore() : createRedisStore(redis.command, redis.transaction)

// Called once per module, next to its TTL constant or env value:
// `const postsCache = moduleCache('posts', { ttlSeconds: env.POSTS_CACHE_TTL })`. Store failures are
// reported as `cache.unavailable` with `source` set to the module, unless `onFailure` says otherwise.
export function moduleCache(module: string, options: CacheOptions): Cache {
  return createModuleCache(cacheStore, module, options)
}
