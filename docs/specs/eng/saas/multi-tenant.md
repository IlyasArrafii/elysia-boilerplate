# Multi-Tenant

> **Status: design only (DEC-042, DEC-047, DEC-050).** The foundation of the SaaS layer: many customer companies (**tenants**) in one app. It needs access **stage 2** ([single-org.md](../auth/access/single-org.md)) and reuses all of it **except §10** (the one hidden organization), which this file replaces. Older decisions call it "access stage 3". Architecture and tenant isolation, including row-level security: [architecture.md](architecture.md). Moving here from stage 2: [migration.md](migration.md) (Step B). Operating it needs the platform console: [platform-console.md](platform-console.md).

## 1. What changes from stage 2

| Concern | Stage 2: single-org | Multi-tenant |
|:---|:---|:---|
| Organizations | One, hidden, created by the seed | Many; each customer company is one **tenant** |
| Creating one | Nobody | A signed-in user, during onboarding (§4) |
| Joining | Automatic at sign-up | Invitation (§6) or creating your own organization |
| Active organization | Always the primary one | Chosen by the user; remembered (§5) |
| Runtime roles | One set | One set per organization (§7) |
| Removing someone | Platform ban | Organization admin removes the member; platform ban for the whole app |
| Platform | Platform layer: users, bans, flags ([single-org.md §8](../auth/access/single-org.md)) | Platform layer + platform console: organizations, suspension, audit ([platform-console.md](platform-console.md)) |
| Tenant isolation | Application filter (`scoped(orgId)`) | Application filter **plus PostgreSQL row-level security** ([architecture.md §3–4](architecture.md), DEC-051) |
| Feature flags | Users only | Percentage by organization ([feature-flags.md](feature-flags.md)) |
| Observability | `organizationId` in log context | Plus per-tenant queries, Sentry tag, PostHog group, tenant purge ([observability.md](observability.md)) |
| Isolation risk | Low (one organization) | **High**: a missing filter leaks one customer's data to another |

## 2. Configuration differences

```ts
// packages/auth/src/server.ts (sketch): only what differs from single-org.md §2
organization({
  allowUserToCreateOrganization: async (user) => user.emailVerified === true,   // TBD: needs an email sender
  organizationLimit: 5,                     // organizations a user may create
  membershipLimit: 100,                     // members per organization (TBD per product)
  invitationExpiresIn: 60 * 60 * 24 * 7,    // 7 days
  invitationLimit: 50,                      // pending invitations per organization
  cancelPendingInvitationsOnReInvite: true,
  sendInvitationEmail: sendInvitation,      // real email sender required (§6)
})
```

The two stage 2 hooks (auto-join and forced active organization, [single-org.md §10.1](../auth/access/single-org.md)) are **removed**. `PRIMARY_ORG_SLUG` is not used.

## 3. Tenant isolation

The full design is in [architecture.md §3–5](architecture.md). It is a release blocker. In short:

1. **Two layers.** The application filters every query by the active organization through `scoped(orgId)`, and PostgreSQL row-level security refuses any row of another organization even when the application filter is missing (DEC-051).
2. **The organization comes from the session, never from the request.** Module routes ignore any `organizationId` in the body, query or path. Switching happens only through `set-active` (§5).
3. **Not found, not forbidden.** Another tenant's record ID returns `404`, never `403`.
4. **Caches, queues, pub/sub and files carry the organization** in their key, channel or path.
5. **Cross-tenant reads** happen only in the `platform` module, through a separate read-only database role ([architecture.md §4.2](architecture.md)).

## 4. Sign-up and onboarding

| Situation after sign-in | Web app goes to |
|:---|:---|
| User has one or more memberships | Last active organization (§5) |
| No membership, a pending invitation for their email | `/onboarding/invitations`: accept or reject |
| No membership, no invitation | `/onboarding/create-organization` |

- Creating an organization makes the creator its `owner` (plugin `creatorRole`) and sets it active.
- A user with no membership can use only: profile, onboarding, accepting invitations, sign-out. Module routes return `403 NO_ACTIVE_ORGANIZATION`.
- `slug`: lowercase letters, digits and `-`, 3–40 chars, unique, checked with the plugin's slug check. Reserved slugs (`platform`, `settings`, `api`, `admin`, `app`, `onboarding`) are refused.

## 5. Active organization and switching

- The active organization lives in the session (`session.activeOrganizationId`), not in the URL. All tabs of one browser share it.
- On sign-in, `databaseHooks.session.create.before` sets it to the user's last active organization (stored as `user.last_active_organization_id`, an additional field) if they are still a member, else the oldest membership, else `null`.
- Switching: `POST /api/auth/organization/set-active`. The plugin refuses an organization the user is not a member of (*verify*). Our hook refuses a `suspended` or `deleted` one with `403 ORGANIZATION_SUSPENDED`.
- After a switch the web app clears the whole TanStack Query cache and refetches `/api/me/permissions`. Nothing from the previous organization stays on screen.
- The header shows an organization switcher with only the user's memberships.

## 6. Invitations

| Step | Endpoint (*verify*) | Needs |
|:---|:---|:---|
| Invite by email with a role | `invite-member` | `invitation:create` |
| List pending invitations | `list-invitations` | `invitation:read` (*verify* resource name) |
| Cancel an invitation | `cancel-invitation` | `invitation:cancel` |
| Accept / reject | `accept-invitation` / `reject-invitation` | Signed in as the invited email |

- Only the invited email address can accept (plugin). The invite link goes to `/onboarding/invitations/{id}`.
- You can invite with a role you hold or lower: a role whose permissions are all in your own set (same rule as granting, [single-org.md §7](../auth/access/single-org.md)). `owner` can be offered only by an owner.
- **Blocker:** invitations need a real email sender. The boilerplate has none yet ([auth/README.md §2](../auth/README.md), `TBD`). Until one exists, multi-tenant cannot ship. Shareable invitation URLs (`getInvitationURL`) are not a substitute: they skip the email check.
- Events: `audit.org.invitation_sent`, `invitation_accepted`, `invitation_rejected`, `invitation_cancelled` (§12).

## 7. Roles per organization

- **Code roles** (`owner`, `admin`, `member`, any custom code role) exist in every organization and are the same everywhere.
- **Runtime roles** belong to one organization. A new organization starts with code roles only.
- `maximumRolesPerOrganization` caps runtime roles (default 20).
- The platform console can list an organization's roles read-only; it never edits them.

## 8. Organization lifecycle

| State | Set by | Effect |
|:---|:---|:---|
| `active` | Creation | Normal |
| `suspended` | `super_admin` in the platform console ([platform-console.md §4](platform-console.md)) | All organization-scoped routes return `403 ORGANIZATION_SUSPENDED`; members can still sign in, use other organizations and see a "suspended" page for this one; data kept |
| `deleted` | Owner (settings, confirm by typing the slug) or `super_admin` | Same as suspended, plus hidden from the switcher; data kept for 30 days (`TBD` per product) |
| Purged | Operator runs `bun run org:purge --older-than 30d` (`--dry-run` first) with the owner database role | Rows deleted from every module table, then the organization. Its log lines are pruned too, except audit events ([observability.md §5](observability.md)) |

`disableOrganizationDeletion: true` stays on: the plugin's hard delete is never reachable. Purging is manual, like log retention (DEC-034).

## 9. Members leaving and being removed

- An organization `admin` removes a member with `remove-member` (`member:delete`). The member's sessions with that organization active get `activeOrganizationId = null` on the next request.
- A member may leave (`leave`). The last owner cannot leave or be removed (plugin); ownership is transferred first.
- Removing a member never deletes their content. Ownership rules on that content then fail for them, and `posts:manage_all` holders can edit it.

## 10. Limits

| Limit | Value |
|:---|:---|
| Organizations a user may create | 5 (`organizationLimit`) |
| Members per organization | 100 (`membershipLimit`, `TBD` per product) |
| Pending invitations per organization | 50 |
| Runtime roles per organization | 20 |
| Invitation lifetime | 7 days |

These are the defaults for every tenant. Different limits per tenant (for paying customers) belong to [plans-billing.md](plans-billing.md); without it, these values apply to everyone.

## 11. Allowed organization endpoints

Single-org's list ([single-org.md §10.3](../auth/access/single-org.md)) plus: `create`, `update`, `check-slug`, `list` (the user's organizations), `set-active`, `get-full-organization`, `remove-member`, `leave`, `invite-member`, `list-invitations`, `get-invitation`, `accept-invitation`, `reject-invitation`, `cancel-invitation`. Not allowed: `delete` (soft delete goes through our `settings` module), team endpoints, `add-member` from the client.

## 12. Audit events

In addition to [single-org.md §13](../auth/access/single-org.md). The full multi-tenant event list, including security events, is in [observability.md §3](observability.md).

| Event | Payload |
|:---|:---|
| `audit.org.created` | `organizationId, actorId` |
| `audit.org.updated` | `organizationId, fields, actorId` (field names only) |
| `audit.org.deleted` / `audit.org.restored` | `organizationId, actorId` |
| `audit.org.invitation_sent` | `organizationId, invitationId, role, actorId` (no email) |
| `audit.org.invitation_accepted` / `rejected` / `cancelled` | `organizationId, invitationId, userId?, actorId?` |
| `audit.org.member_left` | `organizationId, userId` |
| `audit.org.switched` | `fromOrganizationId, toOrganizationId, userId` (info, not audit, if volume is high) |

## 13. Tests: isolation suite

A release blocker. In `apps/api/tests/e2e/isolation/`, generated for **every** organization-scoped route:

- Two organizations A and B, each with an owner and a member, each with data.
- A's member: read, update and delete B's record IDs → `404`; lists contain only A's rows; counts match A only.
- Body, query or path carrying B's `organizationId` → ignored (still A's data).
- After switching to B, nothing from A is returned or cached.
- Suspended B → `403 ORGANIZATION_SUSPENDED` for B's members on B; A unaffected.
- A CI check fails when a new organization-scoped route has no isolation case.
- Row-level security cases from [architecture.md §6](architecture.md) run in the same suite.

Plus: onboarding redirects (§4), invitation rules (§6), lifecycle states (§8), last-owner protection (§9).

## 14. Out of scope

- Plans, billing, per-tenant limits and tenant rollouts: other SaaS parts ([README.md](README.md)).
- Custom domains or subdomains per tenant.
- A database or schema per tenant.
- SSO/SAML per tenant.
- Teams inside an organization.
- Impersonation or "log in as customer" (DEC-032).

## 15. Tasks when adopted

On top of [single-org.md §15](../auth/access/single-org.md) and [platform-console.md §10](platform-console.md):

| Task | Goal | Depends on |
|:---|:---|:---|
| MT-01 | Config (§2), last-active hook (§5), suspended check, allowlist (§11) | ORG-03 |
| MT-02 | Isolation lint rule and isolation suite (§3, §13, [architecture.md §3](architecture.md)) | ORG-02 |
| MT-03 | Email sender + invitations (§6) | Email sender decision (blocker) |
| MT-04 | Lifecycle: soft delete, restore, `org:purge` (§8) | MT-01, MT-09 |
| MT-05 | Web onboarding pages (§4) | MT-01, TASK-09 |
| MT-06 | Web organization switcher and cache reset (§5) | MT-01, TASK-14 |
| MT-07 | Web settings: invitations, remove member, organization profile, delete (§6, §8, §9) | ORG-06, MT-03, MT-04 |
| MT-08 | Web E2E flows: onboarding, invite and accept, switch, suspended page | MT-05, MT-06, MT-07 |
| MT-09 | Row-level security: database roles, policies, `scoped(orgId)` transaction, RLS tests ([architecture.md §4, §6](architecture.md)) | ORG-02 |
| MT-10 | Multi-tenant observability ([observability.md §8](observability.md)) | MT-01, MT-09 |
