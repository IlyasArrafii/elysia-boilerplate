// Where cached strings live. `utils/cache` puts JSON, per-module key prefixes and TTLs on top.
export interface CacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  del(keys: readonly string[]): Promise<void>
  // Deletes every key matching a Redis glob pattern and returns how many were deleted.
  delPattern(pattern: string): Promise<number>
  // Reads and deletes in one atomic step (Redis GETDEL), so a one-time value is used once.
  getAndDelete(key: string): Promise<string | null>
  // Atomically adds one and returns the new count. An absent key starts at 1 with `ttlSeconds`;
  // later increments never extend the TTL, so the counter covers a fixed window (rate limits).
  increment(key: string, ttlSeconds: number): Promise<number>
}

// The slice of Bun's `RedisClient` the Redis store uses, so tests can record the commands sent.
export interface RedisCommands {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<'OK'>
  del(...keys: string[]): Promise<number>
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', hint: number): Promise<[string, string[]]>
  // Commands Bun has no typed method for (GETDEL).
  send(command: string, args: string[]): Promise<unknown>
}

// Runs one command with a reply deadline (`Redis.command` in utils/redis).
export type RunCommand = <T>(run: (redis: RedisCommands) => Promise<T>) => Promise<T>

// Runs the commands as one MULTI/EXEC with a reply deadline and resolves to EXEC's replies, a failed
// command as an `Error` element (`Redis.transaction` in utils/redis).
export type RunTransaction = (commands: readonly (readonly [command: string, ...args: string[]])[]) => Promise<unknown[]>

const SCAN_COUNT = 100

// A whole number of seconds Redis accepts for SET EX. Checked before anything is sent: inside the
// transaction a refused TTL fails only the SET, and the INCR after it would still create the
// counter without an expiry, locking the key out for good.
function assertCounterTtl(key: string, ttlSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new RangeError(`Counter TTL for cache key "${key}" must be a positive whole number of seconds, got ${ttlSeconds}`)
  }
}

function notACounter(key: string, cause?: unknown): TypeError {
  return new TypeError(`Cache key "${key}" does not hold a counter`, { cause })
}

// Redis counts in signed 64 bits; a JavaScript number is exact only up to 2^53. Past that the
// increment has already happened in the store, and only the count the caller gets is refused.
function unsafeCount(key: string, count: unknown): TypeError {
  return new TypeError(`Redis INCR on cache key "${key}" returned ${String(count)}, expected a safe integer`)
}

export function createRedisStore(command: RunCommand, transaction: RunTransaction): CacheStore {
  return {
    get(key) {
      return command((redis) => redis.get(key))
    },

    async set(key, value, ttlSeconds) {
      await command((redis) => redis.set(key, value, 'EX', ttlSeconds))
    },

    async del(keys) {
      if (keys.length === 0) return
      await command((redis) => redis.del(...keys))
    },

    // SCAN, never KEYS: KEYS blocks Redis for the whole keyspace (apps/api R38). SCAN may return a
    // key twice, which is harmless: deleting it again counts zero. Each page is its own command, so
    // the deadline bounds a page, not the whole walk.
    async delPattern(pattern) {
      let cursor = '0'
      let deleted = 0
      do {
        const [next, keys] = await command((redis) => redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT))
        if (keys.length > 0) deleted += await command((redis) => redis.del(...keys))
        cursor = next
      } while (cursor !== '0')
      return deleted
    },

    async getAndDelete(key) {
      const value = await command((redis) => redis.send('GETDEL', [key]))
      return typeof value === 'string' ? value : null
    },

    // Native commands, no Lua: SET NX creates an absent counter at 0 with its TTL, INCR then counts
    // it. MULTI/EXEC runs both as one step, so the key cannot expire between them (an INCR on its
    // own would recreate it without a TTL), and an existing counter keeps the TTL it was created
    // with whatever `ttlSeconds` says now. A transaction cut off before EXEC is discarded by Redis.
    async increment(key, ttlSeconds) {
      assertCounterTtl(key, ttlSeconds)
      const [created, count] = await transaction([
        ['SET', key, '0', 'EX', String(ttlSeconds), 'NX'],
        ['INCR', key],
      ])
      if (created instanceof Error) throw created
      // INCR refuses a value that is not a 64-bit integer, a non-string type, and an overflow.
      if (count instanceof Error) throw notACounter(key, count)
      // Bun returns integers as numbers, which are exact only up to 2^53.
      if (typeof count !== 'number' || !Number.isSafeInteger(count)) throw unsafeCount(key, count)
      return count
    },
  }
}

// Redis's own glob matcher (`stringmatchlen` in redis/src/util.c, 7.4), ported line for line so the
// memory store deletes exactly what SCAN MATCH would, quirks included: a reversed range `[z-a]` is
// normalised, `\` escapes inside and outside classes, and an unclosed `[` takes the rest of the
// pattern as its class. Redis compares bytes and this compares UTF-16 units, which agree on the
// ASCII keys modules use.
export function matchesGlob(pattern: string, key: string): boolean {
  return matchFrom(pattern, 0, key, 0, { skipLongerMatches: false }, 0)
}

// Redis's guard against patterns that would recurse without end.
const MAX_NESTING = 1000

interface MatchState {
  // Set once a `*` failed against every suffix: a `*` further left cannot do better by giving it less.
  skipLongerMatches: boolean
}

function matchFrom(pattern: string, pi: number, key: string, ki: number, state: MatchState, nesting: number): boolean {
  if (nesting > MAX_NESTING) return false
  while (pi < pattern.length && ki < key.length) {
    const char = pattern.charAt(pi)
    if (char === '*') {
      while (pattern.charAt(pi + 1) === '*') pi++
      if (pi === pattern.length - 1) return true
      for (; ki < key.length; ki++) {
        if (matchFrom(pattern, pi + 1, key, ki, state, nesting + 1)) return true
        if (state.skipLongerMatches) return false
      }
      state.skipLongerMatches = true
      return false
    }
    if (char === '[') {
      const { end, matched } = matchClass(pattern, pi + 1, key.charCodeAt(ki))
      if (!matched) return false
      pi = end
    } else if (char !== '?') {
      if (char === '\\' && pattern.length - pi >= 2) pi++
      if (pattern.charAt(pi) !== key.charAt(ki)) return false
    }
    ki++
    pi++
    if (ki === key.length) {
      while (pattern.charAt(pi) === '*') pi++
      break
    }
  }
  return pi >= pattern.length && ki === key.length
}

// `start` is the index after `[`. Returns the index of the class's last pattern character.
function matchClass(pattern: string, start: number, code: number): { end: number; matched: boolean } {
  let pi = start
  const negated = pattern.charAt(pi) === '^'
  if (negated) pi++
  let matched = false
  for (;;) {
    if (pattern.charAt(pi) === '\\' && pattern.length - pi >= 2) {
      pi++
      if (pattern.charCodeAt(pi) === code) matched = true
    } else if (pattern.charAt(pi) === ']') {
      break
    } else if (pi >= pattern.length) {
      pi = pattern.length - 1
      break
    } else if (pattern.length - pi >= 3 && pattern.charAt(pi + 1) === '-') {
      const from = pattern.charCodeAt(pi)
      const to = pattern.charCodeAt(pi + 2)
      if (code >= Math.min(from, to) && code <= Math.max(from, to)) matched = true
      pi += 2
    } else if (pattern.charCodeAt(pi) === code) {
      matched = true
    }
    pi++
  }
  return { end: pi, matched: negated ? !matched : matched }
}

const SWEEP_INTERVAL_MS = 60_000
const COUNTER_VALUE = /^(0|-?[1-9][0-9]*)$/
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

interface Entry {
  value: string
  expiresAt: number
}

// Development and tests only (apps/api R40): it lives in one process, so other instances never see
// its writes or invalidations.
export function createMemoryStore(now: () => number = Date.now): CacheStore {
  const entries = new Map<string, Entry>()
  let lastSweep = now()

  function read(key: string): string | null {
    const entry = entries.get(key)
    if (entry === undefined) return null
    if (entry.expiresAt <= now()) {
      entries.delete(key)
      return null
    }
    return entry.value
  }

  // Expired keys that are never read again would otherwise stay in memory for the process lifetime.
  function sweep(): void {
    if (now() - lastSweep < SWEEP_INTERVAL_MS) return
    lastSweep = now()
    for (const key of [...entries.keys()]) read(key)
  }

  return {
    async get(key) {
      return read(key)
    },

    async set(key, value, ttlSeconds) {
      sweep()
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 })
    },

    async del(keys) {
      for (const key of keys) entries.delete(key)
    },

    async delPattern(pattern) {
      let deleted = 0
      for (const key of [...entries.keys()]) {
        if (read(key) !== null && matchesGlob(pattern, key)) {
          entries.delete(key)
          deleted++
        }
      }
      return deleted
    },

    async getAndDelete(key) {
      const value = read(key)
      entries.delete(key)
      return value
    },

    // Atomic because nothing here awaits. Accepts exactly what Redis INCR accepts: a decimal
    // integer with no sign on 0, no leading zeros, spaces or exponent (Redis `string2ll`), within
    // signed 64 bits and not at the top of them (INCR's overflow error). Counted as a BigInt, so
    // values past 2^53 are stored exactly as Redis stores them, and then refused as Redis's are.
    async increment(key, ttlSeconds) {
      assertCounterTtl(key, ttlSeconds)
      const current = read(key)
      const entry = entries.get(key)
      if (current === null || entry === undefined) {
        sweep()
        entries.set(key, { value: '1', expiresAt: now() + ttlSeconds * 1000 })
        return 1
      }
      if (!COUNTER_VALUE.test(current)) throw notACounter(key)
      const stored = BigInt(current)
      if (stored < INT64_MIN || stored >= INT64_MAX) throw notACounter(key)
      const count = stored + 1n
      entries.set(key, { value: String(count), expiresAt: entry.expiresAt })
      if (count > BigInt(Number.MAX_SAFE_INTEGER) || count < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw unsafeCount(key, count)
      }
      return Number(count)
    },
  }
}
