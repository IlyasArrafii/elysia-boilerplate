# API.md

The HTTP contract. All paths are under `/api` with no version (DEC-006). The root app (`apps/api/src/app.ts`) is the only place that writes the `/api` prefix.

## 1. Authentication and authorisation

| Aspect | Detail |
|:---|:---|
| Method | Better Auth session cookie (`httpOnly`, `sameSite=lax`, `secure` on HTTPS), prefix `app` (cookies `app.*`, `__Secure-app.*` on HTTPS) |
| Origin | Same origin as the web app (DEC-020). No CORS |
| CSRF | Every `POST`/`PUT`/`PATCH`/`DELETE` (any method but `GET`, `HEAD`, `OPTIONS`) outside `/api/auth/*` passes `csrfGuard` (`apps/api/src/utils/csrf`), mounted once in `app.ts` before the modules. It runs in `onRequest`: before routing, body parsing and the `auth`/`permission` options. With `Sec-Fetch-Site`, only `same-origin` and `none` pass, and `Origin` is then not checked (the browser computed the header). Without it, `Origin` must equal `WEB_URL` exactly, so `Origin: null` is refused. With neither header, a request with a `cookie` header is refused and one without goes on to the route's usual `401`. Refused: `403 { code: "CSRF_REJECTED" }` plus an `audit.csrf.rejected` event (`method`, `reason`). `/api/auth/*` is left to Better Auth's own origin check |
| Request bodies | JSON only. Outside `/api/auth/*`, a state-changing request whose `content-type` is anything but `application/json` (parameters such as `charset` allowed) is `415 { code: "UNSUPPORTED_MEDIA_TYPE" }` before the body is read, so no HTML form (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`) reaches a route. With no `content-type`, nothing is parsed |
| Protected route | Route option `{ auth: true }` or `{ permission: '<resource>:<action>' }` (DEC-010) |
| No session | `401 { code: "UNAUTHORIZED" }` |
| Missing permission | `403 { code: "FORBIDDEN" }` |
| Default | A route with neither option is public. Only routes marked **Public** here may be public. Enforced at startup: `assertRouteAccess` (`apps/api/src/utils/auth/macros.ts`) refuses to build the app while a route has neither option and is not in `PUBLIC_ROUTES` (`ALL /api/auth/*`, `GET /api/health/`), which must list exactly the Public routes here; `auth: false` counts as no option |

Roles and permissions: [auth/static-roles.md](auth/static-roles.md).

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

The global error handler (`apps/api/src/utils/error/index.ts`) maps everything thrown to this shape:

| Status | `code` | Source |
|:---|:---|:---|
| 400 | `VALIDATION_ERROR` | `t` validation failed. `details.fields` lists paths and rule names, never values. `rule` is the JSON Schema keyword that failed (`minLength`, `format`, `required`, …) or `type` for a wrong or missing type; at most 50 fields |
| 400 | `VALIDATION_ERROR` | The body could not be parsed (malformed JSON). `message: "Invalid request"`, no `details` |
| 400/401/403/404/409 | module-specific, e.g. `POST_NOT_FOUND` | `moduleError(...)` thrown in a service (DEC-037) |
| 401 | `UNAUTHORIZED` | `auth` macro (also the `permission` macro without a session). `message: "Sign in to continue"` |
| 403 | `FORBIDDEN` | `permission` macro or an ownership rule. `message: "You do not have permission to do this"` |
| 403 | `CSRF_REJECTED` | `csrfGuard` (§1): a cross-site, same-site or foreign-origin write, or a cookie write with neither `Origin` nor `Sec-Fetch-Site`. `message: "Cross-site request refused"`; logged with `module: "core"` and route `[unmatched]`, because it is refused before routing |
| 404 | `NOT_FOUND` | Unknown route under `/api` (Elysia's `NotFoundError`), logged with `module: "core"`. `message: "Not found"` |
| 413 | none (empty body) | Request body over 1 MiB (`MAX_REQUEST_BODY_BYTES`). Answered by Bun.serve itself with `Connection: close`, so it has no `x-request-id` and no error body. With a `Content-Length` over the limit no hook runs at all; a chunked body is cut off at the limit and logged as a `400 VALIDATION_ERROR` ([ARCHITECTURE.md §7](ARCHITECTURE.md)) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `csrfGuard` (§1): a write whose body is not `application/json`. `message: "The request body must be application/json"`; logged like `CSRF_REJECTED` |
| 429 | `RATE_LIMITED` | A per-user rate limit ([ARCHITECTURE.md §10](ARCHITECTURE.md)): `{ "code": "RATE_LIMITED", "message": "Too many requests, try again later" }`, with `Retry-After` and `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds to the window's end). Returned by the limiter rather than thrown, so it is logged as `http.request` with status 429 and emits no `http.error`. Limited routes are listed with their endpoints (§3.4) |
| 429 | Better Auth format | Better Auth's rate limits on `/api/auth/*` (§3.1) |
| 500 | `INTERNAL_ERROR` | Unhandled error. `message: "Internal server error"`; details only in the log, tagged with `module` |
| 503 | `SERVICE_UNAVAILABLE` | Health check when PostgreSQL is down; the body is the health report of §3.2 plus `code` and `message`. Returned by the route rather than thrown, so, like the 429, it emits no `http.error`; its `http.request` is logged at `debug`, like every health request (§3.2) |

Every error the global handler maps emits one `http.error` event. The 429 and the health 503 are returned, not thrown, so they emit none, and a 413 for a `Content-Length` over the limit never reaches the app. Every response from the app carries an `x-request-id` header, `/api/auth/*` included; Bun's 413 (above) never reaches the app and has none. The response never reveals the module, stack or library message.

Unknown paths outside `/api` belong to the web app, which renders its own not-found page (`apps/web/src/components/not-found-page.tsx`).

Routes under `/api/auth/*` do **not** use this format; they follow Better Auth (DEC-007).

## 3. Endpoints

### 3.1 Better Auth (built in, DEC-007, DEC-024)

Called through the Better Auth client, never through Eden. Logged with `module: "auth"` and the route pattern `/api/auth/*` (never the raw path).

Methods and paths are the ones Better Auth 1.7.18 registers, checked against the installed source and the running API. Admin paths are the allowlist `ALLOWED_ADMIN_PATHS` in `apps/api/src/utils/auth/hooks.ts`; keep the two in step.

| Method | Path | Purpose | Permission |
|:---|:---|:---|:---|
| POST | `/api/auth/sign-up/email` | Email/password sign-up | Public |
| POST | `/api/auth/sign-in/email` | Email/password sign-in | Public |
| POST | `/api/auth/sign-in/social` | Start Google OAuth (`provider: "google"`); answers `{ url, redirect: true }` | Public |
| GET (also POST) | `/api/auth/callback/google` | OAuth callback (Better Auth's `/callback/:id`; POST is for `form_post` providers) | Public |
| POST | `/api/auth/sign-out` | Sign out | session |
| GET | `/api/auth/get-session` | Current session; not rate limited ([auth/README.md §2](auth/README.md)). POST is registered too, but answers `405 METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED` because `session.deferSessionRefresh` is off | Public (`null` without one) |
| POST | `/api/auth/update-user` | Update own `name` / `image` | session |
| GET | `/api/auth/admin/list-users` | List and search users | `user:list` |
| POST | `/api/auth/admin/set-role` | Change a user's role | `user:set-role` + guard rules ([static-roles.md §7](auth/static-roles.md)) |
| POST | `/api/auth/admin/ban-user` / `unban-user` | Ban / unban | `user:ban` |
| POST | `/api/auth/admin/list-user-sessions` | A user's sessions; each session's `token` only for a caller with `session:revoke` ([auth/README.md §2](auth/README.md)). Server-side `auth.api.listUserSessions({ headers })` strips them the same way; server code that needs a token calls `internalAdapter.listSessions` deliberately | `session:list` |
| POST | `/api/auth/admin/revoke-user-session` / `revoke-user-sessions` | Revoke one / all sessions | `session:revoke` |
| POST | `/api/auth/admin/remove-user` | Delete a user | `user:delete` |

`set-role`, `ban-user`, `unban-user` and `remove-user` run under the user mutation lock (a PostgreSQL advisory lock, [static-roles.md §7](auth/static-roles.md)); their extra answers (`413 PAYLOAD_TOO_LARGE`, `503 USER_MUTATION_BUSY`) are in [auth/README.md §5](auth/README.md).

Every other admin-plugin path answers `404 NOT_FOUND` over HTTP, for every role including `super_admin` (DEC-032). In 1.7.18 that is `impersonate-user`, `stop-impersonating`, `get-user`, `create-user`, `update-user`, `set-user-password` and `has-permission`. Server-side `auth.api` calls are refused the same way, except `has-permission` without a `request`, which the `permission` macro calls (`auth.api.userHasPermission`).

`/api/api/auth/*` does not exist (404): the root app adds `/api`, the auth plugin adds `/auth`, and Better Auth's `basePath` is `/api/auth`.

OAuth failures that happen before the state is decoded (`state_not_found`, some `state_mismatch` cases) land on Better Auth's built-in `/api/auth/error` page: the API sets no `onAPIError.errorURL` ([auth/README.md §4](auth/README.md)).

### 3.2 Health: Public

- `GET /api/health` → **200** `{ "status": "ok", "db": "up", "redis": "up" | "down" | "disabled", "logStore": "up" | "down" | "disabled", "uptime": 12345 }`.
- **503** `{ "code": "SERVICE_UNAVAILABLE", "message": "A required dependency is down", "status": "degraded", "db": …, "redis": …, "logStore": …, "uptime": … }` when PostgreSQL is down, whatever Redis and the log store report.
- Redis being down never makes health fail: module caches read PostgreSQL, and Better Auth's rate limits and the per-user limits count in memory while it is down ([ARCHITECTURE.md §6](ARCHITECTURE.md)), so the API still serves. It reports `"redis": "down"` with status 200, and a load balancer keeps sending traffic.
- The log store being down never makes health fail (logging must not take the API down); it reports `"logStore": "down"` with status 200.
- `uptime` is whole seconds since the process started.
- Each dependency is `"up"`, `"down"` or `"disabled"` (not configured). `HealthService.dependencies()` is the one place that probes them. The three probes run together and each is bounded to 1 s and never rejects, so a report takes about 1 s at worst:
  - `db`: `probeDb()` from `utils/db`, a `select 1` on the shared pool. Always configured, so never `"disabled"`. Concurrent probes share the query in flight, so a stalled PostgreSQL holds one pool connection, not one per probe.
  - `redis`: `redis.probe()` (a `PING`, sent once more on a new connection when Redis had already closed the shared one: [ARCHITECTURE.md §6](ARCHITECTURE.md)), `"disabled"` on the memory fallback.
  - `logStore`: `probeLogStore()` from `utils/mongo`, `"disabled"` when `LOG_MONGO_URL` is empty.
- Logged at `debug`, so probes don't flood the log.

### 3.3 Me

| Method | Path | Option | Response | Errors |
|:---|:---|:---|:---|:---|
| GET | `/api/me/permissions` | `auth: true` | `{ "roles": ["admin"], "permissions": ["posts:read", …] }` | 401, 500 |

Used by the web app to hide UI the user can't use. Not cached on the server. Sent with `Cache-Control: no-store`, so no browser or proxy reuses one user's answer.

- `roles` are the caller's stored roles as Better Auth reads them (split on commas, nothing trimmed): `NULL` or empty is `["user"]`, and an unknown role is listed but grants nothing.
- `permissions` is the sorted union of what every held registry role grants, from the same compiled roles the `permission` macro checks, each `Permission` once.
- No session: `401 UNAUTHORIZED`. A failing session lookup is `500 INTERNAL_ERROR`, never 401.

### 3.4 Posts (F-04)

| Method | Path | Option | Body / query | Success | Errors |
|:---|:---|:---|:---|:---|:---|
| GET | `/api/posts` | `permission: 'posts:read'` | `?page&limit` | 200 list | 400, 401, 403 |
| GET | `/api/posts/:id` | `permission: 'posts:read'` | — | 200 post | 400, 401, 403, 404 `POST_NOT_FOUND` |
| POST | `/api/posts` | `permission: 'posts:write'` | `{ title, content, status? }` | 201 post | 400, 401, 403, 415, 429 |
| PATCH | `/api/posts/:id` | `permission: 'posts:write'`; author only unless `posts:manage_all` | any subset of the POST body | 200 post | 400, 401, 403, 404, 415, 429 |
| DELETE | `/api/posts/:id` | same as PATCH | — | 204 | 400, 401, 403, 404, 415, 429 |

- Post object: `{ id, authorId, title, slug, content, status, createdAt, updatedAt }`. `createdAt` and `updatedAt` are ISO 8601 strings on every path, cached or not.
- `title`: 3–`POSTS_TITLE_MAX_LENGTH` chars. `content`: 10–`POSTS_CONTENT_MAX_LENGTH` chars. The product owner chose to set both maximums per deployment: the variables are required, have no default, and a value below the minimum fails startup. The numbers themselves stay `TBD`. `status`: `draft` (default) or `published`.
- `slug` is generated from `title`, made unique with a short suffix on collision, not editable. Built as: accents folded, every run of characters other than `a-z0-9` becomes `-`, at most 64 characters, `post` when nothing is left. On collision, `-` plus 6 random `[a-z0-9]` is appended, so a slug has at most 71 characters. There are five attempts, the first without a suffix, then `500`. A title change keeps the slug.
- Fields outside the body schema (`slug`, `authorId`, …) are dropped before validation (Elysia's `normalize`), never written and never a 400. A PATCH with no writable field is `400` with `{ "path": "", "rule": "minProperties" }`; a field left out keeps its value.
- `id` must be a UUID: anything else is `400` `{ "path": "/id", "rule": "format" }`, not 404.
- List: newest first (`created_at`, then `id`, descending), every post whatever its author or status, since one cached page serves every caller. `page` is 1–10 000 (so OFFSET walks at most a million rows); a page past the end is `200` with `items: []`. Out-of-range `page`/`limit` name the field: `{ "path": "/limit", "rule": "maximum" }`.
- Ownership (PATCH, DELETE): a missing post is `404 POST_NOT_FOUND` before the ownership check; a caller who is not the author and holds no role granting `posts:manage_all` gets `403 FORBIDDEN` with the macro's message, logged with `sourceModule: "posts"`.
- As on every route, schema validation (the types and formats of the body, params and query) runs before the `permission` option, so such an invalid request is `400` even without a session. The list's `page`/`limit` range check runs after it, so an out-of-range value is `401` without a session and `403` without `posts:read` before it is `400`.
- POST, PATCH and DELETE pass the CSRF guard first (§1): a cross-site write is `403 CSRF_REJECTED` and a non-JSON body `415 UNSUPPORTED_MEDIA_TYPE`, both before validation and the `permission` option.
- Write limit: POST, PATCH and DELETE together allow 30 requests per user per minute, in windows aligned to the clock (`posts-write`, [ARCHITECTURE.md §10](ARCHITECTURE.md)). The 31st is `429 RATE_LIMITED` (§2) and changes nothing. Counted after the `permission` option, so a `401` or a permission `403` is not counted, and a `400` is answered before it; every other answer counts, `404` and the ownership `403` included. Each user has their own count, and `GET` is not limited. Allowed writes carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.
- List cache: `posts:list:{generation}:{page}:{limit}`, TTL `POSTS_CACHE_TTL` (default 60 seconds, set by the product owner). `{generation}` is a random token at `posts:generation:list` (same TTL), read before the page is loaded. Create, update and delete, once committed, delete the token and remove `posts:list:*` with `SCAN`, both at once; the next read starts a new token. A load that read the database before the write can then only store its page under the old token, so no request that starts after the write gets the old list, on any instance. Removing a user (`/api/auth/admin/remove-user`) deletes their posts by cascade and invalidates the same way after the removal commits (`onUserRemoved`, `utils/auth`). The cache fails open ([ARCHITECTURE.md §6](ARCHITECTURE.md)): with Redis down, lists are read from PostgreSQL and writes return their own success response (`201`, `200`, `204`), because the write is already committed and a `500` would make a client retry a `POST` that succeeded and create the post twice. Each failure is reported as `cache.unavailable` (`source: "posts"`, `operation`, `err`; no post content), at most once per 30 s per operation. If the token's deletion was not confirmed (a timeout may still have applied it), pages cached before the write may be served again once Redis is back, until they expire, at most `POSTS_CACHE_TTL` seconds later. If only the page sweep failed, no read asks for the old pages, and they expire on their own. Only `limit` 20 (the default, `CACHED_LIST_LIMITS` in `service.ts`) is cached; any other `limit` is read from PostgreSQL on every request, because each cached page size holds its own copy of every post. A page past the end is not cached, so high page numbers cannot fill the cache. The `permission` option runs before the cache is read, so a cached page is never served to a caller without `posts:read`.

### 3.5 Admin (F-03, DEC-024)

| Method | Path | Option | Response | Errors |
|:---|:---|:---|:---|:---|
| GET | `/api/admin/roles` | `permission: 'role:read'` | `{ "items": [{ "role": "admin", "label": "Admin", "description": "…", "permissions": ["posts:read", …] }] }` | 401, 403 |

`GET /api/admin/roles` lists every registry role in registry order, each with its compiled permissions sorted (the same `roles` Better Auth checks). It is the code-defined catalogue, not a paginated list: no `page`/`limit` and no `meta`. User, ban and session management are Better Auth's own `/api/auth/admin/*` endpoints (§3.1).

### 3.6 Feature flags (design only, DEC-029)

Not built in the MVP. Contract in [feature-flags/database-provider.md §6](feature-flags/database-provider.md).

## 4. Eden contract (DEC-018)

```ts
// apps/api/src/app.ts  (builds the root app, never listens; index.ts only listens)
// `@repo/api` resolves to this file (package.json `exports`), so `import type { App } from '@repo/api'` opens no port
export type App = typeof app
export type { Permission } from './utils/auth'

// apps/web/src/lib/api-origin.ts
export const apiOrigin = createIsomorphicFn()
  .server(() => process.env.API_INTERNAL_URL)   // SSR: straight to the API (unset: dev uses http://127.0.0.1:3000, a production build throws)
  .client(() => window.location.origin)         // browser: same origin, /api is proxied

// apps/web/src/lib/api.ts
const forwardedHeaders = createIsomorphicFn()
  .server(() => { const cookie = getRequestHeader('cookie'); return cookie ? { cookie } : {} })
  .client(() => ({}))
export const api = treaty<App>(apiOrigin(), { headers: () => forwardedHeaders(), fetch: { redirect: 'manual' } }).api
// usage: await unwrap(api.health.get())  → GET /api/health
```

- Request and response types come from `model.ts`; the web app never re-declares them.
- `error.status` and `error.value.code` drive error display. `unwrap()` in `apps/web/src/lib/api-error.ts` throws an `ApiError { status, code, message, details }`; a body that is not our error format (e.g. a proxy 502) becomes `INTERNAL_ERROR`, and a `fetch` that throws becomes `NETWORK_ERROR` (`network: true`). The Better Auth client's failures (`callAuthClient()`) are the same `ApiError`, with `source: 'auth'`.
- SSR forwards the `Cookie` header through treaty's `headers` option, a function called for each request. The server branches are compiled out of the browser bundle.
- Redirects are never followed (`fetch: { redirect: 'manual' }`), so the forwarded cookie is never resent to wherever a redirect points. The API modules never redirect, so Eden reports a 3xx as an error and `unwrap()` throws it.
- `unwrap()` takes the call itself, not its awaited result, so a `fetch` that throws becomes `NETWORK_ERROR`. Eden puts a path parameter into the URL as it is, so hooks encode it (`api.posts({ id: encodeURIComponent(id) })`).
- The Better Auth client (`apps/web/src/lib/auth-client.ts`) does the same during SSR through `ssr-cookies.ts`: it sends the visitor's cookie only to the API origin and passes the API's `Set-Cookie` back to the page response.
