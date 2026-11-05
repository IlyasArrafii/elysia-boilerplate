# TESTING.md

How tests are organised and what each module and feature must have (DEC-039). The rules that enforce this are in [apps/api/README.md §10](../../../apps/api/README.md) and [apps/web/README.md §9](../../../apps/web/README.md).

## 1. Levels

| Level | App | What it proves | Runs against | Folder |
|:---|:---|:---|:---|:---|
| Unit | api | A service, helper or pure function is correct | Nothing external (mocks, memory sink) | `apps/api/tests/modules/<module>/`, `tests/utils/<util>/` |
| Route (integration) | api | A module's routes: validation, auth, permissions, errors, module tag | `app.handle(new Request(...))` + test PostgreSQL | `apps/api/tests/modules/<module>/` |
| API E2E | api | Real HTTP flows across modules on a running stack | Running API + PostgreSQL + Redis + MongoDB | `apps/api/tests/e2e/<module>/` |
| Unit / component | web | Hooks, `lib/` helpers, forms, pages render the right states | happy-dom, mocked API client | `apps/web/tests/features/<feature>/` |
| Web E2E | web | User journeys in a real browser | Running web + API stack | `apps/web/e2e/<feature>/*.yaml` |

## 2. Tools

| Need | Tool |
|:---|:---|
| Runner (both apps) | `bun test` on Bun 1.4.4: preload, `mock.module()`, `test.each` and `skipIf` all work (TASK-18) |
| DOM for web tests | `@happy-dom/global-registrator` 21.0.4, preloaded through `apps/web/bunfig.toml` (`[test] preload = ["./tests/setup.ts"]`) (TASK-18) |
| React testing | `@testing-library/react` 16.3.3 (peer `react` ^18 \|\| ^19, used with React 19.3.1) + `@testing-library/dom` 10.4.2 (its required peer) + `@testing-library/user-event` 14.6.8 (TASK-18) |
| Module mocks | `mock.module()` from `bun:test` |
| Telemetry assertions | the `memory` sink |
| Web E2E | The workspace E2E system: YAML flows run by its runner. No Playwright, Cypress, Puppeteer or Selenium |

## 3. API layout

```
apps/api/tests/
  setup.ts            preload (apps/api/bunfig.toml): DATABASE_URL → test database; REDIS_URL, LOG_MONGO_URL emptied
  helpers/
    app.ts            builds the app for app.handle(); memory sink; no listen()
    db.ts             guard, migrate once, scoped fixtures; never truncates (test PostgreSQL) (TASK-18)
    auth.ts           createUser(fixtures, db, role) → { id, email, cookie }: a fixtures user (any stored role, NULL included) with a password account, signed in through /api/auth/sign-in/email; signIn(email) → cookie header (TASK-05)
    mongo.ts          test MongoDB database for mongo-sink tests (dropped after the run)
  modules/<module>/   one folder per src/modules/<module>, same name
    service.test.ts
    routes.test.ts
    permissions.test.ts
  utils/<util>/       one folder per src/utils/<util>, same name (auth, telemetry, cache, error, logger, …)
  e2e/
    helpers/          client.ts (fetch with cookie jar against API_E2E_URL) (TASK-18), users.ts (unique accounts, a random
                      `x-forwarded-for` per call, the seeded super_admin) (TASK-19)
    <module>/         one folder per module that has routes, same name
      <flow>.test.ts
```

- Two facts about `app.handle()` verified in TASK-12:
  - Elysia reads the path after the first 11 characters of the URL, so a test request needs a host of at least 4 characters (`http://localhost/api/...`); `http://x/api/...` resolves to the wrong route.
  - `onAfterResponse` hooks, where `http.request` is emitted, run with `setImmediate` after the response is built. Wait one tick (`await new Promise(resolve => setImmediate(resolve))`) after `app.handle()` before asserting on `http.request`; `http.error` is already there. `tests/helpers/app.ts` does this in its `request()` helper.
- Folder names equal the module or util folder names exactly. A module without a test folder fails review.
- `bun run test` (in `apps/api`) runs `bun test tests/modules tests/utils tests/scripts tests/helpers` (`tests/helpers` holds the harness's own tests) (TASK-18). `bun run test:e2e` runs `bun test tests/e2e` and fails at once without `API_E2E_URL`. E2E never runs as part of `test`. At the repo root, `bun run test` runs the folder-check tests and both apps' `test`; `bun run test:e2e` runs the API's (TASK-18).
- Test PostgreSQL (TASK-18): the `app_test` database. `TEST_DATABASE_URL` names it (default `postgres://app:app_dev@127.0.0.1:5442/app_test`, the test stack); the preload copies it into `DATABASE_URL`, overriding any value from the shell or the repo-root `.env`, so app code under test can only reach the test database. `REDIS_URL`, `LOG_MONGO_URL` and `LOG_MONGO_ADMIN_URL` are emptied the same way (memory fallback, stdout only); tests that need a real Redis or MongoDB use their own `TEST_*` URLs. `NODE_ENV` is pinned to `test`. The guard (`tests/helpers/db.ts`) refuses, before connecting, any URL whose database is not exactly `app_test` or that carries query parameters other than `ssl`, `sslmode`, `sslrootcert`, `connect_timeout` and `application_name` (postgres-js would send `database`, `user` or `options` as startup parameters), then checks `current_database()` before migrating. Migrations run `bun run db:migrate` under a PostgreSQL advisory lock, so test processes starting together on a fresh database take turns; waiting for the lock and the migration itself are each limited to 60 s, and a migration that times out is killed before the lock is released. The lock is cooperative: a migration started by hand bypasses it, and if a test process dies mid-migration PostgreSQL frees the lock while its child may still be running. Workers sharing `app_test` must have compatible migration histories. Fixtures never truncate: each scope deletes only the rows it inserted (`test-<uuid>` ids, recorded only after the insert succeeds).
  - **Guard:** `assertTestDatabaseUrl` refuses, before a connection is opened, any URL whose database is not exactly `app_test` or that carries a non-allowlisted query parameter (`?database=app` included), and `prepareTestDatabase` checks `current_database()` after connecting, before migrating. Messages name host and database, never the URL.
  - **Migrations:** `testDb()` runs `bun run db:migrate` (packages/db) once per `bun test` process, under a PostgreSQL advisory lock so processes starting together on a fresh database do not apply the same migration twice, and returns a shared `createDb()` pool that test files never close.
  - **Isolation:** the test database is shared by parallel runs, so tests never truncate or reset it. `fixtures(db)` creates rows with unique IDs and emails (`test+<run>-<n>@example.test`) and `cleanup()` deletes exactly those rows (dependants follow by cascade).
  - Tests that call `testDb()` (the module route and service tests) fail when test PostgreSQL is not running: `docker compose -f docker-compose.test.yml up -d --wait postgres`. The seven suites in `tests/utils/auth/` use their own `prepareTestDatabase()` (`setup.ts`) and **skip** instead (`describe.skipIf(!ready)`), so a run without PostgreSQL can still look green. CI fails on any skipped test for that reason (§6) (TASK-11).
- Test Redis (TASK-21): the real-Redis suites in `tests/utils/cache` and `tests/utils/redis` use `TEST_REDIS_URL` (default `redis://127.0.0.1:6389`, the test stack) and skip when nothing answers there. They only write `test-<uuid>` keys, delete what they wrote and never flush, so `TEST_REDIS_URL=redis://127.0.0.1:6379` may point them at a dev Redis. `createReplyDroppingProxy` (`tests/helpers/redis.ts`) sits in front of a real Redis and throws replies away, so a test can lose a reply after Redis ran the command, and can answer one command (`MULTI`) with a `NOPERM` refusal, as an ACL would, without changing the server's ACLs.
- Test stack ports (TASK-02): `docker-compose.test.yml` is its own project (`app-test`) and publishes PostgreSQL on `127.0.0.1:5442` (database `app_test`, `postgres://app:app_dev@127.0.0.1:5442/app_test`), Redis on `6389` and MongoDB on `27027`: ten above the dev ports, fixed, so tests never collide with `docker-compose.yml`. Its data lives in tmpfs, so every `up` starts empty and `down` leaves nothing behind. The MongoDB log users are the same as in dev ([log-storage.md §2](observability/log-storage.md)). The URLs are listed at the top of the file.

### 3.1 Required tests per module

| File | Must cover |
|:---|:---|
| `routes.test.ts` | For every route: success; `400 VALIDATION_ERROR` with field paths only; `401` without a session; `403` without the permission; `404` when it has `:id`; ownership rule where there is one. Every response has `x-request-id`. |
| `routes.test.ts` (logging) | A forced error in the route produces one `http.error` in the memory sink with `module: "<module>"` and no route field; a `moduleError` carries `sourceModule` |
| `service.test.ts` | Business logic, cache hit = miss payload, cache invalidation on writes, `moduleError` codes |
| `permissions.test.ts` | The module's grants appear in the compiled-roles snapshot; every permission is used by at least one route |

Cross-cutting tests in `tests/utils/`: the permission matrix and guard rules (`auth/`, [auth/access/static-roles.md §11](auth/access/static-roles.md)), redaction ([observability/redaction.md §7](observability/redaction.md)), `mongo` sink and prune command (`telemetry/`, [log-storage.md §8](observability/log-storage.md)), `moduleScope` startup checks (`logger/`).

### 3.2 API E2E

- **Stack:** `docker compose -f docker-compose.test.yml up -d --wait` (PostgreSQL, Redis, MongoDB; `--wait` returns once all three are healthy), migrations and seed (the seed after `bun run test`, which demotes other super_admins: §6), then the API started with `NODE_ENV=test` and `LOG_MONGO_URL` set. `API_E2E_URL` points at it.
- **Isolation:** each test file creates its own users with unique emails (`e2e+<run>-<n>@example.test`) through the Better Auth endpoints; tests never depend on order between files.
- **Required flows:**

| Folder | Flows |
|:---|:---|
| `e2e/auth/` | sign-up → sign-in → get-session → sign-out → 401; sixth sign-in in 60 s → 429; impersonation endpoints → 404 |
| `e2e/posts/` | user creates, lists (cache hit after the first call), edits and deletes own post; another user gets 403; admin edits anyone's; the `x-request-id` of a posts request finds its `http.request` document in MongoDB with `module: "posts"`. Besides `API_E2E_URL` and the seeded super_admin it reads `E2E_REDIS_URL` (the API's Redis, to see the cached page) and `E2E_LOG_MONGO_URL` (a log user that can `find`, e.g. `log_reader`), and the API needs `POSTS_TITLE_MAX_LENGTH` / `POSTS_CONTENT_MAX_LENGTH` (TASK-08) |
| `e2e/admin/` | super_admin changes a role and the next `/api/me/permissions` reflects it; admin gets 403 on set-role; roles catalogue |
| `e2e/me/` | permissions per role |
| `e2e/health/` | 200 with all dependencies; `logStore: "down"` still 200 when MongoDB is stopped |

- **Running it (TASK-19):** besides `API_E2E_URL`, the suite reads `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD` (the seeded super_admin), `WEB_URL` (the Origin Better Auth trusts; default `http://localhost:3001`), `E2E_REDIS_URL` (the API's Redis), `E2E_LOG_MONGO_URL` (a log user that can `find`) and optionally `LOG_MONGO_DB`. The bunfig preload still applies, so `TEST_DATABASE_URL` (default the test stack's `app_test`) must be the database the API under test uses. Files run one after another in one `bun test` process and share no data.
- **Rate limits (TASK-19):** every sign-up and sign-in in `e2e/` sends its own random `x-forwarded-for` (`helpers/users.ts`: 198.19.0.0/16; `posts.test.ts`: 10.208.0.0/16), so files never use up each other's budget. `e2e/auth/session.test.ts` sends one address on purpose to prove the limits: the sixth sign-in in 60 s is 429 even with the right password, and the fourth sign-up is 429 and creates no account.
- **MongoDB stopped (TASK-19):** stopping the stack's MongoDB would break `e2e/posts/` (it reads its logs), so `e2e/health/log-store-down.test.ts` starts a second API process of its own (`src/index.ts`, a free port, the same test PostgreSQL and `E2E_REDIS_URL`) whose `LOG_MONGO_URL` points at a port nothing listens on, i.e. refused like a stopped container, and kills it in `afterAll`. It asserts 200 with `logStore: "down"` and that sign-up and `GET /api/posts` still succeed.

Google OAuth is not automated end to end (it needs Google). It is covered by route tests with the provider mocked and checked by hand before release.

## 4. Web layout

```
apps/web/tests/
  setup.ts            happy-dom registration, Testing Library cleanup (TASK-18)
  tsconfig.json       test types (bun); checked by `bun run typecheck` (TASK-18)
  helpers/
    render.tsx        renders with QueryClient + router test context (router part: TASK-18; QueryClient: TASK-14)
    api-mock.ts       mock.module('@/lib/api') and auth-client helpers (TASK-14: needs `@/lib/api` and the `@/` alias)
  features/<feature>/ one folder per src/features/<feature>, same name
    hooks.test.ts
    lib.test.ts
    <page-or-component>.test.tsx
  lib/                tests for src/lib
  components/         tests for src/components
  lint/               tests for the feature-boundary lint rule in apps/web/lint, including a run of the real
                      oxlint binary on a throwaway app (TASK-14)
apps/web/e2e/
  <feature>/          one folder per feature that has pages, same name
    <flow>.yaml
```

- `bun run test` (in `apps/web`) runs `bun test tests` (TASK-18). Testing Library is imported after happy-dom registers (dynamic import in `setup.ts`), because it binds `screen` to the document present at import.
- Web E2E has no `test:e2e` script: the workspace E2E system runs flows from its own UI and agent tools (`e2e_run`); no CLI was found to call from a script or CI (TASK-18, TASK-11: §6.1).
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
url: http://localhost:3001/login      # web dev port 3001, strictPort (TASK-01)
name: auth - sign in with email
tags: [auth, smoke]
---
- launchApp
- tapOn: "Email"
- inputText: "${E2E_USER_EMAIL}"
- tapOn: "Password"
- inputText: "${E2E_USER_PASSWORD}"
- tapOn: "Sign in"
- assertVisible: "Posts"
- takeScreenshot: auth-signed-in
```

- Header keys: `url` (required), `name`, `tags`, `env`, `clearState`. No other header keys.
- Steps come from the runner's interpreter (`launchApp`, `openLink`, `tapOn`, `inputText`, `assertVisible`, `takeScreenshot`, `back`, …); check names against the interpreter, never from memory. Every flow is validated before it is committed.
- `name` starts with the feature name; `tags` include the feature name.
- Selectors use visible, unique text or accessible labels, never CSS classes shared by repeated rows.
- Credentials come from environment values configured for the E2E environment, never written in the YAML.
- The runner discovers flows in nested `e2e/<feature>/` folders, under both `apps/web/e2e/` and a root `e2e/`; a nested flow validates on disk (TASK-18). Its listing shows each flow under its file name, not the header `name`, so file names should read well on their own. It scans the workspace's main checkout, so a flow in a separate git worktree is listed and run only once it reaches that checkout.
- `e2e/auth/` flows read the E2E environment values `E2E_USER_EMAIL` and `E2E_USER_PASSWORD` (an existing account). The validator rejects an undefined variable, so flows write `${E2E_USER_EMAIL || ''}`: without the value a flow fails at the form's own check (TASK-09). Sign-in allows 5 attempts a minute per IP, so running every auth flow back to back from one machine can hit 429.
- `e2e/admin/` flows also read `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` (an account with role `admin`), `E2E_SUPER_ADMIN_EMAIL` / `E2E_SUPER_ADMIN_PASSWORD` (role `super_admin`) and `E2E_ROLE_TARGET_EMAIL` (a separate account with role `user`, used only by the role-change flow, which promotes it to `admin` and restores it to `user`). The role select has no step of its own in the runner, so the flow drives it with the keyboard (TASK-17).

**Required flows:**

| Folder | Flows |
|:---|:---|
| `e2e/auth/` | sign-up, sign-in, refresh keeps the session, sign-out, protected page redirects to `/login`, wrong password shows the generic message |
| `e2e/posts/` | list, create, edit own, no edit button on another user's post, delete with confirmation, empty state |
| `e2e/admin/` | admin sees the users list; super_admin changes a role with confirmation; `user` visiting `/admin` is redirected with a message; role catalogue |
| `e2e/profile/` | update name, validation error on empty name |

## 6. CI

[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) has two jobs on `ubuntu-24.04`: `verify` (TASK-11, this section) and `security` (TASK-023, §6.2), which starts only after `verify` has passed. The workflow runs on every pull request and every push to `main` and on nothing else: there is no manual trigger (`workflow_dispatch` was removed in TASK-023) and no schedule. Bun is pinned to 1.4.4 and every action to a commit SHA. `verify` holds no secret: its only credentials are the throwaway values of the test stack (§3) and a throwaway password for the seeded `super_admin`, which exist on the runner for the length of the run. `security` holds none at all.

`verify` runs these steps, in this order:

| # | Step | Why it sits here |
|:---|:---|:---|
| 1 | `bun install --frozen-lockfile` | Fails when `bun.lock` and the manifests disagree |
| 2 | `bun run typecheck`, `bun run lint`, `bun run check:test-folders` | Need no service, so a mistake fails in seconds, before any container starts |
| 3 | `docker compose -f docker-compose.test.yml up -d --build --wait` | A new PostgreSQL, Redis and MongoDB (data in memory) for this run only. `--wait` returns once all three are healthy, MongoDB only after its three log users exist |
| 4 | `bun run db:migrate` | Before any test that uses the database |
| 5 | `bun run test` | With `TEST_REDIS_URL`, `TEST_LOG_MONGO_URL` and `TEST_LOG_MONGO_ADMIN_URL` set, so the real Redis and MongoDB suites run. **Fails if the output reports any skipped test**: some suites skip instead of fail when a service is unreachable (§3) |
| 6 | `bun run db:seed` | After step 5, see below |
| 7 | Start the API (`NODE_ENV=test`), wait for `/api/health`, `bun run test:e2e` | The environment of §3.2. No step stops a container, because the posts E2E reads the stack's MongoDB logs |
| 8 | On failure only: the API log and the service logs | Without them a red run on a throwaway runner leaves nothing to read |

**The seed follows the unit tests.** `apps/api/tests/utils/auth/super-admins.test.ts` demotes every `super_admin` in `app_test` that it did not create, to test the "last super_admin" rule. A seed made before `bun run test` is gone when the API E2E needs the seeded account; the first run of the E2E in TASK-11 failed six tests with `403` for that reason. `bun run db:seed` promotes the account again, so locally either run `bun run test` before you seed `app_test`, or seed again after it. A real fix is to restore the demoted roles in that suite's `afterAll`; it is not part of TASK-11.

**Expected skips.** On Windows `bun run test` always skips two tests, the real-signal block of `tests/utils/lifecycle/process.test.ts`, which needs POSIX signals. The skip check in step 5 can therefore only pass on Linux or macOS.

**Verified so far (TASK-11, 2026-11-05).** The workflow has **not run on GitHub**: `origin/main` is still at the first three commits and nothing from TASK-01 onward has been pushed, so a hosted result needs a push, which is the owner's decision. What was run instead is the workflow's own `run:` blocks, replayed in order from the YAML against a fresh isolated test stack, on two platforms:

- Windows 11 with Sokudo's engine: every step passes except the skip check, which trips on the two `win32` tests described above.
- Ubuntu 24.04 in a container (non-root user, Bun 1.4.4, Node 24.14.0, files with LF endings, the services reached on `127.0.0.1` like on a runner): every step passes. That is typecheck, lint, folder check, migrations, 15 + 707 + 426 unit and integration tests with **no skip** (the two real-signal tests pass on Linux), the seed, and 20 API E2E tests in 6 files. Limited to 2 CPUs and 7 GiB, the size of a private-repository runner, it passes the same way (unit step 86 s, E2E 10 s).
- `actionlint` 1.7.12 with `shellcheck` finds nothing in the workflow.

Replaying on Linux found three problems that Windows never showed: the folder check crashed under Bun on Linux (fixed by switching to TypeScript's async client), two test helpers handed out the same "unique" client IPs (fixed with one shared helper, `tests/helpers/ip.ts`), and the seed-order trap above (handled by the order of the steps; the test that demotes the super_admins is untouched). Still unobserved: Docker Hub pulls and `docker compose up` on a hosted runner, and the hosted runners' timing.

### 6.1 Web E2E is a separate gate

The workflow does not run `apps/web/e2e`, and no CI job can. Checked in TASK-11:

- `e2e_run` drives the workspace's in-app browser and reveals its Browser panel to the person using it. From a worker session without that panel open it fails with `the in-app browser panel/tab isn't available for this workspace (the reveal request went unanswered)`. It takes `files`, `all`, `env` and `environment` only: no command line, no headless mode and no tag filter. The workspace has no wiki that documents another interface, and TASK-18 and TASK-11 looked for a CI integration and found none.
- §2 forbids any other browser framework, so there is no substitute to run in the workflow.

So the gate is manual and explicit:

| When | Which flows | How |
|:---|:---|:---|
| After every merge to `main` | The flows whose header `tags` include `smoke` (11 at TASK-11) | API and web running on the merged code against a disposable E2E database; `e2e_run` with `files` set to those paths. The runner has no tag filter, so list them with `grep -rl "^tags:.*smoke" apps/web/e2e` |
| Before a release | Every flow | `e2e_run` with `all: true`. `posts/empty-state.yaml` needs a database without posts |

Most smoke flows create a post, change a profile name or sign in, so they run only against a disposable E2E database, never a shared development one. The accounts and environment values they read are listed in §5. A person, or an agent in a session whose Browser panel is open, has to start the run. Until the workspace offers a command-line runner, "web E2E passed" is a statement about one manual run, and it names the `e2e_runs` run id.

### 6.2 Security gate (Trivy)

The `security` job (TASK-023) has `needs: verify`, the `contents: read` permission and no secret. Any job that deploys must declare `needs: [verify, security]`, otherwise a red gate would not stop a release. The workflow ends with a commented deploy-job template that says so. There is no deploy job and no deploy target yet.

| Step | What it does | Fails the job on |
|:---|:---|:---|
| Check the waiver file | Checks `.trivyignore.yaml` against the rules under **Waivers** below (yq and jq from the runner image) | Any entry that breaks a rule; a file that is missing or is not valid YAML |
| Install Trivy | Downloads the v0.69.3 release archive and checks it against the SHA-256 written in the workflow. Only after that check does it unpack `trivy` and put it on `PATH` | A different archive. Every scan step requires this step to have succeeded, so no scan runs and the job cannot pass |
| Scan dependencies and Dockerfiles | The repository (`fs`): `bun.lock` with its dev dependencies, and every Dockerfile (today only `infra/mongo/Dockerfile`) | A fixable CRITICAL or HIGH vulnerability; a CRITICAL or HIGH misconfiguration |
| Scan the repository for secrets | The repository files, with no severity filter | Any secret, whatever severity its rule has |
| Scan the MongoDB image | The image built from `infra/mongo/Dockerfile` with `docker build`, as Compose builds it | A fixable CRITICAL or HIGH vulnerability |
| Scan the PostgreSQL image, Scan the Redis image | The tags in `docker-compose.test.yml`, read at run time (`postgres:17`, `redis:7-alpine`), so a bump there is scanned without touching the workflow | A fixable CRITICAL or HIGH vulnerability |

**Policy.** `severity: CRITICAL,HIGH` with `exit-code: 1` fails a step. `ignore-unfixed: true` means a vulnerability with no fixed version does not block, and blocks as soon as a fix exists. Each scan prints a table in its own step log. Every scan runs even when an earlier one failed (`!cancelled()`), so one run lists every finding. Dev dependencies are included through `TRIVY_INCLUDE_DEV_DEPS`, which the action has no input for. Trivy skips them by default, which would leave out 312 of the 479 packages of `bun.lock`, and those are what `verify` installs and runs.

Images are scanned for vulnerabilities only, not secrets. A secret scan of `postgres:17` reports Debian's public `ssl-cert-snakeoil.key`. The waiver for it would be a `private-key` entry scoped to that file, kept up to date for an image this repository does not build.

The workflow fails the run, but only a branch protection rule that requires the `Verify` and `Security` checks stops a merge. That is a repository setting, and TASK-023 did not change it.

There is no SARIF upload, because GitHub offers no code scanning for a private repository owned by a personal account (`code-scanning/alerts` answers `403 Code scanning is not enabled for this repository`, checked 2026-11-05). If the repository goes public or gets GitHub Code Security, an upload step with `security-events: write` on this job alone can be added.

**Pins.** After the March 2026 Trivy compromise (advisory GHSA-69fq-xp46-6x23), nothing here refers to a tag or to an installer script.

- `aquasecurity/trivy-action` is pinned to `57a97c7e7821a5776cebc9bb87c984fa69cba8f1`. On 2026-11-05 the GitHub API resolved tag `v0.35.0` directly to that commit. v0.35.0 is the release the advisory names as safe.
- Every call sets `skip-setup-trivy: true`. That keeps the action's `setup-trivy` step from running. That step checks out `aquasecurity/trivy` with no `ref` and runs `contrib/install.sh` from its default branch, which would make the pin meaningless.
- The binary is Trivy `v0.69.3`. The advisory lists v0.69.2 and v0.69.3 as safe, and names v0.69.4 and the Docker Hub images 0.69.5 and 0.69.6 as malicious.
- The step "Install Trivy" downloads `trivy_0.69.3_Linux-64bit.tar.gz` and checks it with `sha256sum --check --strict` against `1816b632dfe529869c740c0913e36bd1629cb7688bd5634f4a858c1d57c88b75`, which is written in the workflow. Only then does it unpack it.
- That hash was taken on 2026-11-05 from the archive after `cosign verify-blob --new-bundle-format` (cosign 2.4.1) had checked the archive's `.sigstore.json` bundle against the identity `https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v0.69.3` (issuer `https://token.actions.githubusercontent.com`). It also equals the archive's line in the release's `trivy_0.69.3_checksums.txt`, whose own bundle verified the same way.
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

**Baseline on 2026-11-05.** Without waivers the gate fails, and every failure comes from an upstream image. With `.trivyignore.yaml` (31 entries, every one owned by `IlyasArrafii` and expiring 2027-02-05), every scan passes. The evidence for each group is in the header of `.trivyignore.yaml` and in each entry's `statement`.

| Target | CRITICAL | HIGH | Scope of the waiver | Why it is waived |
|:---|:---:|:---:|:---|:---|
| `bun.lock` (167 packages; 479 with dev dependencies) | 0 | 0 | — | Nothing to waive |
| `infra/mongo/Dockerfile` | 0 | 1 (`DS-0002`, no `USER`) | `paths: [infra/mongo/Dockerfile]` | The official entrypoint has to start as root, then drops to `mongodb` through gosu. With `USER mongodb` the container exits with status 1 while it initialises (tried) |
| Secrets in the repository | 0 | 0 | — | Nothing to waive |
| MongoDB image: `usr/local/bin/gosu` | 1 | 25 | `paths: [usr/local/bin/gosu]` and `purls: [pkg:golang/stdlib@v1.24.6]` | gosu 1.19 built with go1.24.6. The binary is byte-identical in the mongo and postgres images (sha256 `52c8749d…43dd0`). `govulncheck -mode=binary` places 25 of the 26 CVEs at module level (their package is not linked) and one at package level (`os`, but no `os.(*Root)` code). `go tool nm` agrees |
| MongoDB image: `opt/js-yaml` 3.13.1 | 0 | 3 | `paths: [opt/js-yaml/package.json]` and `purls: [pkg:npm/js-yaml@3.13.1]` | The entrypoint loads it only in `_parse_config`, to read a `--config` file, and no compose service passes `--config` |
| PostgreSQL image: `usr/local/bin/gosu` | 1 | 25 | The same entries | The same binary, for the same reason |
| PostgreSQL image: Debian 13.7 `apt` and `libapt-pkg7.0` (one CVE) | 0 | 2 | `purls` of both packages at 3.0.3 (OS packages have no path in the report) | Needs an `apt install` over an attacker-controlled path, and nothing runs apt in that image |
| Redis image (alpine 3.21.9); the Ubuntu 24.04 layer and the other Go tools of the MongoDB image | 0 | 0 | — | Nothing to waive |

That is 58 findings: 30 distinct vulnerability IDs plus the Dockerfile rule. The images scanned were `mongo:8` = 8.3.13 (`sha256:e16e606f…cd2`), `postgres:17` (`sha256:3b0cda93…84e1`) and `redis:7-alpine` (`sha256:6ba19c50…6af`).

The waivers assume that the three images are used only as local development and CI test services: published on `127.0.0.1`, with throwaway credentials and no deploy target. Check them again before any of these images is used for anything else.

Expect more of the same. The official images ship a gosu built with an old Go release, so each new Go standard-library CVE will fail the gate until the images ship a newer gosu. When one does, check as above that the package it names is still not linked, then add an entry.

govulncheck has limits. Binary mode trusts the symbol table and build info in the binary, and the package and symbol data in the vulnerability database. It cannot see code that reflection or `linkname` would reach. It also reports `GO-2026-6686` (moby/sys/user, a DoS when parsing the user and group files) as reachable. Trivy does not gate on that finding, and its input is the image's own `/etc/passwd` and `/etc/group`.

**Not covered: Compose misconfiguration.** The ticket asked for misconfiguration scanning of the Compose files. Trivy cannot do that. Its built-in checks have no Docker Compose config type: the misconfiguration documentation lists Kubernetes, Dockerfile/Containerfile, Terraform, CloudFormation, Azure ARM, Helm and Ansible, both in v0.69.3 and in v0.76.1. The run reports one config file, `infra/mongo/Dockerfile`. So no step checks `docker-compose*.yml` for things like a port published on `0.0.0.0`, a privileged service or a writable Docker socket. The images the Compose files run are scanned instead. Closing the gap is a separate task: a Compose policy check, for example custom Rego checks fed to Trivy or a dedicated Compose linter, with its own pin and its own probes.

Two other gaps: secrets inside third-party images (above), and image tags rather than digests. Because the scans use tags, the same commit can pass today and fail tomorrow, when upstream publishes a vulnerability or a rebuilt image.

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

Sokudo's engine rejects Windows bind mounts. TASK-023 created the container with `docker create -w /repo`, copied a tar of `git ls-files -co --exclude-standard` in with `docker cp -`, and started it with `docker start -a`. That run used a local image holding the binary from the cosign-verified archive (sha256 `8266084a…746b`).

**Verified (TASK-023, 2026-11-05).** The workflow has **not run on GitHub**. Here is what was run instead:

- **Five scans, with waivers.** Trivy 0.69.3, with each scan's flags as environment variables (the ones the pinned action exports for those inputs, and `TRIVY_IGNOREFILE=.trivyignore.yaml`, which the action's YAML mode sets), against a snapshot of the tree as it is committed. All five passed.
- **Five scans, empty waiver file.** The dependency and Dockerfile scan, the MongoDB scan and the PostgreSQL scan exit 1. The baseline table above comes from this run.
- **Probes.** Each one exits as required:

  | Probe | Result |
  |:---|:---|
  | A second Dockerfile (`apps/api/Dockerfile`, no `USER`) | `DS-0002` on that file, exit 1. The waiver still covers `infra/mongo/Dockerfile` |
  | A `package-lock.json` with js-yaml 3.13.1 in the repository | Its three CVEs and GHSA reported, exit 1, although the same purl is waived at `opt/js-yaml` |
  | `expired_at: 2026-11-01` on `DS-0002` and on `CVE-2025-68121` | Both come back, and both scans exit 1 |
  | A fake GitHub token in an untracked file | CRITICAL `github-pat`, exit 1 |
  | Waiver file deleted | `FATAL ignore file not found`, exit 1 |

- **The waiver check.** Its `run:` block, taken from the workflow with yq and run on Ubuntu 24.04.5 with yq 4.54.1 and jq 1.7 (the runner image's versions), against 34 files. These pass: the committed file, a path-scoped secret entry, an expiry exactly at the cap, an expiry in the past, and a vulnerability scoped by a versioned purl only. Each of these fails: no `paths`/`purls`, no owner, a blank statement, an expiry after the cap (including 2027-02-06), a missing or malformed `expired_at`, impossible dates (2027-02-30, month 13, an unquoted 2027-02-29), `0001-01-01` quoted and unquoted, `*` and `**` paths, a misconfiguration entry without `paths`, a misconfiguration or secret entry with `purls`, a license entry with only `purls`, a global `private-key` secret entry with and without `purls`, the js-yaml entries with `paths` misspelt as `path`, an unknown entry field, an entry that is not a mapping, a versionless and an empty-version purl, an unknown top-level key, a non-list kind, invalid YAML and a missing file.
- **The install step.** Its `run:` block, the same way. With the committed checksum it prints `Version: 0.69.3` and adds one `PATH` line. With the last digit changed, `sha256sum` reports `FAILED`, the step exits 1, nothing is unpacked and `PATH` is unchanged.
- **actionlint.** `actionlint` 1.7.12, with shellcheck 0.11.0, is clean.
- **The gosu evidence, again.** The hash, the image digests, `go version -m`, the symbol counts and `govulncheck` v1.1.4 were re-run on the binary taken from the image. The CVE-to-GO-ID mapping and the levels match the statements.

Not verified: any run on a hosted runner. That includes the action's database cache, the step-level `env:` reaching the action's inner steps (the action's README relies on it), Docker Hub pulls and rate limits from a runner, and the job's run time. The `security` job cannot run on GitHub until `verify` passes there, and `verify` is blocked by MongoDB (§6.3).

### 6.3 MongoDB on the hosted runner (open, TASK-023)

`verify` fails on GitHub at "Start the test services" (run 41880117271, 2026-11-04, runner image `ubuntu-24.04` 20261025.353). The mongo container exits with log id `12257600`, "MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility with this version of MongoDB" (SERVER-121912).

- **The runner kernel.** The runner image moved from kernel `6.17.0-1022-azure` (20261023.334) to `7.0.0-1017-azure` (20261026.354 and 20261101.360), according to the runner-images release notes.
- **What mongod checks.** `src/mongo/db/startup_check_rseq.cpp` exits only when tcmalloc's per-CPU caches are active and the kernel is in 6.19.0–7.0.13. SERVER-125742 (8.0.30, 8.3.9) exempts 7.0.14 and later, but it reads `uname`. Ubuntu reports every 7.0 kernel as `7.0.0`, so Ubuntu kernels stay refused (SERVER-136848).
- **The Ubuntu fix.** SERVER-131779 reads the upstream version from `/proc/version_signature`. Its 8.x fix versions are 8.3.16 and 8.0.37.
- **Docker Hub.** On 2026-11-05 the newest tags are 8.3.13 (`mongo:8`) and 8.0.34, so **no published 8.x image starts on this runner.** Even 8.3.16 would start only if this Azure kernel's upstream base is 7.0.14 or later, and that is not verified.
- **Local reproduction: not possible.** The local engine's kernel is 6.18.33, below the affected range.

The image is therefore still the floating `mongo:8` tag (8.3.13 today), and the TASK-023 waivers are written for that image. Options, for the owner to choose from:

| Option | What changes | Trade-off |
|:---|:---|:---|
| A. `GLIBC_TUNABLES=glibc.pthread.rseq=1` on the mongo service, with `mongo:8.3.13@sha256:e16e606f…` pinned | glibc takes the rseq registration, so tcmalloc falls back to per-thread caches. The check then passes (source above), and the code path the kernel change breaks is not used | It is the docker-library maintainers' documented workaround, not a MongoDB fix, and it costs some allocator performance. Measured locally on 8.3.13: `usingPerCPUCaches` is `true` with the image's default `rseq=0` and `false` with `rseq=1`. Not run on a 6.19+ kernel |
| B. Wait for `mongo:8.3.16` on Docker Hub and pin it | Only the tag | Depends on the runner kernel's `/proc/version_signature` reporting 7.0.14 or later, which is unknown. CI stays red until then |
| C. MongoDB 9.0.4 | A major upgrade | It has the fix, but has the same kernel caveat as B, contradicts "MongoDB 8" in the specs, and needs an in-place upgrade of the dev volume |
| D. Pin the runner to an older image or kernel | `runs-on` of `verify` | Not durable, since GitHub moves images, and it changes the `verify` job |
| E. MongoDB 7.0 | A major downgrade | 7.0 cannot open the 8.x dev volume, which would have to be recreated. Ruled out |

## 7. Acceptance criteria (TASK-18, TASK-19)

- [ ] Every module in `src/modules/` has a matching `tests/modules/<module>/` folder; every module with routes has `tests/e2e/<module>/`.
- [ ] Every feature in `src/features/` has a matching `tests/features/<feature>/` folder; every feature with pages has `e2e/<feature>/`.
- [x] A CI check fails when a module or feature folder has no matching test folder: `bun run check:test-folders` (`scripts/check-test-folders.ts`; exact-case names, at least one test or flow file; a module has routes when the syntax of its controller `index.ts` (DEC-008), parsed with the repo's `typescript` (never imported or run), holds a route call (`get`, `post`, `put`, `patch`, `delete`, `options`, `head`, `all`, `route`, `ws`) on an Elysia chain: one rooted at `new Elysia()` (aliases included), a variable initialised from one, or a `group`/`guard` callback parameter. Paths count in any form (constants, templates); comments, strings and `.get()` on anything else do not; a controller that does not parse fails the check. Routes in other files of the module are not seen) (TASK-18). It uses TypeScript 7's `unstable/async` client: the sync one reads a Node-only file descriptor off Windows and crashes under Bun on Linux (macOS takes the same branch, not tried) (TASK-11).
- [x] `bun run test` passes without Redis or MongoDB running (TASK-18).
- [ ] The required API and web E2E flows above exist and pass. All exist (TASK-19). API: all 20 tests in 6 files pass against an isolated test stack, run from the workflow's own steps on Windows and in an Ubuntu 24.04 container on 2026-11-05 (TASK-11); the workflow has not run on GitHub yet (§6). Web: not executed, because the runner needs a person's open Browser panel (§6.1).
