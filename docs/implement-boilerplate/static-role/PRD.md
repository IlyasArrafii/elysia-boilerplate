# PRD

What the boilerplate contains and why. Where this document summarises a topic, the linked document has the detail; the decisions behind each line are in [DECISIONS.md](DECISIONS.md). A project built on the boilerplate writes its own PRD ([NEW-PROJECT.md §2](NEW-PROJECT.md#2-put-your-prd-in-the-repo)).

## 1. Summary

A production-grade Bun monorepo starter kit for full-stack apps: an Elysia modular-monolith API, a TanStack Start web app, Better Auth (email/password + Google), roles and permissions defined in code, Redis caching, Drizzle on PostgreSQL, structured logging to MongoDB, and Tailwind CSS v4 with shadcn-style primitives.

**Goal:** cut project bootstrap from days to minutes, with an architecture, security baseline and development rules that are already decided and documented, so a team starts from its own PRD instead of from infrastructure.

## 2. Problem

Full-stack developers spend days wiring auth, roles and permissions, caching, an ORM, logging and a monorepo layout from scratch. Existing boilerplates are fragmented, don't use Bun, or don't follow Elysia's official module pattern. Each project then reinvents the same rules for structure, errors, logging and tests.

## 3. Users

| Persona | Need |
|:---|:---|
| Backend / full-stack developer | Start a Bun project quickly without designing auth, RBAC and logging again |
| Startup or indie hacker | Production-ready auth, roles, caching and a database on day one |
| Engineering team | An internal monorepo standard with written rules for modules, features and tests |

## 4. Roles in the shipped app

Roles are defined in code; projects add their own ([auth/static-roles.md](auth/static-roles.md)).

| Role | Who | Can do |
|:---|:---|:---|
| `super_admin` | Owner of the deployment | Everything: change roles, ban, delete users, revoke sessions |
| `admin` | Trusted operator | Manage all posts; list and view users and their sessions; view the role catalogue |
| `user` | Anyone who signs up (default) | Read posts; create, edit and delete their own posts; edit their profile |
| Guest | No session | Public endpoints only (`/api/health`, sign-up, sign-in) |

## 5. Scope

### Built in

| ID | Feature | Spec |
|:---|:---|:---|
| F-01 | Email/password sign-up, sign-in, sign-out | [FEATURES.md §2](FEATURES.md#2-f-01-emailpassword) |
| F-02 | Google sign-in with account linking | [FEATURES.md §3](FEATURES.md#3-f-02-google) |
| F-03 | User and role management (admin plugin) and the role catalogue | [FEATURES.md §4](FEATURES.md#4-f-03-user-and-role-management) |
| F-04 | Example `posts` module: RBAC, ownership, validation, Redis cache | [FEATURES.md §5](FEATURES.md#5-f-04-posts) |
| F-05 | Session in the web app, profile page, own-access page | [FEATURES.md §6](FEATURES.md#6-f-05-session-in-the-web-app-profile-and-access) |
| F-06 | Observability: JSON logs to stdout and MongoDB, module-tagged errors, audit events, redaction, manual retention | [FEATURES.md §7](FEATURES.md#7-f-06-observability) |
| F-07 | Test structure and baseline tests per module and per feature, including E2E | [FEATURES.md §8](FEATURES.md#8-f-07-test-structure), [TESTING.md](TESTING.md) |
| F-08 | Health endpoint and API status page | [FEATURES.md §9](FEATURES.md#9-f-08-health-and-api-status) |

### Out of scope

- Roles created or edited at runtime: roles are code, so changing what a role can do needs a deploy (DEC-022).
- Billing and payments.
- Microservices or event-driven architecture.
- Databases other than PostgreSQL for app data; web frameworks other than TanStack Start.
- An email sender. Verification and password-reset links go to the development log only.
- Impersonation. The admin plugin's endpoints for it are blocked (DEC-032).
- Feature flags in code (designed in [feature-flags/](feature-flags/README.md)).
- Sentry and PostHog (designed in [observability/sentry.md](observability/sentry.md) and [observability/posthog.md](observability/posthog.md)).
- Grafana Alloy + Loki or the ELK Stack (migrations designed in [observability/migration-loki.md](observability/migration-loki.md) and [observability/migration-elk.md](observability/migration-elk.md); one is picked when a trigger fires).
- Frontend telemetry, distributed tracing, metrics SDK, log viewer UI.

## 6. Functional requirements

| ID | Requirement |
|:---|:---|
| FR-01 | Bun monorepo with `apps/*` and `packages/*` workspaces; `bun run dev` starts API and web in parallel. |
| FR-02 | The API is a modular monolith: each module is a named Elysia plugin with its own route prefix, composed in `apps/api/src/app.ts` under `/api` (no version segment); `apps/api/src/index.ts` only listens. |
| FR-03 | Modules talk to each other only through exported services; no shared mutable state. |
| FR-04 | Central cache with `get`, `set`, `del`, `wrap`, `delPattern` and a per-module TTL, on Redis; Redis is mandatory in production; in-memory fallback in dev/test only. |
| FR-05 | Better Auth on the server: email/password, Google OAuth, admin plugin with access control. |
| FR-06 | The web app uses the Better Auth client: session state, login, register, OAuth return, logout. |
| FR-07 | TanStack Form for the auth forms and the profile form, with validation matching the API. The post form validates against the same rules with plain React state. |
| FR-08 | Drizzle ORM on PostgreSQL; migrations with Drizzle Kit; a dev seed creates one `super_admin` and example posts. |
| FR-09 | RBAC through Better Auth access control: every module declares its permissions; a route-level check runs before the handler; a route with neither a permission nor `auth: true` fails startup unless it is listed as Public (default deny). |
| FR-10 | Super Admins manage users and roles through the admin plugin's endpoints; holders of `role:read` view the role catalogue. |
| FR-11 | An example `posts` module shows the full pattern: permissions, ownership rule, validation, cache, Drizzle. |
| FR-12 | Tailwind CSS v4 with design tokens and shadcn-style primitives in `packages/ui`. |
| FR-13 | Observability: one `http.request` event per request; `http.error` events tagged with the **module** that failed; audit events for security actions; `x-request-id` on every log line and response; sensitive data redacted; events stored in MongoDB; old events deleted by a manual prune command. |
| FR-14 | Tests live in one folder per API module and one folder per web feature, for unit, integration and E2E levels; `bun run check:test-folders` enforces it ([TESTING.md](TESTING.md)). |

## 7. Non-functional requirements

| Category | Target |
|:---|:---|
| Performance | API cold start < 200 ms; p95 < 50 ms on cache-hit endpoints, measured from `http.request` events |
| Scalability | Stateless API instances; shared Redis for cache and rate limits; pooled PostgreSQL connections |
| Security | `httpOnly` session cookies; OAuth with PKCE and state; CSRF and origin checks on; rate limits on auth endpoints; RBAC default deny; no impersonation; no secrets or personal data in logs |
| Reliability | Graceful shutdown (flushes the log buffer); health endpoint; idempotent migrations; logging never blocks or fails a request |
| Observability | JSON on stdout always; MongoDB log store in production; retention by kind, deleted manually ([observability/log-storage.md](observability/log-storage.md)) |
| Portability | `bun install` and `bun run dev` locally; Docker Compose for PostgreSQL, Redis and MongoDB |
| Maintainability | Written rules per app ([apps/api/README.md](../../../apps/api/README.md), [apps/web/README.md](../../../apps/web/README.md)); tests mirror module and feature folders |

## 8. Technology stack

Versions are pinned exactly in the `package.json` files and `bun.lock`; these are the ones installed today.

| Component | Technology |
|:---|:---|
| Runtime | Bun 1.4.4 (Vite's CLI runs on Node.js `^20.19.0 \|\| >=22.12.0`) |
| API | Elysia 1.4.30 |
| Web | TanStack Start 1.169.4 (TanStack Router 1.170.46, Query 5.104.5, Form 1.33.5), React 19.3.1, Vite 8.3.5 |
| App database | PostgreSQL 17 + Drizzle ORM 0.45.4 + Drizzle Kit 0.31.11, driver `postgres` 3.4.9 |
| Auth | Better Auth 1.7.15 (admin plugin with access control) |
| Cache, rate limits | Redis 8.10 through Bun's built-in Redis client |
| Logging | pino 10.4.0 (stdout) + MongoDB 8 log store via the official `mongodb` driver 7.8.0 |
| Styling | Tailwind CSS 4.3.3, design tokens and shadcn-style primitives in `packages/ui` |
| Lint, types | oxlint 1.89.0 (web), TypeScript 7.0.2 |
| Tests | `bun test` (API and web, happy-dom for the web), workspace E2E flows (web) |

## 9. Success metrics

| Metric | Target |
|:---|:---|
| Time from clone to running dev server | `TBD` (baseline measured: [§9.1](#91-bootstrap-baseline)) |
| Ready-made example modules | 2 (`auth` via Better Auth, `posts`) |
| Email/password and Google sign-in success | 100% with valid configuration |
| Permission-matrix test coverage | Every permission × every role |
| Cache hit ratio on the example endpoint | `TBD` |
| Time to add a new module with RBAC and tests | `TBD` minutes |

### 9.1 Bootstrap baseline

A measurement, not a target: the target above stays `TBD` until the product owner sets it. **On the measured machine, a fresh clone reached two answering dev servers in about 51 s with a cold package cache and 22 to 25 s with a warm one.**

**What the clock covers.** From the start of `git clone` until both dev servers answer. It is machine time only. It leaves out what a person does between the commands: reading the README, choosing the secret, the seed password and the post limits (product numbers that are still `TBD`; the runs used the test values 120 and 2000) and opening terminals. That human time is **not measured**.

| Stage | Boundary | Command |
|:---|:---|:---|
| 1 clone | `git clone` returns (a local path: no network) | `git clone --no-hardlinks <repo> <empty folder>` |
| 2 install | `bun install` returns | `bun install --frozen-lockfile` |
| 3 env | `.env` written | A copy of `.env.example` with `BETTER_AUTH_SECRET`, `SEED_SUPER_ADMIN_PASSWORD`, `POSTS_TITLE_MAX_LENGTH`, `POSTS_CONTENT_MAX_LENGTH` and the spare ports set |
| 4 infra | The command returns, all three services healthy | `docker compose -p <own project> -f docker-compose.dev.yml up -d --wait`: new named volumes, images already present |
| 5 data | The last command returns | `bun run db:migrate`, `bun run db:seed`, then `bun run logs:setup` in `apps/api` |
| 6 dev servers | `GET /api/health` is 200, and `GET /` of the web app is 200 and shows "API status" | `bun run dev` in `apps/api` and in `apps/web`, started together |

**Result, in seconds** (one cold run, two warm runs):

| Stage | Cold package cache | Warm package cache |
|:---|---:|---:|
| 1 clone | 1.5 | 1.4, 1.5 |
| 2 install | 35.8 | 6.7, 6.0 |
| 3 env | 0.0 | 0.0, 0.0 |
| 4 infra | 7.7 | 7.7, 7.6 |
| 5 data | 2.0 | 1.9, 1.9 |
| 6 dev servers | 4.1 | 7.8, 5.1 |
| **Total** | **51.2** | **25.4, 22.1** |

"Cold" started `bun install` with `BUN_INSTALL_CACHE_DIR` pointing at an empty folder (391 entries in it afterwards), so every package came from the registry. "Warm" used the default cache, already filled by earlier installs of the same lockfile. A warm install is not a clean-clone number; it is listed to show how much of the cold total is download time. The two warm totals differ by 3 s, so differences of that size are noise.

**Environment.** One Windows 11 Home machine (10.0.26200; AMD Ryzen AI 7 350, 8 cores and 16 threads; 31 GB RAM; SSD; Windows Defender real-time protection on), Bun 1.4.4, Node 24.14.0, Docker client 25.0.5 and Compose 2.23.3 talking to Sokudo's engine (a Linux VM under WSL2), with the images `postgres:17`, `redis:7-alpine` and `mongo:8` already pulled. The machine was not idle: a developer's own API and web dev servers and the managed development stack were running. The measured commit was `bfc6df5`; the changes made alongside the measurement (tests, a check script, CI and docs) are not run by any of these stages.

**Differences from the README steps.** Ports 3000 and 3001 were held by a developer's running servers, and the managed development stack was shared and already running. So the API ran on `3010` and the web server on `3101` (its `--port` flag), and the same `docker-compose.dev.yml` was started with `docker compose -p` in its own project, on spare host ports, instead of through the Compose panel. None of this changes the work a stage does.

**Checked after the clock stopped, in all three runs:** `/api/health` returned `status: "ok"` with `db`, `redis` and `logStore` `up` and a numeric `uptime`; `/api/health` through the web proxy returned 200; and the seeded account signed in.

**Not measured, so unknown:**
- the clone over a network;
- the first pull of the three images, and installing Docker or Bun;
- the human steps above;
- any other operating system, and the production build (`vite build` is not part of this baseline);
- the spread over more than three runs: the cold install depends on the network at the time.

**To repeat it**, do the six stages in an empty folder with a clock at each boundary. For a cold install, point `BUN_INSTALL_CACHE_DIR` at an empty folder first.

## 10. Risks

| Risk | Impact | Mitigation |
|:---|:---|:---|
| Better Auth admin plugin integration is complex | High | One place for auth config; documented RBAC; permission-matrix tests |
| RBAC misconfiguration grants access | High | Default deny; matrix tests per role; compiled-roles snapshot; audit events |
| Admin plugin endpoints we don't use stay reachable | High | An allowlist in `hooks.before` blocks every unlisted admin-plugin path; impersonation permissions are not in the statement; `adminUserIds` never set (DEC-032) |
| Sensitive data leaks into logs or vendors | High | Four-layer redaction with tests ([observability/redaction.md](observability/redaction.md)) |
| MongoDB log volume grows without bound | Medium | Retention by kind; manual prune command with dry-run; documented migration to Loki or ELK |
| Log store outage affects the API | Medium | Asynchronous batched sink with a bounded buffer; stdout always has every event |
| TanStack Start version churn | Medium | Exact versions; CI; committed lockfile |
| Modular monolith becomes over-engineered | Medium | Elysia's official pattern; two example modules; written rules |

## 11. Constraints and assumptions

- The API runs on Bun only; no Node.js fallback. Only Vite's CLI uses Node.js.
- PostgreSQL 17, Redis 8.10 and MongoDB 8 via Docker Compose in development.
- Better Auth is the only source of truth for authentication, roles and permissions.
- Users know Bun, React and monorepos, and supply their own Google OAuth, database, Redis and MongoDB credentials.
