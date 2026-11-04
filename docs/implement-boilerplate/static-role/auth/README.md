# Authentication

Better Auth configuration, following the `better-auth-best-practices` and `better-auth-security-best-practices` skills (DEC-007, DEC-019, DEC-020, DEC-032). Roles and permissions depend on the project's access stage ([access/README.md](access/README.md)); the default is stage 1, [static-roles.md](access/static-roles.md). This file describes the default; stages 2 and 3 add the organization plugin ([access/single-org.md](access/single-org.md)).

Options marked *verify* must be checked against the docs for the installed Better Auth version (resolve it from the lockfile, then read the matching docs version).

## 1. Where the code lives

| File | Content |
|:---|:---|
| `packages/auth/src/server.ts` | `createAuth({ db, secret, baseURL, trustedOrigins, google?, secondaryStorage, ac, roles, defaultRole, hooks, databaseHooks, logger, onVerificationLink?, onResetLink? })` returns `betterAuth({...})`. The only place Better Auth options are written. The package reads no env: the API passes every value (TASK-04). |
| `packages/auth/src/client.ts` | `createAuthClient` with `adminClient()`. No `ac`/`roles` on the client (DEC-023). Not created yet: the web app's only client is `apps/web/src/lib/auth-client.ts`, with no plugins; the admin client arrives with the admin UI (TASK-17) (TASK-09). |
| `apps/api/src/utils/auth/auth.ts` | `export const auth = createAuth({...})`. The file the Better Auth CLI reads (`--config`). |
| `apps/api/src/utils/auth/roles.ts` | Role registry ([static-roles.md §2](access/static-roles.md)). |
| `apps/api/src/utils/auth/access.ts` | Builds `ac` and `roles` from module `permissions.ts` files ([static-roles.md §4](access/static-roles.md)). |
| `apps/api/src/utils/auth/hooks.ts` | `hooks.before` guard rules ([static-roles.md §7](access/static-roles.md)). |
| `apps/api/src/utils/auth/audit.ts` | `databaseHooks` and `hooks.after` that emit `audit.*` events (§6). |
| `apps/api/src/utils/auth/permissions.ts` | `defineModulePermissions`, `mergeStatements`, `mergeGrants` and the `Permission` type helpers (TASK-04). |
| `apps/api/src/utils/auth/storage.ts` | `secondaryStorage` adapter on the raw `cacheStore` (§2, TASK-04). |
| `apps/api/src/utils/auth/unknown-roles.ts` | Startup count of users whose role is outside the registry → `rbac.unknown_role` (TASK-04). |
| `apps/api/src/utils/db/index.ts` | The API's single PostgreSQL pool `db` (`createDb(env.DATABASE_URL)`) and `closeDb()`, shared by the Drizzle adapter and module services (TASK-04). |
| `apps/api/src/utils/auth/index.ts` | Named plugin `auth` (`authPlugin`): mounts the handler (log context `module: "auth"`) and uses `authGuard`; re-exports the macros (TASK-05). |
| `apps/api/src/utils/auth/macros.ts` | Named plugin `auth-guard` (`authGuard`) with the `auth` and `permission` macros, and `assertRouteAccess` / `PUBLIC_ROUTES` (default deny). Modules `.use(authGuard)`, never `authPlugin`: using that inside a module would mount `/auth/*` again under the module's prefix (TASK-05). |

Import plugins from their own paths (`better-auth/plugins/admin`, `better-auth/plugins/access`) so unused plugins are not bundled.

## 2. Configuration baseline

| Area | Value | Why |
|:---|:---|:---|
| `secret` | From `BETTER_AUTH_SECRET` only, ≥ 32 chars, high entropy, never committed. `env.ts` and `createAuth` both refuse a shorter one; only `NODE_ENV=test` falls back to a fixed test value (TASK-04) | Better Auth rejects placeholder secrets in production |
| `baseURL` | From `BETTER_AUTH_URL` = public web origin, HTTPS in production | Same origin (DEC-020) |
| `basePath` | `/api/auth` (default) | Matches the `/api` prefix (DEC-006) |
| `trustedOrigins` | `[WEB_URL]`, no wildcards | `callbackURL` and redirects outside it get 403 |
| CSRF | `advanced.disableCSRFCheck: false` (default); `disableOriginCheck` never set | Keep both checks |
| Cookies | Defaults: `httpOnly`, `secure` on HTTPS, `sameSite: "lax"`; `advanced.cookiePrefix: "app"` (neutral; the default `better-auth` names the library, DEC-040); `crossSubDomainCookies` **off** | One origin, no sharing |
| Client IP | `advanced.ipAddress.ipAddressHeaders: ["x-forwarded-for"]`, `ipv6Subnet: 64`. With `trustedProxies` unset, 1.7.15 trusts only a single-value header, so the proxy must set `x-forwarded-for` to the client IP alone (TASK-04) | API always sits behind the proxy; rate limits need the real IP |
| Email/password | `emailAndPassword.enabled: true`, default minimum length (8) | |
| Email verification | `sendVerificationEmail` emits `auth.verification_link` in dev only; a real sender must replace it before `requireEmailVerification` is turned on (`TBD`). Outside development the callback is not configured at all (TASK-04) | No email sender in the MVP |
| Password reset | `sendResetPassword` emits `auth.reset_link` in dev only; outside development the flow is off (TASK-04) | |
| Verification tokens | `verification.storeInDatabase: true`: kept in PostgreSQL as well as Redis. Without it 1.7.15 drops the `verification` table from the generated schema once `secondaryStorage` is set (TASK-04) | The table is part of [DATABASE.md](../DATABASE.md); a Redis flush must not void links already sent |
| Google | `socialProviders.google` from env; PKCE (`S256`) and state are automatic; `account.storeStateStrategy: "cookie"` (default; cookie `app.oauth_state`). Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` the provider is not configured, which only development and test allow (TASK-04) | |
| Account linking | `account.accountLinking.enabled: true`, `trustedProviders: ["google"]`. Better Auth 1.7.15 also requires the **local** row to have `emailVerified: true` (`requireLocalEmailVerified`, default on, left on): Google never links into an unverified password account and redirects with `error=` instead (TASK-04) | Verified Google email links to the existing password account; a pre-registered unverified account cannot capture it |
| OAuth tokens | `account.encryptOAuthTokens: true` | AES-256-GCM at rest |
| Session | `expiresIn` 7 days, `updateAge` 1 day, `freshAge` 1 hour | Sensitive actions need a fresh session |
| Cookie cache | **off** | A cookie cache delays revocation and bans |
| Secondary storage | Redis (DEC-019) with `session.storeSessionInDatabase: true`, through `createSecondaryStorage(cacheStore)`: string values as Better Auth wrote them, TTL per call (a TTL of 0 deletes, a missing one is capped at the session lifetime), keys under `auth:` (so `auth` is a reserved cache module name), errors propagate. Rate limiting needs an atomic `increment` and verification a `getAndDelete`, so `CacheStore` gained both (Lua `INCR`+`EXPIRE` and `GETDEL`, through `Redis.command`) (TASK-04). **Sessions are not kept in Redis** (DEC-054, Proposed): the adapter drops session entries (`<token>` → `{session, user}`, and `active-sessions-<userId>`) on write and ignores them on read, so Better Auth reads every session from PostgreSQL. Redis keeps rate-limit counters and the verification copies (TASK-04) | Admin can list and revoke sessions; a revoked or banned session stops working at once, with no race against Better Auth's non-atomic Redis session lists; Redis down fails the request instead of looking not rate limited |
| Rate limit | `enabled: true`, `storage: "secondary-storage"`; `customRules`: sign-in email 5 / 60 s, sign-up email 3 / 60 s. Rule keys are paths **without** the base path: `/sign-in/email`, `/sign-up/email` (TASK-04). Counted per client IP and path; the sixth sign-in in 60 s answers 429 with `X-Retry-After: 60` (TASK-04) | Better Auth strips `/api/auth` before matching `customRules` |
| Logger | Better Auth `logger` routed through the telemetry scrubber into pino with `module: "auth"`: `log` calls `authLogger.log` (`utils/logger/auth.ts`), whose `log(level, message, ...args)` matches the installed 1.7.15 type (`level` is `debug`/`info`/`warn`/`error`). Its `level` follows `LOG_LEVEL`; `silent` disables it. Checked on a real line: 1.7.15 logs `Sign-up attempt for existing email: <email>` at info, which reaches pino as `[REDACTED:email]` (TASK-04) | Its log lines must not bypass redaction |
| Admin plugin | `admin({ ac, roles, defaultRole: "user" })`; **never** set `adminUserIds` | IDs in `adminUserIds` bypass role checks (DEC-032). `adminRoles` grants nothing in 1.7.15: only `impersonate-user` (blocked) reads it, to protect admin targets, so it is left at its default (TASK-04) |
| Telemetry | `telemetry: { enabled: false }` (TASK-04) | No data leaves the API without a decision (apps/api R35) |
| Unexpected errors | `onAPIError: { throw: true }` (TASK-04). `APIError`s still become Better Auth responses; anything else is rethrown to the API's error handler, which logs it through the scrubber (`http.error`). `onAPIError.onError` is not used: in 1.7.15 it cannot stop better-call 1.4.4 from also printing the raw error with `console.error` | Its error output must not bypass redaction |
| Background tasks | Not needed (long-running Bun server) | Only for serverless platforms |

Environment variables: [ARCHITECTURE.md §7](../ARCHITECTURE.md).

## 3. Mounting in Elysia

- Mount the handler inside the named plugin `auth`. The root app has prefix `/api` and Better Auth's `basePath` is `/api/auth`, so the final path must be `/api/auth/*`, never `/api/api/auth/*`. Pattern used (TASK-04): `new Elysia({ name: 'auth', prefix: '/auth' }).use(moduleScope('auth')).all('/*', ({ request }) => handle(request), { parse: 'none' })`, mounted in `app.ts` with `.use(mountModule(authPlugin))`; `handle` passes the request to `auth.handler`, inside `userMutationLock.run()` for the admin endpoints that change roles or bans ([static-roles.md §7](access/static-roles.md)). The handler gets the untouched `Request` (Better Auth routes on its full path) and `parse: 'none'` leaves the body for Better Auth. Tests assert that `/api/api/auth/*` is 404.
- Macro `auth: true` resolves `{ user, session }` with `auth.api.getSession({ headers, returnHeaders: true })`, or throws `401 { code: "UNAUTHORIZED" }`. It adds `userId` to the request's log context. Any `Set-Cookie` Better Auth returns (a refreshed expiry after `updateAge`, a cleared stale cookie) is forwarded on the response. The session is read from PostgreSQL on every request (DEC-054, Proposed), so a sign-out, revocation or role change applies on the next request (TASK-05).
- Macro `permission: 'posts:read'` implies a session (401 comes before 403), turns the string into `{ posts: ['read'] }`, and checks it with `auth.api.userHasPermission({ body: { role, permissions } })` (1.7.15, server-side, no `request`: allowed by `hooks.ts`), where `role` is the session user's stored role read like Better Auth (`NULL` → `user`). Better Auth types `role` as one registry name but accepts a comma-separated string, so mixed roles keep "any held role" semantics. On failure: `403 { code: "FORBIDDEN" }`. Only `Permission` values compile, and a string cast past the type fails when the route is declared. It resolves the session itself instead of nesting `auth: true`, because Elysia 1.4.30 does not type a nested macro's `user` in the outer macro; a route takes one of the two options (TASK-05).
- A route with neither option is public and must be listed as **Public** in [API.md](../API.md). The app does not start otherwise (`assertRouteAccess`, default deny, TASK-05).

## 4. Flows

| Flow | Endpoint | Result |
|:---|:---|:---|
| Email sign-up | `POST /api/auth/sign-up/email` | User with role `user`; password hashed; session cookie (unless verification is required) |
| Email sign-in | `POST /api/auth/sign-in/email` | Session cookie; generic error for unknown email or wrong password |
| Google sign-in | `POST /api/auth/sign-in/social` `{ provider: "google", callbackURL }` → Google → `GET /api/auth/callback/google` | New user with role `user`, or linked to the account with the same verified email |

The web app sends `callbackURL` = the safe `?redirect=` path (or `/`) and `errorCallbackURL` = `/login` (keeping `?redirect=`); Better Auth appends `error=<code>`, which `/login` shows (`access_denied` on cancel). A failure that happens before the state is decoded (`state_not_found`, some `state_mismatch` cases) goes to Better Auth's default `/api/auth/error` page instead, because the API sets no `onAPIError.errorURL` (TASK-09; an API change, not made in TASK-09).
| Sign-out | `POST /api/auth/sign-out` | Session row deleted from PostgreSQL (sessions are not in Redis, DEC-054) (TASK-04) |
| Session | `GET /api/auth/get-session` | `{ user, session }` or `null` |
| Profile update | `POST /api/auth/update-user` | Only `name` and `image`; email change stays off (default) |

`callbackURL` must be a path on the web origin.

## 5. Error codes on `/api/auth/*`

Better Auth's response format and codes are used as they are (DEC-007). The web app maps `error.code` to messages in `features/auth/lib/errors.ts`. The real codes are **recorded from the running implementation in TASK-04**; never guess them.

Recorded from the running implementation on Better Auth 1.7.15 (TASK-04); `apps/api/tests/utils/auth/routes.test.ts` asserts each one.

| Situation | Status | `error.code` |
|:---|:---|:---|
| Email already registered | 422 (TASK-04) | `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (TASK-04) |
| Wrong email or password | 401 (TASK-04) | `INVALID_EMAIL_OR_PASSWORD` (TASK-04); the same response for an unknown email |
| Rate limited | 429 | none: the body is `{ "message": "Too many requests. Please try again later." }` with header `X-Retry-After` in seconds, so map on the status (TASK-04) |
| Banned user signs in (also when the ban lands during the sign-in) | 403 (TASK-04) | `BANNED_USER` (TASK-04) |
| Guard: own role change | 400 | `CANNOT_CHANGE_OWN_ROLE` ([static-roles.md §7](access/static-roles.md)) |
| Guard: role not in the registry | 400 | `INVALID_ROLE` |
| Guard: ban or remove yourself | 400 | `CANNOT_TARGET_SELF` |
| Guard: `userId` that is not a non-empty string (an array, object, number, `null`) | 400 | `INVALID_USER_ID` (TASK-04) |
| Guard: demoting, banning or removing the last usable `super_admin` | 400 | `LAST_SUPER_ADMIN` (TASK-04) |
| set-role, ban, unban or remove-user: another account change holds the lock too long, or too many are waiting ([static-roles.md §7](access/static-roles.md)) | 503, header `Retry-After: 1` | `USER_MUTATION_BUSY` (TASK-04) |
| set-role, ban, unban or remove-user: body over 16 KiB | 413 | `PAYLOAD_TOO_LARGE` (TASK-04) |
| Blocked admin endpoint | 404 | `NOT_FOUND` |
| Admin action without the permission (e.g. `admin` calling set-role) | 403 | Better Auth's `YOU_ARE_NOT_ALLOWED_TO_*` codes, e.g. `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE` (TASK-04) |
| Session store (Redis) unreachable on get-session | 500 | `FAILED_TO_GET_SESSION` (TASK-04) |
| Any other unexpected failure (not a Better Auth `APIError`, e.g. a database error) | 500 | `INTERNAL_ERROR`, the API's own format ([API.md §2](../API.md)): Better Auth rethrows it (`onAPIError.throw: true`) and the API's error handler logs it as `http.error` with `module: "auth"` (TASK-04) |

## 6. Audit events (DEC-016)

Emitted through telemetry with `module: "auth"` from `audit.ts`:

| Source | Event | Payload |
|:---|:---|:---|
| `databaseHooks.session.create.after` | `audit.session.created` | `userId, sessionId, ip, userAgent` |
| `databaseHooks.session.delete.before` | `audit.session.revoked` | `userId, sessionId, actorId?` |
| `databaseHooks.user.update.after`, `role` changed | `audit.user.role_changed` | `userId, from, to, actorId` |
| `databaseHooks.user.update.after`, `banned` changed | `audit.user.banned` / `audit.user.unbanned` | `userId, actorId, expiresAt?` (never the ban reason) |
| `databaseHooks.account.create.after` | `audit.account.linked` | `userId, provider` |
| `hooks.after` on `/sign-in/email` failure | `audit.auth.sign_in_failed` | `ip, reason` (no email) |
| `hooks.before` guard rejection | `audit.auth.blocked_endpoint` | `path, actorId?` |

`actorId` is the signed-in user who acted, from `ctx.context.session`. Checked in 1.7.15 (TASK-04): `databaseHooks` receive the endpoint context after the admin middleware ran, so `ctx.context.session` and `ctx.body` are there and no `hooks.after` fallback is needed. Never log email, name, ban reason or tokens ([redaction.md](../observability/redaction.md)).

Implementation notes (TASK-04):
- `userId` is the subject of the event (the target user) and is passed as the event's context; `module: "auth"` is set explicitly too, because these hooks also run for server-side `auth.api` calls made while another module handles the request.
- `role_changed` needs the old role, which `user.update.after` does not see: `user.update.before` reads the target row (`ctx.body.userId`) and hands it to `after` through the shared endpoint context. Setting the role a user already has emits nothing. `NULL` is reported as `user`.
- On sign-out the actor is the session owner. A ban revokes every session of the target, one `audit.session.revoked` each, with the admin as actor.
- `audit.user.unbanned` has no `actorId` when an expired ban is lifted by Better Auth during sign-in.
- `audit.account.linked` covers external identities only: the `credential` account created on email sign-up is not reported.
- A successful sign-in also sets `userId` on the request's log context, so its `http.request` carries it.

## 7. Production checklist

- [ ] `BETTER_AUTH_SECRET` strong and unique per environment
- [ ] `BETTER_AUTH_URL` uses HTTPS
- [ ] `trustedOrigins` contains only the web origin
- [ ] Rate limiting on, stored in Redis; `REDIS_URL` set
- [ ] CSRF and origin checks on
- [ ] Reverse proxy sets `x-forwarded-for`; the API is not reachable directly from the internet
- [ ] `encryptOAuthTokens` on
- [ ] Cookie cache off
- [ ] `adminUserIds` not set; unused admin endpoints return 404
- [ ] Dev-only link events cannot fire in production
- [ ] Audit events visible in the MongoDB log store
