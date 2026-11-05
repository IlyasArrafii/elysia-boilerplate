# Boilerplate documentation (static roles)

This folder documents the boilerplate **as built**: a Bun monorepo with an Elysia API, a TanStack Start web app, Better Auth, Drizzle on PostgreSQL, Redis and a MongoDB log store. Roles and permissions are **static**: defined in code and enforced through Better Auth's admin plugin with access control ([auth/static-roles.md](auth/static-roles.md)). The code is the source of truth; these documents describe it.

> **Starting your own project from this repo?** Read [NEW-PROJECT.md](NEW-PROJECT.md) first. It takes you from your own PRD to your own roles, API modules and web features on top of this boilerplate, with a green CI.

Other access models (runtime roles, multi-tenant) are out of scope for this boilerplate; their designs live in [docs/specs/eng/](../../specs/eng/README.md) for reference.

- `docs/specs/eng/` and `docs/specs/id/` are the design baseline. Build work never edits them, and nothing in this folder depends on them.
- `docs/prd/` is the original PRD pack, frozen as history. Never read it to decide how to build anything.
- English only.

## Reading order

1. [NEW-PROJECT.md](NEW-PROJECT.md), when you start a project from this boilerplate.
2. [PRD.md](PRD.md): what the boilerplate contains, for whom, requirements, metrics, risks.
3. [DECISIONS.md](DECISIONS.md): the architecture decisions the code follows.
4. [ARCHITECTURE.md](ARCHITECTURE.md): system shape, monorepo, request flow, caching, environment variables.
5. The documents for the area you are working on:

| Area | Documents |
|:---|:---|
| Features and acceptance criteria | [FEATURES.md](FEATURES.md) |
| HTTP contract | [API.md](API.md) |
| Data model (PostgreSQL + Drizzle, MongoDB log store) | [DATABASE.md](DATABASE.md) |
| Authentication (Better Auth) | [auth/README.md](auth/README.md) |
| Roles and permissions | [auth/static-roles.md](auth/static-roles.md) |
| Logging and telemetry events | [observability/README.md](observability/README.md) |
| Redacting sensitive data | [observability/redaction.md](observability/redaction.md) |
| Log storage (MongoDB) and manual retention | [observability/log-storage.md](observability/log-storage.md) |
| Testing (unit, integration, E2E) and CI | [TESTING.md](TESTING.md) |
| UI design system | [DESIGN.md](DESIGN.md) |

6. Coding rules per app: [apps/api/README.md](../../../apps/api/README.md) and [apps/web/README.md](../../../apps/web/README.md).
7. Glossary: [CONTEXT.md](../../../CONTEXT.md) at the repo root.

## Optional / later (design only)

Designed, not built. Each item becomes work only when its trigger fires and a new DEC entry adopts it; until then, do not install its packages or write its code.

| Item | Design | Trigger |
|:---|:---|:---|
| Feature flags, database provider (default) | [feature-flags/README.md](feature-flags/README.md), [targeting.md](feature-flags/targeting.md), [database-provider.md](feature-flags/database-provider.md) | The first feature that needs a gradual rollout or a kill switch |
| Feature flags, PostHog provider | [feature-flags/posthog-provider.md](feature-flags/posthog-provider.md) | Experiments or flag analytics are needed |
| Sentry | [observability/sentry.md](observability/sentry.md) | Error grouping and alerts are needed beyond MongoDB queries |
| PostHog analytics | [observability/posthog.md](observability/posthog.md) | Product questions the log store cannot answer |
| Grafana Alloy + Loki (default log migration) | [observability/migration-loki.md](observability/migration-loki.md) | A trigger in its §1 |
| ELK Stack (instead of Loki) | [observability/migration-elk.md](observability/migration-elk.md) | A trigger in migration-loki.md §1 and a condition in migration-elk.md §1; never together with Loki |

## Precedence rules

1. `DECISIONS.md` beats every other document in this folder.
2. Other documents in this folder beat the app READMEs. If an app README contradicts a document here, stop and ask.
3. A decision with status **Proposed** must not be implemented until it is **Answered**.
4. `TBD` stays `TBD`. Never invent a number or behaviour to fill it.
5. Anything marked *verify* names a third-party package, option or path that must be checked against the official docs of the installed version before it is used.
6. A document marked **Design only** describes something deliberately not built yet. Do not install its packages or write its code until its adoption trigger fires and a decision records it.

## Keeping this folder true

1. **Docs follow the code.** When a code change alters behaviour, the same change updates the matching section here. Where a document and the code disagree, fix the document to describe the code (DEC-053).
2. **Settled values** (a real error code or path, a port, a verified package option, a measured time) replace the `TBD` or *verify* text in place. Product numbers marked `TBD` (post length limits, KPI targets) stay `TBD` until the product owner sets them.
3. **A change that contradicts a DEC entry** adds a new DEC entry to [DECISIONS.md](DECISIONS.md) with status **Proposed**. It is not merged until the product owner accepts it.
4. Describe behaviour, not the work item that produced it: no ticket or task IDs in these documents.
5. Never record secrets, real credentials or customer data.

## Open questions

- [DEC-054](DECISIONS.md#dec-054-sessions-live-in-postgresql-only-not-in-redis) (sessions live in PostgreSQL only) is **Proposed**. The code already works this way; the entry waits for the product owner.
