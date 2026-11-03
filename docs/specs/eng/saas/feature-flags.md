# Feature Flags in Multi-Tenant

> **Status: design only (DEC-048, DEC-050).** How feature flags behave once the app is multi-tenant ([multi-tenant.md](multi-tenant.md)). Stages 1 and 2 are in [feature-flags/access-stages.md](../feature-flags/access-stages.md); the flag system itself is in [feature-flags/](../feature-flags/README.md). Flags stay role-free (DEC-038) and global (DEC-048). Naming companies on a flag ("beta for Acme") is the optional add-on [tenant-rollout.md](tenant-rollout.md).

## 1. Summary

| | Stage 2: single-org | **Multi-tenant** |
|:---|:---|:---|
| Evaluation context | `targetingKey` (user ID) | `targetingKey` (user ID) + `organizationId` (active organization) |
| Percentage rollout hashes | User ID | **Organization ID** (Q27) |
| User include/exclude lists | Yes | Yes, unchanged |
| Organization include/exclude lists | No | Only with [tenant-rollout.md](tenant-rollout.md) |
| Who manages flags | Platform layer | Platform layer, unchanged. Tenants never manage flags (SAAS-003) |
| `feature_flag` table | Global | Global, no `organization_id`, no RLS ([architecture.md §4.1](architecture.md)) |

## 2. Evaluation context

| Field | Source | Notes |
|:---|:---|:---|
| `targetingKey` | `user.id` | Missing for guests |
| `organizationId` | `session.activeOrganizationId` | Missing for guests and users with no active organization (onboarding) |

`organizationId` is an internal ID, not personal data. It is the only organization attribute: no name, plan, size or country (DEC-048, SAAS-004). The context test changes from "exactly one key" to "exactly these keys".

## 3. Rules

The order in [targeting.md §3](../feature-flags/targeting.md) stays. Only rule 7, the percentage, changes:

| # | Condition | Value |
|:---|:---|:---|
| 7 | `organizationId` present and `bucket(seed, organizationId) < rolloutPercentage` | on value (`SPLIT`) |

- Everyone in one company gets the same answer, so screens never differ between colleagues.
- User include and exclude lists keep working, so you can still turn a flag on for one person.
- No `organizationId` (guest, or a user still in onboarding): rule 7 cannot match, as with guests today. Only 100% turns the flag on.
- `rolloutPercentage` now means "percentage of organizations". The admin API and the console page label it that way.
- One bucketing key for the whole app. A per-flag choice between user and organization is not in the first version.

## 4. Caching and the web app

- The provider's snapshot is global, so nothing changes in its cache.
- `/api/feature-flags/evaluate` returns values for the active organization. The web app's query key includes the organization ID, and switching organizations clears the whole query cache anyway ([multi-tenant.md §5](multi-tenant.md)).

## 5. Step B (stage 2 → multi-tenant)

| What changes | Action |
|:---|:---|
| Percentage hashes organizations instead of users | Flags at 0% or 100% are unaffected. A flag between them is reshuffled: before release B2, finish it (0 or 100) or accept the new group ([migration.md §3.4](migration.md)) |
| Context gains `organizationId` | Shipped in B2 with the context test update |
| Management | Nothing: already on the platform layer since stage 2 |

## 6. PostHog provider

PostHog matches organizations with **groups** (a group type `organization`, keyed by `organizationId`). *Verify* that the OpenFeature PostHog provider passes groups through. If it does not, multi-tenant stays on the database provider ([posthog-provider.md](../feature-flags/posthog-provider.md)).

## 7. Tests

- Two users in one organization always get the same percentage result.
- 1 000 organizations at 25% land within 22–28%.
- A user with no active organization gets the off value below 100%.
- User include and exclude still win over the percentage.
- The context builder outputs exactly `targetingKey` and `organizationId`.

## 8. Tasks when adopted

| Task | Goal | Depends on |
|:---|:---|:---|
| FF-MT-01 | `organizationId` in the context, percentage by organization, labels (§2–4) | FF-ORG-01, MT-01 |
