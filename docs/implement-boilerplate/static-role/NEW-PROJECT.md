# Start a project from your own PRD

You have a PRD. This boilerplate already has sign-up and sign-in (email/password and Google), roles and permissions in code, user and session administration, a Redis cache, structured logs in MongoDB, a test layout and CI. This guide takes you from a fresh clone to your own roles, API modules and web features without rebuilding any of that.

Every path, script and variable below exists in the repo today. `<name>` stands for one of your modules or features (for example `orders`); the example `posts` module and feature are the reference implementation to copy from.

## 1. Bootstrap

Follow [Getting started](../../../README.md#getting-started) in the root README until both dev servers answer and the seeded super admin can sign in at `/login`. Do not skip `bun install --frozen-lockfile`: every typecheck and test needs it, in every fresh clone or worktree.

## 2. Put your PRD in the repo

- Put your product documents in a new `docs/product/` folder (for example `docs/product/PRD.md` and `docs/product/FEATURES.md`). Keep this folder as the documentation of the platform you build on, and update it whenever you change platform behaviour ([README.md](README.md#keeping-this-folder-true)).
- If you prefer one place, replace [PRD.md](PRD.md) and [FEATURES.md](FEATURES.md) here with your own, keeping their shape: `F-xx` features with Given/When/Then acceptance criteria and edge cases, `FR-xx` requirements.
- Record your project's own architecture decisions as new entries in [DECISIONS.md](DECISIONS.md), numbered after the highest existing one. Code and documents cite `DEC-xxx` numbers, so never renumber.

Map the PRD onto the boilerplate's building blocks:

| In your PRD | Becomes | Where |
|:---|:---|:---|
| A domain noun with its own data and rules (orders, invoices) | An API module that owns the resource | `apps/api/src/modules/<name>/` |
| Who may do what to it | Permissions (`<resource>:<action>`) granted to roles | `apps/api/src/modules/<name>/permissions.ts` |
| A kind of user (customer, staff, approver) | A role in the registry | `apps/api/src/utils/auth/roles.ts` |
| A rule about one record ("only the author edits") | An ownership rule in the service, after the permission | `apps/api/src/modules/<name>/service.ts` |
| A screen or user journey | A web feature with pages, plus thin route files | `apps/web/src/features/<name>/`, `apps/web/src/routes/` |
| Something that must be findable later (security action, business event) | A telemetry event | `apps/api/src/utils/telemetry/events.ts` |
| A product number (a limit, a cache TTL) | An environment variable, validated once | `apps/api/src/env.ts`, `.env.example` |
| A table | A Drizzle schema file and a migration | `packages/db/src/schema/`, `packages/db/migrations/` |

A resource belongs to exactly one module, and modules call each other only through their exported service (DEC-002, DEC-009). A screen that shows data from several modules is one web feature calling several endpoints, not one module reaching into another's tables.

## 3. Rename and decide before the first deploy

These identifiers are neutral placeholders (DEC-040). Changing them is a find-and-replace now and a migration later. List every occurrence with `git grep -n "<value>"` before you change one.

| Identifier | Today | Main places | Cost once deployed |
|:---|:---|:---|:---|
| Better Auth app name and cookie prefix | `appName: 'app'`, `COOKIE_PREFIX = 'app'` (cookie `app.session_token`, `__Secure-app.session_token` on HTTPS) | `packages/auth/src/server.ts`; tests that read the cookie: `apps/api/tests/helpers/auth.ts`, `apps/api/tests/helpers/e2e-client.test.ts` | Every user is signed out once |
| PostgreSQL database and user | `app` / `app` (dev), `app_test` (tests) | `docker-compose.dev.yml`, `docker-compose.yml`, `docker-compose.test.yml`, `DATABASE_URL` in `.env.example`, `apps/api/src/env.ts`, `apps/api/tests/helpers/db.ts`, `.github/workflows/ci.yml` | Data migration |
| MongoDB log database and users | `app_logs`; `log_writer`, `log_admin`, `log_reader` | `LOG_MONGO_*` in `.env.example`, `apps/api/src/env.ts` (default `LOG_MONGO_DB`), the three Compose files, `infra/mongo/init.js`, `.github/workflows/ci.yml` | Data migration; Mongo users are created only on an empty volume |
| Compose project names | `app-dev`, `app-test` | `name:` in the Compose files | A renamed dev project starts with new, empty volumes |
| Workspace package scope | `@repo/*` | every `package.json` and import | None; the packages are never published, so keeping `@repo/*` is fine |
| Root package name | `boilerplate` | root `package.json` | None |
| Browser tab title | `Web` | `apps/web/src/routes/__root.tsx` | None |

Then fill in the environment. The variables and their local values are in the root README's environment table and in [ARCHITECTURE.md §7](ARCHITECTURE.md#7-environment-variables). Points that need a decision from you:

- `BETTER_AUTH_SECRET`: at least 32 characters, private.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: both or neither. Empty switches Google off, which only development and test allow. The redirect URI is `${BETTER_AUTH_URL}/api/auth/callback/google`.
- `SEED_SUPER_ADMIN_EMAIL` and `SEED_SUPER_ADMIN_PASSWORD`: the first account; `bun run db:seed` creates or promotes it to `super_admin`.
- `POSTS_TITLE_MAX_LENGTH`, `POSTS_CONTENT_MAX_LENGTH`, `POSTS_CACHE_TTL`: belong to the example module. Remove them with it (§8).
- In production the API refuses to start without `REDIS_URL`, `LOG_MONGO_URL`, HTTPS `BETTER_AUTH_URL` and `WEB_URL`, and both Google variables (`apps/api/src/env.ts`).

## 4. Roles and permissions for your domain

Roles are code, so every change to what a role can do is reviewed, typed, tested and deployed (DEC-022). Details: [auth/static-roles.md](auth/static-roles.md).

1. **Roles.** Edit `roleRegistry` in `apps/api/src/utils/auth/roles.ts` ([§2](auth/static-roles.md#2-the-role-registry), [§8](auth/static-roles.md#8-adding-a-custom-role)). `super_admin` and `user` must stay: `user` is the default for every new account, and `super_admin` is derived to hold every permission. `admin` and any role you add are yours to keep, rename or drop. Role names are stored in `user.role`, so renaming one after launch is a data migration.
2. **Permissions.** Each module declares a statement and per-role grants in its `permissions.ts` with `defineModulePermissions` ([§3](auth/static-roles.md#3-declaring-permissions-in-a-module), [§9](auth/static-roles.md#9-adding-a-custom-permission)). The resource key is the module name; actions are coarse (`read`, `write`, `manage_all`). Grants name only registry roles and never `super_admin` (apps/api R21).
3. **Register** the module's permissions in the `modules` list of `apps/api/src/utils/auth/access.ts`. A duplicate resource key fails startup.
4. **Matrix tests.** Update the hand-written `EXPECTED` map in `apps/api/tests/modules/me/permissions.test.ts`, then refresh the compiled-roles snapshot from `apps/api` with `bun test tests/modules/me --update-snapshots` and review the diff. Update the matrix in [auth/static-roles.md §5](auth/static-roles.md#5-default-permission-matrix).
5. **Web.** Pages and actions check `can('<resource>:<action>')` from `@/features/auth`, never role names (apps/web R17). Hiding UI is UX only; the API decides.

A feature flag never decides access (apps/api R25). Flags are design only ([feature-flags/README.md](feature-flags/README.md)).

## 5. Add an API module

Rules: [apps/api/README.md](../../../apps/api/README.md). Copy the shape of `apps/api/src/modules/posts/`.

1. **Files.** `apps/api/src/modules/<name>/` with exactly `index.ts` (controller), `service.ts`, `model.ts` and `permissions.ts` (DEC-008, R2). A file may be absent when empty; never add `routes.ts`, `lib/` or similar.
2. **Model.** One exported object (`<Name>Model`) of `t` schemas for every body, query, params and success response. Strings have `minLength`/`maxLength`, query numbers `minimum`/`maximum`; types come from `typeof X.static` (R16 to R18).
3. **Service.** `export abstract class <Name>Service` with static methods only, no HTTP types (R10, R11). Tables come from `@repo/db` and the client from `utils/db`. Expected failures throw `moduleError('<name>', status, 'UPPER_SNAKE_CODE', message)` from `utils/error` (R12, DEC-037). Ownership rules run here after the permission passed, using `hasPermission` from `utils/auth` (R22).
4. **Controller.**

   ```ts
   // apps/api/src/modules/<name>/index.ts (sketch, after posts/index.ts)
   export const orders = new Elysia({ name: 'orders', prefix: '/orders' })
     .use(moduleScope('orders'))   // first, with the folder name (R5)
     .use(authGuard)               // adds the `permission` and `auth` route options
     .get('/', ({ query }) => OrderService.list(query.page, query.limit), {
       permission: 'orders:read',
       query: OrderModel.listQuery,
       response: { 200: OrderModel.list },
     })
   ```

   Handlers are inline, pass plain values to the service, and set `201` on create and `204` on delete (R6 to R9). Lists return `{ items, meta: { page, limit, total, totalPages } }` (R26).
5. **Mount** it in `apps/api/src/app.ts` with `.use(mountModule(<name>))`. Startup fails when `moduleScope` is missing or misnamed, and `assertRouteAccess` fails it for any route with neither `permission` nor `auth: true`. A deliberately public route needs an entry in `PUBLIC_ROUTES` (`apps/api/src/utils/auth/macros.ts`) and a **Public** mark in [API.md](API.md) (R20).
6. **Permissions**: §4.
7. **Cache** (if the PRD needs it). `moduleCache('<name>', { ttlSeconds })` from `utils/cache`; keys `<module>:<entity>:<part>`. Every write invalidates what it changed in the same service with `delPattern` (`SCAN`, never `KEYS`), and a hit returns exactly the miss payload (R37 to R39). `PostService` shows a race-safe list invalidation.
8. **Config.** New variables are read and validated once in `apps/api/src/env.ts` and added to `.env.example` (R41).
9. **Events.** Anything that must be findable later gets an entry in `apps/api/src/utils/telemetry/events.ts` and is sent with `telemetry.emit(...)`, never awaited. Payloads carry IDs, never email, names, tokens, URLs or bodies (R31 to R34, [observability/redaction.md](observability/redaction.md)).
10. **User removal.** If your rows must go when a user is removed, reference `user.id` with `onDelete: 'cascade'`. Anything else that depends on those rows (a cache, for example) registers a callback with `onUserRemoved` from `utils/auth`, as `posts` does.
11. **Tests.** `apps/api/tests/modules/<name>/` holds `routes.test.ts`, `service.test.ts` and `permissions.test.ts`. Every route is tested for success, 400, 401, 403 and (with `:id`) 404 through `app.handle(new Request(...))`, and a failure is asserted to be logged with `module: "<name>"` (R45 to R48). Helpers are in `apps/api/tests/helpers/` (`app.ts`, `auth.ts`, `db.ts`). API E2E tests over HTTP go in `apps/api/tests/e2e/<name>/` (R49). In Bun, `mock.module()` must run before the code under test is loaded with `await import(...)`.
12. **Documentation.** Add the endpoints to [API.md](API.md), tables to [DATABASE.md](DATABASE.md) and the permissions to [auth/static-roles.md §5](auth/static-roles.md#5-default-permission-matrix).

`bun run check:test-folders` fails until `apps/api/tests/modules/<name>/` holds a `*.test.ts` file and, because the module has routes, `apps/api/tests/e2e/<name>/` does too.

## 6. Add a web feature

Rules: [apps/web/README.md](../../../apps/web/README.md); visual rules: [DESIGN.md](DESIGN.md). Copy the shape of `apps/web/src/features/posts/`.

1. **Folder.** `apps/web/src/features/<name>/{components,hooks,lib,pages}/` and an `index.ts` that exports only what other code uses (R4, R5). Other code imports the feature only through `@/features/<name>`; a deep import fails `bun run lint` (`apps/web/lint/feature-boundaries.js`).
2. **Data.** A query key factory in `lib/keys.ts`; `queryOptions` shared by hooks and loaders; every call through the Eden client `api` from `@/lib/api`, turned into a thrown error by `unwrap` from `@/lib/api-error`; mutations invalidate their keys in `onSuccess` (R8 to R12). Eden's types come from `type App` in `apps/api/src/app.ts`, so a new API route is typed in the web app as soon as it is mounted.
3. **Pages.** Each data page has loading, empty, error and forbidden states (R25, [DESIGN.md §11](DESIGN.md#11-states)). Forms use TanStack Form with validation in `lib/`, matching the API's `model.ts` limits; a `400 VALIDATION_ERROR` is shown on the field (R21 to R23). For a form, copy `features/profile/components/profile-form.tsx` or the auth forms, which use the shared helpers in `@/lib/form`; the posts form uses plain React state and is not the pattern to follow.
4. **Routes.** Thin files in `apps/web/src/routes/` that render one page from the feature (R1). A page that needs a session goes under `src/routes/_authed/`; a page that needs a permission adds `beforeLoad: ({ context }) => requirePermission(context.queryClient, context.session, '<name>:read')`, as `src/routes/_authed/posts/route.tsx` does (R2). `src/routeTree.gen.ts` is generated by the TanStack Start Vite plugin when the web dev server or `vite build` runs; never edit it by hand (R3).
5. **Navigation.** The header is `apps/web/src/components/app-shell.tsx`. A feature exports its own nav entry that renders nothing without the permission, as `PostsNav` in `features/posts` does, and the shell renders it.
6. **UI.** Tailwind v4 with the tokens from `packages/ui` only; generic primitives go in `packages/ui/src/components/` (R7, R24).
7. **Tests.** `apps/web/tests/features/<name>/` covers hooks, `lib/` helpers, forms and pages, with the API mocked at `@/lib/api` (see `apps/web/tests/features/posts/api-mock.ts`) and components found by role, label and text (R32 to R34).
8. **E2E flows.** One journey per YAML file in `apps/web/e2e/<name>/`; the flow `name` starts with the feature name and its `tags` include it; credentials come from E2E environment values, never the YAML. Validate every flow with the workspace E2E runner before committing it (R35 to R37). The runner only sees flows in the main checkout, so a new flow can run only after it is merged.

`bun run check:test-folders` fails until `apps/web/tests/features/<name>/` holds a test and, because the feature has pages, `apps/web/e2e/<name>/` holds a flow.

## 7. Database changes

1. Add the table in `packages/db/src/schema/<name>.ts` and export it from `packages/db/src/schema/index.ts` (copy `post.ts`).
2. `bun run db:generate` writes a migration to `packages/db/migrations/`. Review the SQL and commit it with `migrations/meta/`.
3. `bun run db:migrate` applies it to the database in `DATABASE_URL`. The API tests migrate `app_test` themselves (`apps/api/tests/helpers/db.ts`).
4. If you change Better Auth options or plugins in `packages/auth/src/server.ts` in a way that changes its tables, run `bun run auth:generate` (rewrites `packages/db/src/schema/auth.ts`), then `bun run db:generate`.
5. Development data goes in `packages/db/src/seed.ts`, which is idempotent (fixed keys and `onConflictDoNothing`) and refuses `NODE_ENV=production`. `bun run db:seed` runs it.
6. Describe the table in [DATABASE.md](DATABASE.md).

## 8. Remove or replace the example `posts` module

`posts` exists to show the full pattern. Recommended order: build your first module and feature next to it, then remove it, so the shared tests always have a module to point at.

Delete these folders and files:

- `apps/api/src/modules/posts/`, `apps/api/tests/modules/posts/`, `apps/api/tests/e2e/posts/`
- `apps/web/src/features/posts/`, `apps/web/src/routes/_authed/posts/`, `apps/web/tests/features/posts/`, `apps/web/e2e/posts/`
- `packages/db/src/schema/post.ts`

Edit these:

| File | Change |
|:---|:---|
| `apps/api/src/app.ts` | Remove the `posts` import and `.use(mountModule(posts))` |
| `apps/api/src/utils/auth/access.ts` | Remove `postsPermissions` from `modules` |
| `apps/api/src/env.ts` | Remove `POSTS_CACHE_TTL` and `readPostsLimits` (`POSTS_TITLE_MAX_LENGTH`, `POSTS_CONTENT_MAX_LENGTH`) |
| `.env.example`, `apps/api/tests/setup.ts`, `.github/workflows/ci.yml` | Remove the `POSTS_*` values |
| `apps/api/tests/utils/logger/env.test.ts` | Remove the `POSTS_*` names and fixture values, the `POSTS_CACHE_TTL` test and the `readPostsLimits` test |
| Root `README.md` | Remove the `POSTS_*` rows from the environment table |
| `apps/web/src/components/app-shell.tsx` | Remove `PostsNav` |
| `packages/db/src/schema/index.ts` | Remove `export * from './post'` |
| `packages/db/src/seed.ts` | Remove the example posts |
| `apps/api/tests/modules/me/permissions.test.ts` and its snapshot | Drop the `posts:*` permissions (§4 step 4) |

Then:

1. `bun run db:generate` writes the migration that drops `post`; apply it with `bun run db:migrate`.
2. Start the web dev server once so `apps/web/src/routeTree.gen.ts` is regenerated without the posts routes.
3. Several shared tests use `posts` as their example permission, route or feature, among them `apps/api/tests/e2e/{admin,me,health}/`, `apps/api/tests/utils/auth/access.test.ts`, `apps/web/tests/features/{admin,auth,profile}/` and `scripts/check-test-folders.test.ts`. List them with `git grep -l -e "posts:" -e "/api/posts" -e "modules/posts" -e "features/posts" -e "POSTS_" -e "readPostsLimits" -- apps/api/tests apps/web/tests scripts` and point each one at a module of yours. Some use `posts` only as a sample string and pass unchanged; the checklist below shows which ones do not. Afterwards, `git grep -n -e "POSTS_" -e "readPostsLimits" -- . ':!docs'` should find only the `moduleCache` usage example in the comment in `apps/api/src/utils/cache/index.ts`.
4. Remove the posts sections from [FEATURES.md](FEATURES.md) (F-04), [API.md](API.md), [DATABASE.md](DATABASE.md) and [auth/static-roles.md](auth/static-roles.md), or replace them with yours.

## 9. Checklist before shipping

- [ ] `bun install --frozen-lockfile`
- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run check:test-folders`
- [ ] `bun run test`, against an isolated `app_test` database ([TESTING.md](TESTING.md), root README "Development checks and test isolation")
- [ ] `bun run test:e2e`, against a running test API named by `API_E2E_URL`
- [ ] The web E2E flows of every new or changed feature, run through the workspace E2E runner; CI cannot run them ([TESTING.md §6.1](TESTING.md#61-web-e2e-is-a-separate-gate))
- [ ] CI green: the `verify` and `security` jobs of `.github/workflows/ci.yml`
- [ ] Documents updated for every behaviour change, and new DEC entries **Answered** before the code that depends on them merges ([README.md](README.md#keeping-this-folder-true))
- [ ] Production: [auth/README.md §7](auth/README.md#7-production-checklist); a reverse proxy serving web and API on one origin (DEC-020); `logs:setup` run once per log database; the prune runbook in [docs/operations/log-retention.md](../../operations/log-retention.md) handed to whoever operates the logs
