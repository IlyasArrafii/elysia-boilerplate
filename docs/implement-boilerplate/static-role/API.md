# API.md

The HTTP contract. All paths are under `/api` with no version (DEC-006).

## 1. Authentication and authorisation

| Aspect | Detail |
|:---|:---|
| Method | Better Auth session cookie (`httpOnly`, `sameSite=lax`, `secure` on HTTPS), prefix `app` (cookies `app.*`, `__Secure-app.*` on HTTPS) |
| Origin | Same origin as the web app (DEC-020). No CORS |
| Protected route | Route option `{ auth: true }` or `{ permission: '<resource>:<action>' }` (DEC-010) |
| No session | `401 { code: "UNAUTHORIZED" }` |
| Missing permission | `403 { code: "FORBIDDEN" }` |
| Default | A route with neither option is public. Only routes marked **Public** here may be public. Enforced at startup: `assertRouteAccess` (`apps/api/src/utils/auth/macros.ts`) refuses to build the app while a route has neither option and is not in `PUBLIC_ROUTES` (`ALL /api/auth/*`, `GET /api/health/`), which must list exactly the Public routes here; `auth: false` counts as no option (TASK-05) |

Roles and permissions: [auth/access/static-roles.md](auth/access/static-roles.md).

## 2. Response format (DEC-017)

**Success:** the object itself, no wrapper.

**Lists:** `?page=1&limit=20` (defaults `page=1`, `limit=20`; `limit` max 100).

```json
{ "items": [ … ], "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 } }
```

**Errors:** HTTP status plus:

```json
{ "code": "VALIDATION_ERROR", "message": "Invalid request", "details": { "fields": [ { "path": "/title", "rule": "minLength" } ] } }
```

| Status | `code` | Source |
|:---|:---|:---|
| 400 | `VALIDATION_ERROR` | `t` validation failed. `details.fields` lists paths and rule names, never values. `rule` is the JSON Schema keyword that failed (`minLength`, `format`, `required`, …) or `type` for a wrong or missing type; at most 50 fields (TASK-12) |
| 400 | `VALIDATION_ERROR` | The body could not be parsed (malformed JSON). `message: "Invalid request"`, no `details` (TASK-12) |
| 400/404/409 | module-specific, e.g. `POST_NOT_FOUND`, `INVALID_STATUS` | `moduleError(...)` thrown in a service (DEC-037) |
| 401 | `UNAUTHORIZED` | `auth` macro (also the `permission` macro without a session). `message: "Sign in to continue"` (TASK-05) |
| 403 | `FORBIDDEN` | `permission` macro or an ownership rule. The macro's `message: "You do not have permission to do this"` (TASK-05) |
| 404 | `NOT_FOUND` | Unknown route. `message: "Not found"` (TASK-12) |
| 429 | Better Auth format | Rate limits apply on `/api/auth/*` only |
| 500 | `INTERNAL_ERROR` | Unhandled error. `message: "Internal server error"`; details only in the log, tagged with `module` (TASK-12) |
| 503 | `SERVICE_UNAVAILABLE` | Health check when a dependency is down; the body is the health report of §3.2 plus `code` and `message` (TASK-12) |

Every response carries an `x-request-id` header. The response never reveals the module, stack or library message.

Routes under `/api/auth/*` do **not** use this format; they follow Better Auth (DEC-007).

## 3. Endpoints

### 3.1 Better Auth (built in, DEC-007, DEC-024)

Called through the Better Auth client, never through Eden. Logged with `module: "auth"` and the route pattern `/api/auth/*` (never the raw path) (TASK-04).

Methods and paths are the ones Better Auth 1.7.15 registers, checked against the installed source and the running API (TASK-04). Admin paths are the allowlist `ALLOWED_ADMIN_PATHS` in `apps/api/src/utils/auth/hooks.ts`; keep the two in step.

| Method | Path | Purpose | Permission |
|:---|:---|:---|:---|
| POST | `/api/auth/sign-up/email` | Email/password sign-up | Public |
| POST | `/api/auth/sign-in/email` | Email/password sign-in | Public |
| POST | `/api/auth/sign-in/social` | Start Google OAuth (`provider: "google"`); answers `{ url, redirect: true }` | Public |
| GET (also POST) | `/api/auth/callback/google` | OAuth callback (Better Auth's `/callback/:id`; POST is for `form_post` providers) | Public |
| POST | `/api/auth/sign-out` | Sign out | session |
| GET (also POST) | `/api/auth/get-session` | Current session | Public (`null` without one) |
| POST | `/api/auth/update-user` | Update own `name` / `image` | session |
| GET | `/api/auth/admin/list-users` | List and search users | `user:list` |
| POST | `/api/auth/admin/set-role` | Change a user's role | `user:set-role` + guard rules ([static-roles.md §7](auth/access/static-roles.md)) |
| POST | `/api/auth/admin/ban-user` / `unban-user` | Ban / unban | `user:ban` |
| POST | `/api/auth/admin/list-user-sessions` | A user's sessions | `session:list` |
| POST | `/api/auth/admin/revoke-user-session` / `revoke-user-sessions` | Revoke one / all sessions | `session:revoke` |
| POST | `/api/auth/admin/remove-user` | Delete a user | `user:delete` |

Every other admin-plugin path answers `404 NOT_FOUND` over HTTP, for every role including `super_admin` (DEC-032). In 1.7.15 that is `impersonate-user`, `stop-impersonating`, `get-user`, `create-user`, `update-user`, `set-user-password` and `has-permission` (TASK-04). Server-side `auth.api` calls are refused the same way, except `has-permission` without a `request`, which the `permission` macro calls (`auth.api.userHasPermission`, TASK-05) (TASK-04).

`/api/api/auth/*` does not exist (404): the root app adds `/api`, the auth plugin adds `/auth`, and Better Auth's `basePath` is `/api/auth` (TASK-04).

### 3.2 Health: Public

- `GET /api/health` → **200** `{ "status": "ok", "db": "up", "redis": "up" | "disabled", "logStore": "up" | "disabled", "uptime": 12345 }`.
- **503** `{ "code": "SERVICE_UNAVAILABLE", "message": "A required dependency is down", "status": "degraded", "db": …, "redis": …, "logStore": …, "uptime": … }` when PostgreSQL is down, or Redis is down while `REDIS_URL` is set (TASK-12).
- The log store being down never makes health fail (logging must not take the API down); it reports `"logStore": "down"` with status 200.
- `uptime` is whole seconds since the process started (TASK-12).
- Each dependency is `"up"`, `"down"` or `"disabled"` (not configured). `HealthService.dependencies()` is the one place that probes them; until a database, Redis and log-store client exist (TASK-03, TASK-07, TASK-15) it reports all three as `"disabled"` rather than claim `"up"` (TASK-12).
- Logged at `debug`, so probes don't flood the log.

### 3.3 Me

| Method | Path | Option | Response |
|:---|:---|:---|:---|
| GET | `/api/me/permissions` | `auth: true` | `{ "roles": ["admin"], "permissions": ["posts:read", …] }` |

Used by the web app to hide UI the user can't use. Not cached on the server. Sent with `Cache-Control: no-store`, so no browser or proxy reuses one user's answer (TASK-05).

- `roles` are the caller's stored roles as Better Auth reads them (split on commas, nothing trimmed): `NULL` or empty is `["user"]`, and an unknown role is listed but grants nothing (TASK-05).
- `permissions` is the sorted union of what every held registry role grants, from the same compiled roles the `permission` macro checks, each `Permission` once (TASK-05).
- No session: `401 UNAUTHORIZED`. A failing session lookup is `500 INTERNAL_ERROR`, never 401 (TASK-05).

### 3.4 Posts (F-04)

| Method | Path | Option | Body / query | Success | Errors |
|:---|:---|:---|:---|:---|:---|
| GET | `/api/posts` | `permission: 'posts:read'` | `?page&limit` | 200 list | 400, 401, 403 |
| GET | `/api/posts/:id` | `permission: 'posts:read'` | — | 200 post | 401, 403, 404 `POST_NOT_FOUND` |
| POST | `/api/posts` | `permission: 'posts:write'` | `{ title, content, status? }` | 201 post | 400, 401, 403 |
| PATCH | `/api/posts/:id` | `permission: 'posts:write'`; author only unless `posts:manage_all` | any subset of the POST body | 200 post | 400, 401, 403, 404 |
| DELETE | `/api/posts/:id` | same as PATCH | — | 204 | 401, 403, 404 |

- Post object: `{ id, authorId, title, slug, content, status, createdAt, updatedAt }`.
- `title`: 3–`TBD` chars. `content`: 10–`TBD` chars. `status`: `draft` (default) or `published`.
- `slug` is generated from `title`, made unique with a short suffix on collision, not editable.
- List cache: `posts:list:{page}:{limit}`, TTL `POSTS_CACHE_TTL` (default `TBD`). Create, update and delete remove `posts:list:*` with `SCAN`.

### 3.5 Admin (F-03, DEC-024)

| Method | Path | Option | Response |
|:---|:---|:---|:---|
| GET | `/api/admin/roles` | `permission: 'role:read'` | `{ "items": [{ "role": "admin", "label": "Admin", "description": "…", "permissions": ["posts:read", …] }] }` |

### 3.6 Feature flags (design only, DEC-029)

Not built in the MVP. Contract in [feature-flags/database-provider.md §6](feature-flags/database-provider.md).

### 3.7 Organizations, platform layer and platform console (design only, DEC-042, DEC-047, DEC-050)

Only at access stage 2 or in the SaaS layer. Organization plugin endpoints and their allowlists: [auth/access/single-org.md §7, §9, §10.3](auth/access/single-org.md) (stage 2) and [saas/multi-tenant.md §11](../../specs/eng/saas/multi-tenant.md) (multi-tenant). Platform layer routes (stage 2 on): [single-org.md §8.3](auth/access/single-org.md). Platform console routes `/api/platform/organizations/*` and `/api/platform/audit` (multi-tenant): [saas/platform-console.md §4](../../specs/eng/saas/platform-console.md). Route groups and database roles in multi-tenant: [saas/architecture.md §2](../../specs/eng/saas/architecture.md). Real paths are recorded here by ORG-01, ORG-07 and PC-01.

## 4. Eden contract (DEC-018)

```ts
// apps/api/src/app.ts  (builds the root app, never listens; index.ts only listens) (TASK-12)
// `@repo/api` resolves to this file (package.json `exports`), so `import type { App } from '@repo/api'` opens no port
export type App = typeof app
export type { Permission } from './utils/auth/access'

// apps/web/src/lib/api-origin.ts (TASK-14)
export const apiOrigin = createIsomorphicFn()
  .server(() => process.env.API_INTERNAL_URL)   // SSR: straight to the API (unset: dev uses http://localhost:3000, a production build throws)
  .client(() => window.location.origin)         // browser: same origin, /api is proxied

// apps/web/src/lib/api.ts (TASK-14)
const forwardedHeaders = createIsomorphicFn()
  .server(() => { const cookie = getRequestHeader('cookie'); return cookie ? { cookie } : {} })
  .client(() => ({}))
export const api = treaty<App>(apiOrigin(), { headers: () => forwardedHeaders() }).api
// usage: unwrap(await api.health.get())  → GET /api/health
```

- Request and response types come from `model.ts`; the web app never re-declares them.
- `error.status` and `error.value.code` drive error display. `unwrap()` in `apps/web/src/lib/api-error.ts` throws an `ApiError { status, code, message, details }`; a body that is not our error format (e.g. a proxy 502) becomes `INTERNAL_ERROR` (TASK-14).
- SSR forwards the `Cookie` header through treaty's `headers` option, a function called for each request (TASK-14; checked against a stand-in API that recorded the forwarded cookie). The server branches are compiled out of the browser bundle.
