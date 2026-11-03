# SaaS Architecture

> **Status: design only (DEC-050, DEC-051).** How the API is put together when it serves many tenants ([multi-tenant.md](multi-tenant.md)): the request pipeline, the route groups, tenant isolation in two layers (application filter + PostgreSQL row-level security) and the database roles. The base architecture is [ARCHITECTURE.md](../ARCHITECTURE.md); stage 2 scoping is [single-org.md §5](../auth/access/single-org.md). Nothing here changes stages 1 or 2 (DEC-049).

## 1. Request pipeline

```
request
  → logger              requestId, module = "core"
  → moduleScope(name)   module = "<module>"
  → auth macro          session → user, active organization (session.activeOrganizationId)
                        organization status: suspended / deleted → 403 ORGANIZATION_SUSPENDED
                        log context += userId, organizationId
  → permission          organization plugin hasPermission on member.role   → 403 FORBIDDEN
  → plan check          only if plans are adopted (plans-billing.md §5)    → 403 PLAN_UPGRADE_REQUIRED
  → handler / service   ownership rules, flag check (feature-flags.md)
  → scoped(orgId)       one transaction: set app.org_id, then the repository queries
  → PostgreSQL          RLS policies on every module table (§4)
```

- `orgId` reaches `scoped()` only from `ctx.org`, which the `auth` macro reads from the session. No handler can pass another value: `scoped` takes a branded `OrgContext`, not a string.
- Platform routes skip the organization steps and use the platform permission and the platform database role instead (§2, §4.2).

## 2. Route groups

| Group | Path | Organization | Check | Database role |
|:---|:---|:---|:---|:---|
| Better Auth core | `/api/auth/*` | None | Better Auth, allowlist ([API.md](../API.md)) | runtime |
| Organization plugin | `/api/auth/organization/*` | Active organization | Plugin + allowlist ([multi-tenant.md §11](multi-tenant.md)) | runtime |
| Module routes | `/api/<module>/*` | **Always** the active organization | `{ permission }` | runtime + RLS |
| Current user | `/api/me/permissions` | Active organization | `auth: true` | runtime |
| Feature flags | `/api/feature-flags/evaluate` | Read from the session for the context ([feature-flags.md](feature-flags.md)) | `auth: true` | runtime (global table) |
| Platform | `/api/platform/*` | None (cross-tenant) | `{ platformPermission }` | **platform** (read-only) for module tables; runtime for Better Auth tables |

Rules:

1. Module routes never take an `organizationId` in the path, query or body. A route that needs one is a platform route.
2. A module route never reads across tenants, even for a `super_admin` (DEC-043).
3. Only the `platform` module may import `*AcrossTenants` functions or the platform database client (lint rule).

## 3. Tenant isolation

### 3.1 Application layer

1. **No direct database access in modules.** `modules/*` may not import `db`; the only way to a module table is `scoped(orgId)` (lint rule `no-restricted-imports`, checked in CI). This covers `select`, `insert`, `update`, `delete`, relational queries (`db.query.*`) and raw SQL alike.
2. Every repository function takes the `OrgContext` first and puts `organization_id` in every `where`, `insert` and `update`.
3. **Foreign keys stay inside the tenant.** When a record points to another record (a comment on a post), the service checks both have the same `organization_id`. A cross-tenant reference is `404`. Composite foreign keys `(organization_id, post_id) → post (organization_id, id)` enforce it in the database where the table shape allows.
4. **Not found, not forbidden.** Another tenant's record ID returns `404`, in the same time as a real miss (no extra lookup that reveals existence).

### 3.2 Why the application layer is not enough

The first design (DEC-046) relied on the application layer only. Reviewing it found these gaps, each of which leaks one tenant's data to another:

| Gap | Example |
|:---|:---|
| The CI check matched only `db.select`/`db.update`/`db.delete` in `repository.ts` | `db.query.post.findMany()`, ``db.execute(sql`…`)``, an `insert … select`, or a query in a job or script was not checked |
| A bug inside `scoped()` | Every module leaks at once, and no test fails unless it hits that exact path |
| Joins | The filter is on `post`, but a joined `comment` row of another tenant still comes back |
| Insert with a wrong `organization_id` | `NOT NULL` passes; nothing checks that the value is the active organization |
| Background jobs | A job with no request has no session; a missing `orgId` is a silent unscoped query |

Row-level security closes all of them: whatever the code does, PostgreSQL returns and accepts only rows of the organization the transaction is bound to. The application layer stays, because it gives correct `404`s, uses the indexes well, and is what the tests read.

## 4. Row-level security (DEC-051)

### 4.1 Which tables

| Tables | RLS | Why |
|:---|:---|:---|
| Every **module table** with `organization_id` (`post`, …) | **Yes**, `ENABLE` + `FORCE` | Tenant data |
| Better Auth tables (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `organization_role`) | No | Better Auth reads them across organizations (a user's memberships, invitations by email). Protected by the plugin and the endpoint allowlist |
| `feature_flag` | No | Global (DEC-048) |
| Plan tables ([plans-billing.md §4](plans-billing.md)) | Yes for per-organization rows, when built | Tenant data |

A CI check fails when a migration creates a table with an `organization_id` column and no policy.

### 4.2 Database roles

| Role | Used by | Rights | RLS |
|:---|:---|:---|:---|
| `app_owner` | Drizzle Kit migrations, `org:purge` | Owns the tables | Bypassed as owner; never used by the API |
| `app_runtime` | The API (`DATABASE_URL`) | `SELECT, INSERT, UPDATE, DELETE` on app tables; not the owner; `NOBYPASSRLS` | **Enforced** |
| `app_platform` | `*AcrossTenants` functions in the `platform` module (`DATABASE_PLATFORM_URL`) | `SELECT` only on module tables; `BYPASSRLS` | Bypassed, but read-only, so the console can never change customer content (SAAS-001) |

At stages 1 and 2 the API may keep one role. Step B introduces the three roles ([migration.md §3](migration.md)).

### 4.3 Policies

One policy per module table, generated with the schema:

```sql
-- generated per module table (sketch)
ALTER TABLE post ENABLE ROW LEVEL SECURITY;
ALTER TABLE post FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON post
  FOR ALL TO app_runtime
  USING      (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));
```

```ts
// packages/db/src/schema/post.ts (sketch, verify Drizzle API in the pinned version)
export const post = pgTable('post', { /* … */ }, (t) => [
  pgPolicy('tenant_isolation', {
    for: 'all', to: appRuntime,
    using: sql`${t.organizationId} = current_setting('app.org_id', true)`,
    withCheck: sql`${t.organizationId} = current_setting('app.org_id', true)`,
  }),
]).enableRLS()
```

- **Fail closed.** With `app.org_id` unset, `current_setting(..., true)` is `NULL` (or `''` on a reused connection); either matches no row. A query outside `scoped()` returns nothing and inserts fail.
- `USING` hides other tenants' rows from `SELECT`, `UPDATE` and `DELETE`, so an update of another tenant's ID changes 0 rows and the service returns `404`.
- `WITH CHECK` refuses writing a row for another organization (SQLSTATE `42501`).

### 4.4 `scoped(orgId)`

```ts
// apps/api/src/utils/db/scoped.ts (sketch)
export function scoped<T>(org: OrgContext, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`)  // transaction-local
    return work(tx)
  })
}
```

Rules:

1. The setting is **transaction-local** (`set_config(..., true)` / `SET LOCAL`), never session-level, so a pooled connection never carries one tenant's ID into another request. This also works behind PgBouncer in transaction mode.
2. One `scoped()` call per unit of work. Redis, HTTP calls and `telemetry.emit` happen **outside** the transaction, so connections are held briefly.
3. Background jobs carry `organizationId` in the job payload and run their work through `scoped()`. A job without one fails before touching the database.
4. A `42501` error is a bug, never a user error: the request returns `500 INTERNAL_ERROR` and emits `security.tenant_violation` (error, alert, [observability.md §3](observability.md)).

### 4.5 Cost

- One extra statement (`set_config`) per unit of work, and a transaction around each. Cache hits do not touch PostgreSQL, so the p95 < 50 ms target on cache hits is unaffected; MT-09 measures the cache-miss cost.
- The policy predicate is `organization_id = …`, the first column of every module index ([single-org.md §5](../auth/access/single-org.md)), so plans do not change.
- Three database URLs instead of one, and migrations must run as `app_owner`.

### 4.6 Verify before building

- Drizzle `pgPolicy`, `pgRole` and `.enableRLS()` in the pinned version, and whether Drizzle Kit emits `FORCE ROW LEVEL SECURITY` (if not, a custom migration adds it).
- That Better Auth's Drizzle adapter works unchanged with `app_runtime` (its tables have no RLS).
- Behaviour of `current_setting('app.org_id', true)` on a pooled connection after a previous transaction set it (expected `''`).

## 5. Caches, queues, files

- Cache keys start with the organization: `org:{orgId}:…`. The cache helper's key type requires the prefix.
- Queue jobs and pub/sub messages carry `organizationId`; channels are per organization where a consumer listens for one tenant.
- Uploads and exports (when they exist) live under `org/{orgId}/`.
- Flags are global and never cached per organization in the provider ([feature-flags.md §4](feature-flags.md)).

## 6. Tests

Part of the isolation suite ([multi-tenant.md §13](multi-tenant.md)), run against PostgreSQL as `app_runtime`:

- A raw query on a module table **without** `scoped()` returns 0 rows, and an insert fails.
- Inside `scoped(A)`, `select` of B's rows returns 0; `update`/`delete` of B's IDs changes 0 rows; `insert` with B's `organization_id` fails with `42501`.
- **Mutation test:** with the `organization_id` filter removed from one repository function (test-only switch), the isolation cases still pass because of RLS.
- Two concurrent requests for A and B on the same pooled connection never see each other's rows.
- `app_platform` can read every tenant and cannot write (`INSERT`/`UPDATE` refused).
- The CI checks fail on: a `db` import in `modules/*`, and a table with `organization_id` and no policy.

## 7. Tasks

| Task | Goal | Depends on |
|:---|:---|:---|
| MT-02 | Lint rule, composite foreign keys, isolation suite (§3, §6) | ORG-02 |
| MT-09 | Database roles, policies, `scoped()` transaction, RLS tests, CI policy check, cache-miss benchmark (§4, §6) | ORG-02 |
