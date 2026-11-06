import type { Context, Options } from 'elysia-rate-limit'
import { cacheStore, type CacheStore } from '../cache'
import { cacheFailureReporter } from '../cache/report'
import { createResilientCounter, type ResilientCounterOptions } from './counter'

// Every limiter's counters live under `ratelimit:<name>:`. `ratelimit` is a reserved cache module
// name (utils/cache), so no module can read them or reset them with its `delPattern`.
export const RATE_LIMIT_KEY_PREFIX = 'ratelimit:'

const LIMITER_NAME = /^[a-z][a-z0-9-]*$/

export interface RateLimitContextOptions {
  // The limiter's namespace in the store: `ratelimit:<name>:<clientKey>:<window>`.
  name: string
  store?: CacheStore
  // For the resilient counter: fallback, breaker, deadline, failure reporter and clock. The defaults
  // are a 5 s breaker, a 1 s deadline and a `cache.unavailable` reporter for `ratelimit:<name>`.
  counter?: Omit<ResilientCounterOptions, 'driver'>
}

// Whole seconds, at least one: the window is also the Redis TTL, and Redis takes whole seconds.
function windowMs(duration: Options['duration']): number {
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 1000 || duration % 1000 !== 0) {
    throw new RangeError(`Rate-limit duration must be a whole number of seconds (at least 1000 ms), got ${String(duration)}`)
  }
  return duration
}

// elysia-rate-limit's `Context` on the cache store, counting in fixed windows aligned to the clock:
// window `w` covers [w × duration, (w + 1) × duration), so every instance counts a request in the same
// window and `RateLimit-Reset` is the window's end. The count goes through the resilient counter, so a
// Redis outage falls back to a bounded per-instance memory counter instead of failing the request.
//
// The prefix is added by the driver, after the counter has bounded the key: a key over 200
// characters is replaced by its hash, which would drop a prefix written into the key itself.
//
// `decrement`, `reset` and `kill` do nothing. Limiters run with `countFailedRequest: true`, so the
// plugin never refunds, and a DECR on a key that had expired would create a counter without a TTL.
export function createRateLimitContext({ name, store = cacheStore, counter: counterOptions = {} }: RateLimitContextOptions): Context {
  if (!LIMITER_NAME.test(name)) {
    throw new Error(`Rate-limit name must match ${LIMITER_NAME.source}, got "${name}"`)
  }
  const counter = createResilientCounter({
    ...counterOptions,
    // `async`, so a store that throws synchronously still rejects into the fallback.
    driver: { increment: async (key, ttlSeconds) => store.increment(`${RATE_LIMIT_KEY_PREFIX}${name}:${key}`, ttlSeconds) },
    onFailure: counterOptions.onFailure ?? cacheFailureReporter(`${RATE_LIMIT_KEY_PREFIX}${name}`),
  })
  let configuredMs: number | undefined

  return {
    init(options) {
      configuredMs = windowMs(options.duration)
    },

    async increment(clientKey, duration, requestTime = Date.now()) {
      const durationMs = duration === undefined ? configuredMs : windowMs(duration)
      if (durationMs === undefined) throw new Error(`Rate limiter "${name}" was used before the plugin initialised it`)
      const window = Math.floor(requestTime / durationMs)
      const count = await counter.increment(`${clientKey}:${window}`, durationMs / 1000)
      return { count, start: window * durationMs, nextReset: new Date((window + 1) * durationMs) }
    },

    decrement() {},
    reset() {},
    kill() {},
  }
}
