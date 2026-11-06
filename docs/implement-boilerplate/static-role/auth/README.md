# Authentication

Better Auth configuration, following the `better-auth-best-practices` and `better-auth-security-best-practices` skills (DEC-007, DEC-019, DEC-020, DEC-032). Roles and permissions are static roles defined in code: [static-roles.md](static-roles.md).

Options marked *verify* must be checked against the docs for the installed Better Auth version (resolve it from the lockfile, then read the matching docs version). The installed version is 1.7.15.

## 1. Where the code lives

| File | Content |
|:---|:---|
| `packages/auth/src/server.ts` | `createAuth({ db, secret, baseURL, trustedOrigins, clientIpHeader, google?, secondaryStorage, ac, roles, defaultRole, hooks?, databaseHooks?, logger?, onVerificationLink?, onResetLink? })` returns `betterAuth({...})`. The only place Better Auth options are written. The package reads no env: the API passes every value. Also exports `AUTH_BASE_PATH`, `COOKIE_PREFIX`, `RATE_LIMIT_RULES` and `SESSION_EXPIRES_IN_SECONDS`. |
| `apps/web/src/lib/auth-client.ts` | The web app's only Better Auth client: `createAuthClient` with the `adminClient()` plugin, typed with the registry's role names only (`adminClient<{ roles: Record<RoleName, Role> }>()`, `RoleName` taken from the `GET /api/admin/roles` schema), so `admin.setRole` accepts exactly the API's roles while no `ac`/`roles` value reaches the browser (DEC-023). During SSR it forwards cookies through `ssr-cookies.ts`. `packages/auth` has no client factory. |
| `apps/api/src/utils/auth/auth.ts` | `export const auth = createAuth({...})`. The file the Better Auth CLI reads (`--config`). |
| `apps/api/src/utils/auth/roles.ts` | Role registry ([static-roles.md §2](static-roles.md)). |
| `apps/api/src/utils/auth/access.ts` | Builds `ac` and `roles` from module `permissions.ts` files ([static-roles.md §4](static-roles.md)). |
| `apps/api/src/utils/auth/permissions.ts` | `defineModulePermissions`, `mergeStatements`, `mergeGrants` and the `Permission` type helpers. |
| `apps/api/src/utils/auth/hooks.ts` | `hooks.before` guard rules and the admin-path allowlist ([static-roles.md §7](static-roles.md)); `hooks.after`, which runs the sign-in failure audit (`audit.ts`) and drops session tokens from `list-user-sessions` (§2). |
| `apps/api/src/utils/auth/audit.ts`, `database-hooks.ts` | `databaseHooks` and the sign-in failure check (called from `hooks.after`) that emit `audit.*` events (§6). |
| `apps/api/src/utils/auth/bans.ts` | Expired-ban lift at sign-in that cannot wipe a newer ban ([static-roles.md §7](static-roles.md)). |
| `apps/api/src/utils/auth/body.ts` | Reads `userId` from an admin request body, the same way for guards and audit. |
| `apps/api/src/utils/auth/super-admins.ts` | "Would this leave no usable `super_admin`?" check. |
| `apps/api/src/utils/auth/user-mutation-lock.ts` | `userMutationLock`: PostgreSQL advisory lock for set-role, ban, unban and remove-user ([static-roles.md §7](static-roles.md)). |
| `apps/api/src/utils/auth/user-removed.ts` | `onUserRemoved(callback)`: runs after a user removal commits (posts use it to invalidate their cache). |
| `apps/api/src/utils/auth/storage.ts` | `guardAuthStorage` / `createSecondaryStorage`: the `secondaryStorage` that holds rate-limit counters only, on the raw `cacheStore`, falling back to memory while Redis fails (§2). |
| `apps/api/src/utils/auth/unknown-roles.ts` | Startup count of users whose role is outside the registry → `rbac.unknown_role`. |
| `apps/api/src/utils/db/index.ts` | The API's single PostgreSQL pool `db` (`createDb(env.DATABASE_URL)`) and `closeDb()`, shared by the Drizzle adapter and module services; bound to the lock's transaction while a user mutation runs. |
| `apps/api/src/utils/logger/auth.ts` | `authLogger`: Better Auth's logger, through the telemetry scrubber. |
| `apps/api/src/utils/auth/index.ts` | Named plugin `auth` (`authPlugin`): mounts the handler (log context `module: "auth"`), takes the user mutation lock for the four mutating admin endpoints and uses `authGuard`; re-exports the macros. |
| `apps/api/src/utils/auth/macros.ts` | Named plugin `auth-guard` (`authGuard`) with the `auth` and `permission` macros, `hasPermission()` for ownership rules, and `assertRouteAccess` / `PUBLIC_ROUTES` (default deny). Modules `.use(authGuard)`, never `authPlugin`: using that inside a module would mount `/auth/*` again under the module's prefix. |

Plugins are imported from their own paths (`better-auth/plugins/admin`, `better-auth/plugins/access`) so unused plugins are not bundled. The admin plugin is the only server plugin.

## 2. Configuration baseline

| Area | Value | Why |
|:---|:---|:---|
| `secret` | From `BETTER_AUTH_SECRET` only, ≥ 32 chars, high entropy, never committed. `env.ts` and `createAuth` both refuse a shorter one; only `NODE_ENV=test` falls back to a fixed test value | Better Auth rejects placeholder secrets in production |
| `baseURL` | From `BETTER_AUTH_URL` = public web origin, HTTPS in production | Same origin (DEC-020) |
| `basePath` | `/api/auth` (`AUTH_BASE_PATH`) | Matches the `/api` prefix (DEC-006) |
| `appName` | `app` | Neutral name |
| `trustedOrigins` | `[WEB_URL]`, no wildcards | `callbackURL` and redirects outside it get 403 |
| CSRF | `advanced.disableCSRFCheck: false` and `advanced.disableOriginCheck: false`, both **pinned** in every environment, tests included. Left unset, 1.7.15 turns both checks off whenever `isTest()` is true (`NODE_ENV=test` or any truthy `TEST`), so a stray `TEST=1` in a deployment would allow cross-site cookie POSTs and open callback URLs; `env.ts` also refuses `TEST` in production. Tests send `Origin: WEB_URL` like a browser. Routes outside `/api/auth/*` get the same protection from the API's own `csrfGuard` (`apps/api/src/utils/csrf`): `Sec-Fetch-Site` `same-origin`/`none`, else `Origin` = `WEB_URL`, JSON bodies only ([API.md §1](../API.md#1-authentication-and-authorisation)) | Keep both checks; `SameSite=Lax` alone lets a sibling subdomain post with the cookie |
| Cookies | Defaults: `httpOnly`, `secure` on HTTPS, `sameSite: "lax"`; `advanced.cookiePrefix: "app"` (neutral; the default `better-auth` names the library, DEC-040), so `app.session_token` / `__Secure-app.session_token`; `crossSubDomainCookies` **off** | One origin, no sharing |
| Client IP | `advanced.ipAddress.ipAddressHeaders: [CLIENT_IP_HEADER]` (default `cf-connecting-ip`, required in production, [ARCHITECTURE.md §7](../ARCHITECTURE.md)), `ipv6Subnet: 64`, **no** `trustedProxies`. 1.7.15 believes the header only when it holds exactly one valid IP; a list, garbage or no header is no client IP, and in production every such request shares one `no-trusted-ip` bucket per path (`127.0.0.1` in development and test). `x-forwarded-for` is not read, so a client cannot pick its own bucket with it. The same IP goes into `session.ipAddress` and the audit events (§6) | Cloudflare overwrites `CF-Connecting-IP` with one IP, while it appends to a client-sent `x-forwarded-for`. Trustworthy only while the API is reachable through the edge alone ([ARCHITECTURE.md §9](../ARCHITECTURE.md#9-client-ip-and-origin-exposure)) |
| Email/password | `emailAndPassword.enabled: true`, default minimum length (8) | |
| Email verification | `emailVerification.sendVerificationEmail` emits `auth.verification_link` in development only; a real sender must replace it before `requireEmailVerification` is turned on (`TBD`). Outside development the callback is not configured at all | No email sender in the MVP |
| Password reset | `sendResetPassword` emits `auth.reset_link` in development only; outside development the flow is off | |
| Verification tokens | `verification.storeInDatabase: true`: kept in PostgreSQL only, since the secondary storage stores and returns nothing but rate-limit counters (DEC-055). Without it 1.7.15 drops the `verification` table from the generated schema once `secondaryStorage` is set, and would find no verification value at all | The table is part of [DATABASE.md](../DATABASE.md); a Redis flush must not void links already sent, and a used reset token or OAuth state must not come back from a Redis copy whose delete failed |
| Google | `socialProviders.google` from env; PKCE (`S256`) and state are automatic; `account.storeStateStrategy: "cookie"` (cookie `app.oauth_state`). Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` the provider is not configured, which only development and test allow | |
| Account linking | `account.accountLinking.enabled: true`, `trustedProviders: ["google"]`. Better Auth 1.7.15 also requires the **local** row to have `emailVerified: true` (`requireLocalEmailVerified`, default on, left on): Google never links into an unverified password account and redirects with `error=` instead | Verified Google email links to the existing password account; a pre-registered unverified account cannot capture it |
| OAuth tokens | `account.encryptOAuthTokens: true` | AES-256-GCM at rest |
| Session | `expiresIn` 7 days, `updateAge` 1 day, `freshAge` 1 hour, `storeSessionInDatabase: true` | Sensitive actions need a fresh session |
| Cookie cache | **off** (`session.cookieCache.enabled: false`) | A cookie cache delays revocation and bans |
| Session store | **PostgreSQL only** (DEC-054). The secondary storage never stores or returns a session entry (`<token>` → `{session, user}`, `active-sessions-<userId>`), so Better Auth reads every session from the `session` table. `session.storeSessionInDatabase` must stay `true` and `preserveSessionInDatabase` unset, or every session would look absent | Admin can list and revoke sessions; a revoked or banned session stops working on the next request, with no race against Better Auth's non-atomic Redis session lists |
| Secondary storage | **Rate-limit counters only** (DEC-055), through `createSecondaryStorage(cacheStore)` = `guardAuthStorage(...)` (`utils/auth/storage.ts`). An allowlist: `get` and `getAndDelete` answer `null` and `set` and `delete` do nothing, without touching Redis. `increment` counts in Redis under `auth:` (so `auth` is a reserved cache module name) with `CacheStore.increment` (one `MULTI`/`EXEC`: `SET key 0 EX <ttl> NX` then `INCR`, no Lua, [ARCHITECTURE.md §6](../ARCHITECTURE.md)), the window rounded up to whole seconds. When Redis rejects or misses a 1 s deadline, a 5 s breaker opens and the count continues in a bounded per-instance memory counter; one `cache.unavailable` warning (`source: "auth"`) per 30 s. A plugin that reads `secondaryStorage` itself gets nothing back (in 1.7.15 only `device-authorization`, not enabled): grep a plugin's dist for `secondaryStorage` before enabling it | A Redis outage never fails `/api/auth/*`, and limits still hold, per instance, while it lasts |
| Rate limit | `enabled: true`, `storage: "secondary-storage"`; `customRules` (`RATE_LIMIT_RULES`): sign-in email 5 / 60 s, sign-up email 3 / 60 s. Rule keys are paths **without** the base path: `/sign-in/email`, `/sign-up/email`. Counted per client IP and path; the sixth sign-in in 60 s answers 429 with `X-Retry-After: 60`. `/get-session` is **not** rate limited (`'/get-session': false`): the web SSR calls it on every render without forwarding the visitor's IP, so in production all visitors would share one bucket and one busy client would show everyone the session error page; it only returns a session to a valid cookie. Accepted trade-off: the rule lifts the limit for every client, not only the SSR. A cookie with a bad signature is refused before any database read, but a signed-in client can still drive one PostgreSQL read per call (no cookie cache), so the edge proxy's rate limit on `/api/auth/*` is what bounds it ([§7](#7-production-checklist)). Other `/api/auth/*` paths get Better Auth's default (100 per 10 s) | Better Auth strips `/api/auth` before matching `customRules` |
| Logger | Better Auth `logger` routed through the telemetry scrubber into pino with `module: "auth"`: `log` calls `authLogger.log` (`utils/logger/auth.ts`), whose `log(level, message, ...args)` matches the installed 1.7.15 type (`level` is `debug`/`info`/`warn`/`error`). Its `level` follows `LOG_LEVEL` (`trace` → `debug`, `fatal` → `error`); `silent` disables it. Checked on a real line: 1.7.15 logs `Sign-up attempt for existing email: <email>` at info, which reaches pino as `[REDACTED:email]` | Its log lines must not bypass redaction |
| Admin plugin | `admin({ ac, roles, defaultRole: "user" })`; **never** set `adminUserIds` | IDs in `adminUserIds` bypass role checks (DEC-032). `adminRoles` grants nothing in 1.7.15: only `impersonate-user` (blocked) reads it, to protect admin targets, so it is left at its default |
| Session tokens | `list-user-sessions` returns each session's raw `token` in 1.7.15. `hooks.after` removes it from every session unless the caller holds `session:revoke`, the permission of `revoke-user-session`, the only endpoint that takes a token. The `admin` role (`session:list` only) therefore never sees one. If the session lookup in the hook fails, the tokens are stripped (fails closed) | Defence in depth, keep it: today a raw token is not usable on its own (the cookie is HMAC-signed with `BETTER_AUTH_SECRET` and no plugin accepts unsigned tokens), but it becomes a credential for that session, a `super_admin`'s included, once `bearer()` or a similar plugin is added or the secret leaks |
| Email verification at sign-up | Not required (no email sender in the MVP), so anyone can register an address they do not own (email squatting). Accepted as a known risk for now: a `super_admin` removes the squatting account (`remove-user`) | Account linking still refuses to link Google into an unverified local account (above) |
| Impersonation | None. The impersonation endpoints are blocked (404) and the impersonate actions are not in the statement ([static-roles.md §3, §7](static-roles.md)) | DEC-032 |
| Telemetry | `telemetry: { enabled: false }` | No data leaves the API without a decision (apps/api R35) |
| Unexpected errors | `onAPIError: { throw: true }`. `APIError`s still become Better Auth responses; anything else is rethrown to the API's error handler, which logs it through the scrubber (`http.error`). `onAPIError.onError` is not used: in 1.7.15 it cannot stop better-call 1.4.4 from also printing the raw error with `console.error`. `onAPIError.errorURL` is not set (§4) | Its error output must not bypass redaction |
| Background tasks | Not needed (long-running Bun server) | Only for serverless platforms |

Environment variables: [ARCHITECTURE.md §7](../ARCHITECTURE.md).

## 3. Mounting in Elysia

- The handler is mounted inside the named plugin `auth`. The root app has prefix `/api` and Better Auth's `basePath` is `/api/auth`, so the final path is `/api/auth/*`, never `/api/api/auth/*`. Pattern used: `new Elysia({ name: 'auth', prefix: '/auth' }).use(moduleScope('auth')).use(authGuard).all('/*', ({ request }) => handle(request), { parse: 'none' })`, mounted in `app.ts` with `.use(mountModule(authPlugin))`. `handle` passes the request to `auth.handler`; for `set-role`, `ban-user`, `unban-user` and `remove-user` it first answers a caller without a session (401) or without the endpoint's permission (403), reads the body (16 KiB at most), then runs the handler inside `userMutationLock.run()` ([static-roles.md §7](static-roles.md)). The handler gets the untouched `Request` (Better Auth routes on its full path) and `parse: 'none'` leaves the body for Better Auth. Tests assert that `/api/api/auth/*` is 404.
- Macro `auth: true` resolves `{ user, session }` with `auth.api.getSession({ headers, returnHeaders: true })`, or throws `401 { code: "UNAUTHORIZED" }`. It adds `userId` to the request's log context. Any `Set-Cookie` Better Auth returns (a refreshed expiry after `updateAge`, a cleared stale cookie) is forwarded on the response. The session is read from PostgreSQL on every request (DEC-054), so a sign-out, revocation, ban or role change applies on the next request.
- Macro `permission: 'posts:read'` implies a session (401 comes before 403), turns the string into `{ posts: ['read'] }`, and checks it with `auth.api.userHasPermission({ body: { role, permissions } })` (server-side, no `request`: allowed by `hooks.ts`), where `role` is the session user's stored role read like Better Auth (`NULL` → `user`). Better Auth types `role` as one registry name but accepts a comma-separated string, so mixed roles keep "any held role" semantics. On failure: `403 { code: "FORBIDDEN" }`. Only `Permission` values compile, and a string cast past the type fails when the route is declared. It resolves the session itself instead of nesting `auth: true`, because Elysia 1.4.30 does not type a nested macro's `user` in the outer macro; a route takes one of the two options.
- `hasPermission(role, permission)` (same check) is exported for ownership rules in services.
- A route with neither option is public and must be listed as **Public** in [API.md](../API.md). The app does not start otherwise (`assertRouteAccess`, default deny).

## 4. Flows

| Flow | Endpoint | Result |
|:---|:---|:---|
| Email sign-up | `POST /api/auth/sign-up/email` | User with role `user`; password hashed; session cookie (unless verification is required) |
| Email sign-in | `POST /api/auth/sign-in/email` | Session cookie; generic error for unknown email or wrong password |
| Google sign-in | `POST /api/auth/sign-in/social` `{ provider: "google", callbackURL }` → Google → `GET /api/auth/callback/google` | New user with role `user`, or linked to the account with the same verified email |
| Sign-out | `POST /api/auth/sign-out` | Session row deleted from PostgreSQL (sessions are not in Redis, DEC-054) |
| Session | `GET /api/auth/get-session` | `{ user, session }` or `null` |
| Profile update | `POST /api/auth/update-user` | Only `name` and `image`; email change stays off (default). Answers `{ status: true }` only, not the user; no session → 401 `UNAUTHORIZED`. The body is any record, with no length or format checks on `name` or `image` in 1.7.15 |

`callbackURL` must be a path on the web origin.

Google errors: the web app sends `callbackURL` = the safe `?redirect=` path (or `/`) and `errorCallbackURL` = `/login` (keeping `?redirect=`); Better Auth appends `error=<code>`, which `/login` shows (`access_denied` on cancel). A failure that happens before the state is decoded (`state_not_found`, some `state_mismatch` cases) goes to Better Auth's built-in `/api/auth/error` page instead, because the API sets no `onAPIError.errorURL`. Sending those to a web route needs an API config change.

## 5. Error codes on `/api/auth/*`

Better Auth's response format and codes are used as they are (DEC-007). The web app maps `error.code` to messages in `features/auth/lib/errors.ts`. The codes below are recorded from the running implementation on Better Auth 1.7.15; never guess them. `apps/api/tests/utils/auth/routes.test.ts` asserts each one.

| Situation | Status | `error.code` |
|:---|:---|:---|
| Email already registered | 422 | `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` |
| Wrong email or password | 401 | `INVALID_EMAIL_OR_PASSWORD`; the same response for an unknown email |
| Rate limited | 429 | none: the body is `{ "message": "Too many requests. Please try again later." }` with header `X-Retry-After` in seconds, so map on the status |
| Banned user signs in (also when the ban lands during the sign-in) | 403 | `BANNED_USER` |
| Guard: own role change | 400 | `CANNOT_CHANGE_OWN_ROLE` ([static-roles.md §7](static-roles.md)) |
| Guard: role not in the registry | 400 | `INVALID_ROLE` |
| Guard: ban or remove yourself | 400 | `CANNOT_TARGET_SELF` |
| Guard: `userId` that is not a non-empty string (an array, object, number, `null`) | 400 | `INVALID_USER_ID` |
| Guard: demoting, banning or removing the last usable `super_admin` | 400 | `LAST_SUPER_ADMIN` |
| set-role, ban, unban or remove-user: another account change holds the lock too long, or too many are waiting ([static-roles.md §7](static-roles.md)) | 503, header `Retry-After: 1` | `USER_MUTATION_BUSY` |
| set-role, ban, unban or remove-user: body over 16 KiB | 413 | `PAYLOAD_TOO_LARGE` |
| Blocked admin endpoint | 404 | `NOT_FOUND` |
| Admin action without the permission (e.g. `admin` calling set-role) | 403 | Better Auth's `YOU_ARE_NOT_ALLOWED_TO_*` codes, e.g. `YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE` |
| Any other unexpected failure (not a Better Auth `APIError`, e.g. a database error) | 500 | `INTERNAL_ERROR`, the API's own format ([API.md §2](../API.md)): Better Auth rethrows it (`onAPIError.throw: true`) and the API's error handler logs it as `http.error` with `module: "auth"` |

## 6. Audit events (DEC-016)

Emitted through telemetry with `module: "auth"` from `audit.ts`:

| Source | Event | Payload |
|:---|:---|:---|
| `databaseHooks.session.create.after` | `audit.session.created` | `userId, sessionId, ip, userAgent` |
| `databaseHooks.session.delete.after` | `audit.session.revoked` | `userId, sessionId, actorId?` |
| `databaseHooks.user.update.after`, `role` changed | `audit.user.role_changed` | `userId, from, to, actorId` |
| `databaseHooks.user.update.after`, `banned` changed | `audit.user.banned` / `audit.user.unbanned` | `userId, actorId, expiresAt?` (never the ban reason) |
| `databaseHooks.account.create.after` | `audit.account.linked` | `userId, provider` |
| `hooks.after` on `/sign-in/email` failure | `audit.auth.sign_in_failed` | `ip, reason` (no email) |
| `hooks.before` guard rejection | `audit.auth.blocked_endpoint` | `path, actorId?` |

`actorId` is the signed-in user who acted, from `ctx.context.session`. Checked in 1.7.15: `databaseHooks` receive the endpoint context after the admin middleware ran, so `ctx.context.session` and `ctx.body` are there and no `hooks.after` fallback is needed. Never log email, name, ban reason or tokens ([redaction.md](../observability/redaction.md)).

Implementation notes:
- `userId` is the subject of the event (the target user) and is passed as the event's context; `module: "auth"` is set explicitly too, because these hooks also run for server-side `auth.api` calls made while another module handles the request.
- `role_changed` needs the old role, which `user.update.after` does not see: `user.update.before` reads the target row (`ctx.body.userId`) and hands it to `after` through the shared endpoint context. Setting the role a user already has emits nothing. `NULL` is reported as `user`.
- Events from set-role, ban, unban and remove-user are emitted only after the lock's transaction commits, so a rolled-back change is never reported.
- `audit.session.revoked` comes from `delete.after`, which 1.7.15 runs only once the row delete has returned: sign-out catches a failed delete and still answers 200, so an event sent before the delete would report a session that is still alive. Inside the lock it also waits for the commit. `delete.after` also runs when the row was already gone (0 rows deleted, e.g. two concurrent revocations of one session), so a session can produce two `session.revoked` events; it is gone either way. If the pre-read fails, nothing is deleted and no event is sent.
- On sign-out the actor is the session owner. A ban revokes every session of the target, one `audit.session.revoked` each, with the admin as actor.
- `audit.user.unbanned` has no `actorId` when an expired ban is lifted by Better Auth during sign-in.
- `audit.account.linked` covers external identities only: the `credential` account created on email sign-up is not reported.
- A successful sign-in also sets `userId` on the request's log context, so its `http.request` carries it.

## 7. Production checklist

- [ ] `BETTER_AUTH_SECRET` strong and unique per environment
- [ ] `BETTER_AUTH_URL` uses HTTPS
- [ ] `trustedOrigins` contains only the web origin
- [ ] Rate limiting on, stored in Redis; `REDIS_URL` set (while Redis is down, limits count per instance: DEC-055)
- [ ] The edge proxy rate-limits `/api/auth/*` per client IP (it is the only limit on `/get-session`)
- [ ] CSRF and origin checks on, for Better Auth and for the API's own routes (`csrfGuard` mounted in `app.ts`)
- [ ] `CLIENT_IP_HEADER` is a header the edge overwrites with one IP (`cf-connecting-ip` behind Cloudflare), the API is reachable through the edge alone, and `HOST` is `127.0.0.1`, or `0.0.0.0` only inside a container whose API port is not published ([ARCHITECTURE.md §9](../ARCHITECTURE.md#9-client-ip-and-origin-exposure))
- [ ] Cloudflare's **Remove visitor IP headers** managed transform is off, and no Worker in front of the API rewrites the request
- [ ] `TEST` is unset (startup refuses it in production); CSRF and origin checks stay pinned in `createAuth`
- [ ] `encryptOAuthTokens` on
- [ ] Cookie cache off
- [ ] `adminUserIds` not set; unused admin endpoints return 404
- [ ] Dev-only link events cannot fire in production
- [ ] Audit events visible in the MongoDB log store
