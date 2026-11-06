import type { CsrfRejectReason } from '../csrf'
import type { LogContext } from '../logger/context'
import type { SerializedError } from './scrub'
import type { Kind, Level, SinkName } from './types'

// Payloads carry IDs, codes and counts only (redaction.md §1). Adding a field here is reviewed
// against that table; never add an email, name, body or URL field.

export interface ValidationField {
  path: string
  rule: string
}

export interface EventPayloads {
  'http.request': { method: string; route: string; status: number; durationMs: number }
  'http.error': {
    status: number
    code: string
    sourceModule?: string
    err: SerializedError
    fields?: ValidationField[]
  }
  'app.started': { version: string; env: string }
  'app.stopping': { version: string; env: string }
  // By kind and age, or every document of one user for an erasure request (log-storage.md §5.3).
  // Not `kind` and `userId`: those are base fields of every line and would be overwritten (TASK-15).
  'app.logs_pruned':
    | { prunedKind: Kind; deleted: number; cutoff: string; dryRun: boolean }
    | { prunedKind: 'all'; deleted: number; erasedUserId: string; dryRun: boolean }
  'cache.fallback': { reason: string }
  // A cache call failed and `source` carried on without it (fail open): `auth` counting rate limits
  // in memory, or a module cache (`source` is the cache module) reading its source, skipping a write
  // or leaving an invalidation undone. The `module` context field names the request's module, which
  // differs when a user removal clears the posts cache from an auth request. At most one per source
  // and operation every 30 s; `suppressed` counts the failures left out since the previous event
  // (utils/cache/report.ts).
  'cache.unavailable': { source: string; operation: string; suppressed: number; err: SerializedError }
  'rbac.unknown_role': { roles: { role: string; count: number }[] }
  // `dropped`: documents a buffered sink gave up on since the last report (log-storage.md §3).
  'telemetry.sink_failed': { sink: SinkName; failedEvent: string; dropped?: number }
  'telemetry.sink_dropped': { sink: SinkName; dropped: number }
  'audit.session.created': { sessionId: string; ip: string; userAgent: string }
  'audit.session.revoked': { sessionId: string; actorId?: string }
  'audit.user.role_changed': { from: string; to: string; actorId: string }
  'audit.user.banned': { actorId: string; expiresAt?: string }
  // No `actorId` when an expired ban is lifted by Better Auth during sign-in (TASK-04).
  'audit.user.unbanned': { actorId?: string }
  'audit.account.linked': { provider: string }
  'audit.auth.sign_in_failed': { ip: string; reason: string }
  'audit.auth.blocked_endpoint': { path: string; actorId?: string }
  // A state-changing request refused by the CSRF guard (utils/csrf). Never a header, cookie or URL.
  'audit.csrf.rejected': { method: string; reason: CsrfRejectReason }
  'auth.verification_link': { url: string }
  'auth.reset_link': { url: string }
}

export type EventName = keyof EventPayloads
export type DevEventName = 'auth.verification_link' | 'auth.reset_link'

export interface EventDefinition<E extends EventName> {
  kind: Kind
  // Where the event may go. The `memory` sink (tests) receives every event regardless.
  sinks: readonly SinkName[]
  level: Level | ((payload: EventPayloads[E], context: LogContext) => Level)
  // Dot-paths in the payload kept untouched by the scrubber (redaction.md §4).
  keep?: readonly string[]
}

type Definitions<N extends EventName> = { readonly [E in N]: EventDefinition<E> }

export type EventCatalogue = Definitions<EventName>

const STORED: readonly SinkName[] = ['log', 'mongo']
const LOG_ONLY: readonly SinkName[] = ['log']

function requestLevel(status: number): Level {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

export const eventCatalogue: Definitions<Exclude<EventName, DevEventName>> = {
  'http.request': {
    kind: 'http',
    sinks: STORED,
    // Probes would flood the log, so health requests are debug (API.md §3.2).
    level: ({ status }, { module }) => (module === 'health' ? 'debug' : requestLevel(status)),
  },
  'http.error': {
    kind: 'error',
    sinks: STORED,
    level: ({ status }) => requestLevel(status),
    keep: ['code'],
  },
  'app.started': { kind: 'app', sinks: STORED, level: 'info' },
  'app.stopping': { kind: 'app', sinks: STORED, level: 'info' },
  'app.logs_pruned': { kind: 'app', sinks: STORED, level: 'info' },
  'cache.fallback': { kind: 'app', sinks: STORED, level: 'warn' },
  'cache.unavailable': { kind: 'app', sinks: STORED, level: 'warn' },
  'rbac.unknown_role': { kind: 'app', sinks: STORED, level: 'warn' },
  'telemetry.sink_failed': { kind: 'app', sinks: LOG_ONLY, level: 'warn' },
  'telemetry.sink_dropped': { kind: 'app', sinks: LOG_ONLY, level: 'warn' },
  'audit.session.created': { kind: 'audit', sinks: STORED, level: 'info' },
  'audit.session.revoked': { kind: 'audit', sinks: STORED, level: 'info' },
  'audit.user.role_changed': { kind: 'audit', sinks: STORED, level: 'info' },
  'audit.user.banned': { kind: 'audit', sinks: STORED, level: 'info' },
  'audit.user.unbanned': { kind: 'audit', sinks: STORED, level: 'info' },
  'audit.account.linked': { kind: 'audit', sinks: STORED, level: 'info' },
  'audit.auth.sign_in_failed': { kind: 'audit', sinks: STORED, level: 'info' },
  'audit.auth.blocked_endpoint': { kind: 'audit', sinks: STORED, level: 'info' },
  'audit.csrf.rejected': { kind: 'audit', sinks: STORED, level: 'warn' },
}

// These carry a secret link, so they exist only in development and only on stdout
// (redaction.md §6). A production telemetry that registers them fails at startup.
export const devEventCatalogue: Definitions<DevEventName> = {
  'auth.verification_link': { kind: 'app', sinks: LOG_ONLY, level: 'info', keep: ['url'] },
  'auth.reset_link': { kind: 'app', sinks: LOG_ONLY, level: 'info', keep: ['url'] },
}
