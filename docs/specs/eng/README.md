# Specifications (English)

This folder is the **source of truth** for building the boilerplate. It is self-contained: everything an engineer or AI agent needs is written here.

- `docs/specs/eng/` (this folder) is **canonical**.
- `docs/specs/id/` is the Indonesian translation with the same files and sections. If the two disagree, English wins and the Indonesian file is fixed (DEC-031).
- [`docs/implement-boilerplate/static-role/`](../../implement-boilerplate/static-role/README.md) is the **working copy** for the static-roles build (DEC-053). Implementation tickets follow and update that copy; this folder is the design baseline they never edit.
- `docs/prd/` is the original PRD pack, frozen as history. Never read it to decide how to build anything.

## Reading order

1. [PRD.md](PRD.md): what we are building, for whom, scope, requirements, metrics, risks.
2. [DECISIONS.md](DECISIONS.md): every architecture decision (DEC-001 onward).
3. [ARCHITECTURE.md](ARCHITECTURE.md): system shape, monorepo, request flow, caching, environment variables.
4. The documents for the area you are working on:

| Area | Documents |
|:---|:---|
| Features and acceptance criteria | [FEATURES.md](FEATURES.md) |
| Data model (PostgreSQL + Drizzle, MongoDB log store) | [DATABASE.md](DATABASE.md) |
| HTTP contract | [API.md](API.md) |
| Authentication (Better Auth) | [auth/README.md](auth/README.md) |
| Access stages (stage 1 static roles → stage 2 single-org) | [auth/access/README.md](auth/access/README.md) |
| Stage 1: roles and permissions (default) | [auth/access/static-roles.md](auth/access/static-roles.md) |
| Stage 2: roles and permissions granted at runtime (design only) | [auth/access/single-org.md](auth/access/single-org.md) |
| Choosing a stage and Step A (stage 1 → 2) | [auth/access/migration.md](auth/access/migration.md) |
| SaaS layer (design only): multi-tenant, architecture and row-level security, Step B, flags, observability, platform console, tenant rollout, plans and billing | [saas/README.md](saas/README.md), [saas/DECISIONS.md](saas/DECISIONS.md) |
| Logging and telemetry events | [observability/README.md](observability/README.md) |
| Redacting sensitive data | [observability/redaction.md](observability/redaction.md) |
| Log storage (MongoDB) and manual retention | [observability/log-storage.md](observability/log-storage.md) |
| Migration to Grafana Alloy + Loki | [observability/migration-loki.md](observability/migration-loki.md) |
| Migration to the ELK Stack (alternative to Loki) | [observability/migration-elk.md](observability/migration-elk.md) |
| Sentry (design only) | [observability/sentry.md](observability/sentry.md) |
| PostHog (design only) | [observability/posthog.md](observability/posthog.md) |
| Observability at access stages 1 and 2 | [observability/access-stages.md](observability/access-stages.md) |
| Feature flags (design only) | [feature-flags/README.md](feature-flags/README.md), [targeting.md](feature-flags/targeting.md), [access-stages.md](feature-flags/access-stages.md), [database-provider.md](feature-flags/database-provider.md), [posthog-provider.md](feature-flags/posthog-provider.md) |
| Testing (unit, integration, E2E) | [TESTING.md](TESTING.md) |
| UI design system | [DESIGN.md](DESIGN.md) |

5. Coding rules per app: [apps/api/README.md](../../../apps/api/README.md) and [apps/web/README.md](../../../apps/web/README.md).
6. [TASKS.md](TASKS.md): the build backlog.
7. Glossary: [CONTEXT.md](../../../CONTEXT.md) at the repo root.

## Precedence rules

1. `DECISIONS.md` beats every other document in this folder.
2. Other documents in this folder beat the app READMEs. If an app README contradicts a spec, stop and ask.
3. A decision with status **Proposed** must not be implemented until it is **Answered**.
4. `TBD` stays `TBD`. Never invent a number or behaviour to fill it.
5. Anything marked *verify* names a third-party package, option or path that must be checked against the official docs of the installed version before it is used.
6. A document marked **Design only** describes something deliberately not built yet. Do not install its packages or write its code until its adoption trigger fires and a decision records it.

## Open questions

None for the core specs. Round 7 answered Q27 and settled Q30 and Q32 (DEC-047, DEC-048).

SaaS questions (Q28, Q29, Q31, Q33 to Q39) are tracked in [saas/README.md](saas/README.md#6-open-questions). They cannot change stages 1 and 2 (DEC-049).
