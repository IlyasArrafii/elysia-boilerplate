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
                     PostgreSQL 17 ◄─┼─► Redis 8.10
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
docker-compose.yml        local PostgreSQL 17, Redis 8.10, MongoDB 8
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
      auth/                roles, access, auth (CLI config), hooks, audit, macros, storage, redis driver, user mutation lock
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
    lib/dev-api-url.ts     http://127.0.0.1:3000, the dev default shared by the proxy and dev SSR
    lib/api-error.ts       ApiError, the one API failure: unwrap() (Eden), callAuthClient() (Better Auth), network
    lib/auth-client.ts     Better Auth client with adminClient()
    lib/ssr-cookies.ts     SSR cookie bridge for the auth client (API origin only, both directions)
    lib/query-client.ts    QueryClient factory, one per request on the server
    lib/form.ts            TanStack Form helpers
    styles.css             tailwindcss + @repo/ui/styles.css (DESIGN.md §4)
  lint/                    oxlint JS plugin: feature-boundaries/no-deep-import
  server.ts                production server: serves dist/client, hands the rest to dist/server/server.js (§11)
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

1. The edge (Cloudflare) sets the visitor's IP in `CLIENT_IP_HEADER` (`cf-connecting-ip`) and forwards `/api/*` to the API, which is reachable through the edge alone (§9). In development the Vite dev proxy (`^/api(/|$)`) forwards it; no such header arrives, so Better Auth uses `127.0.0.1`.
2. `logger` plugin reads or creates `x-request-id`, creates the request's log context (`requestId`, `module: "core"`).
3. `/api/auth/*` → Better Auth handler (own rate limit, CSRF and origin checks); log context `module: "auth"`. `set-role`, `ban-user`, `unban-user` and `remove-user` first take the user mutation lock ([auth/static-roles.md §7](auth/static-roles.md)).
4. Other routes → `moduleScope` sets `module` to the owning module; the `auth` macro resolves the session from PostgreSQL and adds `userId`; `permission` checks grants (401/403 on failure). On a route with a per-user rate limit, the limit is counted next (429 past it, §10).
5. Controller → service → Drizzle / cache.
6. Global error handler maps thrown errors to `{ code, message }` (unknown routes → `404 NOT_FOUND`) and emits `http.error` with `module`.
7. `onAfterResponse` emits one `http.request` with `module`.
8. Sinks: `log` writes the line to stdout synchronously; `mongo` buffers it and inserts in batches.

## 6. Caching and Redis

**Production uses Redis for everything below. It is mandatory:** with `NODE_ENV=production` the API refuses to start without `REDIS_URL`. The in-memory fallback exists only for dev and tests, because memory is per instance and would break rate limits and cache invalidation across instances. The one exception is the rate-limit counters, Better Auth's and the per-user limits (§10), which count in a bounded memory counter while Redis fails (DEC-055, below).

| User | Key prefix | Notes |
|:---|:---|:---|
| Better Auth `secondaryStorage`: rate-limit counters only | `auth:` + Better Auth's key (`<ip>\|<path>`), or `auth:sha256:<hex>` for a key longer than 200 characters | DEC-019, DEC-055. The same key whichever driver `AUTH_REDIS_DRIVER` picks (DEC-057). Sessions (DEC-054) and verification values live in PostgreSQL only. `auth` and `ratelimit` are therefore not valid cache module names |
| Per-user rate limits (`userRateLimit`, §10) | `ratelimit:<name>:<userId>:<window>`, or `ratelimit:<name>:sha256:<hex>` when `<userId>:<window>` is longer than 200 characters | `<window>` is the window's number since the epoch (`floor(time / window length)`); TTL one window. E.g. `ratelimit:posts-write:<userId>:29900160` (2026-11-07 00:00 UTC, one-minute windows) |
| Module cache | `<module>:<key>`, e.g. `posts:list:<generation>:1:20` | DEC-001; TTL per module; invalidated with `SCAN` |
| Feature flag change notice (when adopted) | pub/sub `feature-flags:changed` | DEC-029, design only |

Not cached: `GET /api/me/permissions` on the server (the web app caches it per session), sessions (Better Auth's cookie cache is off, so revocation and bans apply at once), HTTP responses at the proxy.

Without `REDIS_URL` (dev/test): rate limit and cache in memory, one `cache.fallback` event at startup. Sessions are in PostgreSQL either way.

Memory is bounded: the Compose Redis runs with `--maxmemory 256mb --maxmemory-policy allkeys-lru` (`docker-compose.yml`, `docker-compose.dev.yml`; the test stack is unchanged). Every key the API writes has a TTL, so under pressure the least recently used key is evicted rather than writes being refused. Cache pages can be rebuilt; an evicted rate-limit counter cannot, and loses its accumulated count, so its window starts again. `volatile-lru` would protect nothing more: it spares only keys without a TTL, and the rate-limit counters have one. `maxmemory` bounds the dataset, not the whole Redis process. 256 MB is a development default, not a measured production size: size `maxmemory` per deployment on a managed Redis, and keep an eviction policy.

Module caches fail open: a Redis outage never fails a module route, because cached data can always be loaded again from PostgreSQL. A read that fails is a miss, so `wrap` returns what `load()` gives. A write that fails is skipped. An invalidation that fails resolves anyway, so a write that has committed keeps its own response: a `500` after a commit invites a retry that writes twice. The cost is staleness: when an invalidation fails, data cached before the write can be served again once Redis is back, until it expires, which is at most the module's TTL (`POSTS_CACHE_TTL` for posts). Every failure is reported as `cache.unavailable` (`source` is the module).

**Implementation.**

- `utils/redis` uses Bun's built-in `RedisClient` (no extra package), read from the `Bun` global so the module also loads under Node (the Better Auth CLI). It is created with `autoReconnect: false`, `enableOfflineQueue: false` and a 1 s `connectionTimeout`. Bun's defaults queue a command and retry in the background, which held a command for about 30 s while Redis was unreachable (checked on Bun 1.4.4). Instead a command fails at once and the next one reconnects.
- Every command goes through `Redis.command(run, timeoutMs = 1000)`: Bun never times out a reply on an open connection, so a Redis that accepts the connection and then stops answering would otherwise hold the request forever. When the deadline passes, the connection is closed (which rejects every command still waiting on it) and the next command reconnects. Never call the raw client directly. `closeRedis()` closes the client for graceful shutdown (§8).
- A command can also be written to a connection Redis has already closed (`CLIENT KILL`, its `timeout`, a restart): the close reaches Bun a moment later, so `connected` is still true, and the command fails with `ERR_REDIS_CONNECTION_CLOSED` without a reply. Nothing on the client can see that dead socket before reuse (measured on Bun 1.4.4 behind Docker port forwarding: the close came up to about 0.6 ms after a reply on another connection; one event-loop turn did not let Bun see it). `probe()` sends its `PING` once more, on a new connection and within the same deadline, so a Redis that is up is not reported down. `command()` never resends: the command may have run, and `INCR` or `MULTI` must not run twice. It fails, and the next command reconnects.
- Every Compose file runs Redis 8.10 (`redis:8.10.3-alpine`, pinned by digest) for the `redis` service. The API needs a server that answers Bun's RESP3 `HELLO` and supports every command it sends (`GET`, `SET … EX [NX]`, `INCR`, `MULTI`/`EXEC`, `GETDEL`, `DEL`, `SCAN`, `PING`, and with `AUTH_REDIS_DRIVER=official` also `EVAL` running `INCR` and `EXPIRE`, below): Redis 6.2 or later, or Valkey ([DEC-056](DECISIONS.md)). Nothing in the API names the server, so a deployment moves to Valkey without code changes: [VALKEY-MIGRATION.md](VALKEY-MIGRATION.md).
- `cache.fallback` is emitted once, by `utils/redis` at import, with `reason: "REDIS_URL is empty"`.
- `utils/cache` exposes `moduleCache('<module>', { ttlSeconds })` with `get/set/del/wrap/delPattern`. Keys are passed without the module prefix and stored as `<module>:<key>`. Patterns are Redis globs relative to that prefix, so a module cannot invalidate another module's keys. The TTL is a positive whole number of seconds, one per module. Values are stored as JSON. `wrap` returns the JSON round-tripped value on a miss too, so a hit equals the miss payload (a `Date` comes back as a string, and the return type says so). `delPattern` uses `SCAN … MATCH … COUNT 100`, never `KEYS`. The memory fallback matches patterns with a port of Redis's own glob matcher, so it deletes exactly the keys Redis would.
- **Fail open for module caches** (`createModuleCache`, above). Store calls fall into three groups:
  - *Reads* (`get`, and the read half of `wrap`): an error, or an open breaker, is a miss.
  - *Opportunistic writes* (`set`, and the write half of `wrap`): skipped on an error or while the breaker is open.
  - *Invalidations* (`del`, `delPattern`): always sent, even while the breaker is open. On failure they resolve without throwing, `delPattern` with 0, since SCAN deletes page by page and how many keys went is unknown.
  - *The breaker:* each module has its own 5 s breaker. A failed store call opens it, or restarts it, invalidations included, and any store call that answers closes it. After 5 s it is half-open: the next read or write is the one trial on Redis, and reads and writes that arrive while it is in flight skip Redis without waiting. A trial that fails opens it for another 5 s. A negative elapsed time (the clock moved back) counts as the window having passed. So a Redis that has stopped answering delays one read or write per window, by at most the 1 s reply deadline. Invalidations ask Redis every time, so on such a Redis each one can cost a write up to 1 s; posts sends its two together, so a write waits it out once.
  - *Reporting:* every failed call goes to the `onFailure` option, which defaults to `cacheFailureReporter(module)` (`utils/cache/report.ts`). That emits `cache.unavailable` (`source: "<module>"`, `operation: "get" | "set" | "del" | "delPattern"`) at most once per 30 s per operation, with a `suppressed` count. A throw from `onFailure` is ignored.
  - *Bugs still reject:* keys and values are checked before the breaker and the store, so an empty key, a value JSON cannot hold, and a `load()` that rejects all fail the call whether Redis is up or not.
  - *Posts:* a committed write deletes the list generation (`del`, an invalidation, so it is not skipped while the breaker is open) and, at the same time, sweeps `posts:list:*`. The next read starts a new generation ([API.md §3.4](API.md)).
- Better Auth secondary storage (`utils/auth/storage.ts`, DEC-055) is an allowlist on the raw `cacheStore` export, not on `moduleCache`: only `increment` reaches Redis, as `CacheStore.increment('auth:' + key, ttl)`. `get` and `getAndDelete` answer `null`, and `set` and `delete` do nothing, so sessions and verification values are read from PostgreSQL only (`storeSessionInDatabase` and `verification.storeInDatabase` must stay on, which `tests/utils/auth/storage.test.ts` checks). With `AUTH_REDIS_DRIVER=official` the same guard wraps Better Auth's own driver instead (below).
- **Fixed-window counter without Lua.** `CacheStore.increment(key, ttlSeconds)` backs Better Auth's rate limiter, which counts every `/api/auth/*` request (100 per 10 s by default, plus the stricter rules in [auth/README.md §2](auth/README.md)).
  - *Context:* the counter must be atomic and the API's own code sends no Lua. The one exception is the third-party `@better-auth/redis-storage` package, and only with `AUTH_REDIS_DRIVER=official` (DEC-057, below). Two separate commands are not enough: if the key expires between `SET … NX` and `INCR`, or a crash falls between `INCR` and `EXPIRE`, the counter is left without a TTL and locks the key out for good.
  - *Decision:* one native `MULTI`/`EXEC` transaction, `SET key 0 EX <ttl> NX` then `INCR key`. An absent key is created with its TTL before it is counted, and an existing counter keeps the TTL it was created with, whatever TTL a later call passes. Redis discards a transaction that is cut off before `EXEC`. The TTL must be a whole number of seconds, at least 1, and is checked before anything is sent: inside the transaction a refused `EX` fails only the `SET`, and the `INCR` would still create a counter with no TTL (checked on Redis 7.4 and 8.10). Each `EXEC` element is checked: an `INCR` error (not an integer, wrong type, overflow) is `does not hold a counter`, and a count that is not a safe JavaScript integer is refused. The memory store accepts exactly what Redis `INCR` accepts, counts in exact signed 64-bit integers as Redis does, and refuses the same TTLs.
  - *Isolation:* `Redis.transaction` runs on a second connection of its own, opened by the first transaction. On the shared connection, a `MULTI` would pull other callers' concurrent `GET`/`SET`/`PING` into the transaction. Bun 1.4.4 holds `MULTI` and `EXEC` until every earlier reply on that connection is in, and `MULTI`'s `OK` is awaited before anything is queued (an ACL can refuse `MULTI` alone, and commands sent with it would then run one by one, outside a transaction). Transactions that arrive while one is in flight are sent together as the next `MULTI`/`EXEC` (at most 1000 commands), and each caller gets its own slice of the replies. Failures before `EXEC` are shared by the batch: a command Redis refuses to queue, a refused `MULTI`, a timeout or a lost connection rejects every caller in it. Errors while `EXEC` runs stay per command.
  - *Failure handling:* every caller has a deadline (1 s by default). A transaction still queued when its deadline passes leaves the queue and never runs. Once sent, a deadline that passes or a lost connection means the outcome is unknown, since `EXEC` may have run. The transaction connection is then dropped, which fails the rest of that batch, and nothing is retried: a retry could count one request twice. Each batch runs under a deadline too, so the queue always drains.
  - *Trade-offs:* one extra Redis connection per API process. A single increment takes about 2.1 ms against 0.65 ms for a `GET` on the same link (0.6 ms Windows→Docker). Bursts batch: 5000 concurrent increments took about 46 ms, all unique and consecutive.
  - *Fail open for Better Auth (DEC-055):* `CacheStore.increment` itself still rejects on any failure. Better Auth's rate limiter reaches it through `createResilientCounter` (`utils/rate-limit/counter.ts`), which normalises the window to whole seconds (`max(1, ceil(window))`) and races the call against a 1 s deadline. On a rejection or a missed deadline it opens a 5 s breaker and counts in `createMemoryCounter`: a fixed window per key, the same semantics as Redis, at most 100 000 keys per process (expired keys swept once a minute, then the oldest-inserted evicted). While the breaker is open Redis is not asked. After 5 s it is half-open: the next request is the only one sent to Redis, and requests that arrive while it is in flight count in memory without waiting. If that trial answers, the breaker closes; if it fails or misses the deadline, the breaker opens for another 5 s. A refused connection fails at once, and a Redis that has stopped answering delays one request per breaker window, by at most 1 s. Before either counter sees a key, one longer than 200 characters is replaced by `sha256:` and its SHA-256 in hex: the path in `<ip>|<path>` is whatever the client sent (the limiter runs before routing), so this bounds the Redis key length, and Redis and memory count the same key. Shorter keys are kept as they are, so existing Redis counters carry on. The first failure of a breaker window emits `cache.unavailable` (`source: "auth"`, `operation: "increment"`), at most once per 30 s with a `suppressed` count. During an outage limits are per instance and reset on restart, and counts made in memory are not carried back to Redis.
- **Official driver (`AUTH_REDIS_DRIVER=official`, DEC-057).** `utils/auth/redis-driver.ts` picks the driver for the guard: `custom` (the default) is `createSecondaryStorage(cacheStore)` above, and `official` is `@better-auth/redis-storage` (`redisStorage({ client, keyPrefix: 'auth:' })`) on an ioredis connection of its own. The guard, the breaker, the memory fallback and the key bounding are the same for both. Only the Redis side differs:
  - *Commands:* one `EVAL` per count. The script runs `INCR`, then `EXPIRE <window>` when the count is 1. On connect: `AUTH` when the URL has credentials and `SELECT` when it names a database other than 0, nothing else (`enableReadyCheck: false` and `disableClientInfo: true` drop ioredis's `INFO` and `CLIENT SETINFO`). The package's `GETDEL`, `SETEX`, `SET`, `DEL` and `SCAN` are never called: the guard does not forward them.
  - *Same counters:* the package adds `auth:` after the guard has bounded the key, so both drivers count the same key in the same fixed window. A key that exists keeps its TTL with either. Switching drivers keeps the counters (checked on a real Redis by `tests/utils/auth/redis-driver.test.ts`).
  - *Client:* `lazyConnect` (importing `auth.ts`, as the Better Auth CLI does on Node, opens nothing; the first increment connects), `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `commandTimeout: 1000`, `connectTimeout: 1000`, `disconnectTimeout: 500` (*Shutdown*, below). ioredis reads client options from a query string in the URL and lets them win over these, so with `official` startup refuses a `REDIS_URL` that has one. Reconnects use ioredis's default backoff (50 ms more per attempt, at most 2 s), without end. With ioredis's defaults a command was held about 10.5 s (`GET`) to 32.5 s (an increment) while Redis was down. The guard's 1 s deadline bounded that anyway; these settings make the command itself fail at once.
  - *Errors:* an `'error'` listener reports connection errors as `cache.unavailable` (`source: "auth"`, `operation: "increment"`) through the guard's own reporter, so an outage is one event per 30 s whichever noticed it first. Without a listener ioredis prints `Unhandled error event` and a stack on every failed reconnect. The URL is never logged. ioredis keeps reconnecting on its own while Redis is down (at least every 2 s), and each failure reaches the listener, so with `official` the event also fires on an instance that gets no traffic, and its `suppressed` count includes those reconnect failures: it is not comparable with the count under `custom`.
  - *Shutdown:* `closeAuthRedis()` disconnects after the HTTP server stopped (§8). It sends no `QUIT`. A client closed between two reconnect attempts keeps ioredis's status `reconnecting`, but no attempt follows. What remains is ioredis's `disconnectTimeout` timer, which only the socket's `'close'` clears: after an outage that socket has already closed, so the timer runs out and holds the process up to 500 ms past `Cleanup complete` (with ioredis's default of 2 s, measured 1.95 s). On a peer that never answers the close, the same timer destroys the socket inside the step's 1 s. `tests/utils/lifecycle/process.test.ts` checks shutdown with Redis up and with it unreachable.
  - *Not covered:* `/api/health` probes the `utils/redis` connection only.
- A Redis error never fails a request. Module caches fail open (above), and the rate-limit counters, Better Auth's (above) and the per-user limits (§10), fall back to memory. All report `cache.unavailable`, from `source` `"<module>"`, `"auth"` or `"ratelimit:<name>"`. `/api/health` reports `redis: up | down | disabled` from a `PING` with a 1 s timeout. `down` still answers 200, because nothing fails without Redis; only PostgreSQL being down gives a 503. `disabled` means the memory fallback.

## 7. Environment variables

`apps/api/src/env.ts` is the only API file that reads `process.env` (api R41). It validates every value once at startup and fails on a bad one, never echoing URLs or secrets.

| Variable | App | Required | Notes |
|:---|:---|:---|:---|
| `NODE_ENV` | api, web | yes | `development` / `test` / `production`. The API fails startup when it is unset, empty or any other value: there is no default, because development mode logs reset links and skips every production check. The production web server (`apps/web/server.ts`) fails the same way; `bun run start` never sets it, and `bun run build` always builds with `production` (§11) |
| `TEST` | api | must be unset in production | Not read by the app itself. Better Auth treats any non-empty `TEST` as test mode and turns off its origin and CSRF checks, so `NODE_ENV=production` with `TEST` set fails startup |
| `CLIENT_IP_HEADER` | api | production | The one header the edge overwrites with the visitor's IP, e.g. `cf-connecting-ip`. Letters, digits and `-` only, stored lower-cased; anything else fails startup, and so does an empty value in production. Default `cf-connecting-ip` in development and test. Passed to Better Auth as `advanced.ipAddress.ipAddressHeaders: [CLIENT_IP_HEADER]` with no trusted proxies ([auth/README.md §2](auth/README.md)). Trustworthy only when the API is reachable through the edge alone (§9) |
| `HOST` | api, web | no | Address the API listens on (`app.listen({ port, hostname })`). Default `127.0.0.1`. An IPv4 or IPv6 address without brackets, or `localhost`; a host name, `[::1]` or `host:port` fails startup. `0.0.0.0` only inside a container whose API port is not published (§9). Clients use the bound address, not `localhost` (§9). The production web server binds it too, with the same rules and default; the web dev server ignores it |
| `PORT` | api | no | API: 1–65535, default `3000`. Both web servers ignore it: dev is fixed at `3001` with `strictPort` in `apps/web/vite.config.ts`, production listens on `WEB_PORT` |
| `WEB_PORT` | web | no | Port of the production web server (`apps/web/server.ts`, §11): 1–65535, default `3001`, the dev server's port; anything else fails startup. Not `PORT`, because the one root `.env` gives `PORT` to the API and both servers read that file on `bun run start`. A platform that assigns the port through `PORT` needs `WEB_PORT=$PORT` for the web process |
| `DATABASE_URL` | api, db scripts | yes | PostgreSQL. Also read by `drizzle-kit migrate` and the seed in `packages/db`. Must start with `postgres://` or `postgresql://`; with `NODE_ENV=test` it defaults to the test stack `postgres://app:app_dev@127.0.0.1:5442/app_test`, otherwise it is required |
| `REDIS_URL` | api | production | Empty = memory fallback (dev/test only). Must be a `redis://` or `rediss://` URL. `NODE_ENV=production` without it fails startup |
| `AUTH_REDIS_DRIVER` | api | no | Which driver counts Better Auth's rate limits in Redis, behind the same guard (DEC-057, §6): `custom` (default) or `official` (`@better-auth/redis-storage` on its own ioredis connection; needs `+eval +expire` from a restricted user, [VALKEY-MIGRATION.md §3.4](VALKEY-MIGRATION.md)). Any other value fails startup, and so does `official` without `REDIS_URL` or with a query string in it |
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
| `API_INTERNAL_URL` | web | production | API URL for SSR and the dev proxy, e.g. `http://127.0.0.1:3000`. Unset: dev uses `http://127.0.0.1:3000`; a production build throws `API_INTERNAL_URL is not set`. The production web server checks it at startup and refuses to start when it is unset or not an `http(s)` URL, without echoing it |

**Request body limit.** The root app sets `serve.maxRequestBodySize` to `MAX_REQUEST_BODY_BYTES` (1 MiB, `apps/api/src/app.ts`), which Elysia merges into every `app.listen`. Bun's default is about 128 MB. A body whose `Content-Length` is over the limit gets `413` with an empty body and `Connection: close` from Bun itself, before any hook or handler runs, so it is never buffered or parsed. A chunked body (no `Content-Length`) does reach the hooks, but Bun stops reading it at the limit: the client gets Bun's `413`, and the app sees a truncated body that fails to parse, so it logs an `http.error` `400 VALIDATION_ERROR` and never reaches the `permission` macro. At most 1 MiB is buffered either way. The limit covers every route, including `/api/auth/*`, whose admin mutations keep their own 16 KB cap. Tests that call `app.handle()` bypass Bun.serve and therefore the limit; `tests/modules/posts/body-limit.test.ts` checks it on a real port.

`PORT` and `API_INTERNAL_URL` must change together: the web dev proxy and dev SSR read `API_INTERNAL_URL` and keep targeting `:3000` otherwise.

**Loading the env in development.** One `.env` at the repo root is the only env file; there are no per-app `.env` files. Bun auto-loads `.env` only from the folder a script runs in, never from the repo root, so each script passes the root file explicitly:

| Process | How it gets the root `.env` |
|:---|:---|
| root `dev:api` (run by root `dev`) | `bun --watch --env-file=.env apps/api/src/index.ts`. It lives in the root `package.json` because `bun --watch` only watches files under its working directory, and a root script runs from the repo root, so edits to `packages/*` (`db`, `auth`, `shared`) restart the API. Root `dev` is `bun run --parallel dev:api dev:web`, where `dev:web` is `bun run --filter @repo/web dev` |
| root `start:api` (run by root `start`) | `bun --env-file=.env apps/api/src/index.ts`: the `dev:api` entry without `--watch` (§11) |
| `apps/api` `dev` | `bun --watch --env-file=../../.env src/index.ts`, for running the API alone from `apps/api`. It does not watch `packages/*` (Bun prints "not in the project directory" warnings); use root `bun run dev` or `bun run dev:api` for that |
| `apps/api` `logs:setup`, `logs:prune` | `bun --env-file=../../.env scripts/…` |
| `packages/db` `db:generate`, `db:migrate`, `db:seed` | `bun --env-file=../../.env …` (`drizzle-kit` runs as a child and inherits the loaded variables) |
| `packages/db` `auth:generate` | `bun --env-file=../../.env run auth generate …`: the CLI loads `apps/api/src/utils/auth/auth.ts`, which reads `env.ts`. The CLI runs on **Node** (jiti), not Bun, which is why `utils/redis` reads the client from the `Bun` global instead of importing `bun`; run on Bun, the generator writes a different file (it detects `defaultNow()` from `Function.toString`, which Bun's transpiler rewrites) |
| `apps/web` dev server | `bun --env-file=../../.env vite dev`; `vite.config.ts` reads `process.env.API_INTERNAL_URL` (default `http://127.0.0.1:3000`) and sets `envDir: false`. There is no `loadEnv` |
| `apps/web` `start` (root `start:web`, run by root `start`) | `bun --env-file=../../.env server.ts` (§11) |
| `docker compose` | Reads the root `.env` itself |

- A variable set in the shell wins over the same key in `.env` (Bun's `--env-file` behaves this way; an explicitly empty shell variable also wins).
- A missing `.env` file is not an error: Bun ignores a missing `--env-file` target (checked on Bun 1.4.4, exit code 0), so production and CI run the same scripts with real environment variables.
- With `--env-file`, Bun does not also load a `.env` from the app folder, so a stray per-app file is ignored.
- Web dev: Vite's bin runs on Node (shebang) as a child of Bun and inherits the variables `--env-file` loaded, so `vite.config.ts` and dev SSR read the same `process.env.API_INTERNAL_URL`, with no repo-root path in the config. Unset, both the proxy and dev SSR use `http://127.0.0.1:3000` (`src/lib/dev-api-url.ts`). A build bakes nothing in: the built server reads the real environment at runtime and throws `API_INTERNAL_URL is not set` when `apiOrigin()` first runs on the server if the variable is missing (`import.meta.env.PROD` removes the dev default from the build).
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
| `postgres` (`closeDb(850)`: postgres-js terminates busy connections at 850 ms), `redis` (`closeRedis()`), `authRedis` (`closeAuthRedis()`: the official auth driver's ioredis connection, a no-op with `custom`, §6), `logStore` (`closeLogStore()`), together | 1000 each | an error, a forced PostgreSQL close, or the timeout |

The worst case adds up to 9 s. Exit behaviour:

- **Clean shutdown, exit 0.** When every step succeeds, the log line is `Cleanup complete`, the exit code is set to 0 and the process ends on its own once nothing holds it open. That is the "no hanging connections" check.
- **Failed shutdown, exit 1.** When any step fails or times out (requests cut off, buffered events lost, a client that would not close), it logs `Shutdown finished with failures` with each step's status and exits 1 right after the last step, so an orchestrator never mistakes it for a clean one.
- **Watchdog, exit 1 at 9.5 s.** Started at the first signal, it forces exit 1 whatever is still running or holding the process open (a stalled request handler keeps running after its connection is closed, for example), so the process always ends in under 10 s. It is unavoidable when a handler or handle never settles, and kills whatever was still running.
- Failures are plain `logger` lines on stdout (`Shutdown step failed` / `Shutdown step timed out`, `Shutdown finished with failures`, `Shutdown deadline passed; forcing exit`); no new telemetry event, since the log store may be what failed.

Windows cannot deliver a real signal to another process, so the child-process tests trigger shutdown from inside the API process with `process.emit`; the real-signal tests run on Linux and macOS only (e.g. CI).

## 9. Client IP and origin exposure

The API takes the visitor's IP from one header set by the edge, `CLIENT_IP_HEADER` (default `cf-connecting-ip`), and from nothing else: Better Auth gets `advanced.ipAddress.ipAddressHeaders: [CLIENT_IP_HEADER]`, `ipv6Subnet: 64` and no trusted proxies. That IP keys the `/api/auth/*` rate limits ([auth/README.md §2](auth/README.md)) and is recorded in `session.ipAddress`, `audit.session.created` and `audit.auth.sign_in_failed`.

| The header holds | Client IP (Better Auth 1.7.15) |
|:---|:---|
| Exactly one valid IPv4 or IPv6 address | That address; IPv6 is grouped by its /64 for rate limits |
| A list (`1.1.1.1, 2.2.2.2`), anything that is not an IP, or nothing | None. In production every such request shares one rate-limit bucket per path, `no-trusted-ip`, `session.ipAddress` is empty and the audit `ip` is `unknown`. Development and test use `127.0.0.1` instead |

`x-forwarded-for` is never read. Cloudflare appends to an `x-forwarded-for` the client sent, so its left part is whatever the client chose, while `CF-Connecting-IP` always holds one IP, the client's, when no Worker is involved (Cloudflare docs, *HTTP request headers*). `apps/api/tests/utils/auth/config.test.ts` checks that a changing `x-forwarded-for` gets no fresh bucket, and that a two-IP header lands in `no-trusted-ip`.

**The invariant.** The header is only as trustworthy as the path to the API. If anything other than the edge can reach the API port, a client can send any `cf-connecting-ip`, get a fresh rate-limit bucket on every request, and write any IP into sessions and audit events. The API must therefore be reachable through the edge alone. `HOST` (default `127.0.0.1`) keeps the port off other machines unless the operator opens it.

| Deployment | `HOST` | What keeps the port private |
|:---|:---|:---|
| Cloudflare Tunnel on a host (`cloudflared` and the web server on the same machine) | `127.0.0.1` | The API listens on loopback only, and the tunnel is the only way in |
| Containers (Dokploy, openship) | `0.0.0.0` inside the API container: its loopback is not reachable from the proxy or web containers | The API port is **not published** on the host; only containers on the internal network (the proxy, the web SSR) reach it. The origin accepts only Cloudflare: a Cloudflare Tunnel, or a firewall that allows only [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) plus Authenticated Origin Pulls, so a request sent straight to the origin's IP is refused. A proxy between Cloudflare and the API must pass `cf-connecting-ip` through unchanged; check that it does |
| No Cloudflare | as above, by how the proxy reaches the API | Set `CLIENT_IP_HEADER` to a header the edge proxy **overwrites** on every request with the address the connection came from, never one it appends to or passes through. Verify this for the proxy in use by sending the header yourself through it; do not assume a proxy's default behaviour, Traefik's included. The API must still be reachable through that proxy alone |

**Point clients at the address `HOST` binds, not at `localhost`.** With the default, set the tunnel ingress to `http://127.0.0.1:<PORT>` and `API_INTERNAL_URL` to `http://127.0.0.1:<PORT>`. `localhost` resolves to `::1` first on Windows (and on Linux hosts that list `::1` first), where nothing listens, so each new connection is refused before the client falls back: about 200 ms for curl and 2 s for .NET's `Invoke-RestMethod`, measured on Windows 11, and an `ECONNREFUSED ::1` for a client that does not fall back. `HOST=localhost` is no fix: Bun binds only the first address `localhost` resolves to, which is `::1` on Windows.

Cloudflare settings: keep the **Remove visitor IP headers** managed transform off (it removes `CF-Connecting-IP`), and do not put a Worker in front of the API that rewrites the request: a Worker changes the header.

**Server-to-server calls carry no visitor IP.** The web SSR reaches the API at `API_INTERNAL_URL`, not through the edge, and forwards the cookie only, so its requests have no client IP. On a full page load it calls `GET /api/auth/get-session` from every route guard (not rate limited, for this reason) and `GET /api/auth/admin/list-users` from the `/admin/users` and `/admin/users/$userId` loaders. The latter share one `no-trusted-ip|/admin/list-users` bucket across all admins (Better Auth's default rule, 100 requests per 10 s). Client-side navigation runs the same loaders in the browser, through the edge, with the visitor's IP.

## 10. Per-user rate limits

Three layers limit requests, each keyed on what it can trust at that point:

| Layer | Counted per | Where | Limits |
|:---|:---|:---|:---|
| Edge (Cloudflare) | client IP | every request, before it reaches the API | Operator-configured; the only limit on `/api/auth/get-session` ([auth/README.md §7](auth/README.md#7-production-checklist)) |
| Better Auth | client IP and path | `/api/auth/*` only | sign-in 5 / 60 s, sign-up 3 / 60 s, otherwise 100 / 10 s ([auth/README.md §2](auth/README.md)) |
| `userRateLimit` (`utils/rate-limit`) | user ID | a module's expensive routes, after the session and the permission are checked | `POST`/`PATCH`/`DELETE /api/posts`: 30 per minute together, as `posts-write`. `GET` routes are not limited |

The edge and Better Auth cannot tell users apart behind one address (an office NAT, the web SSR); the per-user layer bounds what one signed-in account can do from any number of addresses.

**How it works.**

- [elysia-rate-limit](https://github.com/rayriffy/elysia-rate-limit) 4.6.3, pinned: the last release for Elysia 1.x (5.x needs Elysia 2). The plugin keeps no state of its own besides an in-memory default, which is not used: `createRateLimitContext` (`utils/rate-limit/context.ts`) is its store.
- **Fixed windows aligned to the clock.** Window `w = floor(time / length)` covers `[w × length, (w + 1) × length)` on every instance. The count is `CacheStore.increment('ratelimit:<name>:<userId>:<w>', length)`: the same `SET … EX … NX` + `INCR` transaction as Better Auth's counters (§6), with a TTL of one window. A user can therefore make up to twice the limit across a window boundary.
- `userRateLimit({ name, max, windowSeconds })` keys on the user resolved by the `permission` macro, never on the socket address, which is the proxy in production and would put every user in one bucket. Request `max + 1` in a window answers `429 RATE_LIMITED` ([API.md §2](API.md)) with `Retry-After` and `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds to the window's end); allowed requests carry the `RateLimit-*` headers too. The 429 is returned, not thrown, so it is logged as `http.request` with status 429 and emits no `http.error`.
- **Where it is mounted.** Inside the `.guard({ permission })` that declares the limited routes' permission, as the guard's first `.use()`. The guard's `permission` resolves before the limiter's `beforeHandle`, so a 401 or a permission 403 is never counted and every counted request has a user. A 403 from the service (a writer editing someone else's post) is answered by the handler, after the limiter, and is counted. A route's own `permission` option resolves *after* the limiter (checked on Elysia 1.4.30), which would then find no user and count nothing: the routes in the guard carry no `permission` of their own. Never on `/api/auth/*`.
- **What is counted.** Every request that reaches the limiter, whatever the handler answers (`countFailedRequest: true`), so a 404 for a missing post counts. Body, query and params validation runs before the macro, so a `400` is answered before the limiter and never counted. The plugin also counts parse errors, validation errors and 404s in an `onError` hook of its own, which Elysia runs twice on a guarded route, so on its own the plugin counts a handler 404 three times. The global error handler (`utils/error`) is mounted before every module and answers every error first, so that hook never runs in this app and a handler 404 is counted once (`tests/utils/rate-limit/index.test.ts` checks both, on Elysia 1.4.30). Were it to run (another error hook in front, or none), it calls the key generator before any macro resolved the user: the generator answers `unresolved` instead of throwing, which would turn a 400 into a 500, and `skip` lets `unresolved` through uncounted.
- **Nothing is refunded.** The context's `decrement`, `reset` and `kill` do nothing: a `DECR` on a key that had expired would create a counter without a TTL.
- **Redis down.** The count goes through `createResilientCounter` (§6): a 1 s deadline, a 5 s breaker with one trial call, and a bounded memory counter per limiter and per instance meanwhile. The prefix is added after the counter has bounded the key, so a hashed key stays under `ratelimit:<name>:`. The first failure of a breaker window emits `cache.unavailable` with `source: "ratelimit:<name>"`, at most once per 30 s. During an outage each instance limits on its own and counts are not carried back to Redis; nothing answers 500.
- **One limiter per set of numbers.** The plugin registers each limiter as an Elysia plugin named `elysia-rate-limit` with the seed `<max>:<duration>:<scoping>`, and Elysia keeps only the first plugin with a given name and seed in an instance: a second limiter with the same numbers in the same chain, or in a guard of a module that already uses one, is dropped without a word (checked on Elysia 1.4.30). `userRateLimit` therefore refuses, when it is built, a second name with the same `max` and `windowSeconds`, and other numbers for a name it has seen. Building the same limiter again is allowed and shares its counters; build it once and `.use()` it wherever it applies. Used in two guards of one module, it limits the routes of both, with one count per user across them, and it does not reach a sibling guard or module routes that do not use it (checked on Elysia 1.4.30).
- `DEBUG=elysia-rate-limit*` makes the plugin print each client key, that is user IDs, to stderr, outside the logger and its redaction. Never set it in production.

**Trade-offs.** One Redis transaction (about 2 ms) per limited request. Limits count per instance while Redis is down. A route test that writes more than a limit allows in one window clears the module's counters in `beforeEach` (the test store is in memory); every limited module has a route test for request `max + 1` ([apps/api/README.md §11](../../../apps/api/README.md)).

## 11. Production build and start

| Root command | What it runs |
|:---|:---|
| `bun run build` | `vite build` in `apps/web` (`bun run --filter @repo/web build`), always a production build (`NODE_ENV` below). The API has no build step |
| `bun run start` | `start:api` and `start:web` together (`bun run --parallel`, like `dev`). When one fails (non-zero exit), Bun stops the other; one that exits 0 leaves the other running |
| `bun run start:api` | `bun --env-file=.env apps/api/src/index.ts` |
| `bun run start:web` | `apps/web` `start`: `bun --env-file=../../.env server.ts` |

`bun run start` is for trying the build on one machine. In a deployment, the supervisor (container runtime, systemd, …) runs each server's command itself, one process per server, so its `SIGTERM` reaches the server directly. Through `--parallel` and `--filter` that is not checked: Bun 1.4.4 on Windows reported the stopped script as `Signaled: SIGINT`, and nobody has checked on Linux which signal reaches the servers, and so whether the API runs its §8 shutdown.

**Web.** `vite build` (TanStack Start 1.169.4 on Vite 8, no Nitro) writes `apps/web/dist/client/` (the browser assets, all under `assets/` with content-hashed names) and `apps/web/dist/server/server.js`. The default export of `server.js` is `{ fetch(request) }`, which renders pages and server routes but never serves `dist/client`. `apps/web/server.ts` is the production server around it, on `Bun.serve`:

- **Assets.** A `GET` or `HEAD` for a file of `dist/client` gets that file, with `Cache-Control: public, max-age=31536000, immutable` under `/assets/` and `no-cache` elsewhere. The file list is read once at startup and each request is looked up in it, so no path can reach a file outside `dist/client`. Every other request goes to `server.js`, which answers an unknown path with the not-found page (404).
- **Never put files in `apps/web/public/assets/`.** Vite copies `public/` into `dist/client` unchanged, so such a file would get the year-long `immutable` header under a name that never changes. The header is safe only for Vite's own output, whose names carry a content hash.
- **No `/api` proxy.** In production the edge sends `/api/*` to the API (DEC-020, §1). Sent to the web port, `/api/*` gets the not-found page.
- **Startup checks.** These run in order, and each failure prints one line and exits 1. First, the build must exist (``No web build in …/apps/web/dist: run `bun run build` first``). Then `NODE_ENV` must be `development`, `test` or `production`. `API_INTERNAL_URL` must be an `http(s)` URL (it is never echoed). `WEB_PORT` and `HOST` must be valid (§7). Last, the address must be free (``127.0.0.1:3001 is already in use: stop the other server (`bun run dev` uses the same ports) or set WEB_PORT``).
- **Port.** `WEB_PORT`, never `PORT` (§7). A hosting platform that assigns the port through `PORT` needs `WEB_PORT=$PORT` for the web process.
- **Request bodies.** Capped at 1 MiB (`MAX_REQUEST_BODY_BYTES`, the API's limit) instead of Bun's ~128 MB. A larger `Content-Length` gets Bun's `413` before `server.js` runs. Nothing in the app reads a body today; the cap is there for server routes added later.
- **Errors.** `development: false` is set on `Bun.serve`. An unhandled error therefore gets a plain `500`, never Bun's error page with a stack trace, whatever `NODE_ENV` is.
- **Shutdown.** On the first `SIGTERM` or `SIGINT`, `stop()` refuses new connections and waits up to 4 s for in-flight requests; idle keep-alive connections do not hold it. After that, `stop(true)` closes the rest and gets at most 500 ms, so the process is gone within 4.5 s of the signal. The exit code is 0 when every request finished and 1 when some were cut off. `tests/server.test.ts` checks both exit codes and the keep-alive case on every platform by sending the signal with `process.emit` from inside the server; the real-signal test runs on Linux and macOS only, because Windows cannot deliver one.
- **Dependencies.** `server.js` imports React, the router and the other dependencies at runtime from `apps/web/node_modules` (they are not bundled), so the server runs where `bun install` ran.
- **Build output.** `apps/web/dist/` and `apps/web/.tanstack/` are git-ignored. The build also regenerates `src/routeTree.gen.ts`. On a `core.autocrlf=true` checkout, git then shows that file as modified even when its content is unchanged.

**API.** There is no build: `start:api` runs `src/index.ts` with Bun, like `dev:api` but without `--watch`. Bun runs TypeScript directly, and the workspace packages (`@repo/db`, `@repo/auth`, `@repo/shared`) export TypeScript source. A bundle would also break the logger in development, which loads `pino-pretty` by name in a worker thread. It would add a build step that can fail and would gain nothing at runtime. Like the web server, the API therefore runs from the repo with its `node_modules`.

**`NODE_ENV`.**

- **Build: always `production`.** `vite build` keeps a `NODE_ENV` that is already set. A shell or build machine with `NODE_ENV=development` or `test` would then ship React's development build, and an `apiOrigin()` that falls back to `http://127.0.0.1:3000` instead of throwing. So `vite.config.ts` sets `NODE_ENV=production` when the command is `build`; Vite reads it only after loading that file. A `NODE_ENV=production vite build` script prefix is not enough: under `bun run` (Bun 1.4.4, Windows), Vite still saw the outer value. `tests/vite.config.test.ts` guards this.
- **Start: never set by the scripts.** It comes from the environment or the root `.env`. React and the router in `server.js` are not bundled, so they choose their production or development builds from it at runtime: with the development `.env`, pages are server-rendered by React's development build while the browser runs the production client.

**Trying it locally.**

- **With the development `.env`** (`NODE_ENV=development`), run `bun run build`, then `bun run start`. The built web app is served on `http://localhost:3001` (`WEB_PORT`) and the API on `PORT`. Server-rendered pages load and call the API through `API_INTERNAL_URL`, and `/api/health` answers on the API port. With no edge in front, browser calls to `/api/*` on the web port get the not-found page, so sign-in, mutations and client-side loaders fail. Use `bun run dev` to click through the app, or put an edge in front (next item). `bun run dev` uses the same ports: stop it first, or set different `PORT`, `API_INTERNAL_URL` and `WEB_PORT` values in the shell.
- **With `NODE_ENV=production`**, the API refuses the development values (§7). `BETTER_AUTH_URL` and `WEB_URL` must be `https` origins, and `REDIS_URL`, `LOG_MONGO_URL`, `CLIENT_IP_HEADER` and the Google client must be set. Use a production-like `.env`, or set the same values in the shell, which wins over the file. A browser session also needs an HTTPS edge on that origin, which sends `/api/*` to the API and everything else to the web server, as in production. Without the edge, server-rendered pages and `/api/health` still work.
