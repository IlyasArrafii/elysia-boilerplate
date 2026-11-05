# apps/api: Rules

Mandatory rules for people and AI agents writing code in `apps/api` (Elysia on Bun, modular monolith). Specs: [docs/specs/eng/](../../docs/specs/eng/README.md). Terms: [CONTEXT.md](../../CONTEXT.md). If a rule conflicts with the specs, stop and ask.

## 1. Structure

```
src/
  app.ts                root app: prefix '/api', global utils, .use(mountModule(module)), export type App; never listens
  index.ts              imports app.ts and listens on PORT
  env.ts                env read and validated once
  modules/<name>/       index.ts · service.ts · model.ts · permissions.ts
  utils/<name>/         shared code: auth, logger, telemetry, cache, error, redis, mongo
scripts/                operator commands (logs-setup, logs-prune)
tests/                  helpers · modules/<name> · utils/<name> · e2e/<name>
```

- **R1.** `/api` is written only in `src/app.ts`. A module writes only its own prefix. No `/v1`.
- **R2.** One module = one folder with exactly `index.ts`, `service.ts`, `model.ts`, `permissions.ts`. A file may be absent when empty, never renamed. No `routes.ts`, `controller.ts`, `schema.ts` or `lib/`.
- **R3.** Code used by more than one module lives in `utils/<name>/`. Code used by one module stays in it.

## 2. Controller (`index.ts`)

- **R4.** One named Elysia instance per module: `new Elysia({ name: '<module>', prefix: '/<module>' })`.
- **R5.** The first `.use()` of every controller is `moduleScope('<module>')`, with the module's folder name. `src/app.ts` mounts it with `.use(mountModule(<module>))`, which fails startup when the scope is missing or misnamed.
- **R6.** A controller declares routes and route options and passes plain values to the service. No Drizzle, Redis, MongoDB or business logic.
- **R7.** Never pass `Context` to a service.
- **R8.** Handlers are written inline in the chain (keeps Elysia and Eden type inference).
- **R9.** Non-200 success statuses are explicit: create → `201`, delete → `204`.

## 3. Service (`service.ts`)

- **R10.** `export abstract class <Name>Service` with `static` methods only.
- **R11.** A service knows nothing about HTTP (`Context`, `request`, `headers`, `set`).
- **R12.** Business errors are thrown with `moduleError('<module>', status, CODE, message)`. Never `throw new Error` for an expected case.
- **R13.** PostgreSQL only through Drizzle from `@repo/db`; cache only through `utils/cache`; events only through `utils/telemetry`.
- **R14.** Other modules may call only this module's service. Never import another module's `model.ts`, controller or tables.
- **R15.** No circular imports between modules.

## 4. Model (`model.ts`)

- **R16.** Every `body`, `query`, `params` and success response has a `t` schema.
- **R17.** One exported object (`PostModel`). Types derived with `typeof X.static`, never rewritten by hand.
- **R18.** Strings have `minLength`/`maxLength`; query numbers have `minimum`/`maximum`.

## 5. Auth and permissions

- **R19.** Protected routes use `permission: '<resource>:<action>'` or `auth: true`. Never call `auth.api.getSession` in a handler or service.
- **R20.** A route with neither option is public and must be listed as Public in [API.md](../../docs/specs/eng/API.md).
- **R21.** Every permission is declared in its module's `permissions.ts` with `defineModulePermissions`, and the module is listed in `utils/auth/access.ts`. Grants name only registry roles. Never grant to `super_admin`.
- **R22.** Ownership rules are checked in the service, after the permission passes.
- **R23.** Never create endpoints under `/api/auth/*`. Better Auth options only in `packages/auth/src/server.ts`; app auth wiring only in `src/utils/auth/`.
- **R24.** No impersonation. Never add `impersonate` actions to a statement, never spread `defaultStatements`, never set `adminUserIds`. An admin-plugin endpoint is reachable only if [API.md §3.1](../../docs/specs/eng/API.md) lists it.
- **R25.** Never use a feature flag to decide access, and never target a flag by role.

## 6. Responses and errors

- **R26.** Return the object directly. Lists are `{ items, meta: { page, limit, total, totalPages } }`.
- **R27.** Errors are `{ code, message, details? }` with the right status. `code` is `UPPER_SNAKE_CASE` and stable.
- **R28.** Don't catch errors to swallow them. Unexpected errors go to the global handler, which returns `500 INTERNAL_ERROR`. One exception: cache invalidation after a committed write catches its error and emits `cache.invalidation_failed` (warn), because a `500` after the commit invites a retry that writes twice.
- **R29.** Never return a stack trace, module name, database message or library `err.message` to the client.

## 7. Logging and telemetry

- **R30.** No `console.*`. Use `log` from the context, or `logger` outside a request.
- **R31.** Anything that must be findable later is an event: `telemetry.emit(...)` with an entry in `utils/telemetry/events.ts`. Plain `log.*` lines go to stdout only.
- **R32.** Never pass `module`, `requestId` or `userId` by hand; they come from the log context.
- **R33.** Never log or emit email, name, password, token, cookie, auth header, raw URL, query string or request/response body. Identity is `userId` ([redaction.md](../../docs/specs/eng/observability/redaction.md)).
- **R34.** `telemetry.emit` is never awaited on the request path.
- **R35.** Only `utils/telemetry/sinks/*` and `utils/mongo` import the MongoDB driver or a vendor SDK. Vendor SDKs only after a decision adopts them.
- **R36.** The API never deletes logs. Retention is the `logs:prune` script, run by an operator.

## 8. Cache

- **R37.** Cache only through `utils/cache`. Keys `<module>:<entity>:<part>`. One TTL constant or env value per module.
- **R38.** Every write that changes cached data invalidates its keys in the same service, with `SCAN`, never `KEYS`.
- **R39.** A cache hit returns exactly the cache-miss payload.
- **R40.** Never rely on the memory fallback in production; Redis is required there.

## 9. Config

- **R41.** Env is read and validated once in `src/env.ts`. Never read `process.env` elsewhere.
- **R42.** Secrets are never committed or logged.
- **R43.** No feature-flag packages until a decision adopts them ([feature-flags/README.md §9](../../docs/specs/eng/feature-flags/README.md)).
- **R44.** `src/app.ts` exports `type App` and `type Permission` (`@repo/api` resolves to it). Breaking them breaks the web app. `src/index.ts` only listens; tests and the web app never import it.

## 10. Tests

- **R45.** Tests live in `tests/`, never in `src/`. Folders mirror source names exactly: `tests/modules/<module>/`, `tests/utils/<util>/`, `tests/e2e/<module>/`.
- **R46.** Every module has `routes.test.ts`, `service.test.ts` and `permissions.test.ts` covering [TESTING.md §3.1](../../docs/specs/eng/TESTING.md).
- **R47.** Every route is tested for success, 400, 401, 403 and (with `:id`) 404, via `app.handle(new Request(...))`, never a listening server.
- **R48.** Every module's route tests assert that a failure is logged with `module: "<module>"`.
- **R49.** Every module with routes has API E2E flows in `tests/e2e/<module>/`, run by `bun run test:e2e` against the running stack. E2E never runs in `bun run test`.
- **R50.** Tests never call external vendors. Telemetry is asserted with the `memory` sink; redaction tests assert on captured output.

## 11. New module checklist

1. `src/modules/<name>/{index,service,model,permissions}.ts`; `moduleScope('<name>')` first in the controller.
2. Statement and grants in `permissions.ts`; module added to `utils/auth/access.ts`; matrix in [static-roles.md §5](../../docs/specs/eng/auth/access/static-roles.md) updated.
3. Schemas, service, controller (`permission` on every route); `.use(mountModule(<name>))` in `src/app.ts`.
4. New events in `events.ts` with safe payloads.
5. `tests/modules/<name>/` and `tests/e2e/<name>/`; compiled-roles snapshot updated.
6. [API.md](../../docs/specs/eng/API.md) updated, in `eng/` and `id/`.
