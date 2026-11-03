# SaaS Layer

> **Status: design only (DEC-047, DEC-049, DEC-050).** Everything needed to run the boilerplate **as a business** with many customer companies: multi-tenancy itself, its architecture, flags, observability and migration, the platform console, tenant rollout, plans and billing. It needs access **stage 2** ([auth/access/](../auth/access/README.md)) and is never built at stage 1. Decisions for this folder are in [DECISIONS.md](DECISIONS.md) (SAAS-xxx), separate from the main log.

## 1. Where it sits

```
Access (auth/access/)                       SaaS (this folder)
Stage 1: static-roles ──Step A──► Stage 2: single-org ──Step B──► Multi-tenant ──► platform console  required
(default)                         roles + permissions             (foundation)     tenant rollout    optional
                                  granted at runtime                               plans and billing optional
```

- **Access** answers "who may do what inside the app": roles in code (stage 1) or roles created at runtime with the permissions they grant (stage 2).
- **SaaS** answers "how do I run this for many companies": keep their data apart, let them sign up and invite colleagues, see and suspend them, roll features out per company, and charge them.
- Multi-tenant was called "access stage 3" in DEC-042 to DEC-048. It moved here because everything it needs (tenant isolation, a console, per-tenant observability) only matters when you sell to several companies (DEC-050).
- The SaaS layer only **adds** to stage 2. It never changes stages 1 and 2. A SaaS idea that needs an access change waits for a DEC entry in the main log first (DEC-049).

## 2. Parts

| Part | Spec | Needed | Status |
|:---|:---|:---|:---|
| Multi-tenant | [multi-tenant.md](multi-tenant.md) | **Foundation**: many organizations, onboarding, invitations, switching, lifecycle | Design |
| Architecture and isolation | [architecture.md](architecture.md) | **Required**: request pipeline, route groups, application filter + row-level security, database roles | Design (DEC-051) |
| Moving to multi-tenant | [migration.md](migration.md) | Step B from stage 2, and the order for adding the other parts | Design |
| Feature flags | [feature-flags.md](feature-flags.md) | **Required** when flags are adopted: percentage by organization | Design (DEC-048) |
| Observability | [observability.md](observability.md) | **Required**: per-tenant queries, isolation alert, tenant purge, vendor tags | Design |
| Platform console | [platform-console.md](platform-console.md) | **Required**: someone has to suspend tenants and see who uses the app | Design, answered (SAAS-001) |
| Tenant rollout | [tenant-rollout.md](tenant-rollout.md) | When a feature must be turned on for named companies ("beta for Acme") | Design, **Proposed** (SAAS-002 to SAAS-004) |
| Plans and billing | [plans-billing.md](plans-billing.md) | When customers pay for plans | **Draft**, Proposed (SAAS-005 to SAAS-011); Q33 open |

## 3. Who is who

| Person | Layer | Uses |
|:---|:---|:---|
| **You, the SaaS owner**, and your staff | Platform: `user.role` = `super_admin` or a platform code role | `/platform/*`: tenants, users, flags, plans |
| **A customer's owner or admin** | Organization: `member.role` = `owner`, `admin` or a runtime role | `/settings/*` of their own organization: members, roles, billing |
| **A customer's member** | Organization: `member.role` = `member` or a runtime role | The product itself |

Tenants never manage flags or plans, and never see platform pages.

## 4. A paid feature passes three checks

| # | Check | Question | Decided by | When it fails |
|:---|:---|:---|:---|:---|
| 1 | **Permission** | May this person do it? | Organization role ([single-org.md §6](../auth/access/single-org.md)) | `403 FORBIDDEN` |
| 2 | **Plan** | Does this company pay for it? | Entitlements ([plans-billing.md §5](plans-billing.md)) | `403 PLAN_UPGRADE_REQUIRED` |
| 3 | **Flag** | Is it released to this company yet? | Feature flag ([feature-flags.md](feature-flags.md)) | The old behaviour, or the feature is hidden |

The checks run in that order ([architecture.md §1](architecture.md)). Each has one job, so none replaces another:

- A flag never stands in for a plan. "Pro tenants get export" is a plan rule, not a flag targeting rule (SAAS-004).
- A plan never stands in for a permission. A Pro company's `member` still cannot do what only `admin` may do.

## 5. Adoption order

1. **Access stage 2** ([auth/access/migration.md](../auth/access/migration.md)), if the project is at stage 1.
2. **Multi-tenant + architecture + observability + platform console**, in Step B ([migration.md](migration.md)): MT-01…10, PC-01…03, MIG-04, MIG-05; FF-MT-01 if flags are adopted.
3. **Tenant rollout**, once a named-company rollout is needed (TR-01, TR-02).
4. **Plans with manual activation**: you set each company's plan in the console (BIL-01…05).
5. **A payment provider**, once Q33 is answered (BIL-06).

## 6. Open questions

These are **SaaS owner** questions. Tenants never manage flags or plans. Nothing here is built until it is answered. Recommendations are recorded as Proposed entries in [DECISIONS.md](DECISIONS.md).

**Tenant rollout**

- **Q28:** Order when user and organization rules disagree? Recommended: kill switch → exclude user → exclude organization → include user → include organization → percentage → off (SAAS-002).
- **Q29:** May a tenant opt itself into beta features? Recommended: no in the first version (SAAS-003).
- **Q31:** Plan-based behaviour goes through entitlements, never through flag attributes? Recommended: yes (SAAS-004). Flags already see only the organization ID (DEC-048).

**Plans and billing**

- **Q33:** Market and payment provider. **Your call:** Indonesia, global or both? IDR, USD or both? Do invoices need PPN (Indonesian VAT)? Recommended: provider-neutral, manual activation from the console first, then Stripe (global) or Xendit/Midtrans (Indonesia) (SAAS-005).
- **Q34:** Pricing model? Recommended: flat plans (Free / Pro / Business), monthly and yearly. No per-seat or usage pricing in v1 (SAAS-006).
- **Q35:** What does a plan control? Recommended: features and limits, plans in code, per-organization overrides from the console (SAAS-007).
- **Q36:** Plan lifecycle? Recommended: free plan plus an optional 14-day trial; upgrade now, downgrade at period end; over a limit, block new additions only; failed payment → 7 days' grace → read-only → suspended (SAAS-008).
- **Q37:** Who handles billing in a tenant? Recommended: `owner`, plus anyone given `billing:manage`. The console shows each organization's plan and failed payments; MRR later (SAAS-009).

**Onboarding and offboarding**

- **Q38:** Extra sign-up flows? Recommended: sales-led yes (you create the organization in the console and invite its owner); company name on the sign-up form no (SAAS-010).
- **Q39:** What happens when a tenant cancels? Recommended: active until period end → suspended → data export for 30 days → purge, with audit events (SAAS-011).
