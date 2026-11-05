# apps/web: Rules

Mandatory rules for people and AI agents writing code in `apps/web` (TanStack Start, feature-based). Specs: [docs/specs/eng/](../../docs/specs/eng/README.md). Visual design: [DESIGN.md](../../docs/specs/eng/DESIGN.md). Terms: [CONTEXT.md](../../CONTEXT.md). If a rule conflicts with the specs, stop and ask.

## 1. Structure

```
src/
  routes/                 TanStack file-based routing (thin)
  features/<feature>/     components/ · hooks/ · lib/ · pages/ · index.ts
  components/             app-wide components: layout, shell, error boundary
  lib/                    api.ts (Eden) · auth-client.ts · query-client.ts
tests/                    helpers · features/<feature> · lib · components
e2e/<feature>/            E2E flows (YAML)
```

## 2. Route files

- **R1.** A route file contains only `createFileRoute(...)`, `beforeLoad`, `loader`, pending/error components and one page from `@/features/<feature>`. No other JSX, no `useQuery`, no logic.
- **R2.** Protection happens in `beforeLoad`: no session → `/login`; missing permission → `/` with a message. UX only; the API decides.
- **R3.** Never edit `routeTree.gen.ts` by hand.

## 3. Features

- **R4.** Other code imports a feature only from `@/features/<feature>` (its `index.ts`). Deep imports fail lint.
- **R5.** `index.ts` exports only what is used outside. No `export *`.
- **R6.** No circular imports between features. Shared things move to `src/components/`, `src/lib/` or `packages/`.
- **R7.** Generic UI primitives belong in `packages/ui` (shadcn), not in `apps/web`.

## 4. Data fetching

- **R8.** Every API module call goes through the Eden client in `src/lib/api.ts`. No hand-written `fetch('/api/...')`, no `axios`, no hand-written response types.
- **R9.** Every Eden call is wrapped in a TanStack Query hook in `features/<feature>/hooks/`. Components never call `api.*`.
- **R10.** Query keys come from a per-feature factory; `queryOptions` are shared by hooks and loaders.
- **R11.** Mutations invalidate affected keys in `onSuccess`.
- **R12.** Hooks turn every client's `{ data, error }` into the one thrown `ApiError` from `src/lib/api-error.ts` (`unwrap()` for Eden, `callAuthClient()` for Better Auth), carrying `status` and `code`. A 401 or 403 is handled once, app-wide, by `installAuthFailureReactions` from `@/features/auth`; features never re-read the session or permissions on an error themselves. Errors are shown with `ErrorAlert` from `src/components/error-alert.tsx`.
- **R13.** SSR calls the API through `API_INTERNAL_URL` and forwards the `Cookie` header. Browser code never contains an absolute API URL.

## 5. Auth and permissions

- **R14.** Auth only through the Better Auth client in `src/lib/auth-client.ts`. Never call `/api/auth/*` with Eden or `fetch`.
- **R15.** Never store tokens, sessions or user data in `localStorage`/`sessionStorage`.
- **R16.** Auth messages are mapped from Better Auth's `error.code` in `features/auth/lib/errors.ts`. A failed sign-in always shows the same generic message.
- **R17.** Permission checks use `can(permission)` from `@/features/auth`. Never compare role names in code.
- **R18.** Hiding UI is UX only, never the security boundary.
- **R19.** Clear the TanStack Query cache on sign-in, sign-out and after the current user's role changes.
- **R20.** No impersonation UI or code of any kind.

## 6. Forms

- **R21.** Every form uses TanStack Form with validation in `features/<feature>/lib/`.
- **R22.** Client limits match the API's `model.ts`. A `400 VALIDATION_ERROR` is shown on the field in `details.fields[].path`, otherwise at form level.
- **R23.** Submit is disabled while submitting; a double submit sends one request.

## 7. UI

- **R24.** Tailwind v4 with tokens from `packages/ui`. No loose hex colours.
- **R25.** Every data page has loading, empty, error and forbidden states.
- **R26.** State is never shown by colour alone; everything works with the keyboard and has accessible labels.
- **R27.** No invented content. Example data comes only from the seed.

## 8. Other

- **R28.** Only public-prefixed env variables reach the browser, and they never hold secrets.
- **R29.** No Sentry, PostHog or other telemetry SDK in the web app without a decision.
- **R30.** Once feature flags are adopted, they are read only from `GET /api/feature-flags/evaluate` through a hook. No flag SDK in the browser.
- **R31.** No `console.log` in committed code.

## 9. Tests

- **R32.** Tests live in `tests/`, never in `src/`. Folders mirror source names exactly: `tests/features/<feature>/`, `tests/lib/`, `tests/components/`.
- **R33.** Every feature has tests for its hooks, `lib/` helpers, forms and pages covering [TESTING.md §4.1](../../docs/specs/eng/TESTING.md). The API client is mocked at `@/lib/api`; tests never call a real API.
- **R34.** Components are tested by role, label and text, never by class name.
- **R35.** Every feature with pages has E2E flows in `e2e/<feature>/`, one journey per YAML file, run by the workspace E2E system. No Playwright, Cypress, Puppeteer or Selenium.
- **R36.** A flow's `name` starts with the feature name and its `tags` include it. Selectors use unique visible text or accessible labels. Credentials come from E2E environment values, never the YAML.
- **R37.** Every flow is validated by the E2E runner before it is committed.

## 10. New feature checklist

1. `src/features/<name>/{components,hooks,lib,pages}/` and `index.ts`.
2. Query key factory, `queryOptions` and hooks.
3. Pages with loading, empty, error and forbidden states.
4. Gate with `can()`; add rows to [static-roles.md §6](../../docs/specs/eng/auth/access/static-roles.md).
5. Thin route file in `src/routes/`.
6. `tests/features/<name>/` and `e2e/<name>/`.
