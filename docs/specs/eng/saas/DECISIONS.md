# SaaS Decisions

Decisions for the SaaS layer ([README.md](README.md)), kept apart from the main log ([../DECISIONS.md](../DECISIONS.md)) by DEC-049.

**Rules**

1. The SaaS layer starts with multi-tenant ([multi-tenant.md](multi-tenant.md), called "access stage 3" before DEC-050) and requires access stage 2. Nothing here is built at stage 1, and nothing here changes stage 2.
2. A SAAS entry may **add** to the SaaS layer. It may not change stages 1 or 2, or the rules in DEC-042 to DEC-051.
3. When a SAAS entry needs such a change, it stays **Proposed** until a DEC entry in the main log records it. The main log always wins.
4. Status values are the same as the main log: **Answered**, **Decided (lead)**, **Proposed** (do not implement), **Superseded**.

## Touch points with the access stages

Places where a SaaS decision meets an access rule. Each one is resolved here or marked as needing a DEC entry.

| SaaS topic | Access rule it meets | Resolution |
|:---|:---|:---|
| Row-level security | Stage 2 scoping through `scoped(orgId)` ([single-org.md §5](../auth/access/single-org.md)) | RLS is added only in Step B, inside `scoped()`; stage 2 has none (DEC-051, [architecture.md §4](architecture.md)). No change to stage 2 |
| Flags and observability | Stage 2 behaviour ([feature-flags/access-stages.md](../feature-flags/access-stages.md), [observability/access-stages.md](../observability/access-stages.md)) | Multi-tenant additions live in [feature-flags.md](feature-flags.md) and [observability.md](observability.md); stage 2 docs only point to them (DEC-050). No change to stage 2 |
| Plan limits (members, roles) | Fixed multi-tenant limits ([multi-tenant.md §10](multi-tenant.md)) | The multi-tenant values stay the defaults. A plan may only set a different value per organization (SAAS-007). No DEC needed |
| Plan attributes in flags | Flag context is user ID + organization ID only (DEC-048) | Plans never reach flags (SAAS-004). Adding an attribute would need a new DEC |
| `billing:*` permissions | Module statements and organization roles ([single-org.md §4](../auth/access/single-org.md)) | A new `billing` module with its own statement, built only with multi-tenant. Adding a module is normal. No DEC needed |
| Read-only state after failed payment | Organization states are `active`, `suspended`, `deleted` ([multi-tenant.md §8](multi-tenant.md)) | **Needs a DEC** to add a `read_only` state before SAAS-008 can be built |
| Sales-led onboarding | Organizations are created by users during onboarding ([multi-tenant.md §4](multi-tenant.md)) | A console route creates the organization and invites the owner; the invitation flow is unchanged (SAAS-010). No DEC needed |
| Cancellation and purge | Soft delete, then manual `org:purge` after 30 days ([multi-tenant.md §8](multi-tenant.md)) | Cancellation ends in the same soft delete and purge (SAAS-011). No DEC needed |

---

## SAAS-001: Platform console scope

**Status:** Answered (round 6: Q24 "own file"; round 7: "separate the platform console into SaaS")

- **Decision:** The platform console is the SaaS owner's cross-tenant admin area, built on the platform layer ([single-org.md §8](../auth/access/single-org.md)). It is required with multi-tenant. Cross-tenant reads happen only there, on the read-only `app_platform` database role ([architecture.md §4.2](architecture.md)), through `*AcrossTenants` functions. It is read-only towards customer content, audits every request, and never impersonates (DEC-032). Design in [platform-console.md](platform-console.md).
- **Trade-off:** No "view as customer" for support. In return, the console never becomes a back door to customer data.

## SAAS-002: Rule order for tenant rollout

**Status:** Proposed (Q28)

- **Recommendation:** kill switch → exclude user → exclude organization → include user → include organization → 100% → percentage by organization → off. Design in [tenant-rollout.md §2](tenant-rollout.md).
- **Why:** When a company says "no beta for us", one user on an include list must not break that promise.
- **Alternative:** include user before exclude organization, if single power users should win.

## SAAS-003: Tenants cannot opt in or out of flags themselves

**Status:** Proposed (Q29)

- **Recommendation:** Only the platform layer manages flags (DEC-048). A tenant that wants in or out asks you, and you edit the organization lists.
- **Why:** A second place to change flags means more endpoints, permissions and tests, and customers may switch on half-finished features.

## SAAS-004: Plans never go through flags

**Status:** Proposed (Q31)

- **Recommendation:** Paid features are checked with entitlements ([plans-billing.md §5](plans-billing.md)), not with flags. Flags keep only the organization ID (DEC-048).
- **Why:** Flags are temporary (they have a `removeBy` date). Plan rules are permanent and tied to money, so they need their own checks, history and tests.

## SAAS-005: Billing is provider-neutral, manual first

**Status:** Proposed (Q33: market, currency and tax are open)

- **Recommendation:** Plans and entitlements do not depend on any payment provider. Version 1 is **manual**: you set a company's plan and period in the console after it pays by bank transfer or invoice. A `BillingProvider` adapter adds Stripe or Xendit/Midtrans later.
- **Open:** Indonesia, global or both; IDR, USD or both; whether PPN applies. These decide the provider and the invoice format, not the plan model.

## SAAS-006: Flat plans, monthly and yearly

**Status:** Proposed (Q34)

- **Recommendation:** Plans `free`, `pro`, `business` with a fixed price per month or per year. No per-seat, usage-based or proration in version 1.

## SAAS-007: Plans control features and limits; plans in code, overrides in the console

**Status:** Proposed (Q35)

- **Recommendation:** Each plan lists boolean **features** and numeric **limits**. Plans live in code (reviewed, typed, deployed), like stage 1 roles. A per-organization **override** from the console handles custom deals (for example Pro plus 500 members). Stage 3 limits stay the defaults when no plan sets a value.

## SAAS-008: Plan lifecycle

**Status:** Proposed (Q36). **The read-only step needs a DEC entry first** (see Touch points).

- **Recommendation:** Free plan, optional 14-day trial. Upgrades apply now; downgrades at the end of the period. Over a limit after a downgrade: block new additions only, never delete. Failed payment: 7 days' grace → read-only → suspended.

## SAAS-009: Who handles billing in a tenant

**Status:** Proposed (Q37)

- **Recommendation:** Organization permissions `billing:read` and `billing:manage`. The `owner` holds both by default; others only if a role grants them. The console shows each organization's plan and failed payments; MRR reporting comes later.

## SAAS-010: Sales-led onboarding

**Status:** Proposed (Q38)

- **Recommendation:** You can create an organization from the console and invite its first person as `owner`. A company name field on the sign-up form is not in version 1.

## SAAS-011: Cancellation

**Status:** Proposed (Q39)

- **Recommendation:** After cancellation the organization stays usable until the end of the paid period, is then suspended, can export its data for 30 days, and is then purged with `org:purge` ([multi-tenant.md §8](multi-tenant.md)). Every step emits an audit event.
