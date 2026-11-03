# PRD

Product requirements, rebuilt from the agreed specs (DEC-031). Where this document summarises a topic, the linked spec has the detail; the decisions behind each line are in [DECISIONS.md](DECISIONS.md).

## 1. Summary

This boilerplate is a production-grade Bun monorepo boilerplate for full-stack apps: an Elysia modular-monolith API, a TanStack Start web app, Better Auth (email/password + Google), role-based access control, Redis caching, Drizzle on PostgreSQL, structured logging to MongoDB, and Tailwind CSS v4 with shadcn/ui.

**Goal:** cut project bootstrap from days to minutes, with an architecture, security baseline and development rules that are already decided and documented.

## 2. Problem

Full-stack developers spend days wiring auth, roles and permissions, caching, an ORM, logging and a monorepo layout from scratch. Existing boilerplates are fragmented, don't use Bun, or don't follow Elysia's official module pattern. Each project then reinvents the same rules for structure, errors, logging and tests.

## 3. Users

| Persona | Need |
|:---|:---|
| Backend / full-stack developer | Start a Bun project quickly without designing auth, RBAC and logging again |
| Startup or indie hacker | Production-ready auth, roles, caching and a database on day one |
| Engineering team | An internal monorepo standard with written rules for modules, features and tests |

## 4. Roles in the shipped app

Roles are defined in code; projects add custom roles ([auth/access/static-roles.md](auth/access/static-roles.md)).

| Role | Who | Can do |
|:---|:---|:---|
| `super_admin` | Owner of the deployment | Everything: change roles, ban, delete users, revoke sessions |
| `admin` | Trusted operator | Manage all posts; list and view users and their sessions; view the role catalogue |
| `user` | Anyone who signs up (default) | Read posts; create, edit and delete their own posts; edit their profile |
| Guest | No session | Public endpoints only (`/api/health`, sign-up, sign-in) |

## 5. Scope

### In scope (MVP)

| ID | Feature | Spec |
|:---|:---|:---|
| F-01 | Email/password sign-up, sign-in, sign-out | [FEATURES.md §2](FEATURES.md) |
| F-02 | Google sign-in with account linking | [FEATURES.md §3](FEATURES.md) |
| F-03 | User and role management (admin plugin) and the role catalogue | [FEATURES.md §4](FEATURES.md) |
| F-04 | Example `posts` module: RBAC, ownership, validation, Redis cache | [FEATURES.md §5](FEATURES.md) |
| F-05 | Session in the web app, profile page | [FEATURES.md §6](FEATURES.md) |
| F-06 | Observability: JSON logs to stdout and MongoDB, module-tagged errors, audit events, redaction, manual retention | [FEATURES.md §7](FEATURES.md) |
| F-07 | Test structure and baseline tests per module and per feature, including E2E | [TESTING.md](TESTING.md) |

### Out of scope (MVP)

- Multi-tenancy (organisations) in the default build: designed as the foundation of the opt-in SaaS layer, on top of access stage 2 ([saas/](../../specs/eng/saas/README.md), DEC-047, DEC-050). Billing and payments: designed in the same SaaS layer.
- Microservices or event-driven architecture.
- Databases other than PostgreSQL for app data; web frameworks other than TanStack Start.
- Full email templates for verification and password reset (links go to the dev log).
- Roles editable at runtime from a UI in the default build (roles are code). Available at access stage 2 ([auth/access/migration.md](auth/access/migration.md)).
- Impersonation. It is not part of this boilerplate; the admin plugin's endpoints for it are blocked (DEC-032).
- Feature flags in code (designed in [feature-flags/](feature-flags/README.md)).
- Sentry and PostHog (designed in [observability/sentry.md](observability/sentry.md) and [observability/posthog.md](observability/posthog.md)).
- Grafana Alloy + Loki or the ELK Stack (migrations designed in [observability/migration-loki.md](observability/migration-loki.md) and [observability/migration-elk.md](observability/migration-elk.md); one is picked when a trigger fires).
- Frontend telemetry, distributed tracing, metrics SDK, log viewer UI.

## 6. Functional requirements

| ID | Requirement |
|:---|:---|
| FR-01 | Bun monorepo with `apps/*` and `packages/*` workspaces; `bun run dev` starts API and web in parallel. |
| FR-02 | The API is a modular monolith: each module is a named Elysia plugin with its own route prefix, composed in `apps/api/src/app.ts` under `/api` (no version segment); `apps/api/src/index.ts` only listens (TASK-12). |
| FR-03 | Modules talk to each other only through exported services; no shared mutable state. |
| FR-04 | Central Redis cache with `get`, `set`, `del`, `wrap`, `delPattern` and per-module TTL; Redis is mandatory in production; in-memory fallback in dev/test only. |
| FR-05 | Better Auth on the server: email/password, Google OAuth, admin plugin with access control. |
| FR-06 | The web app uses the Better Auth client: session state, login, register, OAuth return, logout. |
| FR-07 | TanStack Form for auth forms and the profile form, with runtime validation matching the API. |
| FR-08 | Drizzle ORM on PostgreSQL; migrations with Drizzle Kit; a dev seed creates one `super_admin`. |
| FR-09 | RBAC through Better Auth access control: every module declares its permissions; a route-level check runs before the handler; default deny. |
| FR-10 | Super Admins manage users and roles through the admin plugin's endpoints; holders of `role:read` view the role catalogue. |
| FR-11 | An example `posts` module shows the full pattern: permissions, ownership rule, validation, cache, Drizzle. |
| FR-12 | Tailwind CSS v4 + shadcn/ui base with auth-ready components. |
| FR-13 | Observability: one `http.request` event per request; `http.error` events tagged with the **module** that failed; audit events for security actions; `x-request-id` on every log line and response; sensitive data redacted; events stored in MongoDB; old events deleted by a manual prune command. |
| FR-14 | Tests live in one folder per API module and one folder per web feature, for unit, integration and E2E levels ([TESTING.md](TESTING.md)). |

## 7. Non-functional requirements

| Category | Target |
|:---|:---|
| Performance | API cold start < 200 ms; p95 < 50 ms on cache-hit endpoints, measured from `http.request` events |
| Scalability | Stateless API instances; shared Redis for cache, sessions and rate limits; pooled PostgreSQL connections |
| Security | `httpOnly` session cookies; OAuth with PKCE and state; CSRF and origin checks on; rate limits on auth endpoints; RBAC default deny; no impersonation; no secrets or personal data in logs |
| Reliability | Graceful shutdown (flushes the log buffer); health endpoint; idempotent migrations; logging never blocks or fails a request |
| Observability | JSON on stdout always; MongoDB log store in production; retention by kind, deleted manually ([observability/log-storage.md](observability/log-storage.md)) |
| Portability | `bun install && bun run dev` locally; docker compose for PostgreSQL, Redis and MongoDB |
| Maintainability | Written rules per app ([apps/api/README.md](../../../apps/api/README.md), [apps/web/README.md](../../../apps/web/README.md)); tests mirror module and feature folders |

## 8. Technology stack

| Component | Technology |
|:---|:---|
| Runtime | Bun 1.1+ |
| API | ElysiaJS 1.2+ |
| Web | TanStack Start 1.0+ (TanStack Router, Query, Form) |
| App database | PostgreSQL 17 + Drizzle ORM + Drizzle Kit |
| Auth | Better Auth 1.x (admin and access-control plugins) |
| Cache, sessions, rate limits | Redis 7 + ioredis |
| Logging | pino (stdout) + MongoDB 8 log store via the official `mongodb` driver |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Tests | `bun test` (API and web), workspace E2E flows (web) |

*Verify* exact versions when the monorepo is bootstrapped (TASK-01) and pin them in the lockfile.

## 9. Success metrics

| Metric | Target |
|:---|:---|
| Time from clone to running dev server | `TBD` (baseline measured after MVP) |
| Ready-made example modules | 2 (`auth` via Better Auth, `posts`) |
| Email/password and Google sign-in success | 100% with valid configuration |
| Permission-matrix test coverage | Every protected route × every role |
| Cache hit ratio on the example endpoint | `TBD` |
| Time to add a new module with RBAC and tests | `TBD` minutes |

## 10. Release plan

| Phase | Content | Tasks |
|:---|:---|:---|
| P0 | Monorepo, dev infrastructure | TASK-01, TASK-02 |
| P1 | Schema, logging, MongoDB sink and prune command, cache, shutdown, test harness | TASK-03, TASK-07, TASK-12, TASK-13, TASK-15, TASK-18 |
| P2 | Auth and RBAC | TASK-04, TASK-05 |
| P3 | API modules | TASK-06, TASK-08 |
| P4 | Web | TASK-14, TASK-09, TASK-10, TASK-16, TASK-17 |
| P5 | Operations: CI, E2E suites | TASK-11, TASK-19 |

Details in [TASKS.md](TASKS.md).

## 11. Risks

| Risk | Impact | Mitigation |
|:---|:---|:---|
| Better Auth admin plugin integration is complex | High | One place for auth config; documented RBAC; permission-matrix tests |
| RBAC misconfiguration grants access | High | Default deny; matrix tests per role; compiled-roles snapshot; audit events |
| Admin plugin endpoints we don't use stay reachable | High | Blocked by `hooks.before`; their permissions are not in the statement; `adminUserIds` never set (DEC-032) |
| Sensitive data leaks into logs or vendors | High | Four-layer redaction with tests ([observability/redaction.md](observability/redaction.md)) |
| MongoDB log volume grows without bound | Medium | Retention by kind; manual prune command with dry-run; documented migration to Loki or ELK |
| Log store outage affects the API | Medium | Asynchronous batched sink with a bounded buffer; stdout always has every event |
| TanStack Start version churn | Medium | Pin versions; CI; committed lockfile |
| Modular monolith becomes over-engineered | Medium | Elysia's official pattern; two example modules; written rules |

## 12. Constraints and assumptions

- Bun only; no Node.js fallback.
- PostgreSQL 17, Redis 7 and MongoDB 8 via docker compose in dev.
- Better Auth is the only source of truth for authentication, roles and permissions.
- Users know Bun, React and monorepos, and supply their own Google OAuth, database, Redis and MongoDB credentials.
