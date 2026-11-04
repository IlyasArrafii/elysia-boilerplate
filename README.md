# Elysia boilerplate

A Bun monorepo with an Elysia API, TanStack Start web app, Better Auth, Drizzle/PostgreSQL, Redis caching, and MongoDB log storage. The current implementation uses static roles.

The [static-role implementation record](docs/implement-boilerplate/static-role/README.md) governs this build. `docs/specs/` is the frozen design baseline; `docs/prd/` is historical. Coding conventions live in [apps/api/README.md](apps/api/README.md) and [apps/web/README.md](apps/web/README.md).

## Getting started

### 1. Prerequisites and installation

Clone the repository, open its root folder as a Sokudo workspace, and run the commands below from that folder unless another directory is specified. Shell-specific examples use PowerShell.

- Git and **Bun 1.4.4**, the development baseline verified in the implementation record. There is no runtime-version file or `packageManager` field enforcing Bun's version. Use the committed `bun.lock`; package versions are exact.
- **Node.js satisfying `^20.19.0 || >=22.12.0`**, the engine requirement in the installed Vite 8.3.5 manifest. Node 24.14.0 was available during this documentation check. Vite's executable runs on Node as a child of Bun; the API runs on Bun.
- Sokudo with its managed Docker engine available. The development Compose stack supplies PostgreSQL 17, Redis 7, and MongoDB 8. These image tags pin major versions, not image digests.
- Available local ports: API `3000`, web `3001`, PostgreSQL `5432`, Redis `6379`, MongoDB `27017`, unless deliberately configured otherwise below.

```powershell
bun --version
node --version
bun install --frozen-lockfile
```

Install dependencies in every fresh worktree before running checks or starting either app.

### 2. Configure the root environment

For a new checkout without a `.env`:

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

Edit that file privately. Keep one `.env` at the repository root; do not commit it or create app-local copies. The example's database credentials are throwaway local values for the Compose services, never production credentials.

| Variable | Local setting or requirement |
|:---|:---|
| `NODE_ENV` | `development`. |
| `DATABASE_URL` | PostgreSQL URL for the development `app` database. Use the local connection in `.env.example`, adjusting the host port if needed. Required outside test mode. |
| `BETTER_AUTH_SECRET` | Supply a private random secret of at least 32 characters, for example generated locally with `openssl rand -base64 32`. Do not paste it into logs or tickets. |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD` | Choose the local super-admin account and a private password. Both are required by `db:seed`; there is no default password. |
| `POSTS_TITLE_MAX_LENGTH`, `POSTS_CONTENT_MAX_LENGTH` | Required whole numbers, at least `3` and `10` respectively. Supply the project owner's chosen limits; there are no runtime defaults. The blank example values prevent API startup. Test fixtures use `120` and `2000`, which are test values, not product decisions. |
| `PORT`, `API_INTERNAL_URL` | `3000` and `http://localhost:3000`. Always change these together. |
| `WEB_URL`, `BETTER_AUTH_URL` | Both `http://localhost:3001`, the public web origin, without an `/api` path. Use the same hostname in the browser. |
| `REDIS_URL` | Local Redis connection from `.env.example`. Empty enables the development/test memory fallback; production requires Redis. |
| `LOG_MONGO_URL` | MongoDB **writer** connection from `.env.example`; empty disables the Mongo sink in development/test. Production requires it. |
| `LOG_MONGO_ADMIN_URL` | Separate MongoDB **admin** connection, used only by log setup/prune scripts. The API does not read it. |
| `LOG_MONGO_DB`, `LOG_MONGO_MIN_LEVEL` | `app_logs` and `info`. Mongo URLs authenticate against `app_logs` as well. |
| `LOG_LEVEL` | `debug` for local development; `info` for operator commands whose result events must be visible. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Leave both empty to disable Google sign-in locally, or supply both. Production requires both. Callback: `http://localhost:3001/api/auth/callback/google` with the default web origin. |
| `POSTS_CACHE_TTL` | Leave empty for the default `60` seconds, or supply a positive whole number. |
| `APP_VERSION` | May be empty locally; the API reports `unknown`. |

Environment validation lives in [env.ts](apps/api/src/env.ts), with post minimums checked in [the posts model](apps/api/src/modules/posts/model.ts).

For example, moving the API to port 4000 requires both root `.env` entries:

```dotenv
PORT=4000
API_INTERNAL_URL=http://localhost:4000
```

Web development stays on **3001** (`strictPort: true`); `PORT` does not move it. The public auth origins stay on 3001 too.

The API, database scripts, and log scripts explicitly load the root file with `bun --env-file=../../.env`. The web script is `bun --env-file=../../.env vite dev`; [vite.config.ts](apps/web/vite.config.ts) reads `process.env.API_INTERNAL_URL` and sets `envDir: false`. Older `.env.example` comments mentioning Vite `loadEnv` are stale. Shell variables override file values, including explicitly empty values. Restart your own local app processes after changing these settings; check for old shell overrides if a change appears ignored.

### 3. Start development infrastructure in Sokudo

Use the workspace's **Compose panel → Up**, which selects [docker-compose.dev.yml](docker-compose.dev.yml) and applies Sokudo's engine, project name, and port overrides. Agents use `docker_compose_up` and `docker_compose_status`. A raw shell `docker compose up` targets a different engine/configuration and is not the managed startup procedure.

Wait for all three services to report **running / healthy**, and inspect their published ports in Sokudo:

| Service | Default host endpoint | Data |
|:---|:---|:---|
| PostgreSQL | `127.0.0.1:5432` | Database `app`; named volume. |
| Redis | `127.0.0.1:6379` | Cache and counters; persistence disabled, `/data` on tmpfs. |
| MongoDB | `127.0.0.1:27017` | `app_logs.log_event`; named data/config volumes. |

`POSTGRES_PORT`, `REDIS_PORT`, and `MONGO_PORT` in the root `.env` configure host ports. If one changes, update every corresponding connection URL and confirm the actual published port in Sokudo. MongoDB requires updating both writer and admin URLs. The Compose file publishes services on loopback.

The managed development Mongo service uses the `mongo:8` image and writes an inline bootstrap inside the container. This avoids the managed engine's Windows bind-mount and build-context path limitations. Keep this working arrangement; `infra/mongo/Dockerfile` is used by the other Compose definitions, not this managed dev service. Mongo initialization creates the three log users only on an **empty** volume. A healthy container does not prove that application migrations or log indexes have been applied.

For routine use, leave shared services running. Coordinate any Restart or Down action with other users; perform lifecycle actions through Sokudo. Down preserves named volumes but interrupts services, and Redis is disposable. Do not delete volumes to fix a connection or credential problem. Existing Mongo roles/passwords need an authorized in-place update. A PostgreSQL major-version upgrade needs a planned dump/restore or a separately provisioned new volume.

### 4. Migrate, seed, and prepare log indexes

On your intended development database, after checking that `DATABASE_URL` targets `app` on the expected service:

```powershell
bun run db:migrate
bun run db:seed
```

Migrations are in [packages/db/migrations](packages/db/migrations). The [seed](packages/db/src/seed.ts) creates or promotes the configured account to `super_admin` and inserts three example posts (two published, one draft). Re-running skips existing post slugs and an existing super-admin; it does **not** reset an existing account's password. It refuses `NODE_ENV=production`. On a shared database, coordinate these writes with its owner instead of re-running them to check your setup.

When using the Mongo sink, run the index setup once per log database. It is idempotent and uses the admin connection:

```powershell
cd apps/api
bun run logs:setup
cd ../..
```

See the [log-retention runbook](docs/operations/log-retention.md) for privileges, index details, and operational recovery. Setup does not install automatic deletion.

### 5. Start the local API and web app

From the repository root:

```powershell
bun run dev
```

This starts both apps in parallel. Alternatively, use two terminals at the root:

```powershell
bun run --filter @repo/api dev
```

```powershell
bun run --filter @repo/web dev
```

Open `http://localhost:3001/`. Sign in at `/login` with the seeded account. The browser uses `/api/*` on the web origin; the Vite proxy forwards it to the API. SSR calls that same API via `API_INTERNAL_URL`.

Check both the direct API and the web proxy, replacing the first port if you changed `PORT`:

```powershell
Invoke-RestMethod -Uri http://localhost:3000/api/health
Invoke-RestMethod -Uri http://localhost:3001/api/health
```

With the three stores configured and reachable, expect HTTP 200, `status: "ok"`, `db: "up"`, `redis: "up"`, `logStore: "up"`, and numeric `uptime`. PostgreSQL or a configured Redis being down returns 503. MongoDB being down still returns 200, with `logStore: "down"`; check that field separately. An intentionally empty Redis or Mongo URL reports `disabled`. These health probes establish connectivity, not schema/index readiness or successful log insertion. The home page also has an API status display and **Check again** action.

## Development checks and test isolation

These commands exist in the root [package.json](package.json):

| Command | What it runs / prerequisite |
|:---|:---|
| `bun run typecheck` | Apps, packages, then `scripts/`; a failed earlier check prevents the final scripts check. |
| `bun run lint` | Web oxlint with warnings denied; there is no API lint script. |
| `bun run check:test-folders` | Checks module/feature test-folder coverage. No running app required. |
| `bun run test` | Folder-check tests and API/web unit/integration tests. API DB-backed tests require **`app_test`**. Does not run E2E. |
| `bun run test:e2e` | **API HTTP E2E only**, against an already running test API selected by `API_E2E_URL`. |

Do not run broad tests against the development `app` database. [docker-compose.test.yml](docker-compose.test.yml) describes the separate `app-test` project: PostgreSQL database `app_test` on **5442**, Redis on **6389**, and MongoDB on **27027**, with tmpfs data rather than dev volumes. Its port values are fixed; dev `*_PORT` variables do not change them. Sokudo's managed dev Up action does **not** provision this test stack. Provisioning that separate stack on the managed Windows engine has not been verified here; its Mongo service still needs a local image build. Obtain an isolated test service before running DB-backed tests, without changing or tearing down the shared development stack.

### Test environment names

Configure test values in the shell that launches the tests. They are not interchangeable with the app's store URLs or Sokudo's browser-runner environment.

| Variable | Consumer and meaning |
|:---|:---|
| `TEST_DATABASE_URL` | API test preload; defaults to the local `app_test` connection on 5442 specified in `docker-compose.test.yml`. Must name **exactly `app_test`**. |
| `TEST_REDIS_URL` | Real Redis unit/integration tests; defaults to `redis://127.0.0.1:6389`. These suites skip if it is unavailable. They may use dev Redis on 6379 only because they write unique `test-*` keys, clean up their own keys, and never call `FLUSHDB`/`FLUSHALL`. |
| `TEST_LOG_MONGO_URL`, `TEST_LOG_MONGO_ADMIN_URL` | Optional live Mongo tests: writer and admin on an **isolated test MongoDB** (`app_logs`, normally port 27027). Both must be set to enable them. One test performs age-based pruning across the collection; never point these variables at development or production logs. |
| `API_E2E_URL` | API E2E client's base origin, for example `http://localhost:3010` for a separately started test API. Required; no server is started by the command. |
| `E2E_REDIS_URL` | API posts E2E checks the running test API's Redis and mutates application cache keys. Use isolated Redis, even though the `TEST_REDIS_URL` suites may share dev Redis. |
| `E2E_LOG_MONGO_URL` | API posts E2E reads the running test API's log store; use the `log_reader` connection with `find`, not the insert-only writer. `LOG_MONGO_DB` selects the database, default `app_logs`. |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD`, `WEB_URL` | API E2E needs the test API's seeded account and trusted web origin. Supply them to the test process as well as the server/seed process. |

The [API preload](apps/api/tests/setup.ts) pins `NODE_ENV=test`, replaces `DATABASE_URL` with the guarded `TEST_DATABASE_URL`, empties `REDIS_URL` and both application Mongo URLs, and supplies test-only post limits. [The DB helper](apps/api/tests/helpers/db.ts) checks the URL and connected database before migrating once per process under an advisory lock. Fixtures delete only their own inserted rows. PostgreSQL being absent is a failure, not a skipped test. Avoid concurrent manual migrations or incompatible migration histories on a shared `app_test`.

That preload only controls the test process. It **cannot protect the external server** named by `API_E2E_URL`. Before API E2E, configure a separate API terminal with `NODE_ENV=test`, `DATABASE_URL` targeting `app_test`, isolated `REDIS_URL` and writer `LOG_MONGO_URL`, the intended auth/seed values, and valid post limits. Set a free API port such as `3010`; if a web app uses it, pair it with `API_INTERNAL_URL=http://localhost:3010`. Apply migrations and seed to that isolated database, then start `bun run --filter @repo/api dev`. In the test terminal, configure the matching `API_E2E_URL` and E2E values above before running `bun run test:e2e`. Setting only `TEST_DATABASE_URL` does not configure a separately launched API or a manual seed.

### Web E2E in Sokudo

The existing flows live in [apps/web/e2e](apps/web/e2e). Run them through Sokudo's E2E UI or agent tools, with API and web already running for the selected test environment. There is no web `test:e2e` package script or verified headless/CI CLI. Root `test:e2e` does not run these flows. [TESTING.md](docs/implement-boilerplate/static-role/TESTING.md) describes the suite; TASK-019 owns its expansion, and TASK-011 owns final CI integration.

1. Configure credentials in **Settings → Environment Variables**, using the active default or a named environment. Mark passwords as secrets. The runner's `environment` argument selects a named environment, and `env` overrides values for a run; neither requires putting secrets into YAML or chat.
2. Set `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` for an existing ordinary user. Admin flows also need `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`, `E2E_SUPER_ADMIN_EMAIL` / `E2E_SUPER_ADMIN_PASSWORD`, and `E2E_ROLE_TARGET_EMAIL` for a separate ordinary user whose role the flow changes. `db:seed` creates only the super-admin, not all these accounts.
3. Discover the current files with `e2e_list_flows`, validate a selected file with `e2e_validate`, and run it with `e2e_run`. For example, the agent-tool input `{"files":["apps/web/e2e/health/status.yaml"]}` runs the status flow using the active environment. This is tool input, not a shell command. Read results with `e2e_runs`.
4. Discovery and execution use the workspace's **main checkout**. A new flow in a worker worktree is not runnable there until the user merges it into that checkout. Ensure the served code matches the flows being run. Runs are serialized per workspace; wait for an active run to finish.

Current YAML files have literal `http://localhost:3001` URLs; an environment variable alone does not retarget them. Flows can create accounts/posts, update profiles, and change roles. Use disposable test accounts/data and coordinate the app bound to that port. Seeded list flows need the example posts; `posts/empty-state.yaml` requires a separate **unseeded** test database with no posts and an existing E2E user. Do not reset a shared database to satisfy it. Sign-in rate limits can affect back-to-back auth runs; allow the limit window to expire rather than disabling protection.

## Troubleshooting

| Symptom | Check / next action |
|:---|:---|
| API exits with missing secret or post limits | Fill the required root `.env` entries. Blank limits are intentional; obtain the chosen values. Check shell overrides without printing secret values. |
| Direct health works but web proxy/SSR fails | Match `PORT` and `API_INTERNAL_URL`, then restart your own web process. Keep the web auth origins on 3001. |
| Port 3001 is occupied | Vite deliberately refuses a fallback port. Identify and coordinate with its owner; do not kill another worker's server. |
| Healthy PostgreSQL but app tables are absent | Confirm the intended database, then apply its migrations. Container health only checks readiness. |
| Seeded login fails after changing the seed password | The seed does not rotate existing passwords. Use the application's reset flow or an authorized account-maintenance procedure. |
| Mongo authentication or index setup fails | Check port, database, `authSource`, and role-specific URL. Initialization is not replayed on an existing volume. Follow [non-destructive recovery](docs/operations/log-retention.md#failure-and-recovery). |
| DB-backed tests cannot reach 5442 | Provision isolated `app_test` or set `TEST_DATABASE_URL` to its actual endpoint. Do not substitute the dev `app` database. |
| Sokudo cannot see a worktree flow | Discovery scans the main checkout. Validate the file, then wait for user merge before running it. |
| Web admin tests fail typecheck | See the dated verification note below. This documentation change does not repair tests owned by other tickets. |

## Verification of this guide

Checked on **2026-11-04**, against intake commit `b3c3f33` (TASK-022):

- Executed: `bun install --frozen-lockfile`, `bun run lint`, and `bun run check:test-folders` passed. From `apps/api`, `bun test tests/scripts/logs-prune.test.ts` passed all 29 tests using an in-memory fake, without pruning MongoDB.
- Executed: `bun run typecheck` failed with nine existing errors in `apps/web/tests/features/admin/*` (missing `../auth/app` imports and resulting implicit-any errors). API and package checks passed; the trailing `scripts/` typecheck was not reached.
- Read-only tools: Sokudo reported all three dev containers healthy on 5432/6379/27017. Flow discovery returned the existing suite, and `apps/web/e2e/health/status.yaml` validated. No E2E flow was executed.
- HTTP checks: the default API/web URLs on 3000/3001 were unreachable during this check. App startup and the expected health response above are source-verified instructions, not a successful live bootstrap claim.
- Documentation checks: relative links and anchors resolve, code fences are balanced, and the diff has no whitespace errors. LSP has no Markdown language server; its additional test-file diagnostics are outside this change.
- Not executed: copying/configuring `.env`, migrations, seed, index creation, real prune/dry-run, full tests, isolated test-stack provisioning, or CI. Required local secrets/post limits and isolated test services remain prerequisites for those steps. No clone-to-running timing was measured; TASK-011 retains that work.

The [operations runbook](docs/operations/log-retention.md) is likewise checked against source and the prune unit tests; its live database commands are operator instructions, not commands performed for this ticket.
