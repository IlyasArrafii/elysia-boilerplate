# Observability at Each Access Stage

> **Status: design only (DEC-044, DEC-050).** How logs and telemetry events change between access stage 1 (static-roles) and stage 2 (single-org) ([auth/access/README.md](../auth/access/README.md)), and what Step A changes. The base model is [README.md](README.md). Observability in the SaaS multi-tenant layer (per-tenant queries, Sentry and PostHog by organization, tenant purge) is in [saas/observability.md](../saas/observability.md).

## 1. Summary

| | **Stage 1: static-roles** (default) | **Stage 2: single-org** |
|:---|:---|:---|
| Log context | `requestId, module, userId?` | `requestId, module, userId?, organizationId?` |
| `module` values | Module names, `auth`, `core` | Same, plus `platform` (the platform layer module) |
| Role warnings at startup | `rbac.unknown_role` | `access.unknown_platform_role`, `access.member_missing`, `access.stale_permission` |
| Role audit events | `audit.user.role_changed` (all roles) | `audit.user.role_changed` (platform roles only) + `audit.org.*` (organization roles) |
| MongoDB indexes | [DATABASE.md §8](../DATABASE.md) | Unchanged (one organization; no index on `organizationId`) |
| Sentry, PostHog | User ID only | Unchanged: `organizationId` is not sent (one organization adds no information) |
| Erasure | `logs:prune --user` | Unchanged |

## 2. Stage 1: static-roles

[README.md](README.md), [redaction.md](redaction.md) and [log-storage.md](log-storage.md) apply as written.

## 3. Stage 2: single-org

### 3.1 Log context

- The `auth` macro adds `organizationId` to the log context when it resolves `ctx.org` from `session.activeOrganizationId` ([single-org.md §5](../auth/access/single-org.md)). Every event emitted inside an organization-scoped route carries it.
- Routes that are not organization-scoped (`/api/auth/*`, `/api/platform/*`, `/api/feature-flags/evaluate`, health) have no `organizationId`, unless the event payload names one (`audit.org.*`).
- Only the ID is logged. Organization **name, slug and logo** are customer data and never logged ([redaction.md §1](redaction.md)).

### 3.2 Events added

Added to the event catalogue ([README.md §6](README.md)) at stage 2 only. Payloads are IDs and counts, never names or emails.

| Event | Kind | Payload (plus context fields) | Sinks |
|:---|:---|:---|:---|
| `access.member_missing` | `app` | `count` | log, mongo (warn), at startup |
| `access.unknown_platform_role` | `app` | `roles: { role, count }[]` | log, mongo (warn), at startup. Replaces `rbac.unknown_role` |
| `access.stale_permission` | `app` | `roleIds, permissions` | log, mongo (warn), at startup |
| `access.migrated` | `app` | `users, organizationId, unknownRoles` | log, mongo; once, by the Step A script |
| `audit.org.member_added` | `audit` | `organizationId, userId, role, actorId?` | log, mongo |
| `audit.org.member_role_changed` | `audit` | `organizationId, userId, from, to, actorId` | log, mongo |
| `audit.org.member_removed` | `audit` | `organizationId, userId, actorId` | log, mongo |
| `audit.org.role_created` / `role_updated` / `role_deleted` | `audit` | `organizationId, roleId, roleName, permissionCount, actorId` | log, mongo |

Changed meaning:

- `audit.user.role_changed` covers **platform** roles only, with `module: "platform"`.
- `audit.auth.blocked_endpoint` also fires for organization plugin paths not in the allowlist ([single-org.md §9](../auth/access/single-org.md)).
- `audit.feature_flag.changed` has `module: "platform"` ([feature-flags/access-stages.md §3](../feature-flags/access-stages.md)).

Runtime role names (`roleName`) are safe to log: they are labels chosen by staff, like code role names ([redaction.md §1](redaction.md)). The role editor refuses names longer than 40 characters or outside `snake_case` ([single-org.md §7](../auth/access/single-org.md)), so free text cannot reach the log through them.

### 3.3 Not changed at stage 2

- Retention periods, prune commands and MongoDB indexes.
- Sentry and PostHog sinks: no organization tag or group.
- Metrics per module ([README.md §8](README.md)).

## 4. Step A (stage 1 → stage 2)

| What changes | Action |
|:---|:---|
| New `organizationId` field | Older lines do not have it. Queries treat it as optional; no backfill of the log store |
| `rbac.unknown_role` → `access.unknown_platform_role` | Saved queries and alerts switch after Release 3 ([migration.md §3.4](../auth/access/migration.md)) |
| Role audit trail | Stage 1 `audit.user.role_changed` lines stay as history. Stage 2 organization role changes are `audit.org.member_role_changed`. An investigation that spans the switch queries both |
| One-off migration record | `access.migrated` is emitted once after the script commits |
| Sessions revoked | Every user signs in again: expect a peak of `audit.session.created` at the switch |

## 5. Acceptance criteria (stage 2)

- [ ] Every event inside an organization-scoped route has `organizationId`; no event outside one has it, unless its payload names an organization.
- [ ] No log line or MongoDB document contains an organization name or slug (redaction test).
- [ ] Each event in §3.2 has a typed payload in `events.ts` and a test that emits it.
- [ ] Startup with a user that has no `member` row emits `access.member_missing { count: 1 }`.
- [ ] Changing a member's role emits `audit.org.member_role_changed` with `from` and `to`; changing a platform role emits `audit.user.role_changed` with `module: "platform"`.

## 6. Tasks

No separate tasks: the work is part of ORG-02 (log context), ORG-04 (role audit events), ORG-05 (startup checks), ORG-07 (platform module tagging) and MIG-03 (Step A) in [single-org.md §15](../auth/access/single-org.md) and [migration.md §6](../auth/access/migration.md).
