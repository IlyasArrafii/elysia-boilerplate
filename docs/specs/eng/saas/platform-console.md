# SaaS Platform Console

> **Status: design only (DEC-047, SAAS-001).** The admin area for **you, the SaaS owner**, across all tenants. Required with [multi-tenant.md](multi-tenant.md); not used at access stages 1 and 2. It builds on the **platform layer** of [auth/access/single-org.md §8](../auth/access/single-org.md) (platform roles, users, bans, sessions, flags) and adds organization-wide pages. Read [README.md](README.md) first.

## 1. Two admin areas

| | **Platform console** | **Organization settings** |
|:---|:---|:---|
| For | The SaaS owner and their staff | A customer's owner or admin |
| Layer | Platform: `user.role` (admin plugin) | Organization: `member.role` (organization plugin) |
| Sees | All organizations, all users, sessions, bans | Only the active organization |
| API | `/api/auth/admin/*` (users, sessions), `/api/platform/*` | Organization endpoints and module routes, always scoped |
| Web | `/platform/*` | `/settings/*` |
| Spec | Platform layer ([single-org.md §8](../auth/access/single-org.md)) + this file | [single-org.md §10.4](../auth/access/single-org.md), [multi-tenant.md](multi-tenant.md) |

A platform role grants **no** organization permissions, and an organization role grants **no** platform permissions (DEC-043).

## 2. What the console adds to the platform layer

| Platform layer (stage 2 and multi-tenant) | Console (multi-tenant only) |
|:---|:---|
| Users, bans, sessions, platform roles | Organization directory, details and members |
| Feature flag management | Suspend, restore and delete organizations |
| `/platform/users`, `/platform/feature-flags` | Cross-tenant audit search |
| | Overview counts |
| | Later add-ons: tenant rollout lists ([tenant-rollout.md](tenant-rollout.md)), plans ([plans-billing.md](plans-billing.md)) |

## 3. Platform statement additions

Added to `apps/api/src/modules/platform/permissions.ts` ([single-org.md §8.2](../auth/access/single-org.md)):

```ts
// sketch: on top of user, session and feature_flag
platform_org:   ['list', 'get', 'suspend', 'restore', 'delete'],
platform_audit: ['read'],
// grants
platform_support: { ..., platform_org: ['list', 'get'] },
```

Routes use `{ platformPermission: 'platform_org:suspend' }`.

## 4. Endpoints

| Method | Path | Needs | Result |
|:---|:---|:---|:---|
| GET | `/api/platform/organizations` | `platform_org:list` | Paginated `{ id, slug, name, status, memberCount, createdAt }`; filter by `status`, search by slug |
| GET | `/api/platform/organizations/:id` | `platform_org:get` | Details, owners' user IDs, member count, runtime role names |
| GET | `/api/platform/organizations/:id/members` | `platform_org:get` | `{ userId, roles, createdAt }[]` |
| POST | `/api/platform/organizations/:id/suspend` | `platform_org:suspend` | `status = suspended`; body `{ reason }` (stored, never logged) |
| POST | `/api/platform/organizations/:id/restore` | `platform_org:restore` | `status = active` |
| POST | `/api/platform/organizations/:id/delete` | `platform_org:delete` | Soft delete ([multi-tenant.md §8](multi-tenant.md)) |
| GET | `/api/platform/audit` | `platform_audit:read` | Audit events from the log store, filtered by `organizationId`, `userId`, event, date |

`GET /api/platform/users/:id/memberships` is part of the platform layer ([single-org.md §8.3](../auth/access/single-org.md)).

## 5. Rules

The platform layer rules apply ([single-org.md §8.4](../auth/access/single-org.md)): fresh session for writes, no impersonation, no self-targeting, at least one `super_admin`. In addition:

1. **Cross-tenant reads happen only here.** Module routes never skip the organization filter, even for `super_admin`.
2. **Read-only towards customer content.** The console reads customer metadata (organizations, members, counts). It does not read or edit customer content (posts). Viewing content needs a new decision.
3. **Every request is audited**, reads included (`audit.platform.accessed`), writes with their own event (§8).
4. **Suspending an organization never bans its users.** Banning is per user and blocks the whole app.
5. You cannot suspend an organization you are the only owner of without typing its slug to confirm.

## 6. Data access

- The `platform` module reads other modules only through their exported services (DEC-002).
- Functions that read across tenants are named `*AcrossTenants` (`organizationsService.listAcrossTenants`, `postsService.countByOrganizationAcrossTenants`). Only the `platform` module may import them; a lint rule enforces it. They run on the read-only `app_platform` database role, which bypasses row-level security but cannot write ([architecture.md §4.2](architecture.md)).
- Audit reads go to the MongoDB log store with the read-only user ([log-storage.md](../observability/log-storage.md)).

## 7. Web

Same `/platform` layout and banner as the platform layer ([single-org.md §8.5](../auth/access/single-org.md)).

| Page | Needs |
|:---|:---|
| `/platform` (overview: counts of organizations, users, banned users) | any platform permission |
| `/platform/organizations`, `/platform/organizations/:id` | `platform_org:list` / `platform_org:get` |
| Suspend, restore, delete buttons (confirm by typing the slug) | matching `platform_org:*` |
| `/platform/users/:id` gains a memberships list | `user:get` |
| `/platform/audit` | `platform_audit:read` |

## 8. Audit events

| Event | Payload |
|:---|:---|
| `audit.platform.accessed` | `actorId, path, targetOrganizationId?, targetUserId?` |
| `audit.platform.org_suspended` / `org_restored` / `org_deleted` | `organizationId, actorId` (never the reason) |

## 9. Tests

- Platform permission matrix for the routes in §4: `super_admin`, `platform_support`, `user`.
- Every console request emits `audit.platform.accessed`.
- Lint: importing a `*AcrossTenants` function outside `platform` fails.
- Suspend → the organization's members get 403 on it; restore → access returns.
- Stale session → `403 SESSION_NOT_FRESH` on suspend, restore and delete.

## 10. Tasks when adopted

| Task | Goal | Depends on |
|:---|:---|:---|
| PC-01 | Organization endpoints, `*AcrossTenants` services, lint rule, audit (§3–6, §8) | ORG-07, MT-01 |
| PC-02 | Audit query endpoint over the log store | ORG-07, TASK-15 |
| PC-03 | Web console pages (§7) | PC-01, PC-02, ORG-08 |

## 11. Proposed add-on: sales-led onboarding (SAAS-010)

Not built until SAAS-010 is Answered.

| Method | Path | Needs | Result |
|:---|:---|:---|:---|
| POST | `/api/platform/organizations` | `platform_org:create` | Creates the organization (`status = active`) and sends an `owner` invitation to the given email through the normal invitation flow ([multi-tenant.md §6](multi-tenant.md)) |

- The invited person accepts as usual and becomes `owner`. You never become a member.
- Emits `audit.platform.org_created` (`organizationId, actorId`, never the email).
