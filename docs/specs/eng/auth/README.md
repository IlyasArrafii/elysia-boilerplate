# Authentication

Better Auth configuration, following the `better-auth-best-practices` and `better-auth-security-best-practices` skills (DEC-007, DEC-019, DEC-020, DEC-032). Roles and permissions depend on the project's access stage ([access/README.md](access/README.md)); the default is stage 1, [static-roles.md](access/static-roles.md). This file describes the default; stages 2 and 3 add the organization plugin ([access/single-org.md](access/single-org.md)).

Options marked *verify* must be checked against the docs for the installed Better Auth version (resolve it from the lockfile, then read the matching docs version).

## 1. Where the code lives

| File | Content |
|:---|:---|
| `packages/auth/src/server.ts` | `createAuth({ db, redis, ac, roles, hooks, databaseHooks, logger })` returns `betterAuth({...})`. The only place Better Auth options are written. |
| `packages/auth/src/client.ts` | `createAuthClient` with `adminClient()`. No `ac`/`roles` on the client (DEC-023). |
| `apps/api/src/utils/auth/auth.ts` | `export const auth = createAuth({...})`. The file the Better Auth CLI reads (`--config`). |
| `apps/api/src/utils/auth/roles.ts` | Role registry ([static-roles.md §2](access/static-roles.md)). |
| `apps/api/src/utils/auth/access.ts` | Builds `ac` and `roles` from module `permissions.ts` files ([static-roles.md §4](access/static-roles.md)). |
| `apps/api/src/utils/auth/hooks.ts` | `hooks.before` guard rules ([static-roles.md §7](access/static-roles.md)). |
| `apps/api/src/utils/auth/audit.ts` | `databaseHooks` and `hooks.after` that emit `audit.*` events (§6). |
| `apps/api/src/utils/auth/index.ts` | Named plugin `auth`: mounts the handler (log context `module: "auth"`) and defines the `auth` and `permission` macros. |

Import plugins from their own paths (`better-auth/plugins/admin`, `better-auth/plugins/access`) so unused plugins are not bundled.

## 2. Configuration baseline

| Area | Value | Why |
|:---|:---|:---|
| `secret` | From `BETTER_AUTH_SECRET` only, ≥ 32 chars, high entropy, never committed | Better Auth rejects placeholder secrets in production |
| `baseURL` | From `BETTER_AUTH_URL` = public web origin, HTTPS in production | Same origin (DEC-020) |
| `basePath` | `/api/auth` (default) | Matches the `/api` prefix (DEC-006) |
| `trustedOrigins` | `[WEB_URL]`, no wildcards | `callbackURL` and redirects outside it get 403 |
| CSRF | `advanced.disableCSRFCheck: false` (default); `disableOriginCheck` never set | Keep both checks |
| Cookies | Defaults: `httpOnly`, `secure` on HTTPS, `sameSite: "lax"`; `advanced.cookiePrefix: "app"` (neutral; the default `better-auth` names the library, DEC-040); `crossSubDomainCookies` **off** | One origin, no sharing |
| Client IP | `advanced.ipAddress.ipAddressHeaders: ["x-forwarded-for"]`, `ipv6Subnet: 64` | API always sits behind the proxy; rate limits need the real IP |
| Email/password | `emailAndPassword.enabled: true`, default minimum length (8) | |
| Email verification | `sendVerificationEmail` emits `auth.verification_link` in dev only; a real sender must replace it before `requireEmailVerification` is turned on (`TBD`) | No email sender in the MVP |
| Password reset | `sendResetPassword` emits `auth.reset_link` in dev only | |
| Google | `socialProviders.google` from env; PKCE and state are automatic; `account.storeStateStrategy: "cookie"` (default) | |
| Account linking | `account.accountLinking.enabled: true`, `trustedProviders: ["google"]` | Verified Google email links to the existing password account |
| OAuth tokens | `account.encryptOAuthTokens: true` | AES-256-GCM at rest |
| Session | `expiresIn` 7 days, `updateAge` 1 day, `freshAge` 1 hour | Sensitive actions need a fresh session |
| Cookie cache | **off** | Redis lookups are fast; a cookie cache delays revocation and bans |
| Secondary storage | Redis (DEC-019) with `session.storeSessionInDatabase: true` | Admin can list and revoke sessions |
| Rate limit | `enabled: true`, `storage: "secondary-storage"`; `customRules`: sign-in email 5 / 60 s, sign-up email 3 / 60 s | *verify* whether rule keys are `/sign-in/email` or `/api/auth/sign-in/email` |
| Logger | Better Auth `logger` routed through the telemetry scrubber into pino with `module: "auth"` | Its log lines must not bypass redaction |
| Admin plugin | `admin({ ac, roles, defaultRole: "user" })`; **never** set `adminUserIds` | IDs in `adminUserIds` bypass role checks (DEC-032). *Verify* that `adminRoles` grants nothing beyond our `roles`; if it does, set `adminRoles: ["super_admin"]` |
| Background tasks | Not needed (long-running Bun server) | Only for serverless platforms |

Environment variables: [ARCHITECTURE.md §7](../ARCHITECTURE.md).

## 3. Mounting in Elysia

- Mount the handler inside the named plugin `auth`. The root app has prefix `/api` and Better Auth's `basePath` is `/api/auth`, so the final path must be `/api/auth/*`, never `/api/api/auth/*`. *Verify* the mount pattern against Better Auth's Elysia integration docs.
- Macro `auth: true` resolves `{ user, session }` with `auth.api.getSession({ headers })`, or returns `401 { code: "UNAUTHORIZED" }`. It adds `userId` to the request's log context.
- Macro `permission: 'posts:read'` implies `auth: true`, turns the string into `{ posts: ['read'] }`, and checks it with `auth.api.userHasPermission(...)` (*verify* signature). On failure: `403 { code: "FORBIDDEN" }`. Only `Permission` values compile.
- A route with neither option is public and must be listed as **Public** in [API.md](../API.md).

## 4. Flows

| Flow | Endpoint | Result |
|:---|:---|:---|
| Email sign-up | `POST /api/auth/sign-up/email` | User with role `user`; password hashed; session cookie (unless verification is required) |
| Email sign-in | `POST /api/auth/sign-in/email` | Session cookie; generic error for unknown email or wrong password |
| Google sign-in | `POST /api/auth/sign-in/social` `{ provider: "google", callbackURL }` → Google → `GET /api/auth/callback/google` | New user with role `user`, or linked to the account with the same verified email |
| Sign-out | `POST /api/auth/sign-out` | Session deleted from Redis and PostgreSQL |
| Session | `GET /api/auth/get-session` | `{ user, session }` or `null` |
| Profile update | `POST /api/auth/update-user` | Only `name` and `image`; email change stays off (default) |

`callbackURL` must be a path on the web origin.

## 5. Error codes on `/api/auth/*`

Better Auth's response format and codes are used as they are (DEC-007). The web app maps `error.code` to messages in `features/auth/lib/errors.ts`. The real codes are **recorded from the running implementation in TASK-04**; never guess them.

| Situation | Status | `error.code` |
|:---|:---|:---|
| Email already registered | `TBD` (TASK-04) | `TBD` |
| Wrong email or password | `TBD` | `TBD` |
| Rate limited | 429 | `TBD` |
| Banned user signs in | `TBD` | `TBD` |

## 6. Audit events (DEC-016)

Emitted through telemetry with `module: "auth"` from `audit.ts`:

| Source | Event | Payload |
|:---|:---|:---|
| `databaseHooks.session.create.after` | `audit.session.created` | `userId, sessionId, ip, userAgent` |
| `databaseHooks.session.delete.before` | `audit.session.revoked` | `userId, sessionId, actorId?` |
| `databaseHooks.user.update.after`, `role` changed; `bun run role:set` | `audit.user.role_changed` | `userId, from, to, actorId` |
| `databaseHooks.user.update.after`, `banned` changed | `audit.user.banned` / `audit.user.unbanned` | `userId, actorId, expiresAt?` (never the ban reason) |
| `databaseHooks.account.create.after` | `audit.account.linked` | `userId, provider` |
| `hooks.after` on `/sign-in/email` failure | `audit.auth.sign_in_failed` | `ip, reason` (no email) |
| `hooks.before` guard rejection | `audit.auth.blocked_endpoint` | `path, actorId?` |

`actorId` is the signed-in user who acted, from `ctx.context.session` (*verify* availability in `databaseHooks`; fall back to `hooks.after` on admin paths). A role change from `bun run role:set` has no signed-in user: its `actorId` is `cli`. Never log email, name, ban reason or tokens ([redaction.md](../observability/redaction.md)).

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
