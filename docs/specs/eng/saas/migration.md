# Moving to Multi-Tenant and Adding SaaS Parts

> **Status: design only (DEC-047, DEC-050, DEC-051).** How a project at access stage 2 ([single-org.md](../auth/access/single-org.md)) becomes multi-tenant (**Step B**), and in which order the other SaaS parts are added. Step A (stage 1 → 2) comes first: [auth/access/migration.md](../auth/access/migration.md).

## 1. The flow

```
Stage 1 ──Step A──► Stage 2: single-org ──Step B──► Multi-tenant ──► + tenant rollout ──► + plans (manual) ──► + payment provider
(auth/access/migration.md)                (this file)  + platform console    (optional)           (optional)            (after Q33)
```

| | **Step B: stage 2 → multi-tenant** |
|:---|:---|
| Move when | You sell to more than one company and they must not see each other's data |
| Data migration? | **No**: `organization_id` and memberships already exist. Schema only: database roles and RLS policies |
| Releases | 2: (B1) row-level security, invisible to users → (B2) open multi-tenancy |
| Users signed out? | No |
| Also changes | Feature flag percentage (§3.4), observability (§3.5) |
| Done when | The isolation suite, including the RLS cases, passes (§3.6) |
| Going back | B1 at any time; B2 only before a second organization has real users (§5) |

- Skipping stage 2 is not possible: Step B assumes the organization core, `scoped(orgId)` and the platform layer are running.
- The platform console ships **in** release B2, because someone must be able to suspend a tenant from day one.

## 2. Starting a new project multi-tenant

Build stage 2 as in [auth/access/migration.md §2](../auth/access/migration.md), except ORG-05 (one hidden organization), and add in the same build:

- MT-01 to MT-10 ([multi-tenant.md §15](multi-tenant.md)), including RLS (MT-09);
- PC-01 to PC-03 ([platform-console.md §10](platform-console.md));
- FF-MT-01 if flags are adopted ([feature-flags.md §8](feature-flags.md)).

Blocked until an email sender exists (invitations).

## 3. Step B: stage 2 → multi-tenant

### 3.1 Before you start

- [ ] An email sender exists (invitations, [multi-tenant.md §6](multi-tenant.md)).
- [ ] Every module repository goes through `scoped(orgId)`, and the lint rule against `db` imports in `modules/*` is on ([architecture.md §3.1](architecture.md)).
- [ ] The isolation suite ([multi-tenant.md §13](multi-tenant.md)) passes at stage 2 with two test organizations.
- [ ] Every feature flag with a percentage between 0 and 100 is finished (set to 0 or 100) or accepted as reshuffled (§3.4).

### 3.2 Release B1: row-level security (nothing changes for users)

1. Create the database roles `app_owner`, `app_runtime`, `app_platform` ([architecture.md §4.2](architecture.md)). Move table ownership to `app_owner`.
2. Add the RLS policies to every module table ([architecture.md §4.3](architecture.md)) and the CI check for tables without a policy.
3. Change `scoped()` to open a transaction and set `app.org_id` ([architecture.md §4.4](architecture.md)).
4. Switch the API to `DATABASE_URL` = `app_runtime`, migrations to `app_owner`, and the `platform` module's `*AcrossTenants` functions to `DATABASE_PLATFORM_URL` = `app_platform`.
5. Run the RLS tests ([architecture.md §6](architecture.md)) against a copy of production data, then deploy.

With one organization, every row matches `app.org_id`, so users see no difference. Any query that bypassed `scoped()` now returns nothing: watch `http.error` and `security.tenant_violation` for one release cycle before B2.

### 3.3 Release B2: open multi-tenancy

1. Configuration: [multi-tenant.md §2](multi-tenant.md) (creating organizations allowed, limits, invitations).
2. Remove the two stage 2 hooks ([single-org.md §10.1](../auth/access/single-org.md)) and add the last-active-organization hook.
3. Extend the endpoint allowlist ([multi-tenant.md §11](multi-tenant.md)).
4. Ship the web onboarding, switcher and settings pages (MT-05 to MT-07) and the platform console's organization pages (PC-01, PC-03).
5. Existing users stay members of the primary organization, which keeps its data and runtime roles. Its owner may rename it; its slug stays.
6. New users create an organization or accept an invitation ([multi-tenant.md §4](multi-tenant.md)).
7. Remove `PRIMARY_ORG_SLUG` from the environment after the release.

### 3.4 Feature flags

Details: [feature-flags.md §5](feature-flags.md).

- The evaluation context gains `organizationId`, and the percentage rollout hashes `organizationId` instead of the user ID.
- Flags at 0% or 100% are unaffected. A flag between them is reshuffled: before B2, finish it or accept the new group.
- Flag management does not change: it is already on the platform layer since stage 2.

### 3.5 Observability

Details: [observability.md §4](observability.md).

- The MongoDB index `{ organizationId: 1, time: -1 }` is added (`bun run logs:setup`) in B1.
- New events: `security.tenant_violation` (B1), the multi-tenant `audit.org.*` events and `audit.platform.*` events (B2).
- Sentry gets an `organizationId` tag, and PostHog an `organization` group, when they are adopted.

### 3.6 Done when

- [ ] B1: the RLS tests pass, and `security.tenant_violation` stays at 0 for one release cycle in production.
- [ ] Existing users sign in and land in the primary organization with unchanged permissions.
- [ ] A new user creates an organization, becomes `owner`, and sees none of the primary organization's data.
- [ ] Invite, accept, switch and suspend flows pass ([multi-tenant.md §13](multi-tenant.md)).
- [ ] The platform console lists both organizations, and a `super_admin` can suspend the new one.

## 4. Adding the other SaaS parts

Each part is added after multi-tenant runs, one at a time ([README.md §5](README.md)):

| Part | Spec | Precondition | Migration |
|:---|:---|:---|:---|
| Tenant rollout | [tenant-rollout.md](tenant-rollout.md) | Flags adopted, FF-MT-01 done, SAAS-002 to SAAS-004 Answered | Two empty list columns on `feature_flag`; no behaviour change until a list is filled |
| Plans, manual | [plans-billing.md](plans-billing.md) | SAAS-005 to SAAS-011 Answered | Every existing organization gets the default plan (`free`, or a grandfathered plan) in one migration, so nobody loses a feature on release day |
| Payment provider | [plans-billing.md §7](plans-billing.md) | Q33 answered | Existing manual subscriptions stay manual until renewed |

## 5. Rollback and not supported

| Point | How | What is lost |
|:---|:---|:---|
| After B1 | Drop the policies, switch `DATABASE_URL` back to the single role, revert `scoped()` | Nothing |
| After B2, before a second organization has real users | Set `allowUserToCreateOrganization: false` and restore the stage 2 hooks | Organizations created in the meantime stay; their users lose access until moved |
| After a second organization has real users | Not supported | — |

- **Multi-tenant → stage 2:** not supported. It would merge tenants' data and roles.
- If it is ever needed, it is a separate, project-specific migration with its own decision.

## 6. Tasks

| Task | Goal | Depends on |
|:---|:---|:---|
| MIG-04 | Release B1: database roles, policies, `scoped()` transaction, Mongo index (§3.2, §3.5) | MT-09 |
| MIG-05 | Release B2 (§3.3), flag reshuffle check (§3.4), acceptance run (§3.6) | MIG-04, MT-01 to MT-08, PC-01, PC-03 |
