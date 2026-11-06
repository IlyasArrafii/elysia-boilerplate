import { createHash } from 'node:crypto'

// A fixed-window counter: an absent or expired key starts at 1 and lives `ttlSeconds`; later
// increments never extend the window. Better Auth's rate limiter compares the count with its rule.
export interface Counter {
  increment(key: string, ttlSeconds: number): Promise<number>
}

export interface MemoryCounterOptions {
  maxEntries?: number
  now?: () => number
}

export interface ResilientCounterOptions {
  // The shared counter (Redis). Never trusted to answer: it is raced against `deadlineMs`.
  driver: Counter
  // Counts while the driver is failing. Per process, so every instance limits on its own.
  fallback?: Counter
  breakerMs?: number
  deadlineMs?: number
  // Called once when the breaker opens, not for each fallback while it stays open. It runs on the
  // request path, so a throw from it is ignored and the count still comes from the fallback.
  onFailure?: (operation: 'increment', error: unknown) => void
  now?: () => number
}

const SWEEP_INTERVAL_MS = 60_000
// Better Auth's key is `<ip>|<path>`, and the path is whatever an `/api/auth/*` request asked for:
// the limiter runs before routing. A longer key is replaced by its hash, so `maxEntries` bounds the
// memory and not only the entry count. Legitimate keys (an IPv6 address and an auth path) are far shorter.
const MAX_KEY_LENGTH = 200

function assertTtl(ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError(`Counter TTL must be a positive number of seconds, got ${ttlSeconds}`)
  }
}

function boundedKey(key: string): string {
  return key.length <= MAX_KEY_LENGTH ? key : `sha256:${createHash('sha256').update(key).digest('hex')}`
}

interface Window {
  count: number
  startedAt: number
  expiresAt: number
}

// Map order is insertion order, and a restarted window is re-inserted, so the first key is the
// oldest-inserted: the one evicted when the map is full. An evicted key starts again at 1.
export function createMemoryCounter({ maxEntries = 100_000, now = Date.now }: MemoryCounterOptions = {}): Counter {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(`maxEntries must be a positive whole number, got ${maxEntries}`)
  }
  const windows = new Map<string, Window>()
  let lastSweep = now()

  // At most once a minute, so a full map of live keys does not cost a scan per request. A clock
  // that moved back sweeps at once.
  function sweep(at: number): void {
    const elapsed = at - lastSweep
    if (elapsed >= 0 && elapsed < SWEEP_INTERVAL_MS) return
    lastSweep = at
    for (const [key, window] of windows) {
      if (window.expiresAt <= at) windows.delete(key)
    }
  }

  return {
    async increment(rawKey, ttlSeconds) {
      assertTtl(ttlSeconds)
      const key = boundedKey(rawKey)
      const at = now()
      const current = windows.get(key)
      // A clock that moved back before the window began ends it, so a correction never locks a key
      // out for longer than its window.
      if (current !== undefined && at >= current.startedAt && at < current.expiresAt) {
        current.count++
        return current.count
      }

      windows.delete(key)
      sweep(at)
      while (windows.size >= maxEntries) {
        const oldest = windows.keys().next()
        if (oldest.done === true) break
        windows.delete(oldest.value)
      }
      windows.set(key, { count: 1, startedAt: at, expiresAt: at + ttlSeconds * 1000 })
      return 1
    },
  }
}

class CounterTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`Counter did not answer within ${deadlineMs} ms`)
    this.name = 'CounterTimeoutError'
  }
}

async function withDeadline<T>(pending: Promise<T>, deadlineMs: number): Promise<T> {
  // A driver that answers after the deadline is ignored; its rejection must not go unhandled.
  pending.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CounterTimeoutError(deadlineMs)), deadlineMs)
  })
  try {
    return await Promise.race([pending, deadline])
  } finally {
    clearTimeout(timer)
  }
}

// Whole seconds, at least 1: Redis takes only whole seconds, and rounding up never makes a window
// shorter than asked. A window that is not a number is a configuration error, not an outage.
function windowSeconds(ttl: number): number {
  if (!Number.isFinite(ttl)) throw new RangeError(`Counter TTL must be a finite number of seconds, got ${ttl}`)
  return Math.max(1, Math.ceil(ttl))
}

// Counts on the driver, and on the fallback when the driver rejects or misses the deadline. A failure
// opens a breaker for `breakerMs`, during which the driver is not called at all. When it closes there
// is no single trial call: every request that arrives before the first of them fails is sent to the
// driver. A refused connection fails at once, but a driver that has stopped answering makes each of
// those requests wait the full deadline: with the defaults, roughly the traffic of 1 s in every 6 s.
// Counts made on the fallback stay there: when the driver is back, its own counts continue from where
// they were.
export function createResilientCounter({
  driver,
  fallback = createMemoryCounter(),
  breakerMs = 5000,
  deadlineMs = 1000,
  onFailure,
  now = Date.now,
}: ResilientCounterOptions): Counter {
  let openedAt: number | undefined

  // A negative elapsed time (the clock moved back) counts as the breaker window having passed.
  function isOpen(): boolean {
    if (openedAt === undefined) return false
    const elapsed = now() - openedAt
    if (elapsed >= 0 && elapsed < breakerMs) return true
    openedAt = undefined
    return false
  }

  return {
    async increment(key, ttl) {
      const ttlSeconds = windowSeconds(ttl)
      if (isOpen()) return fallback.increment(key, ttlSeconds)
      try {
        return await withDeadline(driver.increment(key, ttlSeconds), deadlineMs)
      } catch (error) {
        // Calls already in flight when the breaker opened fail too; only the first one reports.
        if (!isOpen()) {
          openedAt = now()
          try {
            onFailure?.('increment', error)
          } catch {
            // Reporting is best effort; it must never turn a fallback count into a failed request.
          }
        }
        return fallback.increment(key, ttlSeconds)
      }
    },
  }
}
