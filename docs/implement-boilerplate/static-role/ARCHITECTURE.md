# ARCHITECTURE.md

## 1. System shape

```
Browser ──► web origin (https://app.example.com)
              │
              ├─ /*        → apps/web  (TanStack Start, SSR)
              └─ /api/*    → apps/api  (Elysia, modular monolith)
                               ├─ /api/auth/*   → Better Auth handler   (module "auth")
                               ├─ /api/health                           (module "health")
                               ├─ /api/me                               (module "me")
                               ├─ /api/posts                            (module "posts")
                               └─ /api/admin                            (module "admin")
                                     │
                     PostgreSQL 17 ◄─┼─► Redis 7
                     (app data)      │   (cache, sessions, rate limits)
                                     │
                                     └─► MongoDB 8 (log store, separate database)

apps/api ──stdout JSON──► terminal / container logs   (always)
         ──mongo sink───► MongoDB log_event            (production; optional in dev)
```

- **One origin** (DEC-020). Locally the web dev server proxies `/api` to the API. In production a reverse proxy (Caddy, Nginx or Traefik) sends `/api/*` to the API and everything else to the web app.
- During SSR the web app calls the API on `API_INTERNAL_URL` and **forwards the incoming `Cookie` header**.
- The API is stateless. Sessions, rate limits and cache live in Redis and PostgreSQL, so any number of API instances can run behind the proxy.
- MongoDB holds logs only. App data never goes there, and logs never go to PostgreSQL (DEC-034).

## 2. Monorepo

```
apps/
  api/        Elysia. Rules: apps/api/README.md
  web/        TanStack Start. Rules: apps/web/README.md
packages/
  shared/     pure types and helpers (no I/O)
  auth/       createAuth() server factory + auth client factory (no role definitions; DEC-023)
  db/         Drizzle schema, connection, migrations, seed (PostgreSQL only)
  ui/         shadcn/ui primitives and design tokens
docs/
  specs/eng/  specifications, canonical
  specs/id/   specifications, Indonesian translation
  prd/        original PRD, history only
docker-compose.yml        local PostgreSQL 17, Redis 7, MongoDB 8 (TASK-02)
docker-compose.test.yml   isolated stack for tests, other project name and ports (TASK-02)
infra/mongo/              MongoDB image build: mongo:8 plus init.js, which creates the log users (TASK-02)
.env.example              every variable in §7, placeholders only (TASK-02)
```

Dependency direction (never reversed):

```
apps/web ──► packages/{ui, shared, auth (client only)}  + `import type` from apps/api
apps/api ──► packages/{db, auth, shared}
packages/auth ──► packages/db (types), packages/shared
packages/ui, packages/shared ──► nothing internal
```

`apps/web` imports only **types** from `apps/api` (`App`, `Permission`), never runtime code.

## 3. Backend: modular monolith (DEC-002, DEC-003, DEC-008 to DEC-010, DEC-037)

```
apps/api/
  src/
    app.ts                 root app: prefix '/api', global utils, .use(mountModule(<module>)) each module, export type App; never listens (TASK-12)
    index.ts               imports app.ts and listens on PORT; the process entry point (TASK-12)
    env.ts                 reads and validates env once at startup
    modules/<name>/
      index.ts             controller: new Elysia({ name, prefix }).use(moduleScope('<name>'))
      service.ts           abstract class <Name>Service { static ... }
      model.ts             t schemas (body, query, params, response)
      permissions.ts       permission statement + role grants
    utils/
      auth/                roles, access, auth (CLI config), hooks, audit, macros
      logger/              pino instance, request plugin, moduleScope()
      telemetry/           emit(), event catalogue, scrubber, retention table, sinks (log, mongo, memory)
      cache/               get/set/del/wrap/delPattern on Redis, memory fallback
      error/               moduleError(), global error handler → { code, message }
      redis/               shared ioredis client
      mongo/               shared MongoDB client for the log store
  scripts/
    logs-prune.ts          manual retention (bun run logs:prune)
  tests/                   mirrors modules and utils (TESTING.md)
```

Initial modules: `health`, `me`, `posts`, `admin`. Rules in [apps/api/README.md](../../../apps/api/README.md).

## 4. Frontend: feature-based (DEC-011, DEC-018)

```
apps/web/
  src/
    routes/                TanStack file-based routing, thin
    features/<feature>/    components, hooks, lib, pages, index.ts
    components/            app-wide components (layout, shell)
    lib/api.ts             the one Eden client
    lib/api-origin.ts      API origin: API_INTERNAL_URL in SSR, same origin in the browser (TASK-14)
    lib/dev-api-url.ts     http://localhost:3000, the dev default shared by the proxy and dev SSR (TASK-14)
    lib/api-error.ts       ApiError + unwrap(): Eden { data, error } → thrown error with status and code (TASK-14)
    lib/auth-client.ts     Better Auth client (from packages/auth)
    lib/query-client.ts    QueryClient factory, one per request on the server (TASK-14)
    styles.css             tailwindcss + @repo/ui/styles.css (DESIGN.md §4)
  lint/                    oxlint JS plugin: feature-boundaries/no-deep-import (TASK-14)
  tests/                   mirrors features (TESTING.md)
  e2e/<feature>/           E2E flows (YAML)
```

Initial features: `health` (API status page at `/`, the skeleton's Eden check; TASK-14), `auth`, `profile`, `posts`, `admin`. Rules in [apps/web/README.md](../../../apps/web/README.md).

**Skeleton wiring (TASK-14).**
- `@/` maps to `src/` through `paths` in `apps/web/tsconfig.json`; Vite reads the same `paths` (`resolve.tsconfigPaths`), so typecheck, dev, build and `bun test` agree.
- Eden: `api = treaty<App>(apiOrigin(), { headers }).api`, so calls read `api.health.get()`. `App` is a type-only import from `@repo/api` (a devDependency). `elysia` is a web devDependency only to satisfy Eden's type peer; Eden's runtime does not import it.
- SSR cookie forwarding: the treaty `headers` option is a function, called for each request, that returns `{ cookie }` from `getRequestHeader('cookie')` (`@tanstack/react-start/server`) (TASK-14). `apiOrigin` and the header function are `createIsomorphicFn()`, so their server branches, `process.env` and the server import are compiled out of the client bundle (checked in the dev transform and `vite build` output).
- QueryClient: `router.tsx` creates one per router (per request on the server) and calls `setupRouterSsrQueryIntegration` (`@tanstack/react-router-ssr-query`), which wraps the app in `QueryClientProvider` and sends queries fetched in loaders to the browser. Defaults: `staleTime` 30 s, so SSR data is not refetched on hydration; no retry for a 4xx, one retry otherwise.
- Feature boundaries (R4): `bun run lint` (oxlint, `apps/web/.oxlintrc.json`) runs the JS plugin in `apps/web/lint/feature-boundaries.js`. It reports any import (static, re-export or dynamic, by `@/` alias or relative path) from a file in `src/` into `src/features/<x>/…` other than `<x>`'s `index.ts`, unless the file belongs to `<x>` itself. Files outside `src/` (tests) are not checked. `typescript-eslint` cannot be used: TypeScript 7 has no JavaScript compiler API.

## 5. Request flow

1. Reverse proxy sets `x-forwarded-for` and forwards `/api/*`.
2. `logger` plugin reads or creates `x-request-id`, creates the request's log context (`requestId`, `module: "core"`).
3. `/api/auth/*` → Better Auth handler (own rate limit, CSRF and origin checks); log context `module: "auth"`.
4. Other routes → `moduleScope` sets `module` to the owning module; the `auth` macro resolves the session and adds `userId`; `permission` checks grants (401/403 on failure).
5. Controller → service → Drizzle / cache.
6. Global error handler maps thrown errors to `{ code, message }` and emits `http.error` with `module`.
7. `onAfterResponse` emits one `http.request` with `module`.
8. Sinks: `log` writes the line to stdout synchronously; `mongo` buffers it and inserts in batches.

## 6. Caching and Redis

**Production uses Redis for everything below. It is mandatory:** with `NODE_ENV=production` the API refuses to start without `REDIS_URL`. The in-memory fallback exists only for dev and tests, because memory is per instance and would break rate limits and cache invalidation across instances.

| User | Key prefix | Notes |
|:---|:---|:---|
| Better Auth `secondaryStorage` (verification copies) | `auth:` + Better Auth's key (TASK-04) | DEC-019. Session entries are dropped: sessions live in PostgreSQL only (DEC-054, Proposed) (TASK-04) |
| Better Auth rate limit | managed by Better Auth | DEC-019 |
| Module cache | `<module>:<entity>:<part>`, e.g. `posts:list:1:20` | DEC-001; TTL per module; invalidated with `SCAN` |
| Feature flag change notice (when adopted) | pub/sub `feature-flags:changed` | DEC-029 |

Not cached: `GET /api/me/permissions` on the server (the web app caches it per session), Better Auth's cookie cache (off, so revocation and bans apply at once), HTTP responses at the proxy.

Without `REDIS_URL` (dev/test): rate limit and cache in memory, one `cache.fallback` event at startup. Sessions are in PostgreSQL either way (DEC-054, Proposed) (TASK-04).

**Implementation (TASK-07).**

- `utils/redis` uses Bun's built-in `RedisClient` (no extra package). It is created with `autoReconnect: false`, `enableOfflineQueue: false` and a 1 s `connectionTimeout`. Bun's defaults queue a command and retry in the background, which held a command for about 30 s while Redis was unreachable (checked on Bun 1.4.4). Instead a command fails at once and the next one reconnects. Every command also has a 1 s reply deadline: Bun never times out a reply on an open connection, so a Redis that accepts the connection and then stops answering would otherwise hold the request forever. When the deadline passes, the connection is closed (which rejects every command still waiting on it) and the next command reconnects. `closeRedis()` closes the client for graceful shutdown (TASK-13).
- `cache.fallback` is emitted once, by `utils/redis` at import, with `reason: "REDIS_URL is empty"`.
- `utils/cache` exposes `moduleCache('<module>', { ttlSeconds })` with `get/set/del/wrap/delPattern`. Keys are passed without the module prefix and stored as `<module>:<key>`. Patterns are Redis globs relative to that prefix, so a module cannot invalidate another module's keys. The TTL is a positive whole number of seconds, one per module. Values are stored as JSON. `wrap` returns the JSON round-tripped value on a miss too, so a hit equals the miss payload (a `Date` comes back as a string, and the return type says so). `delPattern` uses `SCAN … MATCH … COUNT 100`. The memory fallback matches patterns with a port of Redis's own glob matcher, so it deletes exactly the keys Redis would.
- Better Auth secondary storage (TASK-04) builds on the raw `cacheStore` export (string values, a TTL per call), not on `moduleCache`.
- A Redis error is not swallowed: the cache call rejects and the request fails through the global handler. `/api/health` reports `redis: up | down | disabled` from a `PING` with a 1 s timeout. `down` gives a 503, and `disabled` means the memory fallback.

## 7. Environment variables

| Variable | App | Required | Notes |
|:---|:---|:---|:---|
| `NODE_ENV` | api, web | yes | `development` / `test` / `production`. The API defaults to `development` when unset (a plain `bun run dev` has none) and fails startup on any other value (TASK-12) |
| `DATABASE_URL` | api, db scripts | yes | PostgreSQL. Also read by `drizzle-kit migrate` and the seed in `packages/db` (TASK-03). Must start with `postgres://` or `postgresql://`; with `NODE_ENV=test` it defaults to the test stack `postgres://app:app_dev@127.0.0.1:5442/app_test`, otherwise it is required (TASK-04). In the SaaS multi-tenant layer this is the `app_runtime` role, and `DATABASE_MIGRATION_URL` / `DATABASE_PLATFORM_URL` are added ([saas/architecture.md §4.2](../../specs/eng/saas/architecture.md)) |
| `REDIS_URL` | api | production | Empty = memory fallback (dev/test only). Must be a `redis://` or `rediss://` URL. `NODE_ENV=production` without it fails startup (TASK-07) |
| `LOG_MONGO_URL` | api | production | MongoDB log store; empty = `mongo` sink off (dev/test) |
| `LOG_MONGO_ADMIN_URL` | api (scripts) | for `logs:setup` / `logs:prune` | Admin log user; never read by the API process |
| `LOG_MONGO_DB` | api | no | Default `app_logs` |
| `LOG_MONGO_MIN_LEVEL` | api | no | Default `info`; `debug` events never reach MongoDB in production |
| `BETTER_AUTH_SECRET` | api | yes | ≥ 32 characters, `openssl rand -base64 32`. Never echoed in an error. Only `NODE_ENV=test` falls back to a fixed test value (TASK-04) |
| `BETTER_AUTH_URL` | api | production | Public **web** origin (same origin): an origin only, no path; HTTPS in production. Default `http://localhost:3001` in development and test (TASK-04) |
| `WEB_URL` | api | production | Value of `trustedOrigins`; same rules and default as `BETTER_AUTH_URL` (TASK-04) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api | production | Redirect URI `${BETTER_AUTH_URL}/api/auth/callback/google`. Both or neither; without them the Google provider is off, which only development and test allow (TASK-04) |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD` | db (seed) | dev | `db:seed` only (TASK-03); both required, no default password |
| `LOG_LEVEL` | api | no | `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`. Default `info` (`debug` in dev, `silent` when `NODE_ENV=test`); any other value fails startup (TASK-12) |
| `APP_VERSION` | api | no | Added to `app.started`; set by CI. Default `unknown` (TASK-12) |
| `POSTS_CACHE_TTL` | api | no | Seconds, a whole number ≥ 1; default 60, set by the product owner (TASK-08) |
| `POSTS_TITLE_MAX_LENGTH`, `POSTS_CONTENT_MAX_LENGTH` | api | yes | Post `title`/`content` maximum length in characters. No default: the product owner sets them per deployment; the numbers are `TBD`. Whole numbers, at least 3 and 10. Read by `readPostsLimits()` (`env.ts`) when the posts module loads, so the API does not start without them, while the scripts and `auth:generate`, which never load posts, do not need them (TASK-08) |
| `API_INTERNAL_URL` | web | yes | API URL for SSR, e.g. `http://localhost:3000` |
| `PORT` | api, web | no | API default `3000`; web dev `3001`, fixed with `strictPort` in `apps/web/vite.config.ts` (TASK-01); web production default *verify* TanStack Start's |

`PORT` and `API_INTERNAL_URL` must change together: the web dev proxy reads `API_INTERNAL_URL` and keeps targeting `:3000` otherwise.

**Loading the env in development (TASK-03).** One `.env` at the repo root is the only env file; there are no per-app `.env` files. Bun auto-loads `.env` only from the folder a script runs in (`apps/api`, `packages/db`), never from the repo root, so each script passes the root file explicitly:

| Process | How it gets the root `.env` |
|:---|:---|
| `apps/api` `dev` | `bun --watch --env-file=../../.env src/index.ts` (the script had lost the flag; restored in TASK-04) |
| `packages/db` `db:generate`, `db:migrate`, `db:seed` | `bun --env-file=../../.env …` (`drizzle-kit` runs as a child and inherits the loaded variables) |
| `packages/db` `auth:generate` | `bun --env-file=../../.env run auth generate …`: the CLI loads `apps/api/src/utils/auth/auth.ts`, which reads `env.ts`. The CLI runs on **Node** (jiti), not Bun, which is why `utils/redis` reads the client from the `Bun` global instead of importing `bun`; run on Bun, the generator writes a different file (it detects `defaultNow()` from `Function.toString`, which Bun's transpiler rewrites) (TASK-04) |
| `apps/web` dev server | `vite.config.ts` calls `loadEnv(mode, <repo root>, '')` for `API_INTERNAL_URL`, default `http://localhost:3000` |
| `docker compose` | Reads the root `.env` itself |

- A variable set in the shell wins over the same key in `.env` (Bun's `--env-file` behaves this way; an explicitly empty shell variable also wins).
- A missing `.env` file is not an error: Bun ignores a missing `--env-file` target (checked on Bun 1.4.4, exit code 0), so production and CI run the same scripts with real environment variables.
- With `--env-file`, Bun does not also load a `.env` from the app folder, so a stray per-app file is ignored.
- Web dev: Vite's bin runs on Node (shebang) as a child of Bun and inherits the variables `--env-file` loaded, so `vite.config.ts` and dev SSR read the same `process.env.API_INTERNAL_URL`, with no repo-root path in the config. Unset, both the proxy and dev SSR use `http://localhost:3000` (`src/lib/dev-api-url.ts`). A build bakes nothing in: the built server reads the real environment at runtime and throws `API_INTERNAL_URL is not set` when it first loads `src/lib/api.ts` if the variable is missing (`import.meta.env.PROD` removes the dev default from the build). Checked against stand-in APIs on three ports, for both `/api/health` through the proxy and the SSR HTML: value only in `.env`, a shell value over a different `.env` value (shell wins), and no `.env` at all (default) (TASK-14).
- Vite reads no `.env`, `.env.local` or `.env.[mode]` file anywhere (`envDir: false`, supported by Vite 8), so the root `.env` loaded by Bun is the only source and the API and web cannot disagree (TASK-14).

**Compose-only variables** (TASK-02; read by `docker-compose.yml` from the repo-root `.env`, never by the apps): `POSTGRES_PORT`, `REDIS_PORT` and `MONGO_PORT` set the host ports of the dev services, defaults `5432`, `6379` and `27017`. Change one when the default is taken on the machine, and change the matching URL above to the same port. Services are published on `127.0.0.1` only. `docker-compose.test.yml` uses fixed ports and ignores them ([TESTING.md §3](TESTING.md)).

Design-only variables (`SENTRY_*`, `POSTHOG_*`, `FEATURE_FLAGS_*`, `LOKI_*`) are listed in their own specs and are not read by the MVP.
