# Elysia boilerplate

A Bun monorepo with an Elysia API, TanStack Start web app, Better Auth, Drizzle/PostgreSQL, Redis caching, and MongoDB log storage. The current implementation uses static roles.

The [static-role implementation record](docs/implement-boilerplate/static-role/README.md) governs this build. `docs/specs/` is the frozen design baseline; `docs/prd/` is historical. Coding conventions live in [apps/api/README.md](apps/api/README.md) and [apps/web/README.md](apps/web/README.md).

**Start a new project from your own PRD:** follow [NEW-PROJECT.md](docs/implement-boilerplate/static-role/NEW-PROJECT.md) to turn this starter kit into your product.

## Getting started

### 1. Prerequisites and installation

Clone the repository, open its root folder as a Sokudo workspace, and run the commands below from that folder unless another directory is specified. Shell-specific examples use PowerShell.

- Git and **Bun 1.4.4**, the development baseline verified in the implementation record. There is no runtime-version file or `packageManager` field enforcing Bun's version. Use the committed `bun.lock`; package versions are exact.
- **Node.js satisfying `^20.19.0 || >=22.12.0`**, the engine requirement of Vite 8.3.5. Vite's executable runs on Node as a child of Bun; the API runs on Bun.
- Sokudo with its managed Docker engine available. The development Compose stack supplies PostgreSQL 17, Redis 8.10, and MongoDB 8. PostgreSQL (`postgres:17`) is pinned to a major version only; Redis is pinned to `redis:8.10.3-alpine` and MongoDB to `mongo:8.3.13`, both by digest.
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
| `PORT`, `API_INTERNAL_URL` | `3000` and `http://127.0.0.1:3000`. Always change these together. Keep `127.0.0.1`, not `localhost`: the API listens on `HOST` (default `127.0.0.1`, IPv4 loopback only), and `localhost` resolves to `::1` first on Windows. |
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

The API, database and log scripts in each workspace load the root file with `bun --env-file=../../.env`; the root `dev:api` script loads the same file as `--env-file=.env`. The web script is `bun --env-file=../../.env vite dev`; [vite.config.ts](apps/web/vite.config.ts) reads `process.env.API_INTERNAL_URL` and sets `envDir: false` (ignore the stale `loadEnv` comment in `.env.example`, see [Known issues](#known-issues)). Shell variables override file values, including explicitly empty values. Restart your own local app processes after changing these settings; check for old shell overrides if a change appears ignored.

### 3. Start development infrastructure in Sokudo

Use the workspace's **Compose panel → Up**, which selects [docker-compose.dev.yml](docker-compose.dev.yml) and applies Sokudo's engine, project name, and port overrides. Agents use `docker_compose_up` and `docker_compose_status`. A raw shell `docker compose up` targets a different engine/configuration and is not the managed startup procedure.

Wait for all three services to report **running / healthy**, and inspect their published ports in Sokudo:

| Service | Default host endpoint | Data |
|:---|:---|:---|
| PostgreSQL | `127.0.0.1:5432` | Database `app`; named volume. |
| Redis | `127.0.0.1:6379` | Cache and counters; persistence disabled, `/data` on tmpfs. |
| MongoDB | `127.0.0.1:27017` | `app_logs.log_event`; named data/config volumes. |

`POSTGRES_PORT`, `REDIS_PORT`, and `MONGO_PORT` in the root `.env` configure host ports. If one changes, update every corresponding connection URL and confirm the actual published port in Sokudo. MongoDB requires updating both writer and admin URLs. The Compose file publishes services on loopback.

The managed development Mongo service uses the pinned `mongo:8.3.13@sha256:e16e606f…cd2` image, with `GLIBC_TUNABLES=glibc.pthread.rseq=1` like `infra/mongo/Dockerfile` ([TESTING.md §6.3](docs/implement-boilerplate/static-role/TESTING.md#63-mongodb-on-the-hosted-runner)), and writes an inline bootstrap inside the container. This avoids the managed engine's Windows bind-mount and build-context path limitations. Keep this working arrangement; `infra/mongo/Dockerfile` is used by the other Compose definitions, not this managed dev service. Mongo initialization creates the three log users only on an **empty** volume. A healthy container does not prove that application migrations or log indexes have been applied.

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
bun run dev:api
```

```powershell
bun run dev:web
```

`dev:api` runs from the root so `bun --watch` also restarts the API when `packages/*` change. `bun run --filter @repo/api dev` still works but does not watch `packages/*`.

Open `http://localhost:3001/`. Sign in at `/login` with the seeded account. The browser uses `/api/*` on the web origin; the Vite proxy forwards it to the API. SSR calls that same API via `API_INTERNAL_URL`.

Check both the direct API and the web proxy, replacing the first port if you changed `PORT`:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/api/health
Invoke-RestMethod -Uri http://localhost:3001/api/health
```

With the three stores configured and reachable, expect HTTP 200, `status: "ok"`, `db: "up"`, `redis: "up"`, `logStore: "up"`, and numeric `uptime`. PostgreSQL being down returns 503 with `code: "SERVICE_UNAVAILABLE"`, a `message`, `status: "degraded"` and the same dependency fields. A configured Redis or MongoDB being down still returns 200, with `redis: "down"` or `logStore: "down"`, because the API keeps serving without them; check those fields separately. An intentionally empty Redis or Mongo URL reports `disabled`. These health probes establish connectivity, not schema/index readiness or successful log insertion. The home page also has an API status display and **Check again** action.

## Development checks and test isolation

These commands exist in the root [package.json](package.json):

| Command | What it runs / prerequisite |
|:---|:---|
| `bun run typecheck` | Apps, packages, then `scripts/`; a failed earlier check prevents the final scripts check. |
| `bun run lint` | Web oxlint with warnings denied; there is no API lint script. |
| `bun run check:test-folders` | Checks module/feature test-folder coverage. No running app required. |
| `bun run test` | Folder-check tests and API/web unit/integration tests. API DB-backed tests require **`app_test`**. Does not run E2E. |
| `bun run test:e2e` | **API HTTP E2E only**, against an already running test API selected by `API_E2E_URL`. |

[CI](.github/workflows/ci.yml) runs on every pull request and every push to `main` and on nothing else: there is no manual trigger. Its `verify` job runs these same commands in the order that works: the frozen install, typecheck, lint and folder check; a new isolated test stack; migrations; `bun run test`; then the seed and the API E2E against a test API. [TESTING.md §6](docs/implement-boilerplate/static-role/TESTING.md#6-ci) lists each step and why it sits where it does.

Once `verify` has passed, the `security` job runs [Trivy](https://trivy.dev). It fails the run on a fixable CRITICAL or HIGH vulnerability in `bun.lock` or in the MongoDB, PostgreSQL and Redis images, on a CRITICAL or HIGH misconfiguration in a Dockerfile, and on any secret in the repository files. Trivy is the pinned v0.69.3 release archive, unpacked only after its SHA-256 matches the one written in the workflow, and the pinned trivy-action never installs its own (`skip-setup-trivy: true`). The only way to accept a finding is an entry in [`.trivyignore.yaml`](.trivyignore.yaml). The entry must be scoped to the exact path or package version (secrets, misconfigurations and licenses by path), use only the documented fields, and name a statement, an owner and an `expired_at` no later than 2027-02-05, a cap set in the workflow. From that date the entry stops applying and the gate fails again. Trivy cannot check the Compose files for misconfiguration, so nothing in CI does. [TESTING.md §6.2](docs/implement-boilerplate/static-role/TESTING.md#62-security-gate-trivy) has the policy, the waiver process, the pins, what is waived today and the gaps. A deploy job added later must declare `needs: [verify, security]`.

CI has not passed on a GitHub-hosted runner yet; see [Known issues](#known-issues).

Do not run broad tests against the development `app` database. [docker-compose.test.yml](docker-compose.test.yml) describes the separate `app-test` project: PostgreSQL database `app_test` on **5442**, Redis on **6389**, and MongoDB on **27027**, with tmpfs data rather than dev volumes. Its port values are fixed; dev `*_PORT` variables do not change them. Sokudo's managed dev Up action does **not** provision this test stack. From a shell that talks to Sokudo's engine (`DOCKER_HOST=npipe:////./pipe/sokudo-docker`), `docker compose -p <your-own-name> -f docker-compose.test.yml up -d --build --wait` builds the Mongo image and waits until all three services are healthy. `-p` keeps it away from another worker's `app-test` project, and `docker compose -p <your-own-name> -f docker-compose.test.yml down -v` removes only yours. The ports are fixed, so only one such stack can run at a time. Never point DB-backed tests at the shared development stack.

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

That preload only controls the test process. It **cannot protect the external server** named by `API_E2E_URL`. Before API E2E, configure a separate API terminal with `NODE_ENV=test`, `DATABASE_URL` targeting `app_test`, isolated `REDIS_URL` and writer `LOG_MONGO_URL`, the intended auth/seed values, and valid post limits. Set a free API port such as `3010`; if a web app uses it, pair it with `API_INTERNAL_URL=http://127.0.0.1:3010`. Apply migrations and seed to that isolated database, then start `bun run --filter @repo/api dev`. Run `bun run test` **before** you seed: `tests/utils/auth/super-admins.test.ts` demotes every other `super_admin` in `app_test`, and `bun run db:seed` promotes the account again if a unit run came after it. In the test terminal, configure the matching `API_E2E_URL` and E2E values above before running `bun run test:e2e`. Setting only `TEST_DATABASE_URL` does not configure a separately launched API or a manual seed.

### Web E2E in Sokudo

The existing flows live in [apps/web/e2e](apps/web/e2e). Run them through Sokudo's E2E UI or agent tools, with API and web already running for the selected test environment. There is no web `test:e2e` package script, and the runner has no command line or headless mode, so the [CI workflow](.github/workflows/ci.yml) cannot run these flows. They are a separate gate with their own policy: [TESTING.md §6.1](docs/implement-boilerplate/static-role/TESTING.md#61-web-e2e-is-a-separate-gate). Root `test:e2e` does not run them either. [TESTING.md](docs/implement-boilerplate/static-role/TESTING.md) describes the suite.

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
| API E2E: every admin or `super_admin` request returns 403 | A unit run demoted the seeded account (`tests/utils/auth/super-admins.test.ts`). Run `bun run db:seed` again, which promotes it, and repeat the E2E. |
| CI `security` job fails | Open the failing scan step: its log has a table of the findings. Bump the dependency or the image tag if a fix exists. Otherwise, check that the flaw cannot be reached, then waive the finding in `.trivyignore.yaml`, scoped to its path or package version, with a statement, an owner and an `expired_at` ([TESTING.md §6.2](docs/implement-boilerplate/static-role/TESTING.md#62-security-gate-trivy)). Do not skip paths or set `exit-code: 0`. |
| CI `verify` fails at "Start the test services" with Mongo log id `12257600` | The runner's kernel is in the range MongoDB refuses. Check that the mongo image still sets `GLIBC_TUNABLES=glibc.pthread.rseq=1`; if it does, the workaround is not enough on that kernel. See [TESTING.md §6.3](docs/implement-boilerplate/static-role/TESTING.md#63-mongodb-on-the-hosted-runner). |

## Known issues

- **CI has not passed on a GitHub-hosted runner.** Every MongoDB 8.x tag on Docker Hub when checked (newest 8.3.13 / 8.0.34) refuses to start on the runner's `7.0.0-*-azure` kernel (SERVER-121912). The MongoDB image is pinned to `mongo:8.3.13@sha256:e16e606f…cd2` with the docker-library workaround `GLIBC_TUNABLES=glibc.pthread.rseq=1`, which passes locally, but local kernels are below the affected range, so whether it works on the hosted runner is unconfirmed. Until `verify` passes there, the `security` job does not run on GitHub either. Cause, fallbacks and the upgrade path: [TESTING.md §6.3](docs/implement-boilerplate/static-role/TESTING.md#63-mongodb-on-the-hosted-runner).
- **Web E2E flows cannot run in CI.** The workspace runner needs an open Browser panel and has no command line or headless mode, so web E2E is a manual gate ([TESTING.md §6.1](docs/implement-boilerplate/static-role/TESTING.md#61-web-e2e-is-a-separate-gate)).
- **Real-signal shutdown tests skip on Windows.** Two tests in `apps/api/tests/utils/lifecycle/process.test.ts` need POSIX signals, so CI's "no skipped tests" check passes only on Linux or macOS.
- **The seed must follow the unit tests on `app_test`.** `tests/utils/auth/super-admins.test.ts` demotes the seeded `super_admin`; re-run `bun run db:seed` before the API E2E (see Troubleshooting).
- **No Compose misconfiguration scan.** Trivy has no Docker Compose check, so CI does not lint `docker-compose*.yml` ([TESTING.md §6.2](docs/implement-boilerplate/static-role/TESTING.md#62-security-gate-trivy)).
- **Stale comment in `.env.example`.** Its header still says apps/web loads the root `.env` through Vite's `loadEnv`; the web dev script actually uses `bun --env-file=../../.env` (step 2).
