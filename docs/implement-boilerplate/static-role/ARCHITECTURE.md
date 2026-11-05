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
                     (app data,      │   (module cache, rate limits,
                      sessions)      │    verification copies)
                                     │
                                     └─► MongoDB 8 (log store, separate database)

apps/api ──stdout JSON──► terminal / container logs   (always)
         ──mongo sink───► MongoDB log_event            (production; optional in dev)
```

- **One origin** (DEC-020). Locally the web dev server proxies `/api` to the API. In production a reverse proxy (Caddy, Nginx or Traefik) sends `/api/*` to the API and everything else to the web app.
- During SSR the web app calls the API on `API_INTERNAL_URL` and **forwards the incoming `Cookie` header**.
- The API is stateless. Sessions live in PostgreSQL only (DEC-054); rate limits and cache live in Redis. Any number of API instances can run behind the proxy.
- MongoDB holds logs only. App data never goes there, and logs never go to PostgreSQL (DEC-034).

## 2. Monorepo

```
apps/
  api/        Elysia. Rules: apps/api/README.md
  web/        TanStack Start. Rules: apps/web/README.md
packages/
  shared/     pure types and helpers (no I/O)
  auth/       createAuth() server factory (no role definitions; DEC-023)
  db/         Drizzle schema, connection, migrations, seed (PostgreSQL only)
  ui/         shadcn/ui primitives and design tokens
scripts/      repo checks: check-test-folders.ts (every module and feature has its test folder), module-routes.ts
infra/mongo/  MongoDB image build: pinned mongo:8.3.13 plus init.js, which creates the log users, and the GLIBC_TUNABLES workaround
docs/
  implement-boilerplate/static-role/   this specification
docker-compose.yml        local PostgreSQL 17, Redis 7, MongoDB 8
docker-compose.dev.yml    Sokudo-managed development stores; API and web run locally
docker-compose.test.yml   isolated stack for tests, other project name and ports
.env.example              every variable in §7, placeholders only
```

`packages/auth` exports only the server factory. The web app's Better Auth client is `apps/web/src/lib/auth-client.ts`.

For this workspace, use Sokudo's Compose panel (or `docker_compose_up`) to start `docker-compose.dev.yml` with the managed engine and workspace overrides. Its MongoDB service uses the same pinned `mongo:8.3.13` image and `GLIBC_TUNABLES` setting as `infra/mongo` ([TESTING.md §6.3](TESTING.md#63-mongodb-on-the-hosted-runner)) with an inline bootstrap, avoiding Windows bind mounts and local build-context paths. The other Compose files keep the `infra/mongo` build. Setup and current verification limits are in the [root README](../../../README.md).

Dependency direction (never reversed):

```
apps/web ──► packages/{ui, shared, auth (client only)}  + `import type` from apps/api
apps/api ──► packages/{db, auth, shared}
packages/auth ──► packages/{db, shared}
packages/ui, packages/shared ──► nothing internal
```

`apps/web` imports only **types** from `apps/api` (`App`, `Permission`), never runtime code. `packages/auth` uses the Better Auth tables from `packages/db` for its Drizzle adapter. `packages/shared` exports nothing yet.

## 3. Backend: modular monolith (DEC-002, DEC-003, DEC-008 to DEC-010, DEC-037)

```
apps/api/
  src/
    app.ts                 root app: prefix '/api', logger + error handler, .use(mountModule(<module>)) each module, assertRouteAccess, export type App; never listens
    index.ts               imports app.ts, listens on PORT, installs graceful shutdown (§8), emits app.started, reports unknown roles; the process entry point
    env.ts                 reads and validates env once at startup
    modules/<name>/
      index.ts             controller: new Elysia({ name, prefix }).use(moduleScope('<name>'))
      service.ts           abstract class <Name>Service { static ... }
      model.ts             t schemas (body, query, params, response)
      permissions.ts       permission statement + role grants
    utils/
      auth/                roles, access, auth (CLI config), hooks, audit, macros, storage, user mutation lock
      db/                  the API's PostgreSQL pool, probeDb(), closeDb()
      logger/              pino instance, request plugin, moduleScope() / mountModule(), Better Auth logger
      telemetry/           emit(), event catalogue, scrubber, retention table, sinks (log, mongo, memory)
      cache/               moduleCache(): get/set/del/wrap/delPattern on Redis, memory fallback
      error/               moduleError(), global error handler → { code, message }
      redis/               shared client on Bun's built-in RedisClient
      mongo/               shared MongoDB client for the log store
      lifecycle/           graceful shutdown (§8)
  scripts/
    logs-setup.ts          log store indexes (bun run logs:setup)
    logs-prune.ts          manual retention (bun run logs:prune)
  tests/                   mirrors modules and utils, plus e2e/ and helpers/ (TESTING.md)
```

Initial modules: `health`, `me`, `posts`, `admin`. Rules in [apps/api/README.md](../../../apps/api/README.md).

## 4. Frontend: feature-based (DEC-011, DEC-018)

```
apps/web/
  src/
    routes/                TanStack file-based routing, thin
    features/<feature>/    components, hooks, lib, pages, index.ts
    components/            app-wide components (app shell, not-found page, form parts)
    lib/api.ts             the one Eden client
    lib/api-origin.ts      API origin: API_INTERNAL_URL in SSR, same origin in the browser
    lib/dev-api-url.ts     http://localhost:3000, the dev default shared by the proxy and dev SSR
    lib/api-error.ts       ApiError + unwrap(): Eden { data, error } → thrown error with status and code
    lib/auth-client.ts     Better Auth client with adminClient()
    lib/ssr-cookies.ts     SSR cookie bridge for the auth client (API origin only, both directions)
    lib/query-client.ts    QueryClient factory, one per request on the server
    lib/form.ts            TanStack Form helpers
    styles.css             tailwindcss + @repo/ui/styles.css (DESIGN.md §4)
  lint/                    oxlint JS plugin: feature-boundaries/no-deep-import
  tests/                   mirrors features (TESTING.md)
  e2e/<feature>/           E2E flows (YAML)
```

Initial features: `health` (API status page at `/`, the skeleton's Eden check), `auth`, `profile`, `posts`, `admin`. An unknown page renders `NotFoundPage` (the root route's `notFoundComponent`) with a link home. Rules in [apps/web/README.md](../../../apps/web/README.md).

**Skeleton wiring.**
- `@/` maps to `src/` through `paths` in `apps/web/tsconfig.json`; Vite reads the same `paths` (`resolve.tsconfigPaths`), so typecheck, dev, build and `bun test` agree.
- Eden: `api = treaty<App>(apiOrigin(), { headers }).api`, so calls read `api.health.get()`. `App` is a type-only import from `@repo/api` (a devDependency). `elysia` is a web devDependency only to satisfy Eden's type peer; Eden's runtime does not import it.
- SSR cookie forwarding: the treaty `headers` option is a function, called for each request, that returns `{ cookie }` from `getRequestHeader('cookie')` (`@tanstack/react-start/server`). The auth client uses `ssr-cookies.ts` for the same job and also passes the API's `Set-Cookie` back to the page. `apiOrigin`, the header function and the auth client's fetch hooks are `createIsomorphicFn()`, so their server branches, `process.env` and the server import are compiled out of the client bundle.
- QueryClient: `router.tsx` creates one per router (per request on the server) and calls `setupRouterSsrQueryIntegration` (`@tanstack/react-router-ssr-query`), which wraps the app in `QueryClientProvider` and sends queries fetched in loaders to the browser. Defaults: `staleTime` 30 s, so SSR data is not refetched on hydration; no retry for a 4xx, one retry otherwise.
- Feature boundaries (R4): `bun run lint` (oxlint, `apps/web/.oxlintrc.json`) runs the JS plugin in `apps/web/lint/feature-boundaries.js`. It reports any import (static, re-export or dynamic, by `@/` alias or relative path) from a file in `src/` into `src/features/<x>/…` other than `<x>`'s `index.ts`, unless the file belongs to `<x>` itself. Files outside `src/` (tests) are not checked. `typescript-eslint` cannot be used: TypeScript 7 has no JavaScript compiler API.

## 5. Request flow

1. Reverse proxy (or the Vite dev proxy, `^/api(/|$)` with `xfwd: true`) sets `x-forwarded-for` and forwards `/api/*`.
2. `logger` plugin reads or creates `x-request-id`, creates the request's log context (`requestId`, `module: "core"`).
3. `/api/auth/*` → Better Auth handler (own rate limit, CSRF and origin checks); log context `module: "auth"`. `set-role`, `ban-user`, `unban-user` and `remove-user` first take the user mutation lock ([auth/static-roles.md §7](auth/static-roles.md)).
4. Other routes → `moduleScope` sets `module` to the owning module; the `auth` macro resolves the session from PostgreSQL and adds `userId`; `permission` checks grants (401/403 on failure).
5. Controller → service → Drizzle / cache.
6. Global error handler maps thrown errors to `{ code, message }` (unknown routes → `404 NOT_FOUND`) and emits `http.error` with `module`.
7. `onAfterResponse` emits one `http.request` with `module`.
8. Sinks: `log` writes the line to stdout synchronously; `mongo` buffers it and inserts in batches.

## 6. Caching and Redis

**Production uses Redis for everything below. It is mandatory:** with `NODE_ENV=production` the API refuses to start without `REDIS_URL`. The in-memory fallback exists only for dev and tests, because memory is per instance and would break rate limits and cache invalidation across instances.

| User | Key prefix | Notes |
|:---|:---|:---|
| Better Auth `secondaryStorage`: verification copies and rate-limit counters | `auth:` + Better Auth's key | DEC-019. Session entries are dropped: sessions live in PostgreSQL only (DEC-054). `auth` is therefore not a valid cache module name |
| Module cache | `<module>:<key>`, e.g. `posts:list:<generation>:1:20` | DEC-001; TTL per module; invalidated with `SCAN` |
| Feature flag change notice (when adopted) | pub/sub `feature-flags:changed` | DEC-029, design only |

Not cached: `GET /api/me/permissions` on the server (the web app caches it per session), sessions (Better Auth's cookie cache is off, so revocation and bans apply at once), HTTP responses at the proxy.

Without `REDIS_URL` (dev/test): rate limit and cache in memory, one `cache.fallback` event at startup. Sessions are in PostgreSQL either way.

**Implementation.**

- `utils/redis` uses Bun's built-in `RedisClient` (no extra package), read from the `Bun` global so the module also loads under Node (the Better Auth CLI). It is created with `autoReconnect: false`, `enableOfflineQueue: false` and a 1 s `connectionTimeout`. Bun's defaults queue a command and retry in the background, which held a command for about 30 s while Redis was unreachable (checked on Bun 1.4.4). Instead a command fails at once and the next one reconnects.
- Every command goes through `Redis.command(run, timeoutMs = 1000)`: Bun never times out a reply on an open connection, so a Redis that accepts the connection and then stops answering would otherwise hold the request forever. When the deadline passes, the connection is closed (which rejects every command still waiting on it) and the next command reconnects. Never call the raw client directly. `closeRedis()` closes the client for graceful shutdown (§8).
- `cache.fallback` is emitted once, by `utils/redis` at import, with `reason: "REDIS_URL is empty"`.
- `utils/cache` exposes `moduleCache('<module>', { ttlSeconds })` with `get/set/del/wrap/delPattern`. Keys are passed without the module prefix and stored as `<module>:<key>`. Patterns are Redis globs relative to that prefix, so a module cannot invalidate another module's keys. The TTL is a positive whole number of seconds, one per module. Values are stored as JSON. `wrap` returns the JSON round-tripped value on a miss too, so a hit equals the miss payload (a `Date` comes back as a string, and the return type says so). `delPattern` uses `SCAN … MATCH … COUNT 100`, never `KEYS`. The memory fallback matches patterns with a port of Redis's own glob matcher, so it deletes exactly the keys Redis would.
- Better Auth secondary storage (`utils/auth/storage.ts`) builds on the raw `cacheStore` export (string values, a TTL per call), not on `moduleCache`. Besides `get/set/del` it uses `getAndDelete` (Redis `GETDEL`) for one-time verification values and `increment` for rate limits.
- **Fixed-window counter without Lua.** `CacheStore.increment(key, ttlSeconds)` backs Better Auth's rate limiter, which counts every `/api/auth/*` request (100 per 10 s by default, plus the stricter rules in [auth/README.md §2](auth/README.md)).
  - *Context:* the counter must be atomic and Lua is not allowed. Two separate commands are not enough: if the key expires between `SET … NX` and `INCR`, or a crash falls between `INCR` and `EXPIRE`, the counter is left without a TTL and locks the key out for good.
  - *Decision:* one native `MULTI`/`EXEC` transaction, `SET key 0 EX <ttl> NX` then `INCR key`. An absent key is created with its TTL before it is counted, and an existing counter keeps the TTL it was created with, whatever TTL a later call passes. Redis discards a transaction that is cut off before `EXEC`. The TTL must be a whole number of seconds, at least 1, and is checked before anything is sent: inside the transaction a refused `EX` fails only the `SET`, and the `INCR` would still create a counter with no TTL (checked on Redis 7.4). Each `EXEC` element is checked: an `INCR` error (not an integer, wrong type, overflow) is `does not hold a counter`, and a count that is not a safe JavaScript integer is refused. The memory store accepts exactly what Redis `INCR` accepts, counts in exact signed 64-bit integers as Redis does, and refuses the same TTLs.
  - *Isolation:* `Redis.transaction` runs on a second connection of its own, opened by the first transaction. On the shared connection, a `MULTI` would pull other callers' concurrent `GET`/`SET`/`PING` into the transaction. Bun 1.4.4 holds `MULTI` and `EXEC` until every earlier reply on that connection is in, and `MULTI`'s `OK` is awaited before anything is queued (an ACL can refuse `MULTI` alone, and commands sent with it would then run one by one, outside a transaction). Transactions that arrive while one is in flight are sent together as the next `MULTI`/`EXEC` (at most 1000 commands), and each caller gets its own slice of the replies. Failures before `EXEC` are shared by the batch: a command Redis refuses to queue, a refused `MULTI`, a timeout or a lost connection rejects every caller in it. Errors while `EXEC` runs stay per command.
  - *Failure handling:* every caller has a deadline (1 s by default). A transaction still queued when its deadline passes leaves the queue and never runs. Once sent, a deadline that passes or a lost connection means the outcome is unknown, since `EXEC` may have run. The transaction connection is then dropped, which fails the rest of that batch, and nothing is retried: a retry could count one request twice. Each batch runs under a deadline too, so the queue always drains.
  - *Trade-offs:* one extra Redis connection per API process. A single increment takes about 2.1 ms against 0.65 ms for a `GET` on the same link (0.6 ms Windows→Docker). Bursts batch: 5000 concurrent increments took about 46 ms, all unique and consecutive.
- A Redis error is not swallowed: the cache call rejects and the request fails through the global handler. `/api/health` reports `redis: up | down | disabled` from a `PING` with a 1 s timeout. `down` gives a 503, and `disabled` means the memory fallback.

## 7. Environment variables

`apps/api/src/env.ts` is the only API file that reads `process.env` (api R41). It validates every value once at startup and fails on a bad one, never echoing URLs or secrets.

| Variable | App | Required | Notes |
|:---|:---|:---|:---|
| `NODE_ENV` | api, web | yes | `development` / `test` / `production`. The API fails startup when it is unset, empty or any other value: there is no default, because development mode logs reset links and skips every production check |
| `TEST` | api | must be unset in production | Not read by the app itself. Better Auth treats any non-empty `TEST` as test mode and turns off its origin and CSRF checks, so `NODE_ENV=production` with `TEST` set fails startup |
| `TRUSTED_PROXIES` | api | production | Comma-separated IP addresses or CIDR ranges of the reverse proxies in front of the API, e.g. `127.0.0.1/32` for one nginx on the same host. Every entry is validated (IPv4 prefix ≤ 32, IPv6 ≤ 128, no zone IDs); a bad or empty entry fails startup. Exposed as `env.TRUSTED_PROXIES: string[]`, `[]` when unset in development and test. Not yet passed to Better Auth. Without trusted proxies Better Auth 1.7.15 accepts `x-forwarded-for` only when it holds a single IP, and otherwise puts every client in one shared `no-trusted-ip` rate-limit bucket |
| `PORT` | api, web | no | API: 1–65535, default `3000`. Web dev: ignored, fixed at `3001` with `strictPort` in `apps/web/vite.config.ts`. Web production: read by the production server (default not verified) |
| `DATABASE_URL` | api, db scripts | yes | PostgreSQL. Also read by `drizzle-kit migrate` and the seed in `packages/db`. Must start with `postgres://` or `postgresql://`; with `NODE_ENV=test` it defaults to the test stack `postgres://app:app_dev@127.0.0.1:5442/app_test`, otherwise it is required |
| `REDIS_URL` | api | production | Empty = memory fallback (dev/test only). Must be a `redis://` or `rediss://` URL. `NODE_ENV=production` without it fails startup |
| `LOG_MONGO_URL` | api | production | MongoDB log store writer; must start with `mongodb://` or `mongodb+srv://`. Empty = `mongo` sink off (dev/test); `NODE_ENV=production` without it fails startup |
| `LOG_MONGO_ADMIN_URL` | api (scripts) | for `logs:setup` / `logs:prune` | Admin log user; never read by the API process |
| `LOG_MONGO_DB` | api | no | Default `app_logs`; 1–63 letters, digits, `_` or `-` |
| `LOG_MONGO_MIN_LEVEL` | api | no | `trace` … `fatal`, default `info`; below `info` fails startup in production, so `debug` events never reach MongoDB there |
| `BETTER_AUTH_SECRET` | api | yes | ≥ 32 characters, `openssl rand -base64 32`. Never echoed in an error. Only `NODE_ENV=test` falls back to a fixed test value |
| `BETTER_AUTH_URL` | api | production | Public **web** origin (same origin): an origin only, no path; HTTPS in production. Default `http://localhost:3001` in development and test |
| `WEB_URL` | api | production | Value of `trustedOrigins`; same rules and default as `BETTER_AUTH_URL` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api | production | Redirect URI `${BETTER_AUTH_URL}/api/auth/callback/google`. Both or neither; without them the Google provider is off, which only development and test allow |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD` | db (seed) | dev | `db:seed` only; both required, no default password |
| `LOG_LEVEL` | api | no | `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent`. Default `info` (`debug` in development, `silent` when `NODE_ENV=test`); any other value fails startup |
| `APP_VERSION` | api | no | Added to `app.started` and `app.stopping`; set by CI. Default `unknown` |
| `POSTS_CACHE_TTL` | api | no | Seconds, a whole number ≥ 1; default 60, set by the product owner |
| `POSTS_TITLE_MAX_LENGTH`, `POSTS_CONTENT_MAX_LENGTH` | api | yes | Post `title`/`content` maximum length in characters. No default: the product owner sets them per deployment; the numbers are `TBD`. Whole numbers, at least 3 and 10. Read by `readPostsLimits()` (`env.ts`) when the posts module loads, so the API does not start without them, while the scripts and `auth:generate`, which never load posts, do not need them |
| `API_INTERNAL_URL` | web | production | API URL for SSR and the dev proxy, e.g. `http://localhost:3000`. Unset: dev uses `http://localhost:3000`; a production build throws `API_INTERNAL_URL is not set` |

**Request body limit.** The root app sets `serve.maxRequestBodySize` to `MAX_REQUEST_BODY_BYTES` (1 MiB, `apps/api/src/app.ts`), which Elysia merges into every `app.listen`. Bun's default is about 128 MB. A body whose `Content-Length` is over the limit gets `413` with an empty body and `Connection: close` from Bun itself, before any hook or handler runs, so it is never buffered or parsed. A chunked body (no `Content-Length`) does reach the hooks, but Bun stops reading it at the limit: the client gets Bun's `413`, and the app sees a truncated body that fails to parse, so it logs an `http.error` `400 VALIDATION_ERROR` and never reaches the `permission` macro. At most 1 MiB is buffered either way. The limit covers every route, including `/api/auth/*`, whose admin mutations keep their own 16 KB cap. Tests that call `app.handle()` bypass Bun.serve and therefore the limit; `tests/modules/posts/body-limit.test.ts` checks it on a real port.

`PORT` and `API_INTERNAL_URL` must change together: the web dev proxy and dev SSR read `API_INTERNAL_URL` and keep targeting `:3000` otherwise.

**Loading the env in development.** One `.env` at the repo root is the only env file; there are no per-app `.env` files. Bun auto-loads `.env` only from the folder a script runs in, never from the repo root, so each script passes the root file explicitly:

| Process | How it gets the root `.env` |
|:---|:---|
| root `dev:api` (run by root `dev`) | `bun --watch --env-file=.env apps/api/src/index.ts`. It lives in the root `package.json` because `bun --watch` only watches files under its working directory, and a root script runs from the repo root, so edits to `packages/*` (`db`, `auth`, `shared`) restart the API. Root `dev` is `bun run --parallel dev:api dev:web`, where `dev:web` is `bun run --filter @repo/web dev` |
| `apps/api` `dev` | `bun --watch --env-file=../../.env src/index.ts`, for running the API alone from `apps/api`. It does not watch `packages/*` (Bun prints "not in the project directory" warnings); use root `bun run dev` or `bun run dev:api` for that |
| `apps/api` `logs:setup`, `logs:prune` | `bun --env-file=../../.env scripts/…` |
| `packages/db` `db:generate`, `db:migrate`, `db:seed` | `bun --env-file=../../.env …` (`drizzle-kit` runs as a child and inherits the loaded variables) |
| `packages/db` `auth:generate` | `bun --env-file=../../.env run auth generate …`: the CLI loads `apps/api/src/utils/auth/auth.ts`, which reads `env.ts`. The CLI runs on **Node** (jiti), not Bun, which is why `utils/redis` reads the client from the `Bun` global instead of importing `bun`; run on Bun, the generator writes a different file (it detects `defaultNow()` from `Function.toString`, which Bun's transpiler rewrites) |
| `apps/web` dev server | `bun --env-file=../../.env vite dev`; `vite.config.ts` reads `process.env.API_INTERNAL_URL` (default `http://localhost:3000`) and sets `envDir: false`. There is no `loadEnv` |
| `docker compose` | Reads the root `.env` itself |

- A variable set in the shell wins over the same key in `.env` (Bun's `--env-file` behaves this way; an explicitly empty shell variable also wins).
- A missing `.env` file is not an error: Bun ignores a missing `--env-file` target (checked on Bun 1.4.4, exit code 0), so production and CI run the same scripts with real environment variables.
- With `--env-file`, Bun does not also load a `.env` from the app folder, so a stray per-app file is ignored.
- Web dev: Vite's bin runs on Node (shebang) as a child of Bun and inherits the variables `--env-file` loaded, so `vite.config.ts` and dev SSR read the same `process.env.API_INTERNAL_URL`, with no repo-root path in the config. Unset, both the proxy and dev SSR use `http://localhost:3000` (`src/lib/dev-api-url.ts`). A build bakes nothing in: the built server reads the real environment at runtime and throws `API_INTERNAL_URL is not set` when `apiOrigin()` first runs on the server if the variable is missing (`import.meta.env.PROD` removes the dev default from the build).
- Vite reads no `.env`, `.env.local` or `.env.[mode]` file anywhere (`envDir: false`, supported by Vite 8), so the root `.env` loaded by Bun is the only source and the API and web cannot disagree. Do not add `loadEnv` back: it kept a stale value across in-process Vite restarts.

**Compose-only variables** (read by `docker-compose.yml` from the repo-root `.env`, never by the apps): `POSTGRES_PORT`, `REDIS_PORT` and `MONGO_PORT` set the host ports of the dev services, defaults `5432`, `6379` and `27017`. Change one when the default is taken on the machine, and change the matching URL above to the same port. Services are published on `127.0.0.1` only. `docker-compose.test.yml` uses fixed ports and ignores them ([TESTING.md §3](TESTING.md)).

Design-only variables (`SENTRY_*`, `POSTHOG_*`, `FEATURE_FLAGS_*`, `LOKI_*`) are listed in their own specs and are not read by the MVP.

## 8. Graceful shutdown

`apps/api/src/index.ts` calls `installShutdown(app.server)` from `utils/lifecycle` after `listen`; importing `app.ts` or `utils/lifecycle` installs no listener. The first `SIGTERM` or `SIGINT` runs the shutdown plan once; later signals are logged (`Already shutting down; signal ignored`) and get the same result.

Steps run in this order (the order of [log-storage.md §3](observability/log-storage.md)), each with its own timeout in milliseconds (`SHUTDOWN_TIMEOUTS`). A failed or stalled step never skips the ones after it, so every client still gets closed:

| Step | Timeout | Fails when |
|:---|:---|:---|
| `announce`: emit `app.stopping` while every sink is still open | 100 | — |
| `server`: `stop()` refuses new connections at once and waits for in-flight requests (their after-commit callbacks included); then `stop(true)` closes what is left | 4000 + 500 | requests were still running at 4 s and were cut off |
| `telemetry.flush(3000)` | 3150 | the outcome is not `flushed` ([observability/README.md §7](observability/README.md)); any `mongo` drop since `app.stopping` counts, not just drops during the flush |
| `telemetry.close()` | 250 | — |
| `postgres` (`closeDb(850)`: postgres-js terminates busy connections at 850 ms), `redis` (`closeRedis()`), `logStore` (`closeLogStore()`), together | 1000 each | an error, a forced PostgreSQL close, or the timeout |

The worst case adds up to 9 s. Exit behaviour:

- **Clean shutdown, exit 0.** When every step succeeds, the log line is `Cleanup complete`, the exit code is set to 0 and the process ends on its own once nothing holds it open. That is the "no hanging connections" check.
- **Failed shutdown, exit 1.** When any step fails or times out (requests cut off, buffered events lost, a client that would not close), it logs `Shutdown finished with failures` with each step's status and exits 1 right after the last step, so an orchestrator never mistakes it for a clean one.
- **Watchdog, exit 1 at 9.5 s.** Started at the first signal, it forces exit 1 whatever is still running or holding the process open (a stalled request handler keeps running after its connection is closed, for example), so the process always ends in under 10 s. It is unavoidable when a handler or handle never settles, and kills whatever was still running.
- Failures are plain `logger` lines on stdout (`Shutdown step failed` / `Shutdown step timed out`, `Shutdown finished with failures`, `Shutdown deadline passed; forcing exit`); no new telemetry event, since the log store may be what failed.

Windows cannot deliver a real signal to another process, so the child-process tests trigger shutdown from inside the API process with `process.emit`; the real-signal tests run on Linux and macOS only (e.g. CI).
