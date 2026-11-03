# Moving Between Access Stages

> **Status: design only (DEC-042, DEC-047, DEC-050).** How a project picks its access stage at the start, and how it moves from stage 1 to stage 2 later (**Step A**). Moving on to multi-tenancy is a SaaS step with its own spec: [saas/migration.md](../../saas/migration.md). Detailed scripts and rollback are in the appendices.

## 1. The flow

```
Stage 1: static-roles (DEFAULT)  ──Step A──►  Stage 2: single-org  ┊ ──Step B──► multi-tenant (saas/migration.md)
```

| | **Step A: stage 1 → stage 2** |
|:---|:---|
| Move when | A non-developer must create roles or change which permissions a role grants |
| Data migration? | **Yes**: create the primary organization, add `organization_id`, one `member` row per user, map roles |
| Releases | 3: expand → migrate and switch → clean up |
| Users signed out once? | Yes |
| Also changes | Feature flag management (§4.1) and log context (§4.2) |
| Done when | Every user has exactly the same permissions before and after (§3.5) |
| Going back | Only within 30 days ([Appendix B](#appendix-b-rollback)) |

- **Backwards** (stage 2 → 1) is not supported (§5).
- **Stage 1 → multi-tenant** has no shortcut: run Step A, run stage 2 for at least one release cycle, then follow [saas/migration.md](../../saas/migration.md). Doing both at once mixes a data migration with new isolation risk.

## 2. Starting a new project

Pick the stage with [README.md §3](README.md) and record it as a project decision ("Access stage: …") before TASK-03.

| Stage | Changes to [TASKS.md](../../TASKS.md) |
|:---|:---|
| **1: static-roles** (default) | None. Build TASK-01 to TASK-19 as written |
| **2: single-org** | TASK-03 also generates the organization tables and adds `organization_id` to `post`; its seed creates the primary organization. TASK-04 → ORG-01. TASK-05 → ORG-03. TASK-06 → ORG-07. TASK-17 → ORG-06 + ORG-08. Add ORG-02, ORG-04, ORG-05 ([single-org.md §15](single-org.md)). TASK-12 also adds the stage 2 log fields and events ([observability/access-stages.md §3](../../observability/access-stages.md)) |

A project that must start multi-tenant starts at stage 2 and adds [saas/migration.md §2](../../saas/migration.md) in the same build.

Starting directly at stage 2 costs less than migrating later: no backfill and no forced sign-out.

## 3. Step A: stage 1 → stage 2

### 3.1 Before you start

- [ ] The decision to move to stage 2 is recorded.
- [ ] A full PostgreSQL backup is taken and a restore has been tested.
- [ ] The whole migration has run once on a copy of production data.
- [ ] A maintenance window is announced: everyone is signed out once.
- [ ] The **permissions snapshot** is saved: for every user, user ID → sorted permission list under stage 1. It is the acceptance check (§3.5).
- [ ] The list of users who will lose `feature_flag:*` is reviewed (§4.1).

### 3.2 Release 1: expand (nothing changes for users)

- Add the organization plugin's tables. The plugin is configured, but no route uses it yet.
- Add `organization_id` as **nullable** to every module table.
- Add the `access_migration_backup` table ([Appendix A](#appendix-a-migration-script)).

### 3.3 Release 2: migrate and switch

- Run `bun run access:migrate-to-org` (`--dry-run` first). In one transaction it creates the primary organization, gives every user a `member` row, maps roles, fills `organization_id`, makes it `NOT NULL` and signs everyone out ([Appendix A](#appendix-a-migration-script)).
- Role mapping:

| Stage 1 role | Organization role (`member.role`) | Platform role (`user.role`) |
|:---|:---|:---|
| `super_admin` | `owner` | `super_admin` |
| `admin` | `admin` | `user` |
| `user` | `member` | `user` |
| Custom code role (e.g. `editor`) | Same name, as an organization **code** role | `user` |

- Deploy the stage 2 code (ORG-01 to ORG-08) right after the script. From now on, checks use `member.role`.
- The script emits `access.migrated { users, organizationId, unknownRoles }` (§4.2).

### 3.4 Release 3: clean up (after 30 days)

- Drop `access_migration_backup` and the rollback script.
- Remove stage 1 code: the module role registry in `roles.ts`, the `userHasPermission` path in the `permission` macro and the `rbac.unknown_role` startup check (replaced by `access.unknown_platform_role`).

### 3.5 Done when

- [ ] Every user's organization permission set equals the §3.1 snapshot, except `feature_flag:*`, which is compared separately (§4.1). A former `super_admin` holds the same set as `owner`; platform permissions are reported separately.
- [ ] Every user has exactly one `member` row, and no `organization_id` is null.
- [ ] `access.member_missing` and `access.unknown_platform_role` are not emitted at startup.
- [ ] The stage 1 matrix tests, re-keyed to organization roles, pass.
- [ ] Sign-in, a protected read, a protected write and a role change work end to end.
- [ ] Every log line inside an organization-scoped route carries `organizationId` (§4.2).

## 4. What else changes in Step A

### 4.1 Feature flags

Details: [feature-flags/access-stages.md §4](../../feature-flags/access-stages.md).

- `feature_flag:read|write` moves from the module statement to the **platform** statement. Only `super_admin` (and an optional `platform_support`) manage flags afterwards.
- Users who held `feature_flag:read` through the stage 1 `admin` role lose it. The migration script prints them; give each one `platform_support` or accept the loss.
- The admin page `/admin/feature-flags` becomes `/platform/feature-flags`.
- Targeting does **not** change: rules still use the user ID only, so no flag result changes for any user.

### 4.2 Observability

Details: [observability/access-stages.md §4](../../observability/access-stages.md).

- Log context gains `organizationId` inside organization-scoped routes. Older lines in the log store do not have it; queries must not assume it.
- New events: `access.migrated`, `access.member_missing`, `access.unknown_platform_role`, `access.stale_permission` and the `audit.org.*` events of [single-org.md §13](single-org.md).
- `rbac.unknown_role` stops after Release 3. Dashboards or saved queries that use it switch to `access.unknown_platform_role`.
- Audit history is kept as it is: stage 1 `audit.user.role_changed` lines stay, and stage 2 role changes are `audit.org.member_role_changed`.

## 5. Not supported

- **Stage 2 → stage 1:** runtime roles have no code equivalent.

If it is ever needed, it is a separate, project-specific migration with its own decision.

## 6. Tasks

| Task | Goal | Depends on |
|:---|:---|:---|
| MIG-01 | Release 1 schema (§3.2) and the permissions snapshot export | Decision to migrate |
| MIG-02 | `access:migrate-to-org` and `access:rollback-from-org` scripts, both with `--dry-run`, tested on a production copy (Appendix A, B) | MIG-01, ORG-01 |
| MIG-03 | Acceptance run (§3.5), flag and observability changes (§4), and the clean-up release (§3.4) | MIG-02, ORG-06, ORG-08 |

Step B tasks are in [saas/migration.md §5](../../saas/migration.md).

## Appendix A: migration script

`access_migration_backup (user_id text primary key, old_role text not null, migrated_at timestamptz not null)` is created in Release 1.

`bun run access:migrate-to-org --dry-run` prints counts. Without `--dry-run`, it runs in **one transaction**:

1. Create the primary organization (slug `PRIMARY_ORG_SLUG`, default `app`). Its owner is the oldest `super_admin`.
2. Copy every `user.role` into `access_migration_backup`.
3. Insert one `member` row per user, mapping roles as in §3.3, plus:

| Stage 1 value | Organization role | Platform role |
|:---|:---|:---|
| Several roles (`"admin,editor"`) | Each mapped, duplicates removed, joined with `,` and no spaces | `super_admin` if any was `super_admin`, else `user` |
| Unknown role (`rbac.unknown_role`) | `member` | `user`, and listed in the script output |

4. Set `user.role` to the platform role.
5. Fill `organization_id` on every module table with the primary organization's ID.
6. Make `organization_id` `NOT NULL`, add the foreign key and the per-organization indexes and unique constraints ([single-org.md §5](single-org.md)).
7. Revoke all sessions: delete from `session` and remove the session keys from Redis. Every user signs in again, and the new session gets `activeOrganizationId` from the stage 2 hook.
8. After commit, emit `access.migrated` and print the users who lose `feature_flag:*` (§4.1).

Custom code roles move as code: their `grants` in each module's `permissions.ts` are re-keyed from the stage 1 role name to the same organization role name. They are **not** turned into runtime roles, so they stay reviewed and typed. A `super_admin` can later recreate them as runtime roles if they should become editable.

## Appendix B: rollback

| Point | How | What is lost |
|:---|:---|:---|
| After Release 1 | Drop the new tables and columns | Nothing |
| Within 30 days of Release 2 | Redeploy Release 1 code, run `bun run access:rollback-from-org` (restores `user.role` from the backup table, revokes sessions) | Runtime roles created since the switch. Rows created since keep their `organization_id`, which Release 1 ignores |
| After Release 3 | Not possible | — |
