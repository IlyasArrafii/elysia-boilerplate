# Architecture Decisions

Every significant decision is recorded here. Decisions are never changed silently: a revision is a new entry that names the entry it replaces.

**Status values**
- **Answered**: approved by the product owner.
- **Decided (lead)**: decided by the tech lead inside constraints the product owner already approved. The product owner can veto it; until then it is binding.
- **Proposed**: a recommendation waiting for an answer. Do not implement.
- **Superseded**: replaced by a later entry. Kept only as a pointer.

---

## DEC-001: Caching strategy

**Status:** Answered. Clarified by DEC-034 (production).

- **Decision:** Redis is the central cache, so API instances can scale horizontally. In dev/test without Redis, an in-memory fallback is used. In production Redis is mandatory ([ARCHITECTURE.md §6](ARCHITECTURE.md)).

## DEC-002: Module boundaries

**Status:** Answered

- **Decision:** Follow Elysia's official "basic" modular-monolith pattern. Modules talk only through exported services.

## DEC-003: Module shape

**Status:** Answered

- **Decision:** One Elysia plugin per module, each with its own route prefix, composed in the root app.

## DEC-004: Auth feature scope

**Status:** Answered

- **Decision:** Email/password and Google OAuth, plus role management with roles and permissions per module.

## DEC-005: Role and permission model

**Status:** Answered

- **Decision:** Better Auth's admin plugin with access control is the single source of truth for roles and permissions.

## DEC-006: API route prefix

**Status:** Answered (Q1)

- **Decision:** All routes live under `/api` with no version segment. The prefix is written once in the root app (`new Elysia({ prefix: '/api' })`). Modules declare only their own prefix (`/posts`, `/admin`).
- **Trade-off:** A future breaking change needs an `/api/v2` group next to the existing routes.

## DEC-007: Auth endpoints

**Status:** Answered (Q2)

- **Decision:** Better Auth's handler is mounted as-is at `/api/auth/*` with email/password and Google OAuth. No custom `/api/auth/register` or `/api/auth/login` wrappers. Configuration follows the `better-auth-best-practices` and `better-auth-security-best-practices` skills ([auth/README.md](auth/README.md)).
- **Trade-off:** Responses and error codes on `/api/auth/*` use Better Auth's format, not ours.

## DEC-008: Backend module files

**Status:** Answered (Q3)

- **Decision:** `apps/api/src/modules/<name>/{index,service,model,permissions}.ts`. `index.ts` is the controller, `model.ts` holds `t` schemas, `permissions.ts` holds the module's permission statement and role grants (DEC-023).

## DEC-009: Service style

**Status:** Answered (Q4)

- **Decision:** `abstract class <Name>Service` with `static` methods only. Services throw business errors with `moduleError(...)` (DEC-037). Other modules call only this service.

## DEC-010: Permission guard

**Status:** Answered (Q5)

- **Decision:** An Elysia macro on a named plugin in `apps/api/src/utils/auth/index.ts`. Routes declare `{ permission: 'posts:read' }` or `{ auth: true }`; the macro resolves `user` and `session` into the context. Default deny.

## DEC-011: Frontend structure

**Status:** Answered (Q6)

- **Decision:** `apps/web/src/features/<feature>/{components,hooks,lib,pages,index.ts}`. Route files in `src/routes/` stay thin. App-wide components in `src/components/`, shadcn primitives in `packages/ui`.

## DEC-012: Feature flags are design only

**Status:** Answered. Extended by DEC-029 and DEC-038.

- **Decision:** Feature flags use the OpenFeature standard, designed in [feature-flags/README.md](feature-flags/README.md). No OpenFeature package is installed in the MVP.

## DEC-013: Logging with pino, no OpenTelemetry

**Status:** Answered (Q7)

- **Decision:** pino, no OpenTelemetry. JSON to stdout; `pino-pretty` only in dev. Correlation uses a request ID (`x-request-id`), not a trace ID.
- **Trade-off:** No distributed tracing and no automatic Postgres/Redis spans. Can be added later as a new sink without touching callers (DEC-014).

## DEC-014: Manual telemetry events with pluggable sinks

**Status:** Answered (Q7/Q8)

- **Decision:** Application code calls only `telemetry.emit(event, payload)` against a typed event catalogue. Sinks decide where events go ([observability/README.md](observability/README.md)).
- **Trade-off:** One small layer to maintain. In return, adding or swapping a destination is one new sink file and callers do not change.

## DEC-015: Where observability data is viewed

**Status:** Answered (Q8). Updated by DEC-034.

- **Decision:** In dev, logs are read in the terminal (pretty-printed). In production, telemetry events are stored in MongoDB (DEC-034) and queried there. No metrics SDK: latency and error rate come from `http.request` events. Frontend telemetry is out of scope.

## DEC-016: Audit log

**Status:** Answered (Q9)

- **Decision:** Better Auth `databaseHooks` and `hooks.after` emit `audit.*` telemetry events. They are stored with every other event in the MongoDB log store (kind `audit`, 365-day retention). No audit table in PostgreSQL.

## DEC-017: Response format for our modules

**Status:** Answered (Q10)

- **Decision:** No `{ success, data }` wrapper. Handlers return the object directly. Errors are an HTTP status plus `{ code, message, details? }` through one global error handler. Lists are `{ items, meta }`.

## DEC-018: Frontend data fetching and feature boundaries

**Status:** Answered (Q11)

- **Decision:** One Eden client in `apps/web/src/lib/api.ts`. TanStack Query hooks in `features/*/hooks`. Features import each other only through `index.ts`, enforced by a lint rule. `profile` has no backend module: it calls Better Auth `updateUser`.

## DEC-019: Session and rate-limit storage

**Status:** Answered (Q12)

- **Decision:** Redis is Better Auth's `secondaryStorage`; `session.storeSessionInDatabase: true` so admins can list and revoke sessions. Rate limits in Redis (`storage: "secondary-storage"`). Without `REDIS_URL` (dev/test only): no secondary storage, rate limits in memory.

## DEC-020: Same origin and Better Auth security baseline

**Status:** Answered (Q13)

- **Decision:** Web and API share **one origin**. `/api/*` is forwarded to the API by the dev proxy locally and a reverse proxy in production. `baseURL` is the public web origin, `trustedOrigins` is `[WEB_URL]` only, `crossSubDomainCookies` off, CSRF on ([auth/README.md](auth/README.md)).
- **Trade-off:** Production needs a reverse proxy. In return: no CORS, plain cookies, far fewer cookie/CSRF misconfigurations.

## DEC-021: Documentation layout

**Status:** Superseded by DEC-030, then DEC-031.

## DEC-022: Roles are defined in code; no role table

**Status:** Answered (Q14)

- **Decision:** No `role` table. Roles live in a typed role registry in code. Projects add custom roles by adding a registry entry and granting permissions in the module files that need them. A user may hold several roles (comma-separated by Better Auth). Design in [auth/access/static-roles.md](auth/access/static-roles.md).
- **Trade-off:** Changing what a role can do needs a deploy.

## DEC-023: Where permissions are declared and how they are assembled

**Status:** Decided (lead)

- **Decision:** Each module's `permissions.ts` exports a `statement` and per-role `grants`. `apps/api/src/utils/auth/access.ts` merges them. `packages/auth` exports `createAuth({...})`; `apps/api/src/utils/auth/auth.ts` calls it and is the file the Better Auth CLI reads. `super_admin` is derived (every action of every statement). The web app gets the current user's permissions from `GET /api/me/permissions`.
- **Trade-off:** The Better Auth CLI needs `--config apps/api/src/utils/auth/auth.ts`.

## DEC-024: User management uses the admin plugin's endpoints

**Status:** Answered (Q15)

- **Decision:** The web app calls `authClient.admin.*` at `/api/auth/admin/*`. "A user cannot change their own role" is a `hooks.before` rule. Our `admin` module only adds `GET /api/admin/roles`.

## DEC-025: Impersonation designed but switched off

**Status:** Superseded by DEC-032.

## DEC-026: Telemetry sinks in the MVP

**Status:** Answered (Q16). Amended by DEC-034.

- **Decision:** The MVP ships the `log` sink (stdout), the `mongo` sink (DEC-034) and the `memory` sink (tests). Sentry and PostHog are design only (DEC-036).

## DEC-027: Sensitive data is never logged

**Status:** Answered

- **Decision:** Four layers: typed payloads that carry IDs instead of personal data; a scrubber inside `telemetry.emit` before any sink; pino `redact` paths; vendor-side scrubbing. Raw URLs, query strings, bodies, cookies and auth headers are never logged ([observability/redaction.md](observability/redaction.md)).

## DEC-028: Central log storage (Loki proposal)

**Status:** Superseded by DEC-034 and DEC-035.

## DEC-029: Feature flag providers and percentage rollout

**Status:** Decided (lead), design only. Targeting narrowed by DEC-038.

- **Decision:** Two providers behind the same OpenFeature API: (1) **database provider**, the default, over a `feature_flag` PostgreSQL table, evaluated in memory, with deterministic percentage rollout; (2) **PostHog provider** for experiments and flag analytics. Flags are always evaluated on the API; the web app reads `GET /api/feature-flags/evaluate`.
- **Trade-off:** The database provider is ours to maintain and has no analytics. PostHog adds a vendor, cost and a network dependency.

## DEC-030: Specs standalone and in English

**Status:** Superseded by DEC-031.

## DEC-031: Bilingual specs and a PRD built from them

**Status:** Answered (round 4)

- **Decision:** Specs live in `docs/specs/eng/` (canonical) and `docs/specs/id/` (Indonesian translation, same files and section numbers). When they disagree, English wins and the translation is fixed in the same change. `PRD.md` inside each folder replaces the old `PRODUCT.md` and is derived from the specs. `docs/prd/` stays frozen as history. App READMEs (coding rules) stay English only.
- **Trade-off:** Every spec change is made twice. A change to `eng/` without the matching `id/` change fails review.

## DEC-032: No impersonation

**Status:** Answered (round 4: "delete impersonation, not implemented")

- **Context:** Better Auth's admin plugin always ships impersonation endpoints and has no option to turn them off. Its default statement contains `user:impersonate` and `user:impersonate-admins`, and any user ID in `adminUserIds` bypasses role checks.
- **Decision:** Impersonation is not part of this boilerplate:
  1. The `admin` module's statement lists the admin-plugin actions we use **explicitly** instead of spreading `defaultStatements`, so the impersonate actions do not exist in our access control and no role (including the derived `super_admin`) can hold them.
  2. A `hooks.before` rule rejects `/admin/impersonate-user` and `/admin/stop-impersonating` with `404 NOT_FOUND`.
  3. `adminUserIds` is never set.
  4. No impersonation fields in events, logs, the web app or env variables.
- **Trade-off:** The generated `session` schema still contains the plugin's unused impersonation column; it is ignored. Adding impersonation later needs a new decision.

## DEC-033: What `admin` can do with users and sessions

**Status:** Answered (Q19)

- **Decision:** `admin` gets `user:list`, `user:get`, `session:list` and `role:read`. Only `super_admin` gets `user:create`, `user:update`, `user:set-role`, `user:ban`, `user:delete`, `user:set-password`, `session:revoke`, `session:delete`.

## DEC-034: MongoDB log store with manual retention

**Status:** Answered (Q17: "manual first, MongoDB by default"; Q18: "agree, delete retention manually")

- **Context:** The product owner wants a self-managed log store now and Grafana Alloy + Loki later.
- **Options:** (a) MongoDB, written by a `mongo` sink; (b) a PostgreSQL table in the app database; (c) Loki + Alloy from day one.
- **Decision:** **(a).** Every telemetry event at `info` or above goes to stdout **and**, through an asynchronous batched `mongo` sink, to a separate MongoDB database (`log_event` collection). Retention by kind: `http` 14 days, `app` 30, `error` 30, `product` 30, `audit` 365. Deletion is **manual**: an operator runs `bun run logs:prune` (dry-run first); no TTL index and no in-app scheduler. `telemetry.flush()` drains the sink buffer on shutdown. Redis is mandatory in production (DEC-001 clarified). Design in [observability/log-storage.md](observability/log-storage.md).
- **Trade-off:** One more database to run, and the API now ships logs itself (bounded buffer, never blocks a request). Not (b): logs would compete with app queries in PostgreSQL. Not (c) yet: three more services before there is traffic to justify them.

## DEC-035: Migration path to Grafana Alloy + Loki

**Status:** Answered (Q17: "move to Alloy later"), design only

- **Decision:** When the trigger in [observability/migration-loki.md](observability/migration-loki.md) fires, Alloy collects stdout and ships to Loki, then the `mongo` sink is switched off. Loki retention stays manual by default (`retention_period: 0s` + delete API), with the same periods. Promtail is not used (end of life 2026-03-02). The ELK Stack is the documented alternative (DEC-041); only one of the two is adopted.

## DEC-036: Sentry and PostHog have separate implementation specs

**Status:** Answered (round 4), design only

- **Decision:** [observability/sentry.md](observability/sentry.md) (error tracking with `@sentry/bun`) and [observability/posthog.md](observability/posthog.md) (product analytics with `posthog-node`) are each a standalone build and migration plan. Neither is built until a new decision adopts it. The manual log (stdout + MongoDB) stays the baseline either way. PostHog is for product analytics only: PostHog Logs and tracing are not used, and the analytics sink and the PostHog feature-flag provider are separate integrations that share only the client ([observability/posthog.md §1.1–1.2](observability/posthog.md)).

## DEC-037: Logs and errors carry the module name

**Status:** Answered (round 4: "catch which module errored, without the route name")

- **Decision:** Every module controller uses `moduleScope('<name>')`, which tags the request context with `module`. Every log line and event inside that module's routes carries `module`. `http.error` is identified by `module` + `code` and carries no route. Services throw `moduleError('<module>', status, code, message)`; when the throwing module differs from the handling module, `http.error` also carries `sourceModule`. Errors outside any module use `module: "core"`; Better Auth's handler uses `module: "auth"` ([observability/README.md §4](observability/README.md)).
- **Trade-off:** One line per controller. In return, errors group by module even when routes change.

## DEC-038: Feature flags target users, never roles

**Status:** Answered (round 4: "default database, user targeting without role targeting")

- **Decision:** The evaluation context is `targetingKey` (user ID) only. Targeting rules are: kill switch, exclude users, include users, percentage rollout. No role targeting, no person properties. Design in [feature-flags/targeting.md](feature-flags/targeting.md). The database provider stays the default (DEC-029).
- **Trade-off:** "Turn on for all admins" needs an explicit user list. In return, flags can never become a second access-control system.

## DEC-039: Test layout mirrors modules and features

**Status:** Answered (round 4)

- **Decision:**
  - API: `apps/api/tests/modules/<module>/` (service and route tests), `tests/utils/<util>/`, `tests/e2e/<module>/` (HTTP tests against a running stack), `tests/helpers/`.
  - Web: `apps/web/tests/features/<feature>/`, `tests/lib/`, `tests/components/`, `tests/helpers/`; E2E flows in `apps/web/e2e/<feature>/*.yaml` run by the workspace E2E system.
  - Runner: `bun test` in both apps. Folder names match the module or feature name exactly. Design in [TESTING.md](TESTING.md).
- **Trade-off:** Tests are not next to the code. In return, module and feature folders keep their fixed file layout (DEC-008, DEC-011) and test folders are easy to find by name.

## DEC-040: No product name

**Status:** Answered (round 5: "drop BunForge, it's just a name")

- **Context:** "BunForge" came from the original PRD. It was only a name, but it was built into the package scope, the auth cookie prefix and database names, which are expensive to rename once code exists.
- **Decision:** The project has no product name; the specs call it "the boilerplate". Neutral identifiers replace the name:
  - Package scope `@repo/*` (`@repo/db`, `@repo/ui`, …), the common convention for internal monorepo packages that are never published.
  - Better Auth `advanced.cookiePrefix: "app"`, giving `app.session_token` (`__Secure-app.session_token` on HTTPS). Not Better Auth's default `better-auth`, which tells anyone reading cookies which auth library runs behind the app.
  - MongoDB log database default `app_logs`; test PostgreSQL database `app_test`; feature-flag provider metadata name `database`.
- **Trade-off:** A project built from the boilerplate that wants its own identifiers changes them before its first deploy. After that, changing the cookie prefix signs every user out once, and renaming a database needs a data migration.

## DEC-041: ELK Stack as an alternative log migration target

**Status:** Answered (round 5: "create specs migration using ELK stack"), design only

- **Context:** DEC-035 plans the move from MongoDB to Grafana Alloy + Loki. The product owner wants the ELK Stack documented as well.
- **Options:** (a) Loki only; (b) ELK only; (c) both documented, exactly one chosen at migration time.
- **Decision:** **(c).** [observability/migration-elk.md](observability/migration-elk.md) describes Filebeat → Logstash → Elasticsearch → Kibana, one data stream per `kind`, daily rollover and **manual** deletion of old backing indices (no ILM delete phase, no `data_retention`), with the DEC-034 periods. Loki stays the default recommendation; ELK is chosen when a condition in migration-elk.md §1 holds (indexed search on high-cardinality fields, existing Elastic platform, full-text search in errors). The API itself never talks to Elasticsearch.
- **Trade-off:** Two migration specs to keep current. ELK costs more memory, disk and operations than Loki, in exchange for every mapped field being indexed.

## DEC-042: One access mode per project, static roles by default

**Status:** Answered (round 6: Q20 "default static roles with the admin plugin", Q26 "rename rbac")

- **Context:** The product owner wants roles that can be created at runtime and a path to multi-tenancy, while keeping the simple code-defined roles as the default.
- **Options:** (a) static roles only; (b) all three modes behind a config switch; (c) three documented modes, one picked per project.
- **Decision:** **(c).** The modes are **static-roles** (default, admin plugin, roles in code), **single-org** (organization plugin with dynamic access control and one hidden organization) and **multi-tenant** (many organizations). A project records its mode before TASK-03. Only that mode is built. Moves go forward only (static-roles → single-org → multi-tenant) and follow [auth/access/migration.md](auth/access/migration.md). `auth/rbac.md` is renamed [auth/access/static-roles.md](auth/access/static-roles.md); its rules are unchanged. DEC-022 (no role table) and DEC-024 apply to static-roles; organization modes add the plugin's `organization_role` table. Design in [auth/access/README.md](auth/access/README.md).
- **Trade-off:** Three specs to keep current. Not (b): it triples the auth code to secure and test.

## DEC-043: Platform layer and organization layer in organization modes

**Status:** Answered (round 6: Q21)

- **Decision:** In organization modes the admin plugin stays, for the platform only. `user.role` holds platform roles (`super_admin`, `user`, optional code roles such as `platform_support`) and grants no module permissions. `member.role` (organization plugin) holds organization roles and grants all module permissions. Routes use `permission` (organization) or `platformPermission` (platform), never both. Design in [auth/access/single-org.md §4, §8](auth/access/single-org.md) and [saas/platform-console.md](../../specs/eng/saas/platform-console.md).
- **Trade-off:** A `super_admin` who wants to edit content must also be a member with a suitable role. In return, the two systems never overlap or drift.

## DEC-044: `organization_id` on module tables in both organization modes

**Status:** Answered (round 6: Q22)

- **Decision:** In single-org and multi-tenant, every module table has `organization_id NOT NULL`, every repository function takes `orgId` first, and caches and logs carry the organization ([auth/access/single-org.md §5](auth/access/single-org.md)). Single-org therefore grows into multi-tenant with no data migration.
- **Trade-off:** One column, one index prefix and one filter per table in single-org, where only one organization exists.

## DEC-045: Separate specs for organization core, multi-tenancy and the platform console

**Status:** Answered (round 6: Q23, Q24). File layout replaced by DEC-047.

- **Decision:** `auth/access/organization.md` (now [single-org.md](auth/access/single-org.md), DEC-047) holds the shared organization core and the single-org mode. [saas/multi-tenant.md](../../specs/eng/saas/multi-tenant.md) holds only what multi-tenant adds (isolation rules, onboarding, invitations, switching, lifecycle, isolation test suite). `auth/access/platform-console.md` (now [saas/platform-console.md](../../specs/eng/saas/platform-console.md), DEC-047) holds the SaaS owner console: users and sessions through the admin plugin endpoints, organizations through `/api/platform/*`, read-only towards customer content, every request audited, no impersonation.
- **Trade-off:** Multi-tenant readers read two files. In return, nothing is written twice.

## DEC-046: Tenant isolation without database row-level security

**Status:** Superseded by DEC-051 (the application layer stays; row-level security is added)

- **Decision:** Multi-tenant isolation is enforced in the application: a typed `scoped(orgId)` repository helper, a CI check against unscoped queries, `404` for other tenants' records, and a mandatory isolation test suite ([saas/multi-tenant.md §3, §13](../../specs/eng/saas/multi-tenant.md)). PostgreSQL RLS is not used in the first version.
- **Trade-off:** A bug in the helper is not caught by the database. RLS remains an option if an audit requires database-level enforcement.

## DEC-047: Access stages, and SaaS separated from access

**Status:** Answered (round 7: "separate SaaS and access; static-roles by default, then single-org, then multi-tenant last; make the migration flow clear")

- **Context:** The access specs mixed three concerns: the stages, the move between them, and running the app as a SaaS business. The product owner wants a clear forward flow and SaaS kept apart.
- **Decision:**
  - The three access modes are named **stages**: stage 1 static-roles (default), stage 2 single-org, stage 3 multi-tenant. A project is at one stage and moves forward one step at a time: **Step A** (1 → 2) and **Step B** (2 → 3). [auth/access/migration.md](auth/access/migration.md) is rewritten around those two steps, with details in appendices.
  - `auth/access/organization.md` is renamed [single-org.md](auth/access/single-org.md). Stage 3 reuses all of it except §10 (the one hidden organization).
  - The **platform layer** (platform roles, users, bans, sessions, flag management) belongs to access and starts at stage 2 ([single-org.md §8](auth/access/single-org.md)). Its tasks are ORG-07 and ORG-08 (formerly PC-01 and part of PC-04).
  - The **SaaS layer** lives in [saas/](../../specs/eng/saas/README.md): the platform console (organization directory, suspension, cross-tenant audit; moved from `auth/access/platform-console.md`), tenant rollout, plans and billing. Its tasks are PC-01 to PC-03.
  - This replaces the file layout in DEC-045. The rules in DEC-043 to DEC-046 are unchanged.
- **Trade-off:** Stage 3 readers read [single-org.md](auth/access/single-org.md), [multi-tenant.md](../../specs/eng/saas/multi-tenant.md) and [saas/platform-console.md](../../specs/eng/saas/platform-console.md). In return, each file covers one stage or layer, and nothing is written twice.

## DEC-048: Feature flags at each access stage

**Status:** Answered (round 7: Q27 "organization ID for multi-tenant"). The Q30 part (flag management on the platform layer) is Decided (lead).

- **Decision:**
  - Flags stay **global** at every stage: the `feature_flag` table has no `organization_id`, and tenants never manage flags.
  - **Stages 2 and 3:** `feature_flag:read|write` moves from the module statement to the **platform** statement, so only platform roles (`super_admin`, optionally `platform_support`) manage flags. No organization role or runtime role can hold it (lead decision for Q30: flags are app-wide, and deciding at stage 2 means stage 3 changes nothing).
  - **Stage 3:** the evaluation context adds `organizationId` (the active organization), and the percentage rollout hashes `organizationId`, so a whole company gets the same answer (Q27). User include/exclude lists still apply. `organizationId` is the only organization attribute (no plan, size or country). This amends DEC-038's "user ID only" for stage 3.
  - Organization include/exclude lists and their rule order are a SaaS add-on ([saas/tenant-rollout.md](../../specs/eng/saas/tenant-rollout.md)), decided in [saas/DECISIONS.md](../../specs/eng/saas/DECISIONS.md).
  - Design in [feature-flags/access-stages.md](feature-flags/access-stages.md) (stages 1 and 2) and [saas/feature-flags.md](../../specs/eng/saas/feature-flags.md) (multi-tenant, DEC-050).
- **Trade-off:** At Step B, flags in the middle of a percentage rollout are reshuffled. At Step A, staff who could view flags through `admin` need a platform role to keep that access.

## DEC-049: SaaS decisions are kept separately and cannot change stages 1 and 2

**Status:** Answered (round 7: "make the SaaS decisions separate; they may conflict with static-roles, single-org or multi-tenant"). Rule 1 amended by DEC-050: the SaaS layer now starts with multi-tenant and requires stage 2.

- **Decision:** SaaS decisions are recorded as SAAS-xxx in [saas/DECISIONS.md](../../specs/eng/saas/DECISIONS.md), not here. Rules:
  1. The SaaS layer requires stage 3. It is never built at stages 1 or 2.
  2. A SaaS decision may **add** to stage 3. It may not change the behaviour of stages 1 or 2, or the rules in DEC-042 to DEC-048.
  3. When a SaaS decision would need such a change, it stays **Proposed** until a DEC entry here records the access change. A DEC entry here always wins over a SAAS entry.
- **Trade-off:** Two decision logs. In return, a project at stage 1 or 2 never has to read SaaS decisions, and SaaS choices cannot quietly break the default build.

## DEC-050: Access covers stages 1 and 2; multi-tenant and everything it needs move to SaaS

**Status:** Answered (round 8: "for access just talk about static-roles and single-org, because single-org can handle roles and permissions; separate multi-tenant, its observability, feature flags and API architecture into saas/")

- **Context:** Stage 2 already answers the access question (roles created at runtime, permissions granted from the code statements). Multi-tenancy adds a different kind of work: keeping customers' data apart, onboarding, a console, per-tenant observability. Keeping it in `auth/access/` mixed the two, and flags and observability had no per-stage docs for the move from stage 1 to stage 2.
- **Decision:**
  - [auth/access/](auth/access/README.md) covers **stage 1** (static-roles, default) and **stage 2** (single-org) only. [auth/access/migration.md](auth/access/migration.md) covers starting a project and **Step A**, including what changes for flags and observability.
  - Multi-tenant moves to [saas/multi-tenant.md](../../specs/eng/saas/multi-tenant.md) and becomes the foundation of the SaaS layer. Its migration (**Step B**) is [saas/migration.md](../../specs/eng/saas/migration.md); its architecture and isolation [saas/architecture.md](../../specs/eng/saas/architecture.md); its flags [saas/feature-flags.md](../../specs/eng/saas/feature-flags.md); its observability [saas/observability.md](../../specs/eng/saas/observability.md).
  - Per-stage docs for stages 1 and 2: [feature-flags/access-stages.md](feature-flags/access-stages.md) and the new [observability/access-stages.md](observability/access-stages.md). Stage 2 adds `organizationId` to the log context, `access.*` startup events and `audit.org.*` events.
  - "Access stage 3" in DEC-042 to DEC-049 now means "multi-tenant (SaaS)". Their rules are unchanged, except DEC-046 (superseded by DEC-051) and DEC-049 rule 1 (the SaaS layer requires stage 2 and starts with multi-tenant).
  - Task IDs keep their names: MT-01 to MT-10, MIG-04 and MIG-05 (Step B) are in `saas/`; FF-ORG-02 is renamed FF-MT-01.
- **Trade-off:** A multi-tenant reader starts in `saas/` and follows links into `auth/access/single-org.md`. In return, a project that stays at stage 1 or 2 never reads anything about tenants.

## DEC-051: Row-level security as a second isolation layer in multi-tenant

**Status:** Decided (lead), after the product owner reported "multi-tenant not using RLS" as a bug (round 8). Supersedes DEC-046.

- **Context:** DEC-046 relied on the application layer only. Its CI check matched only `db.select`/`db.update`/`db.delete` in `repository.ts`, so relational queries, raw SQL, `insert … select`, joins and background jobs could read or write another tenant's rows unnoticed, and one bug in `scoped()` would leak every module at once ([saas/architecture.md §3.2](../../specs/eng/saas/architecture.md)).
- **Options:** (a) keep application-only isolation with a stricter check; (b) application layer **plus** PostgreSQL row-level security; (c) a schema or database per tenant.
- **Decision:** **(b).** In multi-tenant:
  - Every module table with `organization_id` gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and one `tenant_isolation` policy comparing `organization_id` with the transaction-local setting `app.org_id`. Better Auth tables and `feature_flag` have no RLS.
  - `scoped(orgId)` opens a transaction and sets `app.org_id` with `set_config(…, true)`; it stays the only way module code reaches a module table (lint rule against `db` imports in `modules/*`, replacing the old grep check).
  - Three database roles: `app_owner` (migrations, purge), `app_runtime` (the API, RLS enforced), `app_platform` (`*AcrossTenants` only, `SELECT` only, bypasses RLS).
  - A policy violation is a bug: `500`, plus a `security.tenant_violation` event with an alert.
  - Stage 2 gets no RLS (one organization, nothing to protect). Step B adds it in its own release (B1) before tenants are opened (B2).
  - Design in [saas/architecture.md §4](../../specs/eng/saas/architecture.md) and [saas/migration.md §3.2](../../specs/eng/saas/migration.md).
- **Trade-off:** A transaction and one extra statement per unit of work, three database URLs, and migrations that must run as the owner role. Not (a): a check can only find the mistakes it was written for. Not (c): migrations and connection pools multiply with every tenant.

## DEC-052: Implementation notes live outside the specs

**Status:** Superseded by DEC-053. Answered (round 9: "if implementing the tasks needs spec updates, create docs/implement-boilerplate/static-role (default) using the specs as reference")

- **Context:** Some tasks settle values the specs leave open (real Better Auth error codes and paths, the web dev port, the bootstrap time). Earlier task briefs told workers to write them into `docs/specs/eng/` and `docs/specs/id/`, which mixes design with build results and makes parallel tickets edit the same spec files.
- **Decision:**
  - `docs/specs/` stays the design reference. Implementation tickets read it and never edit it.
  - Everything an implementation task needs to record goes to [docs/implement-boilerplate/static-role/](README.md), one file per task (`TASK-NN-<slug>.md`), English only.
  - The folder is per access stage: `static-role/` covers the default build. A later stage-2 build gets its own folder.
  - A recorded deviation that contradicts a DEC entry needs the product owner's acceptance before it is merged.
- **Trade-off:** A reader checks two places: the spec for the design, the notes for what was built. In return the specs stay stable and bilingual parity is never broken by build work.

## DEC-053: The static-roles build works from a copy of the specs

**Status:** Answered (round 10: "update all the specs from docs/specs to docs/implement-boilerplate/static-role")

- **Context:** DEC-052 kept build results in per-task note files next to unchanged specs, so a reader had to merge two sources to know what to build. The product owner wants one place that is both the spec and the build record.
- **Decision:**
  - `docs/implement-boilerplate/static-role/` holds a full copy of `docs/specs/eng/` (without `saas/`, which stays design only) taken on 2026-11-03. Implementation tickets read it and update it in place.
  - `docs/specs/eng/` and `docs/specs/id/` become the design baseline: implementation work never edits them. A design change made later by the product owner is made in both places.
  - Settled values are written in place with `(TASK-NN)`. A deviation that contradicts a DEC entry adds a **Proposed** DEC entry to the copy and waits for the product owner.
  - Per-task note files (`TASK-NN-<slug>.md`) are dropped.
- **Trade-off:** The copy and the baseline drift on purpose; `diff -r` shows the drift. A later stage-2 build would start its own copy.
