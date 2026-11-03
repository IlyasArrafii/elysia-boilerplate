# Redaction

Sensitive data is never written to logs, stored in the log database or sent to a vendor (DEC-027). This document is the policy, the mechanism and the tests. It applies to stdout lines, MongoDB documents, telemetry events, error reports and vendor payloads.

## 1. Data classes

| Class | Examples | Rule |
|:---|:---|:---|
| **Secret** | passwords and hashes, session tokens, cookies, `Authorization` headers, API keys, OAuth access/refresh/ID tokens, OAuth `code` and `state`, verification and reset tokens or links, `BETTER_AUTH_SECRET`, connection strings with passwords (`DATABASE_URL`, `LOG_MONGO_URL`) | **Never** logged or stored, in any environment (dev-only link events in §6 are the one exception, stdout only, dev only) |
| **Personal data (PII)** | email, name, avatar URL, phone, ban reason text, free-text user input | Never logged. Use `userId` |
| **Customer data** (access stage 2 and SaaS) | organization name, slug and logo, invitation email | Never logged. Use `organizationId` / `invitationId` |
| **Content** | request and response bodies, post title/content, form data | Never logged |
| **Network identifiers** | IP address, user agent | Only in `audit.*` events (security purpose); never in `http.*` |
| **Safe** | IDs (`userId`, `postId`, `sessionId`, `organizationId`, `roleId`), module name, route pattern, method, status, duration, error code, role names (code and runtime), provider names, flag keys | Can be logged |

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

Exceptions kept as-is: the top-level `code` of `http.error` (`UPPER_SNAKE_CASE`), `err.code` (SQLSTATE or driver code), `err.name` (error class name), and `url` in the dev-only link events (§6).

**Value rule.** Every string (including `err.message`) is checked against these patterns; the match becomes `[REDACTED:<type>]`:

| Type | Pattern (sketch) |
|:---|:---|
| `email` | `[^\s@]+@[^\s@]+\.[^\s@]+` |
| `jwt` | `eyJ[\w-]+\.[\w-]+\.[\w-]+` |
| `bearer` | `Bearer\s+\S+` |
| `url-secret` | `([?&](token\|code\|state\|key\|secret\|password)=)[^&\s]+` |
| `dsn` | `\w+(\+\w+)?://[^:\s]+:[^@\s]+@` (credentials in connection strings, including `mongodb+srv://`) |

**Limits.** Depth 6, 100 keys per object, strings truncated to 2 000 characters; beyond that `"[TRUNCATED]"`. The scrubber never throws; on an internal error the payload becomes `{ "scrubFailed": true }`.

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
  base: { service: 'api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
})
```

pino `redact` matches exact paths only, which is why the scrubber exists. Never rely on `redact` alone.

## 6. Special cases

| Case | Rule |
|:---|:---|
| `auth.verification_link`, `auth.reset_link` | Contain a secret link. Only when `NODE_ENV=development`, stdout only (never the `mongo` sink). Registering them in production throws at startup. |
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
- [ ] Better Auth's own logger output → goes through the scrubber.
- [ ] `auth.verification_link` in production config → startup fails; in dev it never reaches MongoDB.
- [ ] Vendor sinks, when built: the captured outgoing payload has no Secret or PII data.

## 8. Right to erasure

Logs are keyed by `userId`, not personal data, so deleting an account removes the link between the ID and the person. Retention deletes the lines themselves ([log-storage.md §5](log-storage.md)). If a deployment must also delete a user's log documents on request, the prune command supports `--user <userId>` ([log-storage.md §5.3](log-storage.md)). Whether this meets a deployment's legal requirements is the deploying team's call.
