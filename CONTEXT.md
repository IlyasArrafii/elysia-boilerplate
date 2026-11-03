# CONTEXT.md

Glossary of agreed terms. Specs: [docs/specs/eng/](docs/specs/eng/README.md) (canonical) and [docs/specs/id/](docs/specs/id/README.md) (Indonesian). Decisions: [DECISIONS.md](docs/specs/eng/DECISIONS.md). Coding rules: [apps/api/README.md](apps/api/README.md), [apps/web/README.md](apps/web/README.md). `docs/prd/` is history only.

## API (`apps/api`)

- **Root app**: the Elysia instance in `apps/api/src/index.ts` with `prefix: '/api'`. The only place `/api` is written (DEC-006).
- **Module**: a folder `apps/api/src/modules/<name>/` exported as one named Elysia plugin (DEC-003, DEC-008).
- **Controller**: a module's `index.ts`. Declares the module's routes and prefix; its first `.use()` is `moduleScope`.
- **Service**: a module's `service.ts`, an `abstract class <Name>Service` with `static` methods. The only thing other modules may call (DEC-009).
- **Model**: a module's `model.ts`, the `t` schemas for body, query, params and responses.
- **Permissions file**: a module's `permissions.ts`, its statement and role grants (DEC-023).
- **Utils**: `apps/api/src/utils/<name>/`, code shared across modules.
- **Module error**: an expected business error thrown with `moduleError(module, status, code, message)`; it carries the module that threw it (DEC-037).
- **Better Auth handler**: Better Auth's handler mounted at `/api/auth/*`. Never wrapped (DEC-007).
- **Auth macro**: route options `{ auth: true }` / `{ permission: '…' }` from `utils/auth` (DEC-010).

## Access control

- **Access stage**: how a project decides who may do what; exactly one per project (DEC-042, DEC-047). **Stage 1 static-roles** (default) and **stage 2 single-org** ([auth/access/](docs/specs/eng/auth/access/README.md)). Formerly called "access mode". What was "stage 3 multi-tenant" is now the foundation of the **SaaS layer** (DEC-050).
- **Step A / Step B**: the two forward moves: stage 1 → stage 2 ([auth/access/migration.md](docs/specs/eng/auth/access/migration.md)) and stage 2 → multi-tenant ([saas/migration.md](docs/specs/eng/saas/migration.md)). There is no backward move.
- **Role**: a named set of permissions. In static-roles: stored as a string on `user.role`, defined in code in the role registry; no role table (DEC-022). Defaults `super_admin`, `admin`, `user`; projects add custom roles.
- **Platform role**: from access stage 2 on (and in multi-tenant), the role on `user.role` (`super_admin`, `user`). Runs the app itself; grants no module permissions (DEC-043).
- **Organization role**: from access stage 2 on (and in multi-tenant), the role on `member.role` inside one organization. Either a **code role** (`owner`, `admin`, `member`, custom ones in code) or a **runtime role** created from the UI and stored in `organization_role`.
- **Organization / tenant**: a customer company in the SaaS multi-tenant layer. At stage 2 there is one hidden **primary organization** (slug `PRIMARY_ORG_SLUG`).
- **Active organization**: `session.activeOrganizationId`; every organization permission check and every module query uses it.
- **Scoped query**: a repository call through `scoped(orgId)`, the only way module code reaches a module table; only `*AcrossTenants` functions in the `platform` module may skip it (DEC-044, DEC-051).
- **Row-level security (RLS)**: in multi-tenant, PostgreSQL policies that return and accept only rows of the organization set by `scoped()` for the current transaction; the second isolation layer after the application filter ([saas/architecture.md §4](docs/specs/eng/saas/architecture.md), DEC-051).
- **Database roles**: in multi-tenant, `app_owner` (migrations, purge), `app_runtime` (the API, RLS enforced) and `app_platform` (read-only cross-tenant reads).
- **Platform layer**: from stage 2 on, the admin-plugin part that runs the app itself: platform roles, users, bans, sessions, feature flags ([single-org.md §8](docs/specs/eng/auth/access/single-org.md)).
- **SaaS layer**: everything for running the app for many companies, on top of stage 2: multi-tenant, its architecture, flags, observability and migration, the platform console, tenant rollout, plans and billing ([saas/](docs/specs/eng/saas/README.md)). Its decisions are SAAS-xxx (DEC-049, DEC-050).
- **Platform console**: the SaaS owner's cross-tenant admin area on top of the platform layer: organizations, suspension, audit ([saas/platform-console.md](docs/specs/eng/saas/platform-console.md)).
- **Resource / Action / Statement**: what can be acted on, what can be done to it, and a module's map of the two.
- **Permission**: one `resource:action` string, e.g. `posts:write`. The contract between API routes and web UI.
- **Grant**: the permissions one module gives one role.
- **Ownership rule**: a record-level check in the service after the permission passes.
- **Blocked endpoint**: an admin-plugin endpoint the API does not use (e.g. impersonation); rejected with 404 (DEC-032).

## Observability

- **Request ID**: the `x-request-id` value, on every log line and response (DEC-013).
- **Log context**: per-request `{ requestId, module, userId }` merged into every event of that request.
- **Module scope**: `moduleScope('<name>')`, which sets `module` in the log context for a controller's routes (DEC-037).
- **Telemetry event**: a named, typed occurrence sent with `telemetry.emit(...)` and registered in `events.ts` (DEC-014).
- **Kind**: the class of an event (`http`, `app`, `error`, `audit`, `product`). Drives retention.
- **Sink**: a destination for events. MVP: `log` (stdout), `mongo` (MongoDB log store), `memory` (tests). `sentry` and `posthog` are design only.
- **Log store**: the MongoDB database `app_logs`, collection `log_event` (DEC-034). Logs only, never app data.
- **Scrubber**: the function in `emit()` that removes secrets and personal data before any sink (DEC-027).
- **Audit event**: an event of kind `audit` from Better Auth hooks (DEC-016).
- **Retention**: how long each kind is kept (`http` 14 d, `app`/`error`/`product` 30 d, `audit` 365 d).
- **Prune**: deleting events older than their retention with `bun run logs:prune`, run manually by an operator.
- **Flush**: writing buffered events on shutdown. Not the same as prune.

## Web (`apps/web`)

- **Feature**: a folder `apps/web/src/features/<feature>/{components,hooks,lib,pages,index.ts}` (DEC-011).
- **Page**: a component in `features/<feature>/pages/` rendered by a route file.
- **Route file**: a thin file in `src/routes/` (TanStack file-based routing).

## Testing

- **Test folder**: `tests/modules/<module>/` (API) or `tests/features/<feature>/` (web), named exactly like the source folder (DEC-039).
- **API E2E**: `bun test` files in `apps/api/tests/e2e/<module>/` run over HTTP against a running stack.
- **Web E2E flow**: a YAML journey in `apps/web/e2e/<feature>/`, run by the workspace E2E system.

## Cross-cutting

- **Feature flag**: a switch for gradual rollout or a kill switch, through OpenFeature. Design only (DEC-012).
- **Provider**: where OpenFeature gets values: the database provider (default), PostHog, or in-memory for tests.
- **Targeting key**: the user ID; the only field in a flag's evaluation context. Flags never target roles (DEC-038).
- **Permission vs feature flag**: a permission answers "may they?", a flag answers "is it switched on?". Flags never grant access.
