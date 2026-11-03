# Tenant Rollout

> **Status: design only, Proposed (SAAS-002, SAAS-003, SAAS-004).** Do not build until those are Answered. It needs [multi-tenant.md](multi-tenant.md), adopted feature flags, and percentage by organization ([feature-flags.md](feature-flags.md), FF-MT-01). It adds **named companies** to flag targeting: "beta for Acme", "never for Globex".

## 1. What it adds

| Without tenant rollout (multi-tenant base) | With tenant rollout |
|:---|:---|
| Kill switch, user include/exclude, percentage of organizations | The same, plus **include organizations** and **exclude organizations** lists per flag |

Still no roles, plans or other attributes (DEC-038, DEC-048, SAAS-004). Only the SaaS owner edits the lists (SAAS-003).

## 2. Evaluation order (SAAS-002)

First match wins:

| # | Condition | Value | OpenFeature reason |
|:---|:---|:---|:---|
| 1 | Flag not in the catalogue or table | code default | `ERROR` (`FLAG_NOT_FOUND`) |
| 2 | Requested type ≠ flag type | code default | `ERROR` (`TYPE_MISMATCH`) |
| 3 | `enabled = false` | off value | `DISABLED` |
| 4 | `targetingKey` in `excludeUserIds` | off value | `TARGETING_MATCH` |
| 5 | `organizationId` in `excludeOrgIds` | off value | `TARGETING_MATCH` |
| 6 | `targetingKey` in `includeUserIds` | on value | `TARGETING_MATCH` |
| 7 | `organizationId` in `includeOrgIds` | on value | `TARGETING_MATCH` |
| 8 | `rolloutPercentage = 100` | on value | `STATIC` |
| 9 | `organizationId` present and `bucket(seed, organizationId) < rolloutPercentage` | on value | `SPLIT` |
| 10 | otherwise | off value | `DEFAULT` |

**Example.** Flag `new-editor`: enabled, exclude org **Acme**, include user **budi@acme.com**, include org **Globex**, 10% of organizations.

- Budi (in Acme): rule 5 matches first → **off**. Acme asked for no beta, and that wins over Budi's personal include.
- Anyone in Globex → rule 7 → **on**.
- Anyone else → about 10% of companies, the whole company at once.

Exclude always beats include at the same level, and organization exclude beats user include.

## 3. Data

Two columns on the global `feature_flag` table ([database-provider.md §2](../feature-flags/database-provider.md)):

| Column | Type | Notes |
|:---|:---|:---|
| `include_org_ids` | `text[] not null default '{}'` | Organization IDs |
| `exclude_org_ids` | `text[] not null default '{}'` | Organization IDs |

- The table stays global (DEC-048). These columns hold IDs of organizations; they do not scope the flag.
- Limit: include + exclude organizations ≤ 1 000 per flag. Larger groups use the percentage.
- Unknown organization IDs are rejected by the API (checked against `organization.id`).
- A purged organization's ID is removed by the "clean lists" action, as for deleted users.

## 4. API

On top of [database-provider.md §6](../feature-flags/database-provider.md), with `platformPermission` (DEC-048):

| Method | Path | Needs | Change |
|:---|:---|:---|:---|
| PATCH | `/api/feature-flags/:key` | `feature_flag:write` | Also accepts `includeOrgIds`, `excludeOrgIds` |
| POST | `/api/feature-flags/:key/clean-lists` | `feature_flag:write` | Also removes purged organizations' IDs |

`audit.feature_flag.changed` reports the organization lists as counts added and removed, never the IDs.

## 5. Console page

`/platform/feature-flags/:key` gains two organization pickers (search by slug), showing slug and name. Tenants see nothing: `/api/feature-flags/evaluate` returns only values, never lists or rules (SAAS-003).

## 6. PostHog provider

Organization lists become release conditions on the `organization` **group** (*verify* that the OpenFeature PostHog provider passes groups). If it does not, tenant rollout stays on the database provider.

## 7. Tests

- Every row of §2, including the Budi example.
- An organization on both lists is off.
- Unknown and purged organization IDs: rejected on write, removed by clean lists.
- An organization `owner` with platform role `user` gets 403 on the PATCH.

## 8. Tasks when adopted

| Task | Goal | Depends on |
|:---|:---|:---|
| TR-01 | Columns, evaluation order (§2–3), API changes and audit (§4) | FF-MT-01, SAAS-002 answered |
| TR-02 | Console pickers (§5) | TR-01, PC-03 |
