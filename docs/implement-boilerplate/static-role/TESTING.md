# TESTING.md

How tests are organised and what each module and feature must have (DEC-039). The rules that enforce this are in [apps/api/README.md §10](../../../apps/api/README.md) and [apps/web/README.md §9](../../../apps/web/README.md).

## 1. Levels

| Level | App | What it proves | Runs against | Folder |
|:---|:---|:---|:---|:---|
| Unit | api | A service, helper or pure function is correct | Nothing external (mocks, memory sink) | `apps/api/tests/modules/<module>/`, `tests/utils/<util>/`, `tests/scripts/` |
| Route (integration) | api | A module's routes: validation, auth, permissions, errors, module tag | `app.handle(new Request(...))` + test PostgreSQL | `apps/api/tests/modules/<module>/` |
| API E2E | api | Real HTTP flows across modules on a running stack | Running API + PostgreSQL + Redis + MongoDB | `apps/api/tests/e2e/<module>/` |
| Unit / component | web | Hooks, `lib/` helpers, forms, pages render the right states | happy-dom, mocked API client | `apps/web/tests/features/<feature>/` |
| Web E2E | web | User journeys in a real browser | Running web + API stack | `apps/web/e2e/<feature>/*.yaml` |

## 2. Tools

| Need | Tool |
|:---|:---|
| Runner (both apps) | `bun test` on Bun 1.4.4: preload, `mock.module()`, `test.each` and `skipIf` all work |
| DOM for web tests | `@happy-dom/global-registrator` 21.0.4, preloaded through `apps/web/bunfig.toml` (`[test] preload = ["./tests/setup.ts"]`) |
| React testing | `@testing-library/react` 16.3.3 (peer `react` ^18 \|\| ^19, used with React 19.3.1) + `@testing-library/dom` 10.4.2 (its required peer) + `@testing-library/user-event` 14.6.8 |
| Module mocks | `mock.module()` from `bun:test`. Bun links a test file's static imports before `mock.module` runs, so register the mock first and load the code under test with `await import(...)` |
| Telemetry assertions | the `memory` sink |
| Web E2E | The workspace E2E system: YAML flows run by its runner. No Playwright, Cypress, Puppeteer or Selenium |

## 3. API layout

```
apps/api/tests/
  setup.ts            preload (apps/api/bunfig.toml): NODE_ENV=test, DATABASE_URL → test database;
                      REDIS_URL, LOG_MONGO_URL, LOG_MONGO_ADMIN_URL emptied; test post limits (120 / 2000)
  helpers/            the harness (its own tests live here too: db, ip, and e2e-client for e2e/helpers/client.ts)
    app.ts            the app for app.handle(), the shared memory sink, request()/jsonPost(); no listen()
    db.ts             URL guard, migrate once, testDb(), scoped fixtures(); never truncates (test PostgreSQL)
    auth.ts           createUser(fixtures, db, role) → { id, email, cookie }: a fixtures user (any stored role,
                      NULL included) with a password account, signed in through /api/auth/sign-in/email;
                      signIn(email, password?) → cookie header
    ip.ts             uniqueIp(): the one source of client IPs for unit tests that sign in (shared rate limit)
    capture.ts        captureLogger(): a pino logger writing to a buffer, plus duplicate-key checks on its lines
    probe.ts          a stand-in module whose route makes another module's service throw (sourceModule tests)
    redis.ts          TEST_REDIS_URL, reachability check, a stalling Redis and a reply-dropping proxy,
                      runInApiProcess() for checks that need a child process with its own environment
    silent-server.ts  a TCP server that accepts and never answers (stalled PostgreSQL or MongoDB)
  modules/<module>/   one folder per src/modules/<module>, same name
    service.test.ts
    routes.test.ts
    permissions.test.ts
  utils/<util>/       one folder per src/utils/<util>, same name (auth, cache, db, error, lifecycle, logger,
                      mongo, rate-limit, redis, telemetry)
  scripts/            tests for apps/api/scripts (logs-prune.test.ts)
  e2e/
    helpers/          client.ts (fetch with cookie jar against API_E2E_URL), users.ts (unique accounts,
                      a random client IP per call, the seeded super_admin)
    <module>/         one folder per module that has routes, same name
      <flow>.test.ts
```

- Two facts about `app.handle()`:
  - Elysia reads the path after the first 11 characters of the URL, so a test request needs a host of at least 4 characters (`http://localhost/api/...`); `http://x/api/...` resolves to the wrong route.
  - `onAfterResponse` hooks, where `http.request` is emitted, run with `setImmediate` after the response is built. Wait one tick (`await new Promise(resolve => setImmediate(resolve))`) after `app.handle()` before asserting on `http.request`; `http.error` is already there. `tests/helpers/app.ts` does this in its `request()` helper.
- Folder names equal the module or util folder names exactly. A module without a test folder fails `bun run check:test-folders` (§7).
- `bun run test` (in `apps/api`) runs `bun test tests/modules tests/utils tests/scripts tests/helpers`. `bun run test:e2e` runs `bun test tests/e2e` and fails at once without `API_E2E_URL`. E2E never runs as part of `test`. At the repo root, `bun run test` runs the folder-check tests (`bun test ./scripts`) and both apps' `test`; `bun run test:e2e` runs the API's.
- Test PostgreSQL: the `app_test` database. `TEST_DATABASE_URL` names it (default `postgres://app:app_dev@127.0.0.1:5442/app_test`, the test stack); the preload copies it into `DATABASE_URL`, overriding any value from the shell or the repo-root `.env`, so app code under test can only reach the test database. `REDIS_URL`, `LOG_MONGO_URL` and `LOG_MONGO_ADMIN_URL` are emptied the same way (memory fallback, stdout only); tests that need a real Redis or MongoDB use their own `TEST_*` URLs. `NODE_ENV` is pinned to `test`.
  - **Guard:** `assertTestDatabaseUrl` refuses, before a connection is opened, any URL whose database is not exactly `app_test` or that carries a query parameter other than `ssl`, `sslmode`, `sslrootcert`, `connect_timeout` and `application_name` (postgres-js would send `database`, `user` or `options` as startup parameters; `?database=app` is refused). `prepareTestDatabase` checks `current_database()` after connecting, before migrating. Messages name host and database, never the URL.
  - **Migrations:** `testDb()` runs `bun run db:migrate` (packages/db) once per `bun test` process, under a PostgreSQL advisory lock so processes starting together on a fresh database take turns, and returns a shared `createDb()` pool that test files never close. Waiting for the lock and the migration itself are each limited to 60 s, and a migration that times out is killed before the lock is released. The lock is cooperative: a migration started by hand bypasses it, and if a test process dies mid-migration PostgreSQL frees the lock while its child may still be running. Workers sharing `app_test` must have compatible migration histories.
  - **Isolation:** the test database is shared by parallel runs, so tests never truncate or reset it. `fixtures(db)` creates rows with unique IDs (`test-<uuid>`, recorded only after the insert succeeds) and emails (`test+<run>-<n>@example.test`), and `cleanup()` deletes exactly those rows (dependants follow by cascade).
  - Tests that call `testDb()` (the module route and service tests) fail when test PostgreSQL is not running: `docker compose -f docker-compose.test.yml up -d --wait postgres`. The seven suites in `tests/utils/auth/` that need a database use their own `prepareTestDatabase()` (`setup.ts`) and **skip** instead (`describe.skipIf(!ready)`), so a run without PostgreSQL can still look green. CI fails on any skipped test for that reason (§6).
- Test Redis: the real-Redis suites in `tests/utils/cache`, `tests/utils/rate-limit` and `tests/utils/redis` use `TEST_REDIS_URL` (default `redis://127.0.0.1:6389`, the test stack) and skip when nothing answers there. They only write keys under a `test-<uuid>` name (`test-<uuid>:…`, or `ratelimit:test-<uuid>:…` for a rate limiter), delete what they wrote and never flush, so `TEST_REDIS_URL=redis://127.0.0.1:6379` may point them at a dev Redis. `createReplyDroppingProxy` (`tests/helpers/redis.ts`) sits in front of a real Redis and throws replies away, so a test can lose a reply after Redis ran the command, and can answer one command (`MULTI`) with a `NOPERM` refusal, as an ACL would, without changing the server's ACLs.
- Test MongoDB: the live log-store checks (`tests/utils/mongo/log-store.test.ts`, plus parts of `tests/modules/health/routes.test.ts` and `tests/utils/lifecycle/process.test.ts`) run only when both `TEST_LOG_MONGO_URL` (writer) and `TEST_LOG_MONGO_ADMIN_URL` (admin) are set, and skip otherwise. They use the `app_logs` database of the test stack, and one of them prunes by age across the collection, so never point these variables at development or production logs. The `mongo` sink and the prune command also have in-memory tests that need no MongoDB (`tests/utils/telemetry/mongo-sink.test.ts`, `tests/scripts/logs-prune.test.ts`).
- Test stack: `docker-compose.test.yml` is its own project (`app-test`) and publishes PostgreSQL on `127.0.0.1:5442` (database `app_test`), Redis on `6389` and MongoDB on `27027`: ten above the dev ports, fixed, so tests never collide with the dev stack. Its data lives in tmpfs, so every `up` starts empty and `down` leaves nothing behind. The MongoDB log users are the same as in dev ([log-storage.md §2](observability/log-storage.md)). The URLs are listed at the top of the file.

### 3.1 Required tests per module

| File | Must cover |
|:---|:---|
| `routes.test.ts` | For every route: success; `400 VALIDATION_ERROR` with field paths only; `401` without a session; `403` without the permission; `404` when it has `:id`; ownership rule where there is one. Every response has `x-request-id`. |
| `routes.test.ts` (logging) | A forced error in the route produces one `http.error` in the memory sink with `module: "<module>"` and no route field; a `moduleError` carries `sourceModule` |
| `service.test.ts` | Business logic, cache hit = miss payload, cache invalidation on writes, `moduleError` codes |
| `redis-outage.test.ts` (a module that caches) | The app in a child process with `REDIS_URL` unreachable: reads answer 200 from PostgreSQL, writes answer their usual status with the data in PostgreSQL, no `http.error`, and the cache failures arrive as `cache.unavailable` from the module (posts: `tests/modules/posts/redis-outage.test.ts`) |
| `permissions.test.ts` | The module's grants appear in the compiled-roles snapshot; every permission is used by at least one route |

Cross-cutting tests in `tests/utils/`: the permission matrix and guard rules (`auth/`, [auth/static-roles.md §11](auth/static-roles.md)), redaction (`telemetry/`, [observability/redaction.md §7](observability/redaction.md)), the `mongo` sink (`telemetry/`) and log store (`mongo/`) ([log-storage.md §8](observability/log-storage.md)), `moduleScope` startup checks (`logger/`), graceful shutdown (`lifecycle/`). The prune command is tested in `tests/scripts/`.

### 3.2 API E2E

- **Stack:** `docker compose -f docker-compose.test.yml up -d --build --wait` (PostgreSQL, Redis, MongoDB; `--wait` returns once all three are healthy), migrations and seed (the seed after `bun run test`, which demotes other super_admins: §6), then the API started with `NODE_ENV=test` and `LOG_MONGO_URL` set. `API_E2E_URL` points at it.
- **Isolation:** each test file creates its own users with unique emails (`e2e+<run>-<n>@example.test`) through the Better Auth endpoints; tests never depend on order between files.
- **Required flows:**

| Folder | Flows |
|:---|:---|
| `e2e/auth/` | sign-up → sign-in → get-session → sign-out → 401; sixth sign-in in 60 s → 429; fourth sign-up in 60 s → 429; impersonation endpoints → 404 |
| `e2e/posts/` | user creates, lists (cache hit after the first call), edits and deletes own post; another user gets 403; admin edits anyone's; the `x-request-id` of a posts request finds its `http.request` document in MongoDB with `module: "posts"`. Besides `API_E2E_URL` and the seeded super_admin it reads `E2E_REDIS_URL` (the API's Redis, to see the cached page) and `E2E_LOG_MONGO_URL` (a log user that can `find`, e.g. `log_reader`), and the API needs `POSTS_TITLE_MAX_LENGTH` / `POSTS_CONTENT_MAX_LENGTH` |
| `e2e/admin/` | super_admin changes a role and the next `/api/me/permissions` reflects it; admin gets 403 on set-role; roles catalogue |
| `e2e/me/` | permissions per role |
| `e2e/health/` | 200 with all dependencies; `logStore: "down"` still 200 when MongoDB is unreachable |

- **Environment:** besides `API_E2E_URL`, the suite reads `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD` (the seeded super_admin), `WEB_URL` (the Origin Better Auth trusts; default `http://localhost:3001`), `E2E_REDIS_URL` (the API's Redis), `E2E_LOG_MONGO_URL` (a log user that can `find`) and optionally `LOG_MONGO_DB`. The bunfig preload still applies, so `TEST_DATABASE_URL` (default the test stack's `app_test`) must be the database the API under test uses. Files run one after another in one `bun test` process and share no data.
- **Rate limits:** sign-up allows 3 and sign-in 5 requests a minute per client IP, read from the `CLIENT_IP_HEADER` header (default `cf-connecting-ip`). Tests send it only through `clientIp(ip)` (`tests/helpers/ip.ts`), which reads the same `env.CLIENT_IP_HEADER`, so the header name lives in `env.ts` alone; the API under test must be started with the same `CLIENT_IP_HEADER` as the test run. Every sign-up and sign-in in `e2e/` sends its own random address (`helpers/users.ts`: 198.19.0.0/16; `posts.test.ts`: 10.208.0.0/16), so files never use up each other's budget. `e2e/auth/session.test.ts` sends one address on purpose to prove the limits: the sixth sign-in in 60 s is 429 even with the right password, and the fourth sign-up is 429 and creates no account.
- **MongoDB unreachable:** stopping the stack's MongoDB would break `e2e/posts/` (it reads its logs), so `e2e/health/log-store-down.test.ts` starts a second API process of its own (`src/index.ts`, a free port, the same test PostgreSQL and `E2E_REDIS_URL`) whose `LOG_MONGO_URL` points at a port nothing listens on, i.e. refused like a stopped container, and kills it in `afterAll`. It asserts 200 with `logStore: "down"` and that sign-up and `GET /api/posts` still succeed. No CI step may stop a container while the E2E runs.

Google OAuth is not automated end to end (it needs Google). It is covered by route tests with Google's token endpoint mocked (`tests/utils/auth/google.test.ts`) and checked by hand before release.

## 4. Web layout

```
apps/web/tests/
  setup.ts            preload: happy-dom registration, Testing Library cleanup
  tsconfig.json       test types (bun); checked by `bun run typecheck`
  router.test.ts      getRouter(): builds the generated route tree, a new router per call
  helpers/
    render.tsx        renderWithRouter(): one component on a test router
    app.tsx           renderApp(path): the real route tree with a test QueryClient (no retry delay)
  features/<feature>/ one folder per src/features/<feature>, same name
    api-mock.ts       mock.module() stand-ins for the API clients; imported first, then the code under test
                      with `await import()`
    hooks.test.ts(x)
    lib.test.ts
    <page-or-component>.test.tsx
  routes/             tests for src/routes
  lib/                tests for src/lib
  components/         tests for src/components
  lint/               tests for the feature-boundary lint rule in apps/web/lint, including a run of the real
                      oxlint binary on a throwaway app
apps/web/e2e/
  <feature>/          one folder per feature that has pages, same name
    <flow>.yaml
```

- `bun run test` (in `apps/web`) runs `bun test tests`. Testing Library is imported after happy-dom registers (dynamic import in `setup.ts`), because it binds `screen` to the document present at import.
- Web E2E has no `test:e2e` script: the workspace E2E system runs flows from its own UI and agent tools (`e2e_run`), and has no command line to call from a script or CI (§6.1).
- Components are tested through what users see (roles, labels, text), not class names.

### 4.1 Required tests per feature

| Area | Must cover |
|:---|:---|
| Hooks | Query keys from the factory; `{ data, error }` turned into a thrown error with `status` and `code`; mutations invalidate the right keys |
| `lib/` | Form schemas match the API limits; error-code mapping |
| Forms | Valid input submits once; invalid input blocks submit; server `400 VALIDATION_ERROR` shows on the named field |
| Pages | Loading, empty, error and forbidden states; actions hidden without the permission (`can()` mocked) |

## 5. Web E2E flows

Flows are YAML files run by the workspace E2E system. Each file is one journey.

**Dialect:** a header document, a `---` separator, then the steps.

```yaml
# apps/web/e2e/auth/sign-in.yaml (sketch)
url: http://localhost:3001/login      # web dev port 3001, strictPort
name: auth - sign in with email lands on the status page signed in
tags: [auth, smoke]
clearState: true
---
- launchApp
- tapOn: "Email"
- inputText: "${E2E_USER_EMAIL || ''}"
- tapOn: "Password"
- inputText: "${E2E_USER_PASSWORD || ''}"
- pressKey: Enter
- assertVisible: "Sign out"
- takeScreenshot: auth-signed-in
```

- Header keys: `url` (required), `name`, `tags`, `env`, `clearState`. No other header keys.
- Steps come from the runner's interpreter (`launchApp`, `openLink`, `tapOn`, `inputText`, `pressKey`, `assertVisible`, `takeScreenshot`, `back`, …); check names against the interpreter, never from memory. Every flow is validated (`e2e_validate`) before it is committed.
- `name` starts with the feature name; `tags` include the feature name.
- Selectors use visible, unique text or accessible labels, never CSS classes shared by repeated rows.
- Credentials come from environment values configured for the E2E environment, never written in the YAML.
- The runner discovers flows in nested `e2e/<feature>/` folders, under both `apps/web/e2e/` and a root `e2e/`. Its listing shows each flow under its file name, not the header `name`, so file names should read well on their own. It scans the workspace's main checkout, so a flow in a separate git worktree is listed and run only once it reaches that checkout.
- `e2e/auth/` flows read the E2E environment values `E2E_USER_EMAIL` and `E2E_USER_PASSWORD` (an existing account). The validator rejects an undefined variable, so flows write `${E2E_USER_EMAIL || ''}`: without the value a flow fails at the form's own check. Sign-in allows 5 attempts a minute per IP, so running every auth flow back to back from one machine can hit 429.
- `e2e/admin/` flows also read `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` (an account with role `admin`), `E2E_SUPER_ADMIN_EMAIL` / `E2E_SUPER_ADMIN_PASSWORD` (role `super_admin`) and `E2E_ROLE_TARGET_EMAIL` (a separate account with role `user`, used only by the role-change flow, which promotes it to `admin` and restores it to `user`). The role select has no step of its own in the runner, so the flow drives it with the keyboard.

**Required flows:**

| Folder | Flows |
|:---|:---|
| `e2e/auth/` | sign-up, sign-in, refresh keeps the session, sign-out, protected page redirects to `/login`, wrong password shows the generic message |
| `e2e/posts/` | list, create, edit own, no edit button on another user's post, delete with confirmation, empty state |
| `e2e/admin/` | admin sees the users list; super_admin changes a role with confirmation; `user` visiting `/admin` is redirected with a message; role catalogue |
| `e2e/profile/` | update name, validation error on empty name |

`e2e/health/status.yaml` and `e2e/home/home-loads.yaml` cover the status and home pages as well.

## 6. CI

[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) has two jobs on `ubuntu-24.04`: `verify` (this section) and `security` (§6.2), which starts only after `verify` has passed. The workflow runs on every pull request and every push to `main` and on nothing else: there is no manual trigger (`workflow_dispatch`) and no schedule. A newer push to a pull request cancels its older run; runs on `main` are never cancelled. Bun is pinned to 1.4.4 and every action to a commit SHA. `verify` holds no secret: its only credentials are the throwaway values of the test stack (§3) and a throwaway password for the seeded `super_admin`, which exist on the runner for the length of the run. `security` holds none at all.

`verify` runs these steps, in this order:

| # | Step | Why it sits here |
|:---|:---|:---|
| 1 | `bun install --frozen-lockfile` | Fails when `bun.lock` and the manifests disagree |
| 2 | `bun run typecheck`, `bun run lint`, `bun run check:test-folders` | Need no service, so a mistake fails in seconds, before any container starts |
| 3 | `docker compose -f docker-compose.test.yml up -d --build --wait` | A new PostgreSQL, Redis and MongoDB (data in memory) for this run only. `--wait` returns once all three are healthy, MongoDB only after its three log users exist |
| 4 | `bun run db:migrate` | Before any test that uses the database |
| 5 | `bun run test` | With `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_LOG_MONGO_URL` and `TEST_LOG_MONGO_ADMIN_URL` set, so the real Redis and MongoDB suites run. **Fails if the output reports any skipped test**: some suites skip instead of fail when a service is unreachable (§3) |
| 6 | `bun run db:seed` | After step 5, see below |
| 7 | Start the API (`NODE_ENV=test`, port 3010), wait for `/api/health`, `bun run test:e2e` | The environment of §3.2. No step stops a container, because the posts E2E reads the stack's MongoDB logs |
| 8 | On failure only: the API log and the service logs | Without them a red run on a throwaway runner leaves nothing to read |

**The seed follows the unit tests.** `apps/api/tests/utils/auth/super-admins.test.ts` demotes every `super_admin` in `app_test` that it did not create, to test the "last super_admin" rule. A seed made before `bun run test` is gone when the API E2E needs the seeded account, and the admin E2E tests fail with `403`. `bun run db:seed` refuses to promote an existing account (DATABASE.md §6), so seeding again does not restore it: locally, run `bun run test` before you seed `app_test`, or delete the demoted seed account and seed again. A cleaner fix would be for that suite to restore the demoted roles in its `afterAll`.

**Expected skips.** On Windows `bun run test` always skips two tests, the real-signal block of `tests/utils/lifecycle/process.test.ts`, which needs POSIX signals. The skip check in step 5 can therefore only pass on Linux or macOS.

**Status.** The workflow's `run:` blocks pass when replayed in order against a fresh test stack on Windows (except the skip check, above) and in an Ubuntu 24.04 container (nothing skips), and `actionlint` with `shellcheck` is clean. The workflow has **not yet passed on a GitHub-hosted runner**: see §6.3.

### 6.1 Web E2E is a separate gate

The workflow does not run `apps/web/e2e`, and no CI job can:

- `e2e_run` drives the workspace's in-app browser and needs its Browser panel open. It takes `files`, `all`, `env` and `environment` only: no command line, no headless mode and no tag filter. No CI integration for the runner exists.
- §2 forbids any other browser framework, so there is no substitute to run in the workflow.

So the gate is manual and explicit:

| When | Which flows | How |
|:---|:---|:---|
| After every merge to `main` | The flows whose header `tags` include `smoke` | API and web running on the merged code against a disposable E2E database; `e2e_run` with `files` set to those paths. The runner has no tag filter, so list them with `grep -rl "^tags:.*smoke" apps/web/e2e` |
| Before a release | Every flow | `e2e_run` with `all: true`. `posts/empty-state.yaml` needs a database without posts |

Most smoke flows create a post, change a profile name or sign in, so they run only against a disposable E2E database, never a shared development one. The accounts and environment values they read are listed in §5. A person, or an agent in a session whose Browser panel is open, has to start the run. Until the workspace offers a command-line runner, "web E2E passed" is a statement about one manual run, and it names the `e2e_runs` run id.

### 6.2 Security gate (Trivy)

The `security` job has `needs: verify`, the `contents: read` permission and no secret. Any job that deploys must declare `needs: [verify, security]`, otherwise a red gate would not stop a release. The workflow ends with a commented deploy-job template that says so. There is no deploy job and no deploy target yet.

| Step | What it does | Fails the job on |
|:---|:---|:---|
| Check the waiver file | Checks `.trivyignore.yaml` against the rules under **Waivers** below (yq and jq from the runner image) | Any entry that breaks a rule; a file that is missing or is not valid YAML |
| Install Trivy | Downloads the v0.69.3 release archive and checks it against the SHA-256 written in the workflow. Only after that check does it unpack `trivy` and put it on `PATH` | A different archive. Every scan step requires this step to have succeeded, so no scan runs and the job cannot pass |
| Scan dependencies and Dockerfiles | The repository (`fs`): `bun.lock` with its dev dependencies, and every Dockerfile (today only `infra/mongo/Dockerfile`) | A fixable CRITICAL or HIGH vulnerability; a CRITICAL or HIGH misconfiguration |
| Scan the repository for secrets | The repository files, with no severity filter | Any secret, whatever severity its rule has |
| Scan the MongoDB image | The image built from `infra/mongo/Dockerfile` with `docker build`, as Compose builds it | A fixable CRITICAL or HIGH vulnerability |
| Scan the PostgreSQL image, Scan the Redis image | The images of the `postgres` and `redis` services in `docker-compose.test.yml`, read at run time (`postgres:17`, and `redis:8.10.3-alpine` pinned by digest), so a bump there is scanned without touching the workflow | A fixable CRITICAL or HIGH vulnerability |

**Policy.** `severity: CRITICAL,HIGH` with `exit-code: 1` fails a step. `ignore-unfixed: true` means a vulnerability with no fixed version does not block, and blocks as soon as a fix exists. Each scan prints a table in its own step log. Every scan runs even when an earlier one failed (`!cancelled()`), so one run lists every finding. Dev dependencies are included through `TRIVY_INCLUDE_DEV_DEPS`, which the action has no input for. Trivy skips them by default, which would leave out most of the packages of `bun.lock`, and those are what `verify` installs and runs.

Images are scanned for vulnerabilities only, not secrets. A secret scan of `postgres:17` reports Debian's public `ssl-cert-snakeoil.key`. The waiver for it would be a `private-key` entry scoped to that file, kept up to date for an image this repository does not build.

The workflow fails the run, but only a branch protection rule that requires the `Verify` and `Security` checks stops a merge. That is a repository setting.

There is no SARIF upload, because GitHub offers no code scanning for a private repository owned by a personal account. If the repository goes public or gets GitHub Code Security, an upload step with `security-events: write` on this job alone can be added.

**Pins.** After the March 2026 Trivy compromise (advisory GHSA-69fq-xp46-6x23), nothing here refers to a tag or to an installer script.

- `aquasecurity/trivy-action` is pinned to `57a97c7e7821a5776cebc9bb87c984fa69cba8f1`, the commit of tag `v0.35.0`, the release the advisory names as safe.
- Every call sets `skip-setup-trivy: true`. That keeps the action's `setup-trivy` step from running. That step checks out `aquasecurity/trivy` with no `ref` and runs `contrib/install.sh` from its default branch, which would make the pin meaningless.
- The binary is Trivy `v0.69.3`. The advisory lists v0.69.2 and v0.69.3 as safe, and names v0.69.4 and the Docker Hub images 0.69.5 and 0.69.6 as malicious.
- The step "Install Trivy" downloads `trivy_0.69.3_Linux-64bit.tar.gz` and checks it with `sha256sum --check --strict` against `1816b632dfe529869c740c0913e36bd1629cb7688bd5634f4a858c1d57c88b75`, which is written in the workflow. Only then does it unpack it.
- That hash was taken from the archive after `cosign verify-blob --new-bundle-format` (cosign 2.4.1) had checked the archive's `.sigstore.json` bundle against the identity `https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v0.69.3` (issuer `https://token.actions.githubusercontent.com`). It also equals the archive's line in the release's `trivy_0.69.3_checksums.txt`, whose own bundle verified the same way.
- Nothing is fetched at run time to compare against, so a replaced release asset fails the step.

To move a pin:

1. Read the advisory and the release notes.
2. For the action, resolve the tag to its commit yourself (`gh api repos/aquasecurity/trivy-action/git/refs/tags/<tag>`).
3. For the binary, verify the new archive's bundle with cosign as above, then put its SHA-256 and version in the workflow.
4. Repeat the local run below.

Never use `latest`.

**Waivers.** `.trivyignore.yaml` is the only way to accept a finding. It is one YAML file, which every scan passes through `trivyignores`. A plain `.trivyignore` is not used: it has no paths, so an ID waived for one image would be accepted in every target of every scan. Never use `skip-dirs`, `skip-files`, `ignore-policy`, `exit-code: 0`, `continue-on-error` or an inline `trivy:ignore` comment.

The step "Check the waiver file" enforces the rules that Trivy alone would not:

- The only keys are `vulnerabilities`, `misconfigurations`, `secrets` and `licenses`, each a list.
- An entry has only the fields `id`, `paths`, `purls`, `statement`, `owner` and `expired_at`. Trivy drops unknown fields, so a typo such as `path:` would quietly turn a path-and-package entry into a package-only one. The check rejects any other field.
- Every entry has an `id` and is scoped to the exact place the scan report names: `paths` (the result target or package path, no wildcards), `purls` (the package at an exact version), or both. Trivy requires both to match when both are set. A purl without a version (`pkg:golang/stdlib`) matches every version, so it is rejected. A vulnerability entry with neither `paths` nor `purls` would accept the ID everywhere, so it is rejected.
- A misconfiguration, secret or license entry needs `paths` and must not have `purls`. Trivy matches those findings without a package, so a purl there scopes nothing: a `private-key` entry with only a purl would hide every private key.
- Every entry has a `statement` (why accepting it is safe and how that was checked), an `owner` (who checks it again) and an `expired_at` that is a real calendar date no later than **2027-02-05**. That cap is written in the workflow step; moving it is a workflow change reviewed in a pull request, not something a waiver can do. `0001-01-01` (and anything before 2000) is rejected, because Trivy reads Go's zero time as "never expires".

From `expired_at` on, Trivy stops applying the entry, the finding comes back, and the job fails until the owner has looked again. Deleting the file does not open the gate: the scans name it, and Trivy stops with `ignore file not found`.

To waive a finding:

1. Try to fix it first: bump the dependency or change the tag.
2. Check that the flaw cannot be reached in the way the code or image is used, and write in `statement` how you checked.
3. Scope the entry to the path and the package version from the report.
4. Choose the earliest `expired_at` that is practical.

When an entry expires, check it again, then either remove it or renew it with fresh evidence.

Secrets can be waived too: a `secrets:` entry with `id` and `paths`, for example a test fixture that has to contain a fake key. Never write a secret entry without `paths`. The check rejects one, with or without `purls`, because a rule such as `private-key` without `paths` would hide every real key in the repository. No secret is waived today.

A new Dockerfile is not covered by the `DS-0002` waiver, which names only `infra/mongo/Dockerfile`, so a new Dockerfile without `USER` fails the gate.

**What is waived today.** Without waivers the gate fails, and every failure comes from an upstream image. `.trivyignore.yaml` has 31 entries, each expiring 2027-02-05; with them every scan passes. The evidence for each group is in the header of `.trivyignore.yaml` and in each entry's `statement`.

| Target | Scope of the waiver | Why it is waived |
|:---|:---|:---|
| `bun.lock`, secrets in the repository | — | Nothing to waive |
| `infra/mongo/Dockerfile`: `DS-0002` (no `USER`) | `paths: [infra/mongo/Dockerfile]` | The official entrypoint has to start as root, then drops to `mongodb` through gosu. With `USER mongodb` the container exits with status 1 while it initialises |
| MongoDB and PostgreSQL images: `usr/local/bin/gosu` (Go standard-library CVEs) | `paths: [usr/local/bin/gosu]` and `purls: [pkg:golang/stdlib@v1.24.6]` | gosu 1.19 built with go1.24.6, byte-identical in both images. `govulncheck -mode=binary` places the CVEs at module level (their package is not linked) or, for one, at package level with the vulnerable symbol not linked |
| MongoDB image: `opt/js-yaml` 3.13.1 | `paths: [opt/js-yaml/package.json]` and `purls: [pkg:npm/js-yaml@3.13.1]` | The entrypoint loads it only to read a `--config` file, and no Compose service passes `--config` |
| PostgreSQL image: Debian `apt` and `libapt-pkg7.0` | `purls` of both packages at 3.0.3 (OS packages have no path in the report) | Needs an `apt install` over an attacker-controlled path, and nothing runs apt in that image |
| Redis image (`redis:8.10.3-alpine`, alpine 3.23.8) | — | Nothing to waive: Trivy 0.69.3 found no vulnerability at any severity, unfixed ones included, in its 23 Alpine packages on 2026-11-07. Alpine 3.23 is supported until 2027-11-01. Redis and its bundled modules are built from source, so Trivy lists no package for them and the result says nothing about Redis itself (below). It ships no gosu (its entrypoint drops root with `setpriv`), so the gosu entries do not concern it |

The waivers assume that the three images are used only as local development and CI test services: published on `127.0.0.1`, with throwaway credentials and no deploy target. Check them again before any of these images is used for anything else.

Expect more of the same. The official images ship a gosu built with an old Go release, so each new Go standard-library CVE will fail the gate until the images ship a newer gosu. When one does, check as above that the package it names is still not linked, then add an entry.

govulncheck has limits. Binary mode trusts the symbol table and build info in the binary, and the package and symbol data in the vulnerability database. It cannot see code that reflection or `linkname` would reach.

**Not covered.**

- **Compose misconfiguration.** Trivy has no Docker Compose config type (its misconfiguration checks cover Kubernetes, Dockerfile/Containerfile, Terraform, CloudFormation, Azure ARM, Helm and Ansible), so no step checks `docker-compose*.yml` for things like a port published on `0.0.0.0`, a privileged service or a writable Docker socket. The images the Compose files run are scanned instead. Closing the gap needs a Compose policy check, for example custom Rego checks fed to Trivy or a dedicated Compose linter, with its own pin.
- **Secrets inside third-party images** (above).
- **A tag rather than a digest** for PostgreSQL. The same commit can pass today and fail tomorrow, when upstream publishes a vulnerability or a rebuilt image. Redis and MongoDB are pinned by digest, so for them only a newly published vulnerability changes the result.
- **The Redis server and its modules.** The official image builds Redis and its bundled modules (RedisJSON, RediSearch, RedisTimeSeries, RedisBloom) from source, so Trivy finds no package for any of them (checked with `--list-all-pkgs`: 23 Alpine packages; the only one named after Redis, `.redis-rundeps`, is the image's virtual package for their runtime dependencies). A vulnerability in Redis or a module never fails the gate. Redis security releases have to be watched by hand and the pin bumped to the fixed 8.x patch.

**Run it locally.** The engine needs the image pulled, and the vulnerability database is cached in a volume. Run it from the repository root, on an engine that accepts the bind mount:

```bash
docker run --rm -v "$PWD:/repo" -w /repo -v trivy-cache:/cache -e TRIVY_CACHE_DIR=/cache \
  -e TRIVY_SCANNERS=vuln,misconfig -e TRIVY_SEVERITY=CRITICAL,HIGH -e TRIVY_IGNORE_UNFIXED=true \
  -e TRIVY_INCLUDE_DEV_DEPS=true -e TRIVY_EXIT_CODE=1 -e TRIVY_IGNOREFILE=.trivyignore.yaml \
  aquasec/trivy@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c fs .
```

That digest is `aquasec/trivy:0.69.3`.

- For the secret scan, use `-e TRIVY_SCANNERS=secret` with no severity.
- For an image, replace `fs .` with `image <reference>`, use `-e TRIVY_SCANNERS=vuln`, and add `-v /var/run/docker.sock:/var/run/docker.sock`.

Sokudo's engine rejects Windows bind mounts. There, create the container with `docker create -w /repo`, copy a tar of `git ls-files -co --exclude-standard` in with `docker cp -`, and start it with `docker start -a`.

**Status.** All five scans pass locally with the waivers, and fail as expected with an empty waiver file, an expired entry, a second Dockerfile without `USER`, a planted fake token or a deleted waiver file. The waiver check and the install step pass and fail as required when their `run:` blocks are replayed on Ubuntu 24.04 with the runner's yq and jq. Not verified on a hosted runner: the action's database cache, Docker Hub pulls and rate limits from a runner, and the job's run time. The `security` job cannot run on GitHub until `verify` passes there (§6.3).

### 6.3 MongoDB on the hosted runner

**Known issue: not confirmed on a GitHub-hosted runner.** `verify` failed on GitHub at "Start the test services": the mongo container exited with log id `12257600`, "MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility with this version of MongoDB" (SERVER-121912).

- **The runner kernel.** The `ubuntu-24.04` runner image moved from kernel `6.17.0-*-azure` to `7.0.0-*-azure`.
- **What mongod checks.** `src/mongo/db/startup_check_rseq.cpp` exits only when tcmalloc's per-CPU caches are active and the kernel is in 6.19.0–7.0.13. SERVER-125742 (8.0.30, 8.3.9) exempts 7.0.14 and later, but it reads `uname`. Ubuntu reports every 7.0 kernel as `7.0.0`, so Ubuntu kernels stay refused (SERVER-136848).
- **The Ubuntu fix.** SERVER-131779 reads the upstream version from `/proc/version_signature`. Its 8.x fix versions are 8.3.16 and 8.0.37, which were not on Docker Hub when this was written (the newest tags were 8.3.13 and 8.0.34). Even 8.3.16 would start only if the Azure kernel's upstream base is 7.0.14 or later.
- **Local reproduction is not possible** on a kernel below 6.19.

**Workaround applied.** `infra/mongo/Dockerfile` and the `mongo` service of `docker-compose.dev.yml` both use `mongo:8.3.13@sha256:e16e606f…cd2`, the image the `.trivyignore.yaml` waivers were written for, and set `GLIBC_TUNABLES=glibc.pthread.rseq=1` (the image itself sets `rseq=0`). `docker-compose.yml`, `docker-compose.test.yml` and the `security` job's `docker build` inherit it from the Dockerfile. With `rseq=1` glibc takes the rseq registration, so tcmalloc falls back to per-thread caches and the check passes. It is the docker-library maintainers' documented workaround, not a MongoDB fix, and it costs some allocator performance. Locally (kernel below 6.19) `db.serverStatus().tcmalloc.usingPerCPUCaches` is `false` with `rseq=1` and `true` with `rseq=0`, the test stack comes up healthy, the full test suite and the API E2E pass, and the Trivy scans still pass with the existing waivers. An existing dev MongoDB container picks up the tunable only once it is recreated; no data migration is needed.

Whether mongod starts on the hosted runner's kernel is known only once `verify` runs there. If it still fails:

| Option | What changes | Trade-off |
|:---|:---|:---|
| Wait for `mongo:8.3.16` (or 8.0.37) on Docker Hub and pin it | Only the pin | Depends on the runner kernel's `/proc/version_signature` reporting 7.0.14 or later. CI stays red until then |
| Pin the runner to an older image or kernel | `runs-on` of `verify` | Not durable, since GitHub moves images |
| MongoDB 9.x | A major upgrade | Has the fix with the same kernel caveat, contradicts "MongoDB 8" in the specs, and needs an in-place upgrade of the dev volume |

MongoDB 7.0 is ruled out: it cannot open the 8.x dev volume.

Once a fixed 8.x tag is on Docker Hub and starts on the runner, move both pins (`infra/mongo/Dockerfile`, `docker-compose.dev.yml`) to it, remove the tunable from both, and re-check the waivers against the new image.

## 7. Acceptance criteria

The suite as a whole must satisfy:

- [ ] Every module in `apps/api/src/modules/` has a matching `tests/modules/<module>/` folder, and every module with routes has `tests/e2e/<module>/`.
- [ ] Every feature in `apps/web/src/features/` has a matching `tests/features/<feature>/` folder, and every feature with pages has `e2e/<feature>/`.
- [ ] `bun run check:test-folders` (`scripts/check-test-folders.ts`) fails when a module or feature folder has no matching test folder. Names match exactly (case included) and each folder holds at least one test or flow file. A module has routes when the syntax of its controller `index.ts` (DEC-008), parsed with the repo's `typescript` (never imported or run), holds a route call (`get`, `post`, `put`, `patch`, `delete`, `options`, `head`, `all`, `route`, `ws`) on an Elysia chain: one rooted at `new Elysia()` (aliases included), a variable initialised from one, or a `group`/`guard` callback parameter. Paths count in any form (constants, templates); comments, strings and `.get()` on anything else do not; a controller that does not parse fails the check. Routes in other files of the module are not seen. The parser is TypeScript 7's `unstable/async` client (`scripts/module-routes.ts`), because the sync one crashes under Bun on Linux.
- [ ] `bun run test` passes without Redis or MongoDB running (their suites skip), and with the whole test stack up it passes with no skipped test on Linux.
- [ ] Each module meets §3.1, each feature meets §4.1, and the cross-cutting tests of §3.1 cover the permission matrix, redaction ([redaction.md §7](observability/redaction.md)) and the log store ([log-storage.md §8](observability/log-storage.md)).
- [ ] The API E2E flows of §3.2 exist and pass against an isolated test stack (`bun run test:e2e`).
- [ ] The web E2E flows of §5 exist, validate, and pass in a manual run (§6.1).
- [ ] CI's `verify` and `security` jobs pass on a GitHub-hosted runner. Open: see §6.3.
