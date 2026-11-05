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

## 1. Overview

```
app code ──► telemetry.emit('cache.fallback', { reason }, ctx)     ctx = { requestId, module, userId }
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
    context.ts      the per-request log context in an AsyncLocalStorage: getLogContext(), getRequestContext()
    auth.ts         authLogger / createAuthLogger(): adapter for Better Auth's `logger` option, through the scrubber, `module: "auth"`
    plugin.ts       named plugin 'logger' (as: 'global'): request ID, log context, http.request
    module.ts       moduleScope(name): tags the log context with the module; mountModule(controller): startup check (§4)
  telemetry/
    types.ts        Level, Kind, SinkName, LogLine, Sink
    events.ts       typed event catalogue (name → payload type → kind → sinks)
    retention.ts    retention days per kind (log-storage.md §5)
    scrub.ts        the scrubber and the error serializer (redaction.md §4)
    index.ts        createTelemetry(), the `telemetry` instance: emit(), sink registry, flush()
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
- The `logger` plugin wraps the whole request (Elysia's `wrap`, so it also covers unknown routes, parse failures and the error handler) in an `AsyncLocalStorage` holding the per-request **log context** `{ requestId, module: "core" }`. Services and Better Auth hooks run inside it, so they never receive the HTTP context to find their request.
- `log` in the Elysia context is the shared pino `logger`. Its `mixin` reads the log context when a line is written, so every `log.*` or `logger.*` call inside a request carries `module`, `requestId` and `userId` with no child logger to rebind.
- `moduleScope` sets `module` (§4). The `auth` macro adds `userId` (`getRequestContext().userId = …`).
- Every event emitted during the request gets the context merged in, so `module`, `requestId` and `userId` never need to be passed by hand. `emit()`'s optional third argument overrides them, e.g. `{ userId }` for the target of an admin action.
- Outside a request (startup, shutdown, scripts) the context is just `{ module: "core" }`.
- `onAfterResponse` runs with `setImmediate` after the response is built, so `http.request` is written just after the response is sent.

## 4. Module tagging (DEC-037)

The API is a modular monolith, so the first question about any error is "which module?". The answer comes from the module itself, not from parsing the route.

```ts
// apps/api/src/modules/posts/index.ts (sketch)
export const posts = new Elysia({ name: 'posts', prefix: '/posts' })
  .use(moduleScope('posts'))     // first line of every controller
  .use(authPlugin)
  .get('/', ...)
```

- `moduleScope(name)` is a named plugin (`name: 'module-scope', seed: name`) with a **scoped** `onTransform` hook that runs before validation and sets `module = name` in the log context. It applies only to the routes of the controller that uses it.
- The module name equals the folder name in `src/modules/` and is checked at startup: the root app mounts each controller with `.use(mountModule(posts))`, which throws when the controller is unnamed, has no `moduleScope`, or declares a name different from its own (a typo, or a name copied from another module). It returns the controller unchanged, so Eden keeps its types.
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

- `route` (in `http.request` only) is the route **pattern**, never the raw URL. A trailing slash is dropped (`/api/posts/`, which Elysia registers for `GET /` of a prefixed module, is logged as `/api/posts`). A request that matched no route is logged with the fixed label `[unmatched]`, because the raw path can carry secrets.
- Level: `info` below 400, `warn` for 4xx, `error` for 5xx. Requests handled by the `health` module log at `debug` (`/api/health`, whatever the status).
- `status` of `http.request` is the status of the response actually sent, including a `Response` returned directly by a handler such as Better Auth's.
- Lines written with `log.*` instead of an event carry `kind: "app"` and `event: "log"` by default, so every stdout line has the fields above.
- A stdout line that carries `err` also has pino's `msg`, the scrubbed `err.message`. The log store documents do not have it.

## 6. Event catalogue

| Event | Kind | Payload (plus context fields) | Sinks |
|:---|:---|:---|:---|
| `http.request` | `http` | `method, route, status, durationMs` | log, mongo |
| `http.error` | `error` | `status, code, sourceModule?, fields?, err` ([redaction.md §3](redaction.md)). `fields` is `{ path, rule }[]`, only for a validation failure | log, mongo |
| `app.started` / `app.stopping` | `app` | `version, env` | log, mongo |
| `app.logs_pruned` | `app` | `prunedKind, deleted, cutoff, dryRun`, or `prunedKind: "all", deleted, erasedUserId, dryRun` for `--user`. Not `kind` / `userId`, which are base fields | log, mongo |
| `cache.fallback` | `app` | `reason` | log, mongo (warn) |
| `cache.invalidation_failed` | `app` | `cacheModule, stage, err`. `stage` is `generation` (cached reads may be stale until the TTL) or `pages` (reads are fresh). Not `module`, the context field: a user removal clears the posts cache from an auth request | log, mongo (warn) |
| `rbac.unknown_role` | `app` | `roles: { role, count }[]` | log, mongo (warn) |
| `telemetry.sink_failed` | `app` | `sink, failedEvent, dropped?` (not `event`, which is the top-level field of every line, §5); `dropped` is set by buffered sinks: documents lost since the last report | log only (warn), at most once per minute per sink |
| `telemetry.sink_dropped` | `app` | `sink, dropped` | log only (warn), at most once per minute |
| `audit.session.created` | `audit` | `sessionId, ip, userAgent` | log, mongo |
| `audit.session.revoked` | `audit` | `sessionId, actorId?` | log, mongo |
| `audit.user.role_changed` | `audit` | `from, to, actorId` | log, mongo |
| `audit.user.banned` / `audit.user.unbanned` | `audit` | `actorId, expiresAt?`; `unbanned` has no `actorId` when Better Auth lifts an expired ban during sign-in, and no `expiresAt` | log, mongo |
| `audit.account.linked` | `audit` | `provider` | log, mongo |
| `audit.auth.sign_in_failed` | `audit` | `ip, reason` | log, mongo |
| `audit.auth.blocked_endpoint` | `audit` | `path, actorId?` | log, mongo |
| `audit.csrf.rejected` | `audit` | `method, reason` (`cross-site`, `same-site`, `foreign-origin`, `missing-origin`); level `warn`, never a header, cookie or URL | log, mongo |
| `auth.verification_link`, `auth.reset_link` | `app` | `url` | log only, **dev only**; registering them in production throws at startup |

Audit events carry the affected `userId` in the context (the target user for admin actions). Calling `emit()` with an unknown name or a wrong payload is a TypeScript error.

## 7. `telemetry` contract (sketch)

```ts
export interface Sink {
  name: SinkName
  minLevel?: Level
  handle(line: LogLine): void            // already scrubbed, context merged
  flush?(timeoutMs: number): Promise<number | void>  // events still unwritten at the timeout; none or 0 = none
  dropped?(): number                     // events given up on since creation (failed writes, evictions); never decreases
  close?(): Promise<void>
}
export const telemetry = {
  emit<E extends keyof EventPayloads>(event: E, payload: EventPayloads[E], ctx?: Partial<LogContext>): void,
  checkpoint(): TelemetryCheckpoint,     // each sink's dropped() now; a later flush counts losses from here
  flush(timeoutMs?: number, since?: TelemetryCheckpoint): Promise<'flushed' | 'incomplete' | 'timed_out'>,  // never rejects
  close(): Promise<void>,                // stops the sinks' timers, after flush
  addSink(sink: Sink): () => void,       // returns a function that removes it; tests attach the memory sink this way
}
```

`createTelemetry({ env, sinks, catalogue?, now? })` builds an instance; `telemetry` is the one the app uses, with the `log` sink. The `memory` sink receives every event whatever its catalogue entry says. `auth.verification_link` and `auth.reset_link` live in a separate `devEventCatalogue`, registered only when `env` is `development`; `createTelemetry` throws if a production catalogue contains them.

Rules:
1. `emit` **never throws** and is never awaited on the request path. A sink failure is caught and reported as `telemetry.sink_failed` (rate-limited, stdout only so it cannot loop).
2. The payload passes through the scrubber **before** any sink.
3. `flush(timeoutMs)` drains buffered sinks (the `mongo` buffer) during graceful shutdown; default 3 s. Flush is about buffers, not deleting old data ([log-storage.md §6](log-storage.md)). It resolves to `flushed` when every sink wrote everything and dropped nothing since `since` (or since the flush began, without it), `incomplete` when a sink threw or rejected (synchronously too, without skipping the other sinks), reported unwritten events or dropped some, and `timed_out` when a sink was still flushing at the timeout. Shutdown takes a `checkpoint()` before emitting `app.stopping` and passes it to `flush`, so an event lost while requests drain (a failed write and its retry, or an eviction) fails the shutdown even when MongoDB has recovered by the time of the flush. Shutdown treats anything but `flushed` as a failure.

## 8. Metrics without a metrics SDK

Latency (p50/p95), throughput and error rate per module are computed from `http.request` and `http.error` in MongoDB (aggregation pipelines, [log-storage.md §7](log-storage.md)). The NFR target (p95 < 50 ms on cache hits) is checked this way.

## 9. Out of scope (MVP)

Sentry, PostHog, Loki, ELK, frontend telemetry, distributed tracing, database/Redis spans, dashboards, a log viewer UI.

## 10. Acceptance criteria

Each item has a test in `apps/api/tests/` ([TESTING.md](../TESTING.md)).

- [ ] Every request produces exactly one `http.request` whose `requestId` matches the response header and whose `module` is the module that owns the route.
- [ ] Every log line has `level`, `time`, `kind`, `event`, `service`, `env`, `module`.
- [ ] A 500 inside `posts` produces `http.error` with `module: "posts"`, the stack in the log, no route field, and a response body of only `{ code: "INTERNAL_ERROR", message }`.
- [ ] A `moduleError` thrown by `PostService` while handling another module's route has `module` = handling module and `sourceModule: "posts"`.
- [ ] An unknown route and a malformed JSON body produce `module: "core"`. Every `/api/auth/*` request, Better Auth's own 4xx/5xx responses included, is logged with `module: "auth"` and route `/api/auth/*`, and Better Auth's own log output goes through `authLogger` with `module: "auth"` (`tests/utils/auth/routes.test.ts`, `tests/utils/auth/logger.test.ts`).
- [ ] A controller without `moduleScope`, or with a name that is not a mounted module, fails startup.
- [ ] Every rule in [redaction.md §7](redaction.md) has a passing test.
- [ ] A sink that throws does not fail the request and produces at most one `telemetry.sink_failed` per minute.
- [ ] The audit events in §6 appear on sign-in, sign-out, failed sign-in, role change, ban and unban, admin session revocation, Google linking and blocked endpoints (`tests/utils/auth/routes.test.ts`; Google linking in `tests/utils/auth/google.test.ts` with Google's token endpoint mocked).
- [ ] SIGTERM and SIGINT run `app.stopping` → drain → `telemetry.flush()` → `telemetry.close()` → close the clients, in that order (`installShutdown()` in `utils/lifecycle`; `tests/utils/lifecycle/`).
- [ ] MongoDB criteria in [log-storage.md §8](log-storage.md).
