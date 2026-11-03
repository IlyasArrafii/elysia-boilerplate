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
    index.ts               root app: prefix '/api', global utils, .use() each module, export type App
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
    lib/auth-client.ts     Better Auth client (from packages/auth)
  tests/                   mirrors features (TESTING.md)
  e2e/<feature>/           E2E flows (YAML)
```

Initial features: `auth`, `profile`, `posts`, `admin`. Rules in [apps/web/README.md](../../../apps/web/README.md).

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

**Production uses Redis for everything below. It is mandatory:** with `NODE_ENV=production` the API refuses to start without `REDIS_URL`. The in-memory fallback exists only for dev and tests, because memory is per instance and would break sessions, rate limits and cache invalidation across instances.

| User | Key prefix | Notes |
|:---|:---|:---|
| Better Auth `secondaryStorage` (sessions) | managed by Better Auth | DEC-019; sessions also stored in PostgreSQL |
| Better Auth rate limit | managed by Better Auth | DEC-019 |
| Module cache | `<module>:<entity>:<part>`, e.g. `posts:list:1:20` | DEC-001; TTL per module; invalidated with `SCAN` |
| Feature flag change notice (when adopted) | pub/sub `feature-flags:changed` | DEC-029 |

Not cached: `GET /api/me/permissions` on the server (the web app caches it per session), Better Auth's cookie cache (off, so revocation and bans apply at once), HTTP responses at the proxy.

Without `REDIS_URL` (dev/test): sessions only in PostgreSQL, rate limit and cache in memory, one `cache.fallback` event at startup.

## 7. Environment variables

| Variable | App | Required | Notes |
|:---|:---|:---|:---|
| `NODE_ENV` | api, web | yes | `development` / `test` / `production` |
| `DATABASE_URL` | api, db scripts | yes | PostgreSQL. Also read by `drizzle-kit migrate` and the seed in `packages/db` (TASK-03). In the SaaS multi-tenant layer this is the `app_runtime` role, and `DATABASE_MIGRATION_URL` / `DATABASE_PLATFORM_URL` are added ([saas/architecture.md §4.2](../../specs/eng/saas/architecture.md)) |
| `REDIS_URL` | api | production | Empty = memory fallback (dev/test only) |
| `LOG_MONGO_URL` | api | production | MongoDB log store; empty = `mongo` sink off (dev/test) |
| `LOG_MONGO_ADMIN_URL` | api (scripts) | for `logs:setup` / `logs:prune` | Admin log user; never read by the API process |
| `LOG_MONGO_DB` | api | no | Default `app_logs` |
| `LOG_MONGO_MIN_LEVEL` | api | no | Default `info`; `debug` events never reach MongoDB in production |
| `BETTER_AUTH_SECRET` | api | yes | ≥ 32 characters, `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | api | yes | Public **web** origin (same origin) |
| `WEB_URL` | api | yes | Value of `trustedOrigins` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api | yes | Redirect URI `${BETTER_AUTH_URL}/api/auth/callback/google` |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD` | db (seed) | dev | `db:seed` only (TASK-03); both required, no default password |
| `LOG_LEVEL` | api | no | Default `info` (`debug` in dev) |
| `APP_VERSION` | api | no | Added to `app.started`; set by CI |
| `POSTS_CACHE_TTL` | api | no | Seconds; default `TBD` |
| `API_INTERNAL_URL` | web | yes | API URL for SSR, e.g. `http://localhost:3000` |
| `PORT` | api, web | no | API default `3000`; web dev `3001`, fixed with `strictPort` in `apps/web/vite.config.ts` (TASK-01); web production default *verify* TanStack Start's |

`PORT` and `API_INTERNAL_URL` must change together: the web dev proxy reads `API_INTERNAL_URL` and keeps targeting `:3000` otherwise.

**Loading the env in development (TASK-03).** One `.env` at the repo root is the only env file; there are no per-app `.env` files. Bun auto-loads `.env` only from the folder a script runs in (`apps/api`, `packages/db`), never from the repo root, so each script passes the root file explicitly:

| Process | How it gets the root `.env` |
|:---|:---|
| `apps/api` `dev` | `bun --watch --env-file=../../.env src/index.ts` |
| `packages/db` `db:generate`, `db:migrate`, `db:seed` | `bun --env-file=../../.env …` (`drizzle-kit` runs as a child and inherits the loaded variables) |
| `apps/web` dev server | `vite.config.ts` calls `loadEnv(mode, <repo root>, '')` for `API_INTERNAL_URL`, default `http://localhost:3000` |
| `docker compose` | Reads the root `.env` itself |

- A variable set in the shell wins over the same key in `.env` (Bun and Vite both behave this way; an explicitly empty shell variable also wins).
- A missing `.env` file is not an error: Bun ignores a missing `--env-file` target (checked on Bun 1.4.4, exit code 0), so production and CI run the same scripts with real environment variables.
- With `--env-file`, Bun does not also load a `.env` from the app folder, so a stray per-app file is ignored.
- `loadEnv` only feeds `vite.config.ts`. It does not put the root `.env` into `process.env` of the web server, so SSR code that reads `process.env.API_INTERNAL_URL` in development needs its own wiring (TASK-14).
- Vite also reads `.env.local` and `.env.[mode]` from the repo root. Do not create them: Bun would not load them and the API and web would disagree.

**Compose-only variables** (TASK-02; read by `docker-compose.yml` from the repo-root `.env`, never by the apps): `POSTGRES_PORT`, `REDIS_PORT` and `MONGO_PORT` set the host ports of the dev services, defaults `5432`, `6379` and `27017`. Change one when the default is taken on the machine, and change the matching URL above to the same port. Services are published on `127.0.0.1` only. `docker-compose.test.yml` uses fixed ports and ignores them ([TESTING.md §3](TESTING.md)).

Design-only variables (`SENTRY_*`, `POSTHOG_*`, `FEATURE_FLAGS_*`, `LOKI_*`) are listed in their own specs and are not read by the MVP.
