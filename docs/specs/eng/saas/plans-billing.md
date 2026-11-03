# Plans and Billing

> **Status: Draft, design only.** Built on the **Proposed** answers SAAS-004 to SAAS-011. **Q33 (market, currency, tax) is open.** Do not build anything until those are Answered ([DECISIONS.md](DECISIONS.md)). Requires [multi-tenant.md](multi-tenant.md). Every value marked `TBD` stays `TBD`.

## 1. Goal

Let each customer company (organization) be on a plan that turns features on and sets limits, and let you, the SaaS owner, charge for it. Version 1 activates plans **by hand** in the platform console. A payment provider comes later (SAAS-005).

## 2. Terms

| Term | Meaning |
|:---|:---|
| **Plan** | A named package in code: `free`, `pro`, `business` (SAAS-006) |
| **Feature** | A yes/no entitlement, e.g. `posts.export` |
| **Limit** | A number, e.g. `members: 10` |
| **Entitlements** | What one organization gets right now: its plan's features and limits, plus any override |
| **Subscription** | One organization's plan, interval, period and status |
| **Override** | A per-organization exception set in the console (custom deals) |

## 3. Plans in code (SAAS-007)

```ts
// apps/api/src/modules/billing/plans.ts (sketch; prices and limits TBD)
export const plans = definePlans({
  free:     { features: [],                               limits: { members: 3,   runtimeRoles: 0 } },
  pro:      { features: ['posts.export'],                 limits: { members: 25,  runtimeRoles: 5 } },
  business: { features: ['posts.export', 'audit.export'], limits: { members: 100, runtimeRoles: 20 } },
})
export const prices = { /* TBD after Q33: currency, monthly and yearly per plan */ }
```

- Feature keys are `module.feature`, declared by the owning module, and checked at startup like permissions.
- A limit missing from a plan falls back to the multi-tenant default ([multi-tenant.md §10](multi-tenant.md)).
- Changing a plan is a code change with review and a deploy. Customers already on the plan get the new values.

## 4. Data

Organization-scoped tables in the `billing` module (DEC-044):

| Table | Columns |
|:---|:---|
| `subscription` | `organization_id` (unique), `plan_key`, `interval` (`month`, `year`), `status` (`trialing`, `active`, `past_due`, `canceled`), `current_period_start`, `current_period_end`, `cancel_at_period_end`, `provider` (`manual` in v1), `provider_ref`, timestamps |
| `plan_override` | `organization_id` (unique), `features` (jsonb, add or remove), `limits` (jsonb), `reason` (stored, never logged), `expires_at`, `created_by`, timestamps |
| `billing_event` | Provider webhook events for idempotency: `provider`, `event_id` (unique per provider), `received_at`. Used from BIL-06 |

A new organization gets `subscription(plan_key = 'free', status = 'active')`, or `trialing` on `pro` for 14 days if trials are on (SAAS-008).

## 5. Checking entitlements

| Check | How | Failure |
|:---|:---|:---|
| Feature | Route option `{ entitlement: 'posts.export' }`, after `permission` | `403 PLAN_UPGRADE_REQUIRED` with `{ feature }` |
| Limit | The owning service checks before creating (for example before an invitation or a runtime role) | `403 PLAN_LIMIT_REACHED` with `{ limit, max }` |

- Entitlements are computed per organization and cached in Redis (`org:{orgId}:entitlements`, TTL 5 minutes), cleared on any plan, override or status change.
- `GET /api/me/permissions` gains `entitlements: { features: string[], limits: Record<string, number> }` for the active organization. The web app hides or marks paid features with it, and the API stays the source of truth.
- Order with the other checks: permission → entitlement → flag ([README.md §4](README.md)).
- Members-per-organization: *verify* whether the organization plugin's `membershipLimit` accepts a function per organization. If not, our `hooks.before` on invite and add-member enforces the plan limit.

## 6. Lifecycle (SAAS-008)

| Event | Effect |
|:---|:---|
| Trial ends without a plan | Back to `free`; over-limit rule applies |
| Upgrade | Applies now. Manual: you set the new plan and period |
| Downgrade | Applies at `current_period_end` (`cancel_at_period_end`-style pending change) |
| Over a limit after a downgrade | Nothing is deleted; new additions are blocked with `PLAN_LIMIT_REACHED` until under the limit |
| Payment fails | `past_due`, 7 days' grace with a banner for `billing:read` holders |
| Grace ends | **Read-only** (needs a DEC entry for a new organization state, see [DECISIONS.md](DECISIONS.md#touch-points-with-the-access-stages)), then `suspended` after `TBD` days |

## 7. Payment

**Version 1, manual (SAAS-005).** The customer pays by bank transfer or invoice outside the app. You open the organization in the console and set plan, interval and period, with the invoice number as `provider_ref`. Every change emits `audit.billing.subscription_changed`.

**Later, a provider (BIL-06).** Blocked on Q33.

```ts
// sketch
interface BillingProvider {
  createCheckout(orgId: string, plan: PlanKey, interval: Interval): Promise<{ url: string }>
  cancel(orgId: string): Promise<void>
  parseWebhook(req: Request): Promise<BillingEvent>   // verifies the signature
}
```

- Candidates: Stripe (global, cards, subscriptions) or Xendit/Midtrans (Indonesia: VA, QRIS, e-wallets). *Verify* each one's subscription support at adoption.
- Webhooks: `POST /api/billing/webhooks/:provider`, signature checked, deduplicated by `billing_event`, never trusted for anything the signature does not cover.
- Currency, tax (PPN) and invoice format: `TBD` (Q33).

## 8. Tenant pages

| Page | Needs | Shows |
|:---|:---|:---|
| `/settings/billing` | `billing:read` | Current plan, period, usage against limits, status banner |
| Change plan | `billing:manage` | Version 1: "Request upgrade" (emits `billing.upgrade_requested`, you follow up). With a provider: checkout |

`billing:read` and `billing:manage` come from the `billing` module's statement. `owner` holds both by default (SAAS-009).

## 9. Console additions

On `/platform/organizations/:id` ([platform-console.md §7](platform-console.md)):

| Action | Platform permission |
|:---|:---|
| See plan, status, period, override | `platform_billing:read` |
| Set plan and period, extend trial, set or remove override | `platform_billing:write` |
| `/platform/billing`: organizations by plan, `past_due` list | `platform_billing:read` |

MRR and revenue reports are later.

## 10. Cancellation (SAAS-011)

Cancel → active until `current_period_end` → `suspended` → owner can export data for 30 days → soft delete and `org:purge` ([multi-tenant.md §8](multi-tenant.md)). The export format is `TBD`.

## 11. Audit events

| Event | Payload |
|:---|:---|
| `audit.billing.subscription_changed` | `organizationId, fromPlan, toPlan, status, actorId` |
| `audit.billing.override_set` / `override_removed` | `organizationId, fields, actorId` (field names only) |
| `billing.upgrade_requested` | `organizationId, plan, actorId` (product event) |

## 12. Out of scope (version 1)

Per-seat and usage pricing, proration, coupons, several currencies (pending Q33), tax invoices, self-serve checkout (until a provider is chosen).

## 13. Tests

- Entitlement matrix: each plan × every route with an `entitlement` → expected status.
- Limits: at the limit → `PLAN_LIMIT_REACHED`; a downgrade never deletes data.
- Overrides beat the plan, and expire.
- Cache is cleared on every plan, override and status change.
- An organization `admin` without `billing:read` gets 403 on billing pages.

## 14. Tasks (draft, after the SAAS entries are Answered)

| Task | Goal | Depends on |
|:---|:---|:---|
| BIL-01 | `billing` module: plans in code, tables, default subscription on organization create | MT-01 |
| BIL-02 | Entitlement service, `entitlement` route option, limit checks, cache, `/api/me/permissions` field | BIL-01 |
| BIL-03 | Console: plan panel, overrides, `/platform/billing` | BIL-01, PC-03 |
| BIL-04 | Tenant `/settings/billing` page and upgrade request | BIL-02, ORG-06 |
| BIL-05 | Lifecycle jobs: trial end, downgrade at period end, grace (read-only waits for its DEC) | BIL-02 |
| BIL-06 | Payment provider adapter and webhooks | Q33 answered |
