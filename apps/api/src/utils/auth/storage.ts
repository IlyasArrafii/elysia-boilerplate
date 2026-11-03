import { SESSION_EXPIRES_IN_SECONDS, type SecondaryStorage } from '@repo/auth'
import type { CacheStore } from '../cache'

// Better Auth's own keys (`active-sessions-<userId>`, `verification:<id>`, rate-limit counters) are
// unprefixed. Under `auth:` they can never meet a module's `<module>:` keys (R37), so a module's
// `delPattern` cannot drop them. `auth` is therefore not a valid cache module name.
export const AUTH_KEY_PREFIX = 'auth:'

// Better Auth always passes a TTL in 1.7.15; a plugin that omits one still gets a bound, so nothing
// it writes lives in Redis longer than a session can.
export const MAX_TTL_SECONDS = SESSION_EXPIRES_IN_SECONDS

const ACTIVE_SESSIONS_PREFIX = 'active-sessions-'

// Sessions are never kept in Redis; PostgreSQL alone decides whether a session exists (auth §2).
// Better Auth 1.7.15 trusts a Redis session entry without reading the database, and keeps it with
// non-atomic read-modify-writes: a stale `active-sessions-<userId>` list lets a session key outlive
// a ban's sweep, and a session refresh racing a revocation writes the key back. Either leaves a
// revoked cookie working. With these entries dropped, `findSession`, `findSessions` and
// `listSessions` read the `session` table (`storeSessionInDatabase: true`), where a ban deletes
// the rows in the same transaction that bans the user.
//
// A session entry is the key `<token>` holding `{"session":{"token":"<token>",…},"user":…}`, or the
// user's `active-sessions-<userId>` list.
export function isSessionEntry(key: string, value: string | null): boolean {
  if (key.startsWith(ACTIVE_SESSIONS_PREFIX)) return true
  if (value === null || !value.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(value)
    const session: unknown = Reflect.get(Object(parsed), 'session')
    return Reflect.get(Object(session), 'token') === key
  } catch {
    return false
  }
}

// Better Auth `secondaryStorage` on the raw cache store (DEC-019): string values as Better Auth wrote
// them, TTL per call. Not `moduleCache`, whose fixed TTL and JSON layer do not fit. Errors propagate:
// Redis being down must fail the auth request, not look like "not rate limited".
export function createSecondaryStorage(store: CacheStore): SecondaryStorage {
  const keyOf = (key: string): string => `${AUTH_KEY_PREFIX}${key}`

  return {
    async get(key) {
      if (key.startsWith(ACTIVE_SESSIONS_PREFIX)) return null
      const value = await store.get(keyOf(key))
      // An entry written before sessions left Redis is ignored: it may belong to a revoked session.
      return isSessionEntry(key, value) ? null : value
    },

    getAndDelete: (key) => store.getAndDelete(keyOf(key)),

    // Rate-limit windows are whole seconds; a fraction is rounded up so the window is never shorter.
    increment: (key, ttl) => store.increment(keyOf(key), Math.max(1, Math.ceil(ttl))),

    async set(key, value, ttl) {
      if (isSessionEntry(key, value)) return
      if (ttl === undefined) {
        await store.set(keyOf(key), value, MAX_TTL_SECONDS)
        return
      }
      const seconds = Math.floor(ttl)
      // Better Auth computes the TTL from an expiry and passes 0 once it has passed. Redis refuses
      // `EX 0`, and the value is already dead, so it is removed instead.
      if (seconds <= 0) {
        await store.del([keyOf(key)])
        return
      }
      await store.set(keyOf(key), value, seconds)
    },

    async delete(key) {
      await store.del([keyOf(key)])
    },
  }
}
