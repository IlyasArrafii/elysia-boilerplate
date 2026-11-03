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
| Runner (both apps) | `bun test` (*verify* Bun version supports the features used) |
| DOM for web tests | `@happy-dom/global-registrator` preloaded through `bunfig.toml` (`[test] preload`) |
| React testing | `@testing-library/react` + `@testing-library/user-event` (*verify* compatibility with the React version TanStack Start uses) |
| Module mocks | `mock.module()` from `bun:test` |
| Telemetry assertions | the `memory` sink |
| Web E2E | The workspace E2E system: YAML flows run by its runner. No Playwright, Cypress, Puppeteer or Selenium |

## 3. API layout

```
apps/api/tests/
  helpers/
    app.ts            builds the app for app.handle(); memory sink; no listen()
    db.ts             migrate once, truncate between files (test PostgreSQL)
    auth.ts           createUser(role), signIn(user) → cookie header
    mongo.ts          test MongoDB database for mongo-sink tests (dropped after the run)
  modules/<module>/   one folder per src/modules/<module>, same name
    service.test.ts
    routes.test.ts
    permissions.test.ts
  utils/<util>/       one folder per src/utils/<util>, same name (auth, telemetry, cache, error, logger, …)
  e2e/
    helpers/          client.ts (fetch with cookie jar against API_E2E_URL), users.ts
    <module>/         one folder per module that has routes, same name
      <flow>.test.ts
```

- Folder names equal the module or util folder names exactly. A module without a test folder fails review.
- `bun run test` (in `apps/api`) runs `bun test tests/modules tests/utils`. `bun run test:e2e` runs `bun test tests/e2e`. E2E never runs as part of `test`.
- Test PostgreSQL: `DATABASE_URL` pointing at a separate `app_test` database. `REDIS_URL` empty (memory fallback) for unit and route tests.

### 3.1 Required tests per module

| File | Must cover |
|:---|:---|
| `routes.test.ts` | For every route: success; `400 VALIDATION_ERROR` with field paths only; `401` without a session; `403` without the permission; `404` when it has `:id`; ownership rule where there is one. Every response has `x-request-id`. |
| `routes.test.ts` (logging) | A forced error in the route produces one `http.error` in the memory sink with `module: "<module>"` and no route field; a `moduleError` carries `sourceModule` |
| `service.test.ts` | Business logic, cache hit = miss payload, cache invalidation on writes, `moduleError` codes |
| `permissions.test.ts` | The module's grants appear in the compiled-roles snapshot; every permission is used by at least one route |

Cross-cutting tests in `tests/utils/`: the permission matrix and guard rules (`auth/`, [auth/access/static-roles.md §11](auth/access/static-roles.md)), redaction ([observability/redaction.md §7](observability/redaction.md)), `mongo` sink and prune command (`telemetry/`, [log-storage.md §8](observability/log-storage.md)), `moduleScope` startup checks (`logger/`).

### 3.2 API E2E

- **Stack:** `docker compose -f docker-compose.test.yml up` (PostgreSQL, Redis, MongoDB), migrations and seed, then the API started with `NODE_ENV=test` and `LOG_MONGO_URL` set. `API_E2E_URL` points at it.
- **Isolation:** each test file creates its own users with unique emails (`e2e+<run>-<n>@example.test`) through the Better Auth endpoints; tests never depend on order between files.
- **Required flows:**

| Folder | Flows |
|:---|:---|
| `e2e/auth/` | sign-up → sign-in → get-session → sign-out → 401; sixth sign-in in 60 s → 429; impersonation endpoints → 404 |
| `e2e/posts/` | user creates, lists (cache hit after the first call), edits and deletes own post; another user gets 403; admin edits anyone's; the `x-request-id` of a posts request finds its `http.request` document in MongoDB with `module: "posts"` |
| `e2e/admin/` | super_admin changes a role and the next `/api/me/permissions` reflects it; admin gets 403 on set-role; roles catalogue |
| `e2e/me/` | permissions per role |
| `e2e/health/` | 200 with all dependencies; `logStore: "down"` still 200 when MongoDB is stopped |

Google OAuth is not automated end to end (it needs Google). It is covered by route tests with the provider mocked and checked by hand before release.

## 4. Web layout

```
apps/web/tests/
  setup.ts            happy-dom registration, Testing Library cleanup
  helpers/
    render.tsx        renders with QueryClient + router test context
    api-mock.ts       mock.module('@/lib/api') and auth-client helpers
  features/<feature>/ one folder per src/features/<feature>, same name
    hooks.test.ts
    lib.test.ts
    <page-or-component>.test.tsx
  lib/                tests for src/lib
  components/         tests for src/components
apps/web/e2e/
  <feature>/          one folder per feature that has pages, same name
    <flow>.yaml
```

- `bun run test` (in `apps/web`) runs `bun test tests`.
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
- *Verify* that the runner discovers flows in nested `e2e/<feature>/` folders; if it does not, keep the feature as a filename prefix (`auth-sign-in.yaml`) until it does.

**Required flows:**

| Folder | Flows |
|:---|:---|
| `e2e/auth/` | sign-up, sign-in, refresh keeps the session, sign-out, protected page redirects to `/login`, wrong password shows the generic message |
| `e2e/posts/` | list, create, edit own, no edit button on another user's post, delete with confirmation, empty state |
| `e2e/admin/` | admin sees the users list; super_admin changes a role with confirmation; `user` visiting `/admin` is redirected with a message; role catalogue |
| `e2e/profile/` | update name, validation error on empty name |

## 6. CI

1. `bun install --frozen-lockfile`, typecheck, lint.
2. `bun run test` in `apps/api` and `apps/web` (fast; no external services except test PostgreSQL).
3. Start the test stack; `bun run test:e2e` in `apps/api`.
4. Web E2E flows tagged `smoke` on every merge; the full set nightly or before a release.

## 7. Acceptance criteria (TASK-18, TASK-19)

- [ ] Every module in `src/modules/` has a matching `tests/modules/<module>/` folder; every module with routes has `tests/e2e/<module>/`.
- [ ] Every feature in `src/features/` has a matching `tests/features/<feature>/` folder; every feature with pages has `e2e/<feature>/`.
- [ ] A CI check fails when a module or feature folder has no matching test folder.
- [ ] `bun run test` passes without Redis or MongoDB running.
- [ ] The required API and web E2E flows above exist and pass.
