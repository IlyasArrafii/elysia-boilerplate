# Access Stages

How the boilerplate decides **who may do what** inside one app. A project is at exactly **one access stage**, recorded as a decision before TASK-03 (DEC-042). **Stage 1, static roles, is the default.** Stage 2 is design only until a project adopts it.

Access has **two stages**. Selling to many separate customer companies (multi-tenancy) is not an access stage but the foundation of the SaaS layer: [saas/](../../../../specs/eng/saas/README.md) (DEC-050).

Better Auth names below come from the admin and organization plugin docs as of 2026-11. *Verify* them against the installed version.

## 1. The flow

```
Stage 1: static-roles (DEFAULT)  ──Step A──►  Stage 2: single-org            ┊  SaaS (saas/)
roles in code (admin plugin)                  1 hidden organization          ┊  multi-tenant ──► console,
user.role                                     roles + permissions granted    ┊  rollout, plans
                                              at runtime (member.role)       ┊
```

- Stage 2 builds on stage 1: the module `permissions.ts` files stay the same, only who holds the permissions changes.
- The move is **forward only**: [migration.md](migration.md) (Step A). Going back is not supported.
- A new project may **start** at either stage. Starting at the stage you need costs less than migrating later.
- **Multi-tenancy is SaaS.** It needs stage 2 first and is described, with its own migration, in [saas/](../../../../specs/eng/saas/README.md). Nothing in `saas/` changes stages 1 or 2 (DEC-049).

## 2. The two stages

| | **Stage 1: static-roles** (default) | **Stage 2: single-org** |
|:---|:---|:---|
| Spec | [static-roles.md](static-roles.md) | [single-org.md](single-org.md) |
| Better Auth plugins | `admin` | `admin` + `organization` (one hidden organization) |
| Where a user's role lives | `user.role` | `member.role` in the primary organization |
| Where roles are defined | Code only | Code roles + **runtime roles** (`organization_role`) |
| Who creates roles and grants permissions | A developer, with a deploy | A Super Admin or `owner`, from the UI, picking permissions from the code statements |
| Several roles per user | Yes, comma-separated | Yes, comma-separated |
| Organizations visible to users | No | No |
| `organization_id` on module tables | No | Yes (DEC-044) |
| Platform layer (`user.role` = `super_admin`/`user`) | No (one role system) | Yes: users, bans, sessions, flags ([single-org.md §8](single-org.md)) |
| Feature flags | [feature-flags/access-stages.md §2](../../feature-flags/access-stages.md) | [feature-flags/access-stages.md §3](../../feature-flags/access-stages.md) |
| Observability | [observability/access-stages.md §2](../../observability/access-stages.md) | [observability/access-stages.md §3](../../observability/access-stages.md) |
| Build cost | Lowest; [TASKS.md](../../TASKS.md) as written | ORG-01 to ORG-08 replace four tasks |

## 3. How to choose

1. **Must a non-developer create roles or change which permissions a role grants, without a deploy?** → **Stage 2: single-org**.
2. Otherwise → **Stage 1: static-roles**. Add custom roles in code ([static-roles.md §8](static-roles.md)).

Customers that are separate companies and must not see each other's data are a SaaS question, not this one: go to stage 2, then follow [saas/migration.md](../../../../specs/eng/saas/migration.md).

If unsure, start at stage 1. Moving later is planned in [migration.md](migration.md).

**Only the chosen stage is built.** Building both behind a config switch is rejected: it doubles the auth code that has to be secured and tested (DEC-042).

## 4. What both stages share

These stay the same, so modules never change shape:

- Each module declares its permissions in `permissions.ts` as a **statement** (`resource → actions`). Rules: [static-roles.md §3](static-roles.md).
- `apps/api/src/utils/auth/access.ts` merges the statements and fails startup on a duplicate resource key.
- Routes declare `{ permission: 'posts:write' }`. The macro hides which plugin answers the check.
- Ownership rules ("only the author edits this post") stay in the service.
- The web app checks permissions with `can()`, never role names. `GET /api/me/permissions` returns the permissions for the current user.
- Impersonation is blocked (DEC-032).
- Feature flags never decide access and never target roles (DEC-038).

What changes is only **who holds** the permissions:

| | Stage 1 | Stage 2 |
|:---|:---|:---|
| Grants in `permissions.ts` | `grants` per code role (`admin`, `user`, custom) | `grants` per organization code role (`owner`, `admin`, `member`, custom). Runtime roles pick from the statement |
| Permission check | Admin plugin `userHasPermission` on `user.role` | Organization plugin `hasPermission` on `member.role` in the primary organization |
| `user.role` holds | Every role | Only platform roles: `super_admin` or `user` (DEC-043) |

## 5. Two layers at stage 2

| Layer | Question it answers | Stored in | Plugin | Spec |
|:---|:---|:---|:---|:---|
| **Platform** | "Who runs the app itself?" Users, bans, sessions, feature flags | `user.role` = `super_admin` or `user` | admin | [single-org.md §8](single-org.md) |
| **Organization** | "What may this person do in the app's content?" | `member.role` = `owner`, `admin`, `member` or a runtime role | organization | [single-org.md §4–7](single-org.md) |

A platform role grants **no** module permissions. A `super_admin` who wants to edit posts needs an organization role that allows it (the seed makes the first `super_admin` the `owner`).

## 6. Documents

| File | Content |
|:---|:---|
| [static-roles.md](static-roles.md) | **Stage 1** (default): roles in code, admin plugin |
| [single-org.md](single-org.md) | **Stage 2**: organization plugin core, runtime roles, platform layer, one hidden organization |
| [migration.md](migration.md) | Picking a stage at project start, and **Step A** (1 → 2), including what changes for feature flags and observability |
| [../../feature-flags/access-stages.md](../../feature-flags/access-stages.md) | Feature flags at stages 1 and 2 |
| [../../observability/access-stages.md](../../observability/access-stages.md) | Logs and telemetry events at stages 1 and 2 |
| [../../saas/README.md](../../../../specs/eng/saas/README.md) | SaaS layer: multi-tenancy, its architecture and migration, platform console, tenant rollout, plans and billing |
