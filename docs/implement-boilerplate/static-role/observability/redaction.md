# Redaction

Sensitive data is never written to logs, stored in the log database or sent to a vendor (DEC-027). This document is the policy, the mechanism and the tests. It applies to stdout lines, MongoDB documents, telemetry events, error reports and vendor payloads.

## 1. Data classes

| Class | Examples | Rule |
|:---|:---|:---|
| **Secret** | passwords and hashes, session tokens, cookies, `Authorization` headers, API keys, OAuth access/refresh/ID tokens, OAuth `code` and `state`, verification and reset tokens or links, `BETTER_AUTH_SECRET`, connection strings with passwords (`DATABASE_URL`, `LOG_MONGO_URL`) | **Never** logged or stored, in any environment (dev-only link events in §6 are the one exception, stdout only, dev only) |
| **Personal data (PII)** | email, name, avatar URL, phone, ban reason text, free-text user input | Never logged. Use `userId` |
| **Content** | request and response bodies, post title/content, form data | Never logged |
| **Network identifiers** | IP address, user agent | Only in `audit.*` events (security purpose); never in `http.*` |
| **Safe** | IDs (`userId`, `postId`, `sessionId`), module name, route pattern, method, status, duration, error code, role names (code and runtime), provider names, flag keys | Can be logged |

When in doubt, the field is not logged. Adding a field to any event is reviewed against this table.

## 2. Layers

| # | Layer | Where | Catches |
|:---|:---|:---|:---|
| 1 | **Typed payloads** | `utils/telemetry/events.ts` | Design: payload types only have safe fields; review rejects `email`, `name`, `body`, `url` fields |
| 2 | **Scrubber** | `utils/telemetry/scrub.ts`, inside `emit()` before any sink | Mistakes: sensitive keys or value patterns that slipped in |
| 3 | **pino `redact`** | `utils/logger/index.ts` | Direct `log.*` calls that bypass telemetry |
| 4 | **Vendor scrubbing** | Sentry `beforeSend`, PostHog property allowlist (when adopted) | What SDKs collect on their own ([sentry.md](sentry.md), [posthog.md](posthog.md)) |

The `mongo` sink receives only scrubbed lines (layer 2), so the log database never holds what stdout would not.

## 3. Never logged at all

- **Raw URLs and query strings.** Log the route pattern (`/api/posts/:id`). OAuth callbacks carry `code` and `state`; reset links carry tokens.
- **Request and response bodies**, on success or failure. Validation errors log **field paths and rule names** only.
- **Headers**, except `user-agent` (audit only), `x-request-id`, `content-type`, `content-length`.
- **Library error messages as-is.** Postgres errors put values in `detail` (`Key (email)=(a@b.com) already exists`); Drizzle errors can include query parameters; MongoDB driver errors can include the connection string. The error serializer keeps `name`, `code`, `constraint`, `table`, `column` and the stack, drops `detail`, `params`, `query`, `where`, `keyValue`, and keeps `message` only after the value patterns run, truncated to 500 characters.
- **Better Auth internals.** Its `logger` is routed through the scrubber.

## 4. The scrubber

Runs on every payload, recursively, before sinks. Pure function, unit-tested.

**Key rule.** Any key matching this list (case-insensitive, nested objects and arrays too) has its value replaced with `"[REDACTED]"`:

```
password, passwd, pwd, secret, token, accessToken, refreshToken, idToken, apiKey, api_key,
authorization, cookie, set-cookie, session_token, sessionToken, code, state, otp, email,
name, firstName, lastName, phone, address, banReason, reason_text, body, content, url, keyValue
```

Keys are compared after lower-casing and dropping `_` and `-`, so `access_token`, `accessToken` and `Set-Cookie` all match their entry. The match is on the whole key, not a part of it.

Exceptions kept as-is: the top-level `code` of `http.error` (`UPPER_SNAKE_CASE`), `err.code` (SQLSTATE or driver code), `err.name` (error class name), and `url` in the dev-only link events (§6). "As-is" means neither the key rule nor the value rule touches them, so a dev link keeps its `?token=`. They are paths in the event catalogue's `keep` list (`code` for `http.error`, `url` for the link events); `err.code` and `err.name` are kept for every event.

**Value rule.** Every string (including `err.message`) is checked against these patterns; the match becomes `[REDACTED:<type>]`:

| Type | Pattern (sketch) |
|:---|:---|
| `bearer` | `Bearer\s+\S+` (case-insensitive) |
| `jwt` | `eyJ[\w-]+\.[\w-]+\.[\w-]+` |
| `url-secret` | `[?&](token\|code\|state\|key\|secret\|password)=[^&\s]+` (case-insensitive) |
| `dsn` | `\w+(\+\w+)?://[^:\s]+:[^@\s]+@` (credentials in connection strings, including `mongodb+srv://`) |
| `email` | `[^\s@]+@[^\s@]+\.[^\s@]+` |

The patterns run in the order listed, so a bearer token or connection string is labelled as such before the narrower patterns see it. The whole match is replaced, including `?token=` for `url-secret` and the `scheme://user:password@` part for `dsn`.

**Limits.** Depth 6, 100 keys per object, strings truncated to 2 000 characters; beyond that `"[TRUNCATED]"`. The scrubber never throws; on an internal error the payload becomes `{ "scrubFailed": true }`.

How the limits are applied: a value deeper than 6 levels becomes `"[TRUNCATED]"`; an object keeps its first 100 keys plus a `"[TRUNCATED]": true` key, and an array its first 100 items plus a `"[TRUNCATED]"` item; a string over 2 000 characters is cut and gets `[TRUNCATED]` appended. The value patterns run before the cut, on the first 2 256 characters, so a secret that straddles the cut is replaced rather than left half-visible. `undefined`, functions and symbols are dropped, `bigint` becomes a string, a `Date` an ISO string, an `Error` its serialized form (§3).

`serializeError` (the same file) is the error serializer of §3. It keeps `name`, `code`, `constraint`, `table`, `column`, `message` (patterns first, then 500 characters) and `stack` (patterns first, then 2 000 characters), and drops everything else, including `cause`. `http.error` builds `err` from it only for `moduleError` and unexpected errors. For validation failures, parse failures and unknown routes `err` is just `{ name }`: Elysia's validation message and `found` echo the submitted values and a parser message can quote the body. A validation failure logs `fields`, the paths and rule names, instead.

## 5. pino configuration

```ts
// sketch
pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      '*.password', '*.token', '*.secret', '*.email', '*.accessToken', '*.refreshToken', '*.idToken',
    ],
    censor: '[REDACTED]',
  },
  base: null,                  // service, env and time come from the mixin instead
  timestamp: false,
  serializers: { err: serializeError },
  hooks: { logMethod: … },     // scrubs the message pino writes (below)
})
```

pino `redact` matches exact paths only, which is why the scrubber exists. Never rely on `redact` alone.

`base` is not used: pino writes it before the fields of the call, so an event line that carries `service` and `env` would repeat both keys. The mixin supplies `time`, `service`, `env`, `kind`, `event`, `module`, `requestId` and `userId` as defaults and the fields of the call win.

pino fills `msg` from `err.message` itself, on the raw error and before any serializer, and writes a string message as given. Neither passes through `redact` or the `err` serializer, so the `logMethod` hook runs the value patterns over the message (a string argument, the string next to an object, or the `err.message` pino would take). Format arguments (`log.info('user %s', value)`) are not scrubbed: do not pass personal data as one.

## 6. Special cases

| Case | Rule |
|:---|:---|
| `auth.verification_link`, `auth.reset_link` | Contain a secret link. Only when `NODE_ENV=development`, stdout only (never the `mongo` sink). Registering them in production throws at startup. They are the `devEventCatalogue` in `events.ts`: `createTelemetry` registers it only for `development`, drops them silently in `test` and `production`, and throws if a production catalogue passed to it contains them. |
| `audit.session.created` | Keeps `ip` and `userAgent` for security investigations; retained 365 days as `audit`. |
| `audit.auth.sign_in_failed` | `ip` and a reason code only. Never the attempted email. |
| Ban reason | Stored by Better Auth in PostgreSQL; never in an event. |
| Feature flag evaluation context | Only `targetingKey` (user ID) ([feature-flags/targeting.md](../feature-flags/targeting.md)). |

## 7. Required tests

Folder: `apps/api/tests/utils/telemetry/` ([TESTING.md](../TESTING.md)). Each test sends the sensitive value through the real path and asserts it is absent from the captured output (memory sink, a pino stream to a buffer, and documents written by the `mongo` sink against the test MongoDB):

- [ ] `Cookie` and `Authorization` headers → neither value appears.
- [ ] Sign-up and sign-in bodies → password and email never appear, including on validation failure.
- [ ] OAuth callback with `code` and `state` → neither appears; `route` is the pattern.
- [ ] Postgres unique violation on an email column → the email never appears; `constraint` does.
- [ ] MongoDB driver error containing a connection string → credentials replaced.
- [ ] `emit()` with a nested `{ user: { email } }` → `[REDACTED]`.
- [ ] `err.message` with an email, a JWT and a `?token=` URL → all three replaced.
- [ ] Better Auth's own logger output → goes through the scrubber (`authLogger` in `utils/logger/auth.ts`, passed as `logger` to Better Auth). `tests/utils/telemetry/auth-logger.test.ts` covers the adapter, and `tests/utils/auth/logger.test.ts` drives a real Better Auth line (`Sign-up attempt for existing email: …`) through it, asserting `[REDACTED:email]` and `module: "auth"`.
- [ ] `auth.verification_link` in production config → startup fails; in dev it never reaches MongoDB.
- [ ] Vendor sinks, when built: the captured outgoing payload has no Secret or PII data.

## 8. Right to erasure

Logs are keyed by `userId`, not personal data, so deleting an account removes the link between the ID and the person. Retention deletes the lines themselves ([log-storage.md §5](log-storage.md)). If a deployment must also delete a user's log documents on request, the prune command supports `--user <userId>` ([log-storage.md §5.3](log-storage.md)). Whether this meets a deployment's legal requirements is the deploying team's call.
