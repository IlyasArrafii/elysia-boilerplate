# Observability

pino plus manual telemetry events, no OpenTelemetry (DEC-013, DEC-014, DEC-016, DEC-026, DEC-027, DEC-034, DEC-037). MVP scope: the API only.

| Document | Covers |
|:---|:---|
| This file | Event model, module tagging, request logging, event catalogue, `telemetry` contract |
| [redaction.md](redaction.md) | What must never be logged and how it is stripped |
| [log-storage.md](log-storage.md) | MongoDB log store, write path, manual retention (prune) |
| [migration-loki.md](migration-loki.md) | Moving from MongoDB to Grafana Alloy + Loki (design only) |
| [migration-elk.md](migration-elk.md) | Moving from MongoDB to the ELK Stack: Elasticsearch, Logstash, Kibana (design only, alternative to Loki) |
| [sentry.md](sentry.md) | Adding Sentry for error tracking (design only) |
| [posthog.md](posthog.md) | Adding PostHog for product analytics (design only) |
| [access-stages.md](access-stages.md) | What changes at access stage 2 (single-org) and in Step A: `organizationId`, `access.*` and `audit.org.*` events |
| [../saas/observability.md](../../../specs/eng/saas/observability.md) | SaaS multi-tenant layer: per-tenant queries, Sentry and PostHog by organization, tenant purge, isolation alerts |

## 1. Overview

```
app code ──► telemetry.emit('posts.created', { postId }, ctx)      ctx = { requestId, module, userId }
                  │
                  ▼
            scrubber (redaction.md)
                  │
                  ├─► log sink     (always)                 → pino → stdout (JSON)
                  ├─► mongo sink   (when LOG_MONGO_URL set) → batched insert → MongoDB log_event
                  ├─► memory sink  (tests only)
                  ├─► sentry sink  (design only, sentry.md)
                  └─► posthog sink (design only, posthog.md)
```

- Application code **never** imports a vendor SDK or the MongoDB driver. Only `utils/telemetry/sinks/*` and `utils/mongo` may.
- `log` (pino from the context) can still be used for plain technical lines (`log.debug(...)`); those go to **stdout only**. Anything that must be findable later is an event.

## 2. Code layout

```
apps/api/src/utils/
  logger/
    index.ts        pino instance (redact paths, level from LOG_LEVEL, pino-pretty in dev only)
    plugin.ts       named plugin 'logger' (as: 'global'): request ID, log context, http.request
    module.ts       moduleScope(name): tags the log context with the module (§4)
  telemetry/
    events.ts       typed event catalogue (name → payload type → kind → sinks)
    retention.ts    retention days per kind (log-storage.md §5)
    scrub.ts        the scrubber (redaction.md §4)
    index.ts        emit(), sink registry, flush()
    sinks/
      log.ts        → pino stdout
      mongo.ts      → MongoDB, batched (log-storage.md §3)
      memory.ts     → in-memory array, tests only
  error/
    index.ts        moduleError(), global onError → { code, message }, emits http.error
  mongo/
    index.ts        shared MongoDB client for the log store
```

## 3. Request ID and log context

- Read `x-request-id` if valid (≤ 64 chars, `[A-Za-z0-9_-]`); otherwise `crypto.randomUUID()`. Return it in the `x-request-id` response header.
- The `logger` plugin creates a per-request **log context** `{ requestId, module: "core" }` and a child logger `log` bound to it.
- `moduleScope` sets `module` (§4). The `auth` macro adds `userId`, and at access stage 2 `organizationId` ([access-stages.md §3](access-stages.md)).
- Every event emitted during the request gets the context merged in, so `module`, `requestId` and `userId` never need to be passed by hand.

## 4. Module tagging (DEC-037)

The API is a modular monolith, so the first question about any error is "which module?". The answer comes from the module itself, not from parsing the route.

```ts
// apps/api/src/modules/posts/index.ts (sketch)
export const posts = new Elysia({ name: 'posts', prefix: '/posts' })
  .use(moduleScope('posts'))     // first line of every controller
  .use(authPlugin)
  .get('/', ...)
```

- `moduleScope(name)` is a named plugin (`name: 'module-scope', seed: name`) with a **scoped** hook that runs before validation and sets `logContext.module = name` and rebinds `log` with it. It applies only to the routes of the controller that uses it.
- The module name equals the folder name in `src/modules/` and is checked at startup against the list of mounted modules (a typo fails startup).
- `module` values: a module name, `"auth"` (Better Auth handler, its hooks and logger), or `"core"` (unknown route, body parse failure before routing, root-app code, startup and shutdown).

**Errors thrown in services** use `moduleError` instead of a bare `status(...)`:

```ts
// sketch
throw moduleError('posts', 404, 'POST_NOT_FOUND', 'Post not found')
```

- The response is the normal `{ code, message }` with that status (DEC-017).
- `http.error` gets `sourceModule: "posts"`. When `PostService` is called from another module's route, `module` is the handling module and `sourceModule` the one that threw, so a cross-module failure is visible.
- Unexpected errors (database down, a bug) have no `sourceModule`; `module` from the scope still says where they happened.

`http.error` has **no route field**: errors are grouped by `module` + `code` (+ `sourceModule`). `http.request` keeps the route pattern for latency per endpoint.

## 5. Log line shape

Every line (and every stored document) has these top-level fields:

| Field | Values | Used for |
|:---|:---|:---|
| `level` | pino levels | filtering |
| `time` | ISO 8601 (BSON `Date` in MongoDB) | ordering, retention |
| `kind` | `http`, `app`, `error`, `audit`, `product` | retention class |
| `event` | catalogue name | querying |
| `service` | `api` | label |
| `env` | `NODE_ENV` | label |
| `module` | module name, `auth` or `core` | grouping errors and requests by module |
| `requestId` | inside a request | correlation |
| `userId` | when signed in | audit, erasure |
| `organizationId` | access stage 2 and SaaS only, inside organization-scoped routes ([access-stages.md](access-stages.md)) | per-organization queries, tenant purge |

Examples:

```json
{ "level": "info", "time": "2026-11-02T10:00:00.000Z", "kind": "http", "event": "http.request",
  "service": "api", "env": "production", "module": "posts", "requestId": "4f1c…",
  "method": "GET", "route": "/api/posts/:id", "status": 200, "durationMs": 12.4, "userId": "usr_…" }

{ "level": "error", "time": "2026-11-02T10:00:01.000Z", "kind": "error", "event": "http.error",
  "service": "api", "env": "production", "module": "posts", "sourceModule": "posts", "requestId": "9a2e…",
  "status": 500, "code": "INTERNAL_ERROR",
  "err": { "name": "PostgresError", "code": "57P01", "message": "terminating connection…", "stack": "…" } }
```

- `route` (in `http.request` only) is the route **pattern**, never the raw URL.
- Level: `info` below 400, `warn` for 4xx, `error` for 5xx. `/api/health` logs at `debug`.

## 6. Event catalogue

| Event | Kind | Payload (plus context fields) | Sinks |
|:---|:---|:---|:---|
| `http.request` | `http` | `method, route, status, durationMs` | log, mongo |
| `http.error` | `error` | `status, code, sourceModule?, err` ([redaction.md §3](redaction.md)) | log, mongo |
| `app.started` / `app.stopping` | `app` | `version, env` | log, mongo |
| `app.logs_pruned` | `app` | `kind, deleted, cutoff, dryRun` | log, mongo |
| `cache.fallback` | `app` | `reason` | log, mongo (warn) |
| `rbac.unknown_role` | `app` | `roles: { role, count }[]` | log, mongo (warn) |
| `telemetry.sink_failed` | `app` | `sink, event` | log only (warn), at most once per minute per sink |
| `telemetry.sink_dropped` | `app` | `sink, dropped` | log only (warn), at most once per minute |
| `audit.session.created` | `audit` | `sessionId, ip, userAgent` | log, mongo |
| `audit.session.revoked` | `audit` | `sessionId, actorId?` | log, mongo |
| `audit.user.role_changed` | `audit` | `from, to, actorId` | log, mongo |
| `audit.user.banned` / `audit.user.unbanned` | `audit` | `actorId, expiresAt?` | log, mongo |
| `audit.account.linked` | `audit` | `provider` | log, mongo |
| `audit.auth.sign_in_failed` | `audit` | `ip, reason` | log, mongo |
| `audit.auth.blocked_endpoint` | `audit` | `path, actorId?` | log, mongo |
| `auth.verification_link`, `auth.reset_link` | `app` | `url` | log only, **dev only**; registering them in production throws at startup |

Access stage 2 adds `access.*` and `audit.org.*` events ([access-stages.md §3.2](access-stages.md)); the SaaS layer adds its own ([saas/observability.md](../../../specs/eng/saas/observability.md)).

Audit events carry the affected `userId` in the context (the target user for admin actions). Calling `emit()` with an unknown name or a wrong payload is a TypeScript error.

## 7. `telemetry` contract (sketch)

```ts
export interface Sink {
  name: SinkName
  minLevel?: Level
  handle(line: LogLine): void            // already scrubbed, context merged
  flush?(timeoutMs: number): Promise<void>
  close?(): Promise<void>
}
export const telemetry = {
  emit<E extends keyof EventPayloads>(event: E, payload: EventPayloads[E], ctx?: Partial<LogContext>): void,
  flush(timeoutMs?: number): Promise<void>,
}
```

Rules:
1. `emit` **never throws** and is never awaited on the request path. A sink failure is caught and reported as `telemetry.sink_failed` (rate-limited, stdout only so it cannot loop).
2. The payload passes through the scrubber **before** any sink.
3. `flush(timeoutMs)` drains buffered sinks (the `mongo` buffer) during graceful shutdown; default 3 s. Flush is about buffers, not deleting old data ([log-storage.md §6](log-storage.md)).

## 8. Metrics without a metrics SDK

Latency (p50/p95), throughput and error rate per module are computed from `http.request` and `http.error` in MongoDB (aggregation pipelines, [log-storage.md §7](log-storage.md)). The NFR target (p95 < 50 ms on cache hits) is checked this way.

## 9. Out of scope (MVP)

Sentry, PostHog, Loki, ELK, frontend telemetry, distributed tracing, database/Redis spans, dashboards, a log viewer UI.

## 10. Acceptance criteria (TASK-12, TASK-15)

- [ ] Every request produces exactly one `http.request` whose `requestId` matches the response header and whose `module` is the module that owns the route.
- [ ] Every log line has `level`, `time`, `kind`, `event`, `service`, `env`, `module`.
- [ ] A 500 inside `posts` produces `http.error` with `module: "posts"`, the stack in the log, no route field, and a response body of only `{ code: "INTERNAL_ERROR", message }`.
- [ ] A `moduleError` thrown by `PostService` while handling another module's route has `module` = handling module and `sourceModule: "posts"`.
- [ ] Unknown route and malformed JSON body produce `module: "core"`; Better Auth errors produce `module: "auth"`.
- [ ] A controller without `moduleScope`, or with a name that is not a mounted module, fails startup.
- [ ] Every rule in [redaction.md §7](redaction.md) has a passing test.
- [ ] A sink that throws does not fail the request and produces at most one `telemetry.sink_failed` per minute.
- [ ] The audit events in §6 appear on sign-in, sign-out, role change, ban, Google linking and blocked endpoints.
- [ ] SIGTERM calls `telemetry.flush()` before the process exits.
- [ ] MongoDB criteria in [log-storage.md §8](log-storage.md).
