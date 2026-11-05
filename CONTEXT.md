# CONTEXT.md

Glossary of agreed terms. Build documentation: [docs/implement-boilerplate/static-role/](docs/implement-boilerplate/static-role/README.md), with its [DECISIONS.md](docs/implement-boilerplate/static-role/DECISIONS.md); starting a project: [NEW-PROJECT.md](docs/implement-boilerplate/static-role/NEW-PROJECT.md). Coding rules: [apps/api/README.md](apps/api/README.md), [apps/web/README.md](apps/web/README.md). `docs/specs/` is the design baseline (reference only); `docs/prd/` is history only.

## API (`apps/api`)

- **Root app**: the Elysia instance in `apps/api/src/app.ts` with `prefix: '/api'`. The only place `/api` is written (DEC-006). `apps/api/src/index.ts` only listens.
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

- **Static roles**: the boilerplate's access model. Roles and permissions are defined in code and enforced by Better Auth's admin plugin with access control (DEC-005, DEC-042). Details: [auth/static-roles.md](docs/implement-boilerplate/static-role/auth/static-roles.md).
- **Role**: a named set of permissions, stored as a string on `user.role` and defined in code in the role registry (`apps/api/src/utils/auth/roles.ts`); no role table (DEC-022). Defaults `super_admin`, `admin`, `user`; projects add custom roles. `super_admin` is derived: it holds every permission.
- **Resource / Action / Statement**: what can be acted on, what can be done to it, and a module's map of the two.
- **Permission**: one `resource:action` string, e.g. `posts:write`. The contract between API routes and web UI.
- **Grant**: the permissions one module gives one role.
- **Ownership rule**: a record-level check in the service after the permission passes.
- **Public route**: a route with neither `permission` nor `auth: true`, listed in `PUBLIC_ROUTES` (`apps/api/src/utils/auth/macros.ts`) and marked Public in API.md. Any other unprotected route fails startup (DEC-010).
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
