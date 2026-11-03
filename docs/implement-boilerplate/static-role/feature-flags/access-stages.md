# Feature Flags at Each Access Stage

> **Status: design only (DEC-048, DEC-050).** How feature flags behave at access stage 1 (static-roles) and stage 2 (single-org) ([auth/access/README.md](../auth/access/README.md)), and what changes in Step A. Flags stay role-free at every stage (DEC-038). Flags in the SaaS multi-tenant layer (percentage by organization, named tenants) are in [saas/feature-flags.md](../../../specs/eng/saas/feature-flags.md).

## 1. Summary

| | **Stage 1: static-roles** (default) | **Stage 2: single-org** |
|:---|:---|:---|
| Evaluation context | `targetingKey` (user ID) | `targetingKey` (user ID) |
| Percentage rollout hashes | User ID | User ID |
| Rules | [targeting.md](targeting.md) | [targeting.md](targeting.md), unchanged |
| Who manages flags | Module permission `feature_flag:read|write` on code roles | **Platform** permission `feature_flag:read|write` on `user.role` |
| API option on management routes | `permission` | `platformPermission` |
| Web page | `/admin/feature-flags` | `/platform/feature-flags` |
| `feature_flag` table | Global | Global, no `organization_id` |

Flags are **global**: one `feature_flag` table and one catalogue for the whole app. A flag is never owned by an organization.

## 2. Stage 1: static-roles

Everything in [README.md](README.md), [targeting.md](targeting.md) and [database-provider.md](database-provider.md) applies as written. The `feature-flags` module's `permissions.ts` declares `{ feature_flag: ['read', 'write'] }`; `admin` gets `read`, `super_admin` gets both.

## 3. Stage 2: single-org

- **Targeting is unchanged.** There is one organization, so targeting it would mean nothing. The context stays `targetingKey` only, and every flag gives each user the same result as at stage 1.
- **Management moves to the platform layer** ([single-org.md §8](../auth/access/single-org.md)). Flags are app-wide, while organization roles describe what someone may do with the app's content, so flag control belongs to the people who run the app:
  - `feature_flag` leaves the module statement and joins the platform statement. It is never in `orgAc`, so no organization role or runtime role can hold it, and `create-role` refuses it.
  - Management routes in [database-provider.md §6](database-provider.md) use `{ platformPermission: 'feature_flag:read' }` / `'feature_flag:write'` instead of `permission`.
  - `super_admin` gets both. A platform code role such as `platform_support` may get `read`.
  - `GET /api/feature-flags/evaluate` stays `auth: true` and is not organization-scoped.
- Telemetry is unchanged: `flag.*` and `audit.feature_flag.changed` ([README.md §7](README.md)). At stage 2, `audit.feature_flag.changed` has `module: "platform"`.
- Putting flags on the platform layer already at stage 2 means the SaaS layer needs no permission change for them.

## 4. Step A (stage 1 → stage 2)

| What changes | Action |
|:---|:---|
| `feature_flag:*` moves from module roles to platform roles | Users who held `feature_flag:read` through `admin` lose it. The migration script lists them; give each one `platform_support` or accept the loss. The permissions snapshot check ([migration.md §3.5](../auth/access/migration.md)) compares `feature_flag:*` separately for this reason |
| `/admin/feature-flags` → `/platform/feature-flags` | Redirect the old path for one release |
| Targeting | Nothing: user ID hashing and lists stay, so no user's flag result changes |
| Flag rows | Nothing: the table is global and gets no `organization_id` |

## 5. Tests

- Stage 2: management routes need the platform permission; an organization `owner` with platform role `user` gets 403; `create-role` refuses a runtime role that includes `feature_flag:*`.
- Stage 2: for a fixed set of 1 000 users, every flag gives the same result as the stage 1 evaluator (targeting unchanged).
- Step A: the migration script's "loses `feature_flag:*`" list matches the users who held it through `admin`.

## 6. Tasks when adopted

| Task | Goal | Depends on |
|:---|:---|:---|
| FF-ORG-01 | Stage 2: move flag permissions to the platform statement, `platformPermission` on management routes, `/platform/feature-flags` page, redirect | Flags adopted, ORG-07 |

Multi-tenant flag work (FF-MT-01) is in [saas/feature-flags.md §8](../../../specs/eng/saas/feature-flags.md).
