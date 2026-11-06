import type { SecondaryStorage } from '@repo/auth'
import type { CacheStore } from '../cache'
import { cacheFailureReporter } from '../cache/report'
import { createMemoryCounter, createResilientCounter, type ResilientCounterOptions } from '../rate-limit/counter'

// Better Auth's rate-limit keys (`<ip>|<path>`) are unprefixed. Under `auth:` they can never meet a
// module's `<module>:` keys (R37), so a module's `delPattern` cannot reset them. `auth` is therefore
// not a valid cache module name.
export const AUTH_KEY_PREFIX = 'auth:'

export type GuardAuthStorageOptions = Omit<ResilientCounterOptions, 'driver'>

// One per process, shared by every guard built with the defaults, so the bound holds per instance.
const memoryFallback = createMemoryCounter()
// One per process too: the reporter's 30 s window lives in it.
const reportAuthFailure = cacheFailureReporter('auth')

// Better Auth `secondaryStorage` that holds rate-limit counters only (DEC-055). An allowlist: every
// other operation answers "nothing stored" without touching Redis.
//
// Sessions and verification values live in PostgreSQL only. Better Auth 1.7.15 reads Redis first
// for both and trusts what it finds there without asking PostgreSQL (DEC-054). A delete that
// silently failed during an outage would let a used reset token, an OAuth state or a revoked session
// work again once Redis is back. With `get` always `null`, `session.storeSessionInDatabase` and
// `verification.storeInDatabase` send every read to PostgreSQL, and consuming a verification value
// goes through the database, so `getAndDelete` is never needed. Without those two options this is
// unsafe: Better Auth would find no session and no verification value at all.
//
// A Better Auth plugin that reads `secondaryStorage` directly gets nothing back from this guard. In
// 1.7.15 only `device-authorization` (not enabled) does, so before enabling a plugin, grep its dist
// for `secondaryStorage`.
//
// `increment` falls back to a bounded in-memory counter while Redis fails, with a 5 s breaker, so a
// Redis outage never fails `/api/auth/*`. During one, limits count per instance (DEC-055).
export function guardAuthStorage(
  driver: Pick<SecondaryStorage, 'increment'>,
  options: GuardAuthStorageOptions = {},
): SecondaryStorage {
  const counter = createResilientCounter({
    ...options,
    // `async`, so a driver that throws synchronously still rejects into the fallback.
    driver: { increment: async (key, ttlSeconds) => driver.increment(key, ttlSeconds) },
    fallback: options.fallback ?? memoryFallback,
    onFailure: options.onFailure ?? reportAuthFailure,
  })

  return {
    get: async () => null,
    getAndDelete: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    increment: (key, ttl) => counter.increment(key, ttl),
  }
}

// The app's guard on the raw cache store (DEC-019, DEC-055): counters under `auth:`, through
// `CacheStore.increment` (one MULTI/EXEC with a reply deadline, ARCHITECTURE.md §6).
export function createSecondaryStorage(store: CacheStore, options?: GuardAuthStorageOptions): SecondaryStorage {
  return guardAuthStorage({ increment: (key, ttl) => store.increment(`${AUTH_KEY_PREFIX}${key}`, ttl) }, options)
}
