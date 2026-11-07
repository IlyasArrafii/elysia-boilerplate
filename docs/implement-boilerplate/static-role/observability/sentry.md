# Sentry: Error Tracking (design only)

> **Status: design only (DEC-036).** The baseline is the manual log (stdout + MongoDB). This document is the build and migration plan for adding Sentry. Building it needs a new decision entry. Package names and APIs were checked in 2026-11; *verify* them at build time.

## 1. What Sentry adds, and what it doesn't

| Sentry gives | Still from the manual log |
|:---|:---|
| Errors grouped and deduplicated, per release | Every request line, audit trail, latency |
| Stack traces with source context | Retention and erasure (log-storage.md) |
| Alerts (new issue, regression, spike) | Errors below 500 |

Adopt when the team needs grouping and alerting on 5xx errors faster than querying `log_event`. Sentry is a **sink next to** the manual log, not a replacement: every error still goes to stdout and MongoDB.

## 2. Package choice

| Package | State (2026-11) | Use? |
|:---|:---|:---|
| `@sentry/bun` | Official Bun SDK | **Yes**, manual capture from the sink |
| `@sentry/elysia` | Official, **alpha**; wraps the app with `Sentry.withElysia(app)` and traces lifecycle phases | No: alpha, and wrapping the app puts the SDK outside `sinks/` (breaks DEC-014). Revisit when stable if tracing is wanted |

## 3. Configuration

| Env | Required | Notes |
|:---|:---|:---|
| `SENTRY_DSN` | to enable | Unset = sink not registered, SDK never imported |
| `SENTRY_ENVIRONMENT` | no | Defaults to `NODE_ENV` |
| `APP_VERSION` | no | Sent as `release` |

```ts
// apps/api/src/utils/telemetry/sinks/sentry.ts (sketch)
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
  release: env.APP_VERSION,
  tracesSampleRate: 0,          // errors only
  sendDefaultPii: false,        // no IP, cookies or headers
  defaultIntegrations: false,   // *verify*; add back only what is needed (e.g. linked errors)
  beforeSend(event) {
    delete event.request?.cookies
    delete event.request?.headers
    delete event.request?.data
    delete event.request?.query_string
    delete event.request?.url
    if (event.user) event.user = { id: event.user.id }
    return event
  },
})
```

## 4. What it captures

| Event | Sent? | How |
|:---|:---|:---|
| `http.error` with status ≥ 500 | yes | The sink gets the scrubbed line, so `err` is a `SerializedError` (`name`, `code`, `constraint`, `table`, `column`, `message`, `stack`, already scrubbed: [redaction.md §4](redaction.md)), not an `Error`. Rebuild an `Error` from its `name`, `message` and `stack`, then `Sentry.captureException(error, { tags: { module, sourceModule, code, requestId }, user: { id: userId } })` (*verify* how the SDK reads a copied `stack`) |
| `http.error` with status < 500 | no | Expected client errors are noise |
| Everything else | no | |

- Grouping fingerprint: `['{{ default }}', module]`, so the same bug in two modules is two issues.
- `module` is the main tag for Sentry alert rules ("new issue in `posts`").
- `flush(timeoutMs)` calls `Sentry.flush(timeoutMs)`.

## 5. Implementation steps

1. Decision entry adopting Sentry (refines DEC-036).
2. `bun add @sentry/bun` in `apps/api`.
3. Write `sinks/sentry.ts` per §3–§4, registered with a dynamic `import()` only when `SENTRY_DSN` is set.
4. Add `'sentry'` to `SinkName` (`types.ts`) and, in `events.ts`, to the `sinks` of `http.error` only.
5. Add `SENTRY_*` to `env.ts` validation (optional variables) and `.env.example`.
6. Tests in `apps/api/tests/utils/telemetry/sentry.test.ts` with a test transport (§7).
7. Deploy to staging with a DSN for a staging project; trigger a test 500; check tags and scrubbing in Sentry.
8. Configure alert rules per module in Sentry.
9. Deploy to production.
10. Update the docs in this folder in the same change (DEC-053): this file's status, DECISIONS, the ARCHITECTURE environment table and the event catalogue in [README.md §6](README.md). Never edit `docs/specs/`, the frozen design baseline (DEC-052).

## 6. Removing it

Unset `SENTRY_DSN` (sink stops at once), then remove the sink file, the `'sentry'` entries in `events.ts` and the package. The manual log is unaffected.

## 7. Acceptance criteria

- [ ] Without `SENTRY_DSN`, `@sentry/bun` is never loaded (asserted by test).
- [ ] A thrown error in a route arrives in Sentry once, tagged with `module`, `code` and `requestId`.
- [ ] 4xx responses never reach Sentry.
- [ ] The outgoing payload (test transport) has no cookies, headers, body, URL, query string, email or IP.
- [ ] The same error still appears in stdout and MongoDB.
- [ ] SIGTERM flushes pending events within 3 s.
