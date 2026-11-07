# Elysia boilerplate

A Bun monorepo with an Elysia API, TanStack Start web app, Better Auth, Drizzle/PostgreSQL, Redis caching, and MongoDB log storage. The current implementation uses static roles.

The [static-role implementation record](docs/implement-boilerplate/static-role/README.md) governs this build. `docs/specs/` is the frozen design baseline; `docs/prd/` is historical. Coding conventions live in [apps/api/README.md](apps/api/README.md) and [apps/web/README.md](apps/web/README.md).

**Start a new project from your own PRD:** follow [NEW-PROJECT.md](docs/implement-boilerplate/static-role/NEW-PROJECT.md) to turn this starter kit into your product.

## Getting started

With Git, Bun 1.4.4, Node.js and Docker in place ([Prerequisites](#prerequisites)), run from the root of a fresh clone:

```powershell
bun run setup
bun run dev
```

Open `http://localhost:3001/` and sign in at `/login` as `SEED_SUPER_ADMIN_EMAIL`, with the `SEED_SUPER_ADMIN_PASSWORD` from the root `.env`. When `setup` stops at a problem, or something breaks later, run:

```powershell
bun run doctor
```

It prints a one-line fix for each problem. Then run `bun run setup` again: it is safe to repeat and changes nothing that is already in place.

With the Sokudo-managed stack, run `bun run setup --skip-infra` instead, and never `infra:up` or `infra:down` ([why](#development-infrastructure-in-sokudo)).

## Commands

Every script of the root [package.json](package.json). Run each one from the repository root as `bun run <command>`.

| Command | What it does |
|:---|:---|
| `bun run setup [--skip-infra]` | First run, safe to repeat. It checks Bun and Docker, runs `bun install --frozen-lockfile`, creates the root `.env` and fills only its empty values ([Root environment](#root-environment)), then runs `infra:up`, `db:migrate`, `db:seed` and `doctor`. `--skip-infra` starts no containers and uses the services at the URLs in `.env`. It refuses `NODE_ENV=production`. |
| `bun run doctor` | Read-only check of `.env`, PostgreSQL (pending migrations, seeded `super_admin`), Redis and MongoDB, with a one-line fix per problem. Warnings alone exit 0. It never prints secrets. |
| `bun run dev` | `dev:api` and `dev:web` together. |
| `bun run dev:api` | The API on `PORT` (default 3000) under `bun --watch`, started from the root so changes in `packages/*` restart it too. |
| `bun run dev:web` | The Vite dev server on port 3001 (`strictPort`). It forwards `/api/*` to `API_INTERNAL_URL`. |
| `bun run build` | A production build of `apps/web` into `apps/web/dist/`, whatever `NODE_ENV` says. The API has no build step. See [Production build](#production-build). |
| `bun run start` | `start:api` and `start:web` together, to try the build locally. See [Production build](#production-build). |
| `bun run start:api` | The API without `--watch`. |
| `bun run start:web` | The built web server (`apps/web/server.ts`) on `WEB_PORT` (default 3001). Run `bun run build` first. |
| `bun run infra:up` | Starts PostgreSQL, Redis and MongoDB from [docker-compose.yml](docker-compose.yml) and waits until they are healthy. Not with the Sokudo-managed stack. |
| `bun run infra:down` | Stops and removes those containers. Their named volumes, and so the data, stay. Not with the Sokudo-managed stack. |
| `bun run infra:status` | Lists those services and their state. |
| `bun run infra:logs [service]` | Follows their logs, or one service's: `postgres`, `redis` or `mongo`. |
| `bun run db:migrate` | Applies the pending migrations of [packages/db/migrations](packages/db/migrations) to `DATABASE_URL`. |
| `bun run db:seed` | Creates the `SEED_SUPER_ADMIN_EMAIL` account as `super_admin` and inserts three example posts ([when it refuses](#database-and-log-indexes)). |
| `bun run db:generate` | Writes a new migration from changes to the Drizzle schema in `packages/db/src/schema` (`drizzle-kit generate`). |
| `bun run auth:generate` | Regenerates the Better Auth tables in `packages/db/src/schema/auth.ts` from the API's auth config. |
| `bun run db:studio` | Opens Drizzle Studio on `DATABASE_URL`. |
| `bun run role:set <email> <role>` | Gives an existing user exactly one role: `super_admin`, `admin` or `user`, for example `bun run role:set someone@example.test admin`. It never demotes the last `super_admin`, and after `db:seed` that is the seeded account, so promote another user before demoting it. The change is audited with `actorId: "cli"` and applies on the user's next request. It never prints the email. |
| `bun run typecheck` | `tsc` for the apps and packages, then for `scripts/`. A failed earlier check prevents the final scripts check. |
| `bun run lint` | oxlint on `apps/web` with warnings denied. There is no API lint script. |
| `bun run check:test-folders` | Checks that every API module and web feature has its test folders ([TESTING.md §7](docs/implement-boilerplate/static-role/TESTING.md#7-acceptance-criteria)). Needs no running service. |
| `bun run test` | The root `scripts/` tests, then the API and web unit and integration tests. The API's database tests need the isolated **`app_test`** database ([Development checks and test isolation](#development-checks-and-test-isolation)). It does not run E2E. |
| `bun run test:e2e` | **API HTTP E2E only**, against an already running test API selected by `API_E2E_URL`. It starts no server. |
| `bun run check [--fast] [--keep-stack]` | Runs CI's `verify` job locally on a fresh test stack, the web build and its smoke test included ([TESTING.md §6](docs/implement-boilerplate/static-role/TESTING.md#6-ci) lists the steps). Its steps never see the root `.env`, and it first removes a running `app-test` stack, data included. `--fast` stops after the unit and integration tests; `--keep-stack` leaves the stack running. It skips CI's frozen install and the `security` job. One check runs at a time per machine. |
| `bun run test:stack:up` | Starts the test stack of [docker-compose.test.yml](docker-compose.test.yml) as project `app-test` and waits until it is healthy ([test isolation](#development-checks-and-test-isolation)). |
| `bun run test:stack:down` | Removes the `app-test` stack and its data (`down -v`). |

**Exit codes.** The repository's own commands (`setup`, `doctor`, `check:test-folders`, `db:seed`, `role:set`, and `logs:setup` and `logs:prune` in `apps/api`) share one convention:

- `0`: success, or nothing to do.
- `1`: refused or failed, for example an unknown email or the last `super_admin` for `role:set`, or a service that is down.
- `2`: wrong usage, such as a wrong number of arguments, an unknown option, or an unknown value such as a role or a `logs:prune --kind`.

`doctor` and `check:test-folders` take no arguments and ignore any they are given. `check` follows the convention only for its own outcomes: 2 for an unknown option and 1 when another check is running. After that it exits with the code of the step that failed, which can be any number (127 when Docker is missing, for example), and with 130 when interrupted, so a 2 from `check` need not mean wrong usage. Its closing line, `Failed at "<step>" (exit N).`, names the step. Every other command wraps a tool (`docker compose`, `drizzle-kit`, `tsc`, `oxlint`, `bun test`, Vite) and exits with that tool's code.

### Production build

`bun run build` always makes a production web build: `vite.config.ts` sets `NODE_ENV=production` for `vite build`, even with the development `.env`. The API is not bundled; Bun runs its TypeScript directly. `bun run start` then runs the API and the built web server together. The web server listens on **`WEB_PORT`** (default `3001`), and `PORT` belongs to the API only, so a host that assigns the port through `PORT` needs `WEB_PORT=$PORT` for the web process. `bun run dev` uses the same ports: stop it first.

`bun run start` is for local use. `bun run --parallel` stops the other server only when one exits non-zero, and whether a stop signal reaches the servers through `--parallel` and `--filter` has not been checked on Linux. In production, a supervisor runs each server's own command directly, one process per server. The built web app also has no `/api` proxy, so browser calls to the API need the edge or proxy in front of it. Without one, sign-in and mutations fail on a plain `bun run start`, while server-rendered pages still load. [ARCHITECTURE.md §11](docs/implement-boilerplate/static-role/ARCHITECTURE.md#11-production-build-and-start) has the details.

On a Windows checkout with `core.autocrlf=true`, the build rewrites `apps/web/src/routeTree.gen.ts` with LF line endings, so git shows it as modified after `bun run build` or `bun run check`. Do not commit that file.

## Local environment in detail

`bun run setup` covers the install, the `.env`, the infrastructure, the migrations and the seed below. It does not start the Sokudo-managed stack, run `logs:setup` or start the apps. The sections below explain each setting, and what to run again after a change.

### Prerequisites

Clone the repository, open its root folder as a Sokudo workspace, and run the commands from that folder unless another directory is specified. Shell-specific examples use PowerShell.

- Git and **Bun 1.4.4**, the development baseline verified in the implementation record. There is no runtime-version file or `packageManager` field enforcing Bun's version. Use the committed `bun.lock`; package versions are exact.
- **Node.js satisfying `^20.19.0 || >=22.12.0`**, the engine requirement of Vite 8.3.5. Vite's executable runs on Node as a child of Bun; the API runs on Bun.
- Docker, for PostgreSQL 18, Redis 8.10 and MongoDB 8: either Sokudo's managed stack ([Development infrastructure in Sokudo](#development-infrastructure-in-sokudo), then `setup --skip-infra`), or a Docker engine the shell reaches, for `setup` and `infra:up`. PostgreSQL (`postgres:18`, Debian) is pinned to a major version only; Redis is pinned to `redis:8.10.3-alpine` and MongoDB to `mongo:8.3.13`, both by digest.
- Available local ports: API `3000`, web `3001`, PostgreSQL `5432`, Redis `6379`, MongoDB `27017`, unless deliberately configured otherwise below.

`setup` installs the dependencies. In any other fresh clone or worktree, run `bun install --frozen-lockfile` before running checks or starting either app.

### Root environment

`bun run setup` creates the root `.env` from `.env.example` and fills only the empty values that the table below attributes to `setup`. It never prints the secrets it generates or overwrites a value you set. To create it by hand instead:

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

Edit that file privately. Keep one `.env` at the repository root; do not commit it or create app-local copies. The example's database credentials are throwaway local values for the Compose services, never production credentials.

| Variable | Local setting or requirement |
|:---|:---|
| `NODE_ENV` | `development`. |
| `DATABASE_URL` | PostgreSQL URL for the development `app` database. Use the local connection in `.env.example`, adjusting the host port if needed. Required outside test mode. |
| `BETTER_AUTH_SECRET` | A private random secret of at least 32 characters. `setup` generates one when it is empty; otherwise generate it locally, for example with `openssl rand -base64 32`. Do not paste it into logs or tickets. |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD` | The local super-admin account and its private password. Both are required by `db:seed`; there is no default password, but `setup` generates one when it is empty. |
| `POSTS_TITLE_MAX_LENGTH`, `POSTS_CONTENT_MAX_LENGTH` | Required whole numbers, at least `3` and `10` respectively. Supply the project owner's chosen limits; there are no runtime defaults, and blank values prevent API startup. `setup` fills blanks with `120` and `2000`, the test fixtures' values, as placeholders, not product decisions. |
| `PORT`, `API_INTERNAL_URL` | `3000` and `http://127.0.0.1:3000`. Always change these together. Keep `127.0.0.1`, not `localhost`: the API listens on `HOST` (default `127.0.0.1`, IPv4 loopback only), and `localhost` resolves to `::1` first on Windows. |
| `WEB_PORT` | `3001`. The port of the production web server only (`bun run start:web`); the dev server ignores it. |
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
API_INTERNAL_URL=http://127.0.0.1:4000
```

Web development stays on **3001** (`strictPort: true`); `PORT` does not move it. The public auth origins stay on 3001 too.

The API, database and log scripts in each workspace load the root file with `bun --env-file=../../.env`; the root `dev:api` and `start:api` scripts load the same file as `--env-file=.env`. The web scripts are `bun --env-file=../../.env vite dev` and `bun --env-file=../../.env server.ts`; [vite.config.ts](apps/web/vite.config.ts) reads `process.env.API_INTERNAL_URL` and sets `envDir: false`. `setup` and `doctor` read the file themselves. Shell variables override file values, including explicitly empty values. Restart your own local app processes after changing these settings; check for old shell overrides if a change appears ignored.

### Development infrastructure in Sokudo

Use the workspace's **Compose panel → Up**, which selects [docker-compose.dev.yml](docker-compose.dev.yml) and applies Sokudo's engine, project name, and port overrides, then run `bun run setup --skip-infra` ([Getting started](#getting-started)). Agents use `docker_compose_up` and `docker_compose_status`.

Never run `bun run infra:up` or `infra:down` (or a raw `docker compose up`) next to the managed stack. Those commands drive [docker-compose.yml](docker-compose.yml) as Compose project `app-dev` on whatever engine the shell reaches, while the managed stack runs under a project of Sokudo's own. Whether the shell reaches another engine or Sokudo's, `infra:up` starts a second set of services that fails on the ports the managed stack already publishes, and `infra:down` leaves the managed stack running. (A `docker-compose.dev.yml` you started by hand instead shares project `app-dev` and its service names, so `infra:up` would recreate those containers and `infra:down` would remove them, named volumes excepted.)

Wait for all three services to report **running / healthy**, and inspect their published ports in Sokudo:

| Service | Default host endpoint | Data |
|:---|:---|:---|
| PostgreSQL | `127.0.0.1:5432` | Database `app`; named volume `postgres18_data`. |
| Redis | `127.0.0.1:6379` | Cache and counters; persistence disabled, `/data` on tmpfs. |
| MongoDB | `127.0.0.1:27017` | `app_logs.log_event`; named data/config volumes. |

`POSTGRES_PORT`, `REDIS_PORT`, and `MONGO_PORT` in the root `.env` configure host ports. If one changes, update every corresponding connection URL and confirm the actual published port in Sokudo. MongoDB requires updating both writer and admin URLs. The Compose file publishes services on loopback.

The managed development Mongo service uses the pinned `mongo:8.3.13@sha256:e16e606f…cd2` image, with `GLIBC_TUNABLES=glibc.pthread.rseq=1` like `infra/mongo/Dockerfile` ([TESTING.md §6.3](docs/implement-boilerplate/static-role/TESTING.md#63-mongodb-on-the-hosted-runner)), and writes an inline bootstrap inside the container. This avoids the managed engine's Windows bind-mount and build-context path limitations. It keeps the official image as is, so unlike `infra/mongo/Dockerfile` it still ships the MongoDB Database Tools, which nothing here uses. Keep this working arrangement; `infra/mongo/Dockerfile` is used by the other Compose definitions, not this managed dev service. Mongo initialization creates the three log users only on an **empty** volume. A healthy container does not prove that application migrations or log indexes have been applied.

For routine use, leave shared services running. Coordinate any Restart or Down action with other users; perform lifecycle actions through Sokudo. Down preserves named volumes but interrupts services, and Redis is disposable. Do not delete volumes to fix a connection or credential problem. Existing Mongo roles/passwords need an authorized in-place update. A PostgreSQL major-version upgrade needs a planned dump/restore or a separately provisioned new volume; the move to 18 uses a new volume ([below](#upgrading-the-dev-database-to-postgresql-18)).

### Upgrading the dev database to PostgreSQL 18

The Compose stacks run `postgres:18`. It cannot open a PostgreSQL 17 data directory, and it keeps its data under `/var/lib/postgresql/18/docker`, so the dev stacks mount a **new, empty** named volume, `postgres18_data`, at `/var/lib/postgresql`. The PostgreSQL 17 volume (`postgres_data`, prefixed with the Compose project name, for example `app-dev_postgres_data`) is no longer declared, so it is neither mounted nor removed by `down -v`: it stays as it was until someone deletes it on purpose. Do not delete it as part of the upgrade.

After the first Up with PostgreSQL 18, rebuild the schema and the seed:

```powershell
bun run db:migrate
bun run db:seed
```

Optional, to carry the old data over instead of seeding: dump the `app` database from the old volume with a throwaway PostgreSQL 17 container, restore it into the new, still empty PostgreSQL 18 database, then run `bun run db:migrate` (not `db:seed`). Run it on the engine that holds the old volume (`docker volume ls` shows its name; `app-dev_postgres_data` for `docker-compose.yml`), with the PostgreSQL 18 stack up:

```powershell
docker run -d --name pg17-dump -v app-dev_postgres_data:/var/lib/postgresql/data postgres:17
docker exec pg17-dump pg_isready -U app -d app   # repeat until it accepts connections
docker exec pg17-dump pg_dump -U app -d app -Fc -f /tmp/app.dump
docker cp pg17-dump:/tmp/app.dump "$env:TEMP\app.dump"
docker rm -f pg17-dump                            # removes the container only, never the volume
docker cp "$env:TEMP\app.dump" <postgres-18-container>:/tmp/app.dump
docker exec <postgres-18-container> pg_restore -U app -d app --no-owner /tmp/app.dump
```

The dump holds the local accounts and their password hashes: it is written outside the repository; delete it afterwards.

### Database and log indexes

`setup` runs `bun run db:migrate` and `bun run db:seed`. Run `db:migrate` again after pulling new migrations, after checking that `DATABASE_URL` targets `app` on the expected service.

Migrations are in [packages/db/migrations](packages/db/migrations). The [seed](packages/db/src/seed.ts) creates the configured account as `super_admin` and inserts three example posts (two published, one draft). Re-running skips existing post slugs and an existing super-admin; it does **not** reset an existing account's password. It never promotes an account that already exists with another role: it stops and exits 1 instead. It refuses `NODE_ENV=production`. On a shared database, coordinate these writes with its owner instead of re-running them to check your setup.

When using the Mongo sink, run the index setup once per log database; `setup` does not. It is idempotent and uses the admin connection:

```powershell
cd apps/api
bun run logs:setup
cd ../..
```

See the [log-retention runbook](docs/operations/log-retention.md) for privileges, index details, and operational recovery. Setup does not install automatic deletion.

### Running the API and web app

`bun run --filter @repo/api dev` also starts the API, but unlike the root `dev:api` it does not restart on changes in `packages/*`.

The browser uses `/api/*` on the web origin; the Vite proxy forwards it to the API. SSR calls that same API via `API_INTERNAL_URL`.

Check both the direct API and the web proxy, replacing the first port if you changed `PORT`:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/api/health
Invoke-RestMethod -Uri http://localhost:3001/api/health
```

With the three stores configured and reachable, expect HTTP 200, `status: "ok"`, `db: "up"`, `redis: "up"`, `logStore: "up"`, and numeric `uptime`. PostgreSQL being down returns 503 with `code: "SERVICE_UNAVAILABLE"`, a `message`, `status: "degraded"` and the same dependency fields. A configured Redis or MongoDB being down still returns 200, with `redis: "down"` or `logStore: "down"`, because the API keeps serving without them; check those fields separately. An intentionally empty Redis or Mongo URL reports `disabled`. These health probes establish connectivity, not schema/index readiness or successful log insertion. The home page also has an API status display and **Check again** action.

## Development checks and test isolation

The check and test commands are in [Commands](#commands). `bun run check` runs them the way CI does, on its own test stack, and is the quickest answer to "will CI pass?".

[CI](.github/workflows/ci.yml) runs on every pull request and every push to `main` and on nothing else: there is no manual trigger. Its `verify` job runs these same commands on a new isolated test stack; [TESTING.md §6](docs/implement-boilerplate/static-role/TESTING.md#6-ci) lists each step in order and why it sits where it does.

Once `verify` has passed, the `security` job runs [Trivy](https://trivy.dev). It fails the run on a fixable CRITICAL or HIGH vulnerability in `bun.lock` or in the MongoDB, PostgreSQL and Redis images, on a CRITICAL or HIGH misconfiguration in a Dockerfile, and on any secret in the repository files. Trivy is the pinned v0.69.3 release archive, unpacked only after its SHA-256 matches the one written in the workflow, and the pinned trivy-action never installs its own (`skip-setup-trivy: true`). The only way to accept a finding is an entry in [`.trivyignore.yaml`](.trivyignore.yaml). The entry must be scoped to the exact path or package version (secrets, misconfigurations and licenses by path), use only the documented fields, and name a statement, an owner and an `expired_at` no later than 2027-02-05, a cap set in the workflow. From that date the entry stops applying and the gate fails again. Trivy cannot check the Compose files for misconfiguration, so nothing in CI does. [TESTING.md §6.2](docs/implement-boilerplate/static-role/TESTING.md#62-security-gate-trivy) has the policy, the waiver process, the pins, what is waived today and the gaps. A deploy job added later must declare `needs: [verify, security]`.

CI has not passed on a GitHub-hosted runner yet; see [Known issues](#known-issues).

Do not run broad tests against the development `app` database. [docker-compose.test.yml](docker-compose.test.yml) describes the separate `app-test` project: PostgreSQL database `app_test` on **5442**, Redis on **6389**, and MongoDB on **27027**, with tmpfs data rather than dev volumes. Its port values are fixed; dev `*_PORT` variables do not change them. Sokudo's managed dev Up action does **not** provision this test stack; run `bun run test:stack:up` from a shell that talks to Sokudo's engine (`DOCKER_HOST=npipe:////./pipe/sokudo-docker`). Its project name `app-test` is fixed and shared with `bun run check`. To keep your stack apart from another worker's and from a check, use `docker compose -p <your-own-name> -f docker-compose.test.yml up -d --build --wait` and `docker compose -p <your-own-name> -f docker-compose.test.yml down -v`, which removes only yours. The ports are fixed, so only one such stack can run at a time. Never point DB-backed tests at the shared development stack.

### Test environment names

Configure test values in the shell that launches the tests. They are not interchangeable with the app's store URLs or Sokudo's browser-runner environment.

| Variable | Consumer and meaning |
|:---|:---|
| `TEST_DATABASE_URL` | API test preload; defaults to the local `app_test` connection on 5442 specified in `docker-compose.test.yml`. Must name **exactly `app_test`**. |
| `TEST_REDIS_URL` | Real Redis unit/integration tests; defaults to `redis://127.0.0.1:6389`. These suites skip if it is unavailable. They may use dev Redis on 6379 only because they write unique `test-*` keys, clean up their own keys, and never call `FLUSHDB`/`FLUSHALL`. |
| `TEST_LOG_MONGO_URL`, `TEST_LOG_MONGO_ADMIN_URL` | Optional live Mongo tests: writer and admin on an **isolated test MongoDB** (`app_logs`, normally port 27027). Both must be set to enable them. One test performs age-based pruning across the collection; never point these variables at development or production logs. |
| `API_E2E_URL` | API E2E client's base origin, for example `http://127.0.0.1:3010` for a separately started test API. Required; no server is started by the command. |
| `E2E_REDIS_URL` | API posts E2E checks the running test API's Redis and mutates application cache keys. Use isolated Redis, even though the `TEST_REDIS_URL` suites may share dev Redis. |
| `E2E_LOG_MONGO_URL` | API posts E2E reads the running test API's log store; use the `log_reader` connection with `find`, not the insert-only writer. `LOG_MONGO_DB` selects the database, default `app_logs`. |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD`, `WEB_URL` | API E2E needs the test API's seeded account and trusted web origin. Supply them to the test process as well as the server/seed process. |

The [API preload](apps/api/tests/setup.ts) pins `NODE_ENV=test`, replaces `DATABASE_URL` with the guarded `TEST_DATABASE_URL`, empties `REDIS_URL` and both application Mongo URLs, and supplies test-only post limits. [The DB helper](apps/api/tests/helpers/db.ts) checks the URL and connected database before migrating once per process under an advisory lock. Fixtures delete only their own inserted rows. Without PostgreSQL the module tests fail, while the seven database suites in `tests/utils/auth/` skip; CI treats any skip as a failure. Avoid concurrent manual migrations or incompatible migration histories on a shared `app_test`.

That preload only controls the test process. It **cannot protect the external server** named by `API_E2E_URL`. Before API E2E, configure a separate API terminal with `NODE_ENV=test`, `DATABASE_URL` targeting `app_test`, isolated `REDIS_URL` and writer `LOG_MONGO_URL`, the intended auth/seed values, and valid post limits. Set a free API port such as `3010`; if a web app uses it, pair it with `API_INTERNAL_URL=http://127.0.0.1:3010`. Apply migrations and seed to that isolated database, then start `bun run --filter @repo/api dev`. Run `bun run test` **before** you seed: `tests/utils/auth/super-admins.test.ts` demotes every other `super_admin` in `app_test`, and `bun run db:seed` refuses to promote the demoted seed account again. In the test terminal, configure the matching `API_E2E_URL` and E2E values above before running `bun run test:e2e`. Setting only `TEST_DATABASE_URL` does not configure a separately launched API or a manual seed. `bun run check` does all of this in one command.

### Web E2E in Sokudo

The existing flows live in [apps/web/e2e](apps/web/e2e). Run them through Sokudo's E2E UI or agent tools, with API and web already running for the selected test environment. There is no web `test:e2e` package script, and the runner has no command line or headless mode, so the [CI workflow](.github/workflows/ci.yml) cannot run these flows. They are a separate gate with their own policy: [TESTING.md §6.1](docs/implement-boilerplate/static-role/TESTING.md#61-web-e2e-is-a-separate-gate). Root `test:e2e` does not run them either. [TESTING.md](docs/implement-boilerplate/static-role/TESTING.md) describes the suite.

1. Configure credentials in **Settings → Environment Variables**, using the active default or a named environment. Mark passwords as secrets. The runner's `environment` argument selects a named environment, and `env` overrides values for a run; neither requires putting secrets into YAML or chat.
2. Set `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` for an existing ordinary user. Admin flows also need `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`, `E2E_SUPER_ADMIN_EMAIL` / `E2E_SUPER_ADMIN_PASSWORD`, and `E2E_ROLE_TARGET_EMAIL` for a separate ordinary user whose role the flow changes. `db:seed` creates only the super-admin, not all these accounts.
3. Discover the current files with `e2e_list_flows`, validate a selected file with `e2e_validate`, and run it with `e2e_run`. For example, the agent-tool input `{"files":["apps/web/e2e/health/status.yaml"]}` runs the status flow using the active environment. This is tool input, not a shell command. Read results with `e2e_runs`.
4. Discovery and execution use the workspace's **main checkout**. A new flow in a worker worktree is not runnable there until the user merges it into that checkout. Ensure the served code matches the flows being run. Runs are serialized per workspace; wait for an active run to finish.

Current YAML files have literal `http://localhost:3001` URLs; an environment variable alone does not retarget them. Flows can create accounts/posts, update profiles, and change roles. Use disposable test accounts/data and coordinate the app bound to that port. Seeded list flows need the example posts; `posts/empty-state.yaml` requires a separate **unseeded** test database with no posts and an existing E2E user. Do not reset a shared database to satisfy it. Sign-in rate limits can affect back-to-back auth runs; allow the limit window to expire rather than disabling protection.

## Troubleshooting

Run `bun run doctor` first: it checks `.env` and the three services and names a fix for each problem.

| Symptom | Check / next action |
|:---|:---|
| `setup` or `infra:up` fails to publish a port (the wording depends on the Docker engine) | Something already uses that port. If it is the Sokudo-managed stack, run `bun run setup --skip-infra`. Otherwise change `POSTGRES_PORT`, `REDIS_PORT` or `MONGO_PORT` and the matching URLs in `.env`. |
| API exits with missing secret or post limits | Fill the required root `.env` entries. Blank limits are intentional; obtain the chosen values. Check shell overrides without printing secret values. |
| Direct health works but web proxy/SSR fails | Match `PORT` and `API_INTERNAL_URL`, then restart your own web process. Keep the web auth origins on 3001. |
| Port 3001 is occupied | Vite deliberately refuses a fallback port. Identify and coordinate with its owner; do not kill another worker's server. |
| Healthy PostgreSQL but app tables are absent | Confirm the intended database, then apply its migrations. Container health only checks readiness. |
| Seeded login fails after changing the seed password | The seed does not rotate existing passwords. Use the application's reset flow or an authorized account-maintenance procedure. |
| Mongo authentication or index setup fails | Check port, database, `authSource`, and role-specific URL. Initialization is not replayed on an existing volume. Follow [non-destructive recovery](docs/operations/log-retention.md#failure-and-recovery). |
| DB-backed tests cannot reach 5442 | Provision isolated `app_test` or set `TEST_DATABASE_URL` to its actual endpoint. Do not substitute the dev `app` database. |
| Sokudo cannot see a worktree flow | Discovery scans the main checkout. Validate the file, then wait for user merge before running it. |
| API E2E: every admin or `super_admin` request returns 403 | A unit run demoted the seeded account (`tests/utils/auth/super-admins.test.ts`), and `db:seed` will not promote it again. Delete that account from `app_test`, run `bun run db:seed`, and repeat the E2E; next time, seed after the unit tests. |
| CI `security` job fails | Open the failing scan step: its log has a table of the findings. Bump the dependency or the image tag if a fix exists. Otherwise, check that the flaw cannot be reached, then waive the finding in `.trivyignore.yaml`, scoped to its path or package version, with a statement, an owner and an `expired_at` ([TESTING.md §6.2](docs/implement-boilerplate/static-role/TESTING.md#62-security-gate-trivy)). Do not skip paths or set `exit-code: 0`. |
| CI `verify` fails at "Start the test services" with Mongo log id `12257600` | The runner's kernel is in the range MongoDB refuses. Check that the mongo image still sets `GLIBC_TUNABLES=glibc.pthread.rseq=1`; if it does, the workaround is not enough on that kernel. See [TESTING.md §6.3](docs/implement-boilerplate/static-role/TESTING.md#63-mongodb-on-the-hosted-runner). |

## Known issues

- **CI has not passed on a GitHub-hosted runner.** Every MongoDB 8.x tag on Docker Hub when checked (newest 8.3.13 / 8.0.34) refuses to start on the runner's `7.0.0-*-azure` kernel (SERVER-121912). The MongoDB image is pinned to `mongo:8.3.13@sha256:e16e606f…cd2` with the docker-library workaround `GLIBC_TUNABLES=glibc.pthread.rseq=1`, which passes locally, but local kernels are below the affected range, so whether it works on the hosted runner is unconfirmed. Until `verify` passes there, the `security` job does not run on GitHub either. Cause, fallbacks and the upgrade path: [TESTING.md §6.3](docs/implement-boilerplate/static-role/TESTING.md#63-mongodb-on-the-hosted-runner).
- **Web E2E flows cannot run in CI.** The workspace runner needs an open Browser panel and has no command line or headless mode, so web E2E is a manual gate ([TESTING.md §6.1](docs/implement-boilerplate/static-role/TESTING.md#61-web-e2e-is-a-separate-gate)).
- **Real-signal shutdown tests skip on Windows.** Two tests in `apps/api/tests/utils/lifecycle/process.test.ts` and one in `apps/web/tests/server.test.ts` need POSIX signals, so CI's "no skipped tests" check passes only on Linux or macOS. `bun run check` allows exactly these three skips on Windows ([TESTING.md §6](docs/implement-boilerplate/static-role/TESTING.md#6-ci)).
- **The seed must follow the unit tests on `app_test`.** `tests/utils/auth/super-admins.test.ts` demotes the seeded `super_admin`, and `db:seed` does not promote it again, so seed after `bun run test`, never before (see Troubleshooting).
- **No Compose misconfiguration scan.** Trivy has no Docker Compose check, so CI does not lint `docker-compose*.yml` ([TESTING.md §6.2](docs/implement-boilerplate/static-role/TESTING.md#62-security-gate-trivy)).
