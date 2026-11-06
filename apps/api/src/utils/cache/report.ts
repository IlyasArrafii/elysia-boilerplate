import { telemetry, type EventPayloads } from '../telemetry'
import { serializeError } from '../telemetry/scrub'
import type { CacheStore } from './store'

export type CacheOperation = keyof CacheStore

export type EmitCacheUnavailable = (event: 'cache.unavailable', payload: EventPayloads['cache.unavailable']) => void

// During an outage every request fails the same way, so one event per window is enough to find it,
// and `suppressed` says how many were left out.
const REPORT_INTERVAL_MS = 30_000

interface Window {
  reportedAt: number
  suppressed: number
}

// For callers that keep working without the cache (fail open) and must still say so. Create one per
// `source` and keep it: the 30 s window lives in the reporter. Never throws.
export function cacheFailureReporter(
  source: string,
  emit: EmitCacheUnavailable = (event, payload) => telemetry.emit(event, payload),
  now: () => number = Date.now,
): (operation: CacheOperation, error: unknown) => void {
  const windows = new Map<CacheOperation, Window>()

  return (operation, error) => {
    const at = now()
    const last = windows.get(operation)
    // A clock that moved back ends the window, as if it had passed.
    if (last !== undefined && at - last.reportedAt >= 0 && at - last.reportedAt < REPORT_INTERVAL_MS) {
      last.suppressed++
      return
    }
    windows.set(operation, { reportedAt: at, suppressed: 0 })
    // `serializeError` keeps the name, code and a redacted message only (redaction.md §3): a Redis
    // error can echo a key or a connection string.
    emit('cache.unavailable', { source, operation, suppressed: last?.suppressed ?? 0, err: serializeError(error) })
  }
}
