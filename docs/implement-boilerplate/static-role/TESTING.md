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

[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) (TASK-11) is one job on `ubuntu-24.04`. It runs on every pull request and every push to `main`, and can be started by hand. Bun is pinned to 1.4.4 and the two actions to commit SHAs. It holds no secret: its only credentials are the throwaway values of the test stack (§3) and a throwaway password for the seeded `super_admin`, which exist on the runner for the length of the run.

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

## 7. Acceptance criteria (TASK-18, TASK-19)

- [ ] Every module in `src/modules/` has a matching `tests/modules/<module>/` folder; every module with routes has `tests/e2e/<module>/`.
- [ ] Every feature in `src/features/` has a matching `tests/features/<feature>/` folder; every feature with pages has `e2e/<feature>/`.
- [x] A CI check fails when a module or feature folder has no matching test folder: `bun run check:test-folders` (`scripts/check-test-folders.ts`; exact-case names, at least one test or flow file; a module has routes when the syntax of its controller `index.ts` (DEC-008), parsed with the repo's `typescript` (never imported or run), holds a route call (`get`, `post`, `put`, `patch`, `delete`, `options`, `head`, `all`, `route`, `ws`) on an Elysia chain: one rooted at `new Elysia()` (aliases included), a variable initialised from one, or a `group`/`guard` callback parameter. Paths count in any form (constants, templates); comments, strings and `.get()` on anything else do not; a controller that does not parse fails the check. Routes in other files of the module are not seen) (TASK-18). It uses TypeScript 7's `unstable/async` client: the sync one reads a Node-only file descriptor off Windows and crashes under Bun on Linux (macOS takes the same branch, not tried) (TASK-11).
- [x] `bun run test` passes without Redis or MongoDB running (TASK-18).
- [ ] The required API and web E2E flows above exist and pass. All exist (TASK-19). API: all 20 tests in 6 files pass against an isolated test stack, run from the workflow's own steps on Windows and in an Ubuntu 24.04 container on 2026-11-05 (TASK-11); the workflow has not run on GitHub yet (§6). Web: not executed, because the runner needs a person's open Browser panel (§6.1).
