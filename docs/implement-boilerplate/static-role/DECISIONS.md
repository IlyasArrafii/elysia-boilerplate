# Architecture Decisions

Every significant decision the boilerplate follows is recorded here. Decisions are never changed silently: a revision is a new entry that names the entry it replaces. Numbers are stable because code and documents cite them; a project built on the boilerplate adds its own entries after the highest number.

Numbers missing from the sequence belonged to designs outside this boilerplate, or were superseded by an entry kept here. They are in [docs/specs/eng/DECISIONS.md](../../specs/eng/DECISIONS.md).

**Status values**
- **Answered**: approved by the product owner.
- **Decided (lead)**: decided by the tech lead inside constraints the product owner already approved. The product owner can veto it; until then it is binding.
- **Proposed**: a recommendation waiting for an answer. Do not implement.

---

## DEC-001: Caching strategy

**Status:** Answered. Clarified by DEC-034 (production).

- **Decision:** Redis is the central cache, so API instances can scale horizontally. In dev/test without Redis, an in-memory fallback is used. In production Redis is mandatory ([ARCHITECTURE.md §6](ARCHITECTURE.md)).

## DEC-002: Module boundaries

**Status:** Answered

- **Decision:** Follow Elysia's official "basic" modular-monolith pattern. Modules talk only through exported services.

## DEC-003: Module shape

**Status:** Answered

- **Decision:** One Elysia plugin per module, each with its own route prefix, composed in the root app.

## DEC-004: Auth feature scope

**Status:** Answered

- **Decision:** Email/password and Google OAuth, plus role management with roles and permissions per module.

## DEC-005: Role and permission model

**Status:** Answered

- **Decision:** Better Auth's admin plugin with access control is the single source of truth for roles and permissions.

## DEC-006: API route prefix

**Status:** Answered (Q1)

- **Decision:** All routes live under `/api` with no version segment. The prefix is written once in the root app (`new Elysia({ prefix: '/api' })`). Modules declare only their own prefix (`/posts`, `/admin`).
- **Trade-off:** A future breaking change needs an `/api/v2` group next to the existing routes.

## DEC-007: Auth endpoints

**Status:** Answered (Q2)

- **Decision:** Better Auth's handler is mounted as-is at `/api/auth/*` with email/password and Google OAuth. No custom `/api/auth/register` or `/api/auth/login` wrappers. Configuration follows the `better-auth-best-practices` and `better-auth-security-best-practices` skills ([auth/README.md](auth/README.md)).
- **Trade-off:** Responses and error codes on `/api/auth/*` use Better Auth's format, not ours.

## DEC-008: Backend module files

**Status:** Answered (Q3)

- **Decision:** `apps/api/src/modules/<name>/{index,service,model,permissions}.ts`. `index.ts` is the controller, `model.ts` holds `t` schemas, `permissions.ts` holds the module's permission statement and role grants (DEC-023).

## DEC-009: Service style

**Status:** Answered (Q4)

- **Decision:** `abstract class <Name>Service` with `static` methods only. Services throw business errors with `moduleError(...)` (DEC-037). Other modules call only this service.

## DEC-010: Permission guard

**Status:** Answered (Q5)

- **Decision:** An Elysia macro on the named plugin `authGuard` (`apps/api/src/utils/auth/macros.ts`, exported from `apps/api/src/utils/auth/index.ts`), which every controller with protected routes `.use()`s (`health`, which is Public, does not). Routes declare `{ permission: 'posts:read' }` or `{ auth: true }`; the macro resolves `user` and `session` into the context. Default deny: `assertRouteAccess` (`macros.ts`, next to `PUBLIC_ROUTES`), wrapped around the root app in `apps/api/src/app.ts`, fails startup on any route that declares neither option and is not listed in `PUBLIC_ROUTES`.

## DEC-011: Frontend structure

**Status:** Answered (Q6)

- **Decision:** `apps/web/src/features/<feature>/{components,hooks,lib,pages,index.ts}`. Route files in `src/routes/` stay thin. App-wide components in `src/components/`, shadcn-style primitives in `packages/ui`.

## DEC-012: Feature flags are design only

**Status:** Answered. Extended by DEC-029 and DEC-038.

- **Decision:** Feature flags use the OpenFeature standard, designed in [feature-flags/README.md](feature-flags/README.md). No OpenFeature package is installed.

## DEC-013: Logging with pino, no OpenTelemetry

**Status:** Answered (Q7)

- **Decision:** pino, no OpenTelemetry. JSON to stdout; `pino-pretty` only in dev. Correlation uses a request ID (`x-request-id`), not a trace ID.
- **Trade-off:** No distributed tracing and no automatic Postgres/Redis spans. Can be added later as a new sink without touching callers (DEC-014).

## DEC-014: Manual telemetry events with pluggable sinks

**Status:** Answered (Q7/Q8)

- **Decision:** Anything that must be findable later goes through `telemetry.emit(event, payload)` against a typed event catalogue; sinks decide where events go ([observability/README.md](observability/README.md)). Plain technical lines use pino directly (`log` in a request, `logger` outside one) and reach stdout only.
- **Trade-off:** One small layer to maintain. In return, adding or swapping a destination is one new sink file and callers do not change.

## DEC-015: Where observability data is viewed

**Status:** Answered (Q8). Updated by DEC-034.

- **Decision:** In dev, logs are read in the terminal (pretty-printed). In production, telemetry events are stored in MongoDB (DEC-034) and queried there. No metrics SDK: latency and error rate come from `http.request` events. Frontend telemetry is out of scope.

## DEC-016: Audit log

**Status:** Answered (Q9)

- **Decision:** `audit.*` telemetry events are emitted by Better Auth's `databaseHooks`, `hooks.before` (blocked endpoints) and `hooks.after` (failed sign-ins), by the API's CSRF guard (`audit.csrf.rejected`) and by `bun run role:set` (`audit.user.role_changed` with `actorId: "cli"`). They are stored with every other event in the MongoDB log store (kind `audit`, 365-day retention). No audit table in PostgreSQL.

## DEC-017: Response format for our modules

**Status:** Answered (Q10)

- **Decision:** No `{ success, data }` wrapper. Handlers return the object directly. Errors are an HTTP status plus `{ code, message, details? }` through one global error handler; the per-user rate limiter's 429 and the health check's 503 are returned in the same shape without passing through it ([API.md §2](API.md#2-response-format-dec-017)). Paginated lists are `{ items, meta }`; the role catalogue, which is not paginated, is `{ items }`.

## DEC-018: Frontend data fetching and feature boundaries

**Status:** Answered (Q11)

- **Decision:** One Eden client in `apps/web/src/lib/api.ts`. TanStack Query hooks in `features/*/hooks`. Features import each other only through `index.ts`, enforced by a lint rule. `profile` has no backend module: it calls Better Auth `updateUser`.

## DEC-019: Session and rate-limit storage

**Status:** Answered (Q12). Narrowed by DEC-054 and DEC-055 (both Proposed).

- **Decision:** Redis is Better Auth's `secondaryStorage`; `session.storeSessionInDatabase: true` so admins can list and revoke sessions. Rate limits in Redis (`storage: "secondary-storage"`). Without `REDIS_URL` (dev/test only), the same secondary storage counts in the in-memory cache store. As built, the secondary storage holds rate-limit counters only (DEC-055).

## DEC-020: Same origin and Better Auth security baseline

**Status:** Answered (Q13)

- **Decision:** Web and API share **one origin**. `/api/*` is forwarded to the API by the dev proxy locally and a reverse proxy in production. `baseURL` is the public web origin, `trustedOrigins` is `[WEB_URL]` only, `crossSubDomainCookies` off, CSRF on ([auth/README.md](auth/README.md)).
- **Trade-off:** Production needs a reverse proxy. In return: no CORS, plain cookies, far fewer cookie/CSRF misconfigurations.

## DEC-022: Roles are defined in code; no role table

**Status:** Answered (Q14)

- **Decision:** No `role` table. Roles live in a typed role registry in code. Projects add custom roles by adding a registry entry and granting permissions in the module files that need them. A user may hold several roles (comma-separated by Better Auth). Design in [auth/static-roles.md](auth/static-roles.md).
- **Trade-off:** Changing what a role can do needs a deploy.

## DEC-023: Where permissions are declared and how they are assembled

**Status:** Decided (lead)

- **Decision:** Each module's `permissions.ts` exports one `<module>Permissions = defineModulePermissions({ statement, grants })`: the module's statement and its per-role grants. `apps/api/src/utils/auth/access.ts` merges them. `packages/auth` exports `createAuth({...})`; `apps/api/src/utils/auth/auth.ts` calls it and is the file the Better Auth CLI reads. `super_admin` is derived (every action of every statement). The web app gets the current user's permissions from `GET /api/me/permissions`.
- **Trade-off:** The Better Auth CLI needs `--config apps/api/src/utils/auth/auth.ts` (wired into `bun run auth:generate`).

## DEC-024: User management uses the admin plugin's endpoints

**Status:** Answered (Q15)

- **Decision:** The web app calls `authClient.admin.*` at `/api/auth/admin/*`. "A user cannot change their own role" is a `hooks.before` rule. Our `admin` module only adds `GET /api/admin/roles`.

## DEC-026: Telemetry sinks

**Status:** Answered (Q16). Amended by DEC-034.

- **Decision:** The boilerplate ships the `log` sink (stdout), the `mongo` sink (DEC-034) and the `memory` sink (tests). Sentry and PostHog are design only (DEC-036).

## DEC-027: Sensitive data is never logged

**Status:** Answered

- **Decision:** Four layers: typed payloads that carry IDs instead of personal data; a scrubber inside `telemetry.emit` before any sink; pino `redact` paths; vendor-side scrubbing. Raw URLs, query strings, bodies, cookies and auth headers are never logged ([observability/redaction.md](observability/redaction.md)). The one exception is the development-only `auth.verification_link` and `auth.reset_link` events, which print their link to stdout because there is no email sender.

## DEC-029: Feature flag providers and percentage rollout

**Status:** Decided (lead), design only. Targeting narrowed by DEC-038.

- **Decision:** Two providers behind the same OpenFeature API: (1) **database provider**, the default, over a `feature_flag` PostgreSQL table, evaluated in memory, with deterministic percentage rollout; (2) **PostHog provider** for experiments and flag analytics. Flags are always evaluated on the API; the web app reads `GET /api/feature-flags/evaluate`.
- **Trade-off:** The database provider is ours to maintain and has no analytics. PostHog adds a vendor, cost and a network dependency.

## DEC-032: No impersonation

**Status:** Answered (round 4: "delete impersonation, not implemented")

- **Context:** Better Auth's admin plugin always ships impersonation endpoints and has no option to turn them off. Its default statement contains `user:impersonate` and `user:impersonate-admins`, and any user ID in `adminUserIds` bypasses role checks.
- **Decision:** Impersonation is not part of this boilerplate:
  1. The `admin` module's statement lists the admin-plugin actions we use **explicitly** instead of spreading `defaultStatements`, so the impersonate actions do not exist in our access control and no role (including the derived `super_admin`) can hold them.
  2. A `hooks.before` rule rejects `/admin/impersonate-user` and `/admin/stop-impersonating` with `404 NOT_FOUND`.
  3. `adminUserIds` is never set.
  4. No impersonation fields in events, logs, the web app or env variables.
- **Trade-off:** The generated `session` schema still contains the plugin's unused impersonation column; it is ignored. Adding impersonation later needs a new decision.

## DEC-033: What `admin` can do with users and sessions

**Status:** Answered (Q19)

- **Decision:** `admin` gets `user:list`, `user:get`, `session:list` and `role:read`. Only `super_admin` gets `user:create`, `user:update`, `user:set-role`, `user:ban`, `user:delete`, `user:set-password`, `session:revoke`, `session:delete`.

## DEC-034: MongoDB log store with manual retention

**Status:** Answered (Q17: "manual first, MongoDB by default"; Q18: "agree, delete retention manually")

- **Context:** The product owner wants a self-managed log store now and Grafana Alloy + Loki later.
- **Options:** (a) MongoDB, written by a `mongo` sink; (b) a PostgreSQL table in the app database; (c) Loki + Alloy from day one.
- **Decision:** **(a).** Every telemetry event at `info` or above (the defaults of `LOG_LEVEL` and `LOG_MONGO_MIN_LEVEL`) goes to stdout **and**, through an asynchronous batched `mongo` sink, to a separate MongoDB database (`log_event` collection). The exceptions are the sink-failure warnings and the development-only link events, which stay on stdout. Retention by kind: `http` 14 days, `app` 30, `error` 30, `product` 30, `audit` 365. Deletion is **manual**: an operator runs `bun run logs:prune` (dry-run first); no TTL index and no in-app scheduler. `telemetry.flush()` drains the sink buffer on shutdown. Redis is mandatory in production (DEC-001 clarified), and so is the log store: the API refuses to start in production without `REDIS_URL` or `LOG_MONGO_URL`, or with `LOG_MONGO_MIN_LEVEL` below `info`. Design in [observability/log-storage.md](observability/log-storage.md).
- **Trade-off:** One more database to run, and the API now ships logs itself (bounded buffer, never blocks a request). Not (b): logs would compete with app queries in PostgreSQL. Not (c) yet: three more services before there is traffic to justify them.

## DEC-035: Migration path to Grafana Alloy + Loki

**Status:** Answered (Q17: "move to Alloy later"), design only

- **Decision:** When the trigger in [observability/migration-loki.md](observability/migration-loki.md) fires, Alloy collects stdout and ships to Loki, then the `mongo` sink is switched off. Loki retention stays manual by default (`retention_period: 0s` + delete API), with the same periods. Promtail is not used (end of life 2026-03-02). The ELK Stack is the documented alternative (DEC-041); only one of the two is adopted.

## DEC-036: Sentry and PostHog have separate implementation specs

**Status:** Answered (round 4), design only

- **Decision:** [observability/sentry.md](observability/sentry.md) (error tracking with `@sentry/bun`) and [observability/posthog.md](observability/posthog.md) (product analytics with `posthog-node`) are each a standalone build and migration plan. Neither is built until a new decision adopts it. The manual log (stdout + MongoDB) stays the baseline either way. PostHog is for product analytics only: PostHog Logs and tracing are not used, and the analytics sink and the PostHog feature-flag provider are separate integrations that share only the client ([observability/posthog.md §1.1–1.2](observability/posthog.md)).

## DEC-037: Logs and errors carry the module name

**Status:** Answered (round 4: "catch which module errored, without the route name")

- **Decision:** Every module controller uses `moduleScope('<name>')`, which tags the request context with `module`. Every log line and event inside that module's routes carries `module`. `http.error` is identified by `module` + `code` and carries no route. Services throw `moduleError('<module>', status, code, message)`; the `http.error` it produces also carries `sourceModule`, the module that threw, which differs from `module` when another module's route called the service. Errors outside any module use `module: "core"`; Better Auth's handler uses `module: "auth"` ([observability/README.md §4](observability/README.md)).
- **Trade-off:** One line per controller. In return, errors group by module even when routes change.

## DEC-038: Feature flags target users, never roles

**Status:** Answered (round 4: "default database, user targeting without role targeting")

- **Decision:** The evaluation context is `targetingKey` (user ID) only. Targeting rules are: kill switch, exclude users, include users, percentage rollout. No role targeting, no person properties. Design in [feature-flags/targeting.md](feature-flags/targeting.md). The database provider stays the default (DEC-029).
- **Trade-off:** "Turn on for all admins" needs an explicit user list. In return, flags can never become a second access-control system.

## DEC-039: Test layout mirrors modules and features

**Status:** Answered (round 4)

- **Decision:**
  - API: `apps/api/tests/modules/<module>/` (service and route tests), `tests/utils/<util>/`, `tests/e2e/<module>/` (HTTP tests against a running stack), `tests/helpers/`.
  - Web: `apps/web/tests/features/<feature>/`, `tests/lib/`, `tests/components/`, `tests/helpers/`; E2E flows in `apps/web/e2e/<feature>/*.yaml` run by the workspace E2E system.
  - Runner: `bun test` in both apps. Folder names match the module or feature name exactly. `bun run check:test-folders` fails when a module or feature lacks its folder. Design in [TESTING.md](TESTING.md).
  - As built, code outside modules and features has its own folders too: `apps/api/tests/scripts/` (operator scripts), `apps/web/tests/lint/` (the lint rule) and `apps/web/tests/routes/` (route files). The web app's router, production server and Vite config are tested in `apps/web/tests/router.test.ts`, `server.test.ts` and `vite.config.test.ts`. Three E2E folders name no module or feature: `apps/api/tests/e2e/auth/` (Better Auth), `apps/api/tests/e2e/helpers/` and `apps/web/e2e/home/` (the home page).
  - The repo-root `scripts/` (setup, doctor, check and the folder check) keep their tests next to the code (`scripts/*.test.ts`, `scripts/lib/*.test.ts`), run by `bun test ./scripts`.
- **Trade-off:** In `apps/*`, tests are not next to the code. In return, module and feature folders keep their fixed file layout (DEC-008, DEC-011) and test folders are easy to find by name.

## DEC-040: No product name

**Status:** Answered (round 5: "drop BunForge, it's just a name")

- **Context:** "BunForge" came from the original PRD. It was only a name, but it was built into the package scope, the auth cookie prefix and database names, which are expensive to rename once code exists.
- **Decision:** The project has no product name; the documents call it "the boilerplate". Neutral identifiers replace the name:
  - Package scope `@repo/*` (`@repo/db`, `@repo/ui`, …), the common convention for internal monorepo packages that are never published.
  - Better Auth `advanced.cookiePrefix: "app"`, giving `app.session_token` (`__Secure-app.session_token` on HTTPS). Not Better Auth's default `better-auth`, which tells anyone reading cookies which auth library runs behind the app.
  - MongoDB log database default `app_logs`; test PostgreSQL database `app_test`; feature-flag provider metadata name `database`.
- **Trade-off:** A project built from the boilerplate that wants its own identifiers changes them before its first deploy ([NEW-PROJECT.md §3](NEW-PROJECT.md#3-rename-and-decide-before-the-first-deploy)). After that, changing the cookie prefix signs every user out once, and renaming a database needs a data migration.

## DEC-041: ELK Stack as an alternative log migration target

**Status:** Answered (round 5: "create specs migration using ELK stack"), design only

- **Context:** DEC-035 plans the move from MongoDB to Grafana Alloy + Loki. The product owner wants the ELK Stack documented as well.
- **Options:** (a) Loki only; (b) ELK only; (c) both documented, exactly one chosen at migration time.
- **Decision:** **(c).** [observability/migration-elk.md](observability/migration-elk.md) describes Filebeat → Logstash → Elasticsearch → Kibana, one data stream per `kind`, daily rollover and **manual** deletion of old backing indices (no ILM delete phase, no `data_retention`), with the DEC-034 periods. Loki stays the default recommendation; ELK is chosen when a condition in migration-elk.md §1 holds (indexed search on high-cardinality fields, existing Elastic platform, full-text search in errors). The API itself never talks to Elasticsearch.
- **Trade-off:** Two migration specs to keep current. ELK costs more memory, disk and operations than Loki, in exchange for every mapped field being indexed.

## DEC-042: Static roles: roles and permissions in code

**Status:** Answered (round 6: Q20 "default static roles with the admin plugin"). Restated for this boilerplate, which builds this access model only.

- **Context:** The product owner wants simple, code-defined roles on Better Auth's admin plugin as the foundation every project starts from.
- **Decision:** Roles and permissions are static. Roles live in a typed registry in code (DEC-022); each module declares its permissions, merged into Better Auth's access control (DEC-023) and enforced by the admin plugin (DEC-005). This is the only access model the boilerplate builds; there is no configuration switch for another one. A project that needs roles created or edited without a deploy records a new DEC entry before building anything for it. Design in [auth/static-roles.md](auth/static-roles.md).
- **Trade-off:** Changing what a role can do is a code change and a deploy. In return, every grant is reviewed, typed and covered by the permission-matrix tests, and there is one access-control path to secure.

## DEC-052: The build has its own documentation folder

**Status:** Answered (round 9). Restated: the folder documents the boilerplate as built (DEC-053).

- **Context:** The design baseline in `docs/specs/` leaves values open (`TBD`, *verify*) and describes options that are not built. Writing build results into it mixed design with what exists, and made parallel changes edit the same files.
- **Decision:**
  - `docs/specs/` stays the design reference. Build work never edits it.
  - [docs/implement-boilerplate/static-role/](README.md) documents the boilerplate as built, in English only, and does not depend on `docs/specs/`.
  - `docs/prd/` stays frozen as history.
- **Trade-off:** The design baseline and this folder drift apart on purpose. A reader who wants the original design reads `docs/specs/eng/`.

## DEC-053: Docs follow the code

**Status:** Answered (round 10). Restated for the starter kit, without ticket references.

- **Context:** This folder began as a copy of the design specs that build work updated as it went. As the documentation a new project inherits, it must describe the code that project gets, and stay true as that code changes.
- **Decision:**
  - The code is the truth for behaviour. A change that alters behaviour updates the matching section of this folder in the same change. A document that disagrees with the code is fixed to describe the code.
  - A value the code settles (an error code, a path, a port, a verified package option, a measured time) replaces `TBD` or *verify* in place. Product numbers stay `TBD` until the product owner sets them.
  - A change that contradicts a DEC entry adds a new entry with status **Proposed** and is not merged until the product owner accepts it.
  - Documents describe behaviour, not work items: they carry no ticket or task IDs.
- **Trade-off:** Every behaviour change carries a documentation edit, and review checks both. In return, a project can trust the documents it starts from.

## DEC-054: Sessions live in PostgreSQL only, not in Redis

**Status:** Proposed. Narrows DEC-019; waits for the product owner. The code already works this way. Refined by DEC-055.

- **Context:** DEC-019 makes Redis Better Auth's `secondaryStorage` with `session.storeSessionInDatabase: true`, which in Better Auth 1.7.18 puts every session in Redis as well. `findSession` then trusts a Redis entry without reading PostgreSQL, and the per-user `active-sessions-<userId>` list is a non-atomic read-modify-write. The review of the auth integration, made before 1.7.18, found two ways a revoked or banned user's cookie kept working:
  - Two concurrent sign-ins could drop one token from the list. A later ban or "revoke all" then deleted the database rows but left that token's Redis entry.
  - A session refresh that read its entry before a revocation wrote it back after.

  1.7.18 closes the first case: a ban, "revoke all" or user removal writes a `revoked-sessions-before-<userId>` marker, and every Redis hit is checked against it. The second case remains when a single session is revoked.
- **Decision:** The API's secondary storage adapter (`apps/api/src/utils/auth/storage.ts`) drops session entries on write and ignores them on read. Better Auth then serves `getSession`, `listSessions` and the admin session endpoints from the `session` table, where a ban deletes the rows in the same transaction that bans the user. Redis still holds rate-limit counters and the verification copies (DEC-019 otherwise unchanged). DEC-055 later removed the verification copies, so Redis now holds rate-limit counters only.
- **Trade-off:** Every authenticated request reads PostgreSQL instead of Redis: the session by `session.token` (unique index), then its user by primary key, as two queries because Better Auth's database joins are not enabled. API instances stay stateless. Caching sessions in Redis again needs revocation that is atomic with the Redis lists, which Better Auth 1.7.18 does not provide.

## DEC-055: Auth secondary storage holds rate-limit counters only, and fails open

**Status:** Proposed. Refines DEC-054 and narrows DEC-019; waits for the product owner. The code already works this way.

- **Context:** Under DEC-054 the secondary storage still sent every call to Redis and let every Redis error propagate, so while Redis was down sign-in, `get-session` and sign-out answered 500: Better Auth's rate limiter counts in the secondary storage before every `/api/auth/*` endpoint, and it reads Redis first for sessions and verification values. Making those reads fail open would be unsafe. Better Auth 1.7.18 trusts a session or verification value it finds in Redis without asking PostgreSQL. A delete that silently failed during an outage would therefore let a revoked session, or an OAuth state stored with the `database` strategy, work again once Redis is back. A used reset-password token would not, because 1.7.18 consumes it from PostgreSQL in a transaction.
- **Options:**
  1. Keep failing closed: a Redis outage takes sign-in down for everyone.
  2. Move rate limits to PostgreSQL (`storage: "database"`) and drop the secondary storage. Better Auth 1.7.18's database limiter is safe under concurrency: it reads the key's row, then makes a conditional increment (`count < max` in the `WHERE` clause) and retries on contention, and it deletes expired rows when a window restarts. The cost is one read plus at least one write on PostgreSQL for every rate-limited `/api/auth/*` request (every auth path except `/get-session`), a new `rateLimit` table with its migration, and an abusive client's traffic landing on the primary database.
  3. Keep `secondaryStorage` and `rateLimit.storage: "secondary-storage"`, but store only rate-limit counters there, and count in memory while Redis fails.
- **Decision:** Option 3: it keeps counting, including an attacker's, off PostgreSQL and needs no schema change. The secondary storage (`guardAuthStorage` in `apps/api/src/utils/auth/storage.ts`) is an allowlist: `get` and `getAndDelete` answer `null` and `set` and `delete` do nothing, without touching Redis. Sessions and verification values live in PostgreSQL only (`session.storeSessionInDatabase` and `verification.storeInDatabase` stay `true`; the guard is unsafe without them). `increment` counts in Redis (with the default `custom` driver, `CacheStore.increment` under `auth:`; DEC-057 adds `official`) through a resilient counter (`utils/rate-limit/counter.ts`). When Redis rejects or misses a 1 s deadline, the counter opens a 5 s breaker and counts in a bounded per-instance memory counter (100 000 keys, oldest-inserted evicted first). While the breaker is open Redis is not asked; after it, a single trial request tests Redis while the others keep counting in memory, and only a trial that answers closes the breaker. A key longer than 200 characters (the path is whatever the client sent) is counted under its SHA-256, in Redis and in memory alike. The first failure of each outage window emits `cache.unavailable` (`source: "auth"`, at most one per 30 s).
- **Trade-offs:** During an outage limits count per API instance, so N instances allow up to N times the limit, and the counts reset when an instance restarts. A refused connection fails at once. A Redis that accepts connections and stops answering costs one request per 5 s breaker window up to the 1 s deadline: that request is the single trial, and requests that arrive while it waits count in memory without waiting. A full memory counter evicts its oldest key, whose count starts again. Counts made in memory are not carried back to Redis when it recovers. Revisit if more than one instance runs through long Redis outages: the edge proxy's own limit on `/api/auth/*` is then the shared bound.

## DEC-056: Redis runs the `redis` service; Valkey is a supported alternative

**Status:** Decided (product owner, 2026-11-06). This entry briefly moved development, test and CI to Valkey 9.1.3; the product owner reverted that and kept Redis as the default. DEC-001 and DEC-019 are unchanged.
Revised (product owner, 2026-11-07): default moved from Redis 7.4 to Redis 8.10.3.

- **Context:** Production is self-hosted on Dokploy or Openship. Openship offers only a managed Valkey; Dokploy, or any plain `docker compose` deployment, can run Redis. A move to Valkey may come later, but it is not decided. So Redis stays the boilerplate's default, and Valkey has to stay a supported, documented target.
- **Decision:**
  - `docker-compose.yml`, `docker-compose.dev.yml` and `docker-compose.test.yml` run `redis:8.10.3-alpine` (Alpine 3.23), pinned by the digest of its multi-arch index, with `redis-server` and a `redis-cli` healthcheck. CI runs and scans the image named in `docker-compose.test.yml`. The pin follows the newest generally available Redis 8 release. Redis 8.10 is a standard release of Redis Open Source: it gets security and critical fixes until 6 months after Redis 8.12 is generally available, and redis.io gives no end-of-life date yet (8.12 was at its first release candidate on 2026-11-07).
  - With `redis-server` as the command, the image's entrypoint also loads its bundled modules (RedisJSON, RediSearch, RedisTimeSeries, RedisBloom). The API sends no module command. They are left loaded on purpose; mounting an empty directory (a `tmpfs`) over `/usr/local/lib/redis/modules` turns them off with no other change.
  - Redis Open Source 8 is offered under a choice of three licences (RSALv2, SSPLv1 or AGPLv3), whereas Redis 7.4 offered RSALv2 or SSPLv1.
  - Production may run any server that answers Bun's RESP3 `HELLO` and supports every command in [ARCHITECTURE.md §6](ARCHITECTURE.md), `GETDEL` included: Redis 6.2 or later, or Valkey. Checked with Bun 1.4.4's client: Redis 5 closes the connection (no `HELLO`), Redis 6.0.20 connects but has no `GETDEL`, and Redis 6.2.24, Redis 7.4.12, Redis 8.10.3 and Valkey 9.1.3 work. The real-Redis tests pass against Redis 7.4.12, Redis 8.10.3 and Valkey 9.1.3.
  - The names stay Redis whichever server runs: the `redis` service key (CI reads `.services.redis.image`), `REDIS_URL` with its `redis://` or `rediss://` scheme, `REDIS_PORT` and `utils/redis`. Nothing in the API names the server, so moving to Valkey needs no code change. [VALKEY-MIGRATION.md](VALKEY-MIGRATION.md) is the procedure.
- **Trade-off:** A Valkey production differs from development and CI, which run Redis, so a difference between the two servers would first show in production. Run the real-Redis tests against the new server before the switch, and against a staging instance of the same version after each server upgrade, on an instance no other client uses ([VALKEY-MIGRATION.md §6](VALKEY-MIGRATION.md)). Development and CI accept commands a server at the floor may lack (newer Redis commands, and the bundled modules' commands), so the tests do not catch a new command outside the list in [ARCHITECTURE.md §6](ARCHITECTURE.md): adding one means checking it against Redis 6.2 and Valkey. The digest pin keeps CI's image scan stable, and a Redis fix arrives only through a deliberate bump. Because 8.10 is a standard release, staying on a supported Redis means moving the pin to each new minor release (8.12 next) within 6 months of it becoming generally available, not only to new patches. The extended 8.2 line (supported until 2030-09-01) would need fewer moves, but it is not the newest Redis 8, and as of 2026-11-07 its image is built on Alpine 3.22, supported until 2027-05-01, whereas 8.10's Alpine 3.23 is supported until 2027-11-01. The image scan cannot see the Redis server or its modules ([TESTING.md §6.2](TESTING.md)).

## DEC-057: Optional official Redis driver for auth rate-limit counters

**Status:** Proposed. Extends DEC-055 and amends the "no Lua" rule of [ARCHITECTURE.md §6](ARCHITECTURE.md); waits for the product owner. The code already works this way, and `custom` stays the default.

- **Context:** Better Auth ships its own Redis secondary storage, `@better-auth/redis-storage`, on ioredis. Some operators prefer the package Better Auth maintains to the API's own counter on Bun's client. Used as documented, it is unsafe for this API (DEC-054, DEC-055): `set` with no TTL or TTL 0 writes a key that never expires (Better Auth 1.7.18 can pass TTL 0), every read trusts Redis, and with ioredis's defaults a Redis outage holds a command for about 10 s (a read) to 33 s (an increment) and then fails `/api/auth/*`.
- **Decision:**
  - `AUTH_REDIS_DRIVER` picks the driver that counts Better Auth's rate limits: `custom` (the default, `CacheStore.increment` on `utils/redis`) or `official` (`@better-auth/redis-storage` on an ioredis connection of its own). Any other value fails startup, and so does `official` without `REDIS_URL` (it has no memory store of its own) or with a query string in it (ioredis would read client options from it over its own).
  - Both drivers sit behind the same `guardAuthStorage` (`apps/api/src/utils/auth/storage.ts`), so DEC-055 holds unchanged for either: only `increment` reaches the driver, with the window already a whole number of seconds and a key over 200 characters already replaced by `sha256:<hex>`; `get` and `getAndDelete` answer `null` and `set` and `delete` do nothing; a rejection or a missed 1 s deadline opens the 5 s breaker and counts in memory. The package's unsafe `set` is never called.
  - The driver adds `auth:` itself (`keyPrefix`), after the guard, so both drivers count the same Redis key with the same fixed window. Switching drivers keeps the counters.
  - The ioredis client (`apps/api/src/utils/auth/redis-driver.ts`) fails fast: no offline queue, one retry per request, 1 s command and connect timeouts, and a 500 ms disconnect timeout, so closing it holds shutdown no longer than that. It connects on the first increment, not at import, so the Better Auth CLI never dials Redis. It sends no `INFO` and no `CLIENT SETINFO` on connect. It has an `'error'` listener that reports through the same `cache.unavailable` window as the guard (`source: "auth"`, at most once per 30 s). Graceful shutdown closes it after the HTTP server stops.
- **Trade-offs:**
  - One more Redis connection per API process, next to the up to two of `utils/redis` (commands, and transactions).
  - Two more dependencies, `@better-auth/redis-storage` and `ioredis`. The package version must move in lockstep with `better-auth`: both are pinned exactly, and an upgrade of one upgrades the other.
  - Lua on the server: `increment` is one `EVAL` that runs `INCR`, then `EXPIRE` on the first hit. A restricted user needs `+eval +expire` on top of the default list ([VALKEY-MIGRATION.md §3.4](VALKEY-MIGRATION.md)). Lua is allowed only inside this package and only when `AUTH_REDIS_DRIVER=official`. `EVAL`, `INCR` and `EXPIRE` exist on Redis 6.2 and on Valkey (checked on Redis 6.2.24, Redis 8.10.3 and Valkey 9.1.3).
  - A user granted `+eval` without `+expire` is worse than one with neither. The script's `INCR` runs before its `EXPIRE` is refused, and Lua does not roll back, so the counter is left with no TTL. That locks its IP and path out for good, even after switching back to `custom`.
  - `/api/health` probes `utils/redis` only, so an outage on the official driver's own connection shows only as `cache.unavailable` from `auth`.

## DEC-058: PostgreSQL 18; MongoDB stays 8.3.13 without the Database Tools

**Status:** Answered (product owner, 2026-11-08).

- **Context:** CI's `security` job failed on HIGH vulnerabilities in third-party images: zlib in `postgres:17` (fixed in Debian after that image was built), apt in the mongo image (Ubuntu), and `golang.org/x/net` v0.61.0 (CVE-2026-78661) inside the eight MongoDB Database Tools binaries of the mongo image. The waiver rule is "fix first, waive only what this repository cannot fix" ([TESTING.md §6.2](TESTING.md)).
- **Decision:**
  - The `postgres` service of `docker-compose.yml`, `docker-compose.dev.yml` and `docker-compose.test.yml` runs `postgres:18`, the Debian (trixie) image, pinned to the major version only, as 17 was. Not `-alpine`, for the collation reason in `docker-compose.yml`. The image keeps its data under `/var/lib/postgresql/18/docker` and refuses a mount at `/var/lib/postgresql/data`, so the mounts are at `/var/lib/postgresql`.
  - The dev stacks use a new named volume, `postgres18_data`, which starts empty; developers run `db:migrate` and `db:seed` again, or dump and restore ([README](../../../README.md#upgrading-the-dev-database-to-postgresql-18)). The PostgreSQL 17 volume is no longer declared, so Compose never removes it.
  - MongoDB stays on `mongo:8.3.13` pinned by digest, with `GLIBC_TUNABLES`. `infra/mongo/Dockerfile` builds the image that `docker-compose.yml` and `docker-compose.test.yml` use and CI scans, the image the waivers were written for; it removes the eight Database Tools (`bsondump`, `mongodump`, `mongoexport`, `mongofiles`, `mongoimport`, `mongorestore`, `mongostat`, `mongotop`). Nothing uses them: the API and `logs:setup`/`logs:prune` use the `mongodb` driver, the API spawns no program, and the image's entrypoint, the healthcheck and `init.js` need only `mongod`, `mongos` and `mongosh`, which stay. The Sokudo dev stack (`docker-compose.dev.yml`) keeps the official image, tools included: it is not scanned, and the tools are never run.
  - What upstream has not fixed yet is waived with short expiries, so CI checks again soon ([TESTING.md §6.2](TESTING.md)).
- **Trade-offs:**
  - Existing PostgreSQL 17 dev data is not carried over automatically.
  - A floating major tag means the same commit can scan differently once upstream rebuilds; that is also how the zlib fix arrives without a change here.
  - Exporting logs with the Database Tools (for example the `mongoexport` step in the log migration guides) needs a separately installed copy of the tools; the dev and test image no longer has them.
