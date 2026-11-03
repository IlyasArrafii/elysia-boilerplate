# Observability in Multi-Tenant

> **Status: design only (DEC-050, DEC-051).** What logs, telemetry events and vendor sinks add once the app is multi-tenant ([multi-tenant.md](multi-tenant.md)). The base model is [observability/README.md](../observability/README.md); stage 2 (where `organizationId` first appears) is [observability/access-stages.md](../observability/access-stages.md).

## 1. Summary

| | Stage 2: single-org | **Multi-tenant** |
|:---|:---|:---|
| `organizationId` in log context | Inside organization-scoped routes | Same, and **required** there: a missing one fails the test in §7 |
| MongoDB index | None on `organizationId` | `{ organizationId: 1, time: -1 }` (sparse) |
| Questions answered | Per module | Per module **and** per tenant: errors, latency, audit trail of one customer |
| Security events | — | `security.tenant_violation` (§3) |
| Sentry | User ID | User ID + `organizationId` tag (§6) |
| PostHog | `distinctId` = user ID | Plus the `organization` group (§6) |
| Tenant purge | — | `logs:prune --org` (§5) |

## 2. Log context and queries

- The `auth` macro sets `organizationId` from the active organization ([architecture.md §1](architecture.md)). Platform routes have none in the context; their events name the target in the payload (`targetOrganizationId`).
- Never the organization name, slug or logo ([redaction.md §1](../observability/redaction.md)).
- Index, created by `bun run logs:setup`: `{ organizationId: 1, time: -1 }`, sparse, next to the ones in [DATABASE.md §8](../DATABASE.md).

```js
// errors per tenant and module, last 24 h (sketch)
db.log_event.aggregate([
  { $match: { kind: "error", time: { $gte: since24h }, organizationId: { $exists: true } } },
  { $group: { _id: { organizationId: "$organizationId", module: "$module", code: "$code" }, count: { $sum: 1 } } },
  { $sort: { count: -1 } }, { $limit: 20 },
])
```

The platform console's audit search ([platform-console.md §4](platform-console.md)) reads with the same index.

## 3. Events added

| Event | Kind | Payload (plus context fields) | Sinks |
|:---|:---|:---|:---|
| `security.tenant_violation` | `error` | `module, sqlState, table` | log, mongo (error), Sentry when adopted. **Alert on any occurrence** ([architecture.md §4.4](architecture.md)) |
| `org.purged` | `app` | `organizationId, tables, rows, logsDeleted, dryRun` | log, mongo |
| `audit.org.*` (multi-tenant) | `audit` | [multi-tenant.md §12](multi-tenant.md) | log, mongo |
| `audit.platform.*` | `audit` | [platform-console.md §8](platform-console.md) | log, mongo |

All of them are typed in `events.ts` like the base catalogue. `security.*` is a new prefix with the `error` retention class.

## 4. Step B (stage 2 → multi-tenant)

| Release | What changes |
|:---|:---|
| B1 (row-level security) | Add the `organizationId` index; register `security.tenant_violation` and alert on it. Any occurrence during B1 is a query that bypassed `scoped()` and must be fixed before B2 |
| B2 (open multi-tenancy) | Multi-tenant `audit.org.*` and `audit.platform.*` events; Sentry tag and PostHog group if those vendors are adopted |

Older lines keep their `organizationId` (stage 2 already set it), so no backfill is needed.

## 5. Tenant purge and retention

- Retention periods stay per `kind` ([log-storage.md §5](../observability/log-storage.md)). There is no per-tenant retention in the first version.
- `bun run logs:prune --org <organizationId> [--dry-run]` deletes every document of that organization **except `audit`**. `org:purge` ([multi-tenant.md §8](multi-tenant.md)) runs it, then emits `org.purged`.
- Audit lines of a purged organization stay until their normal 365-day retention: they are the record of who did what, and carry IDs only.
- A user erasure (`logs:prune --user`) is unchanged and works across organizations.

## 6. Vendors

| Vendor | Change | Never |
|:---|:---|:---|
| Sentry ([sentry.md](../observability/sentry.md)) | `tags.organizationId` on captured errors. Alert rule "new issue affecting more than N organizations" | Organization name or slug |
| PostHog analytics ([posthog.md](../observability/posthog.md)) | `client.capture({ distinctId: userId, groups: { organization: organizationId }, … })` (*verify* API) | `groupIdentify` with names or other properties |
| PostHog flags | Groups for percentage by organization ([feature-flags.md §6](feature-flags.md)) | |

Both stay optional. Without them, MongoDB queries (§2) answer the same questions more slowly.

## 7. Acceptance criteria

- [ ] Every event inside an organization-scoped route has `organizationId` (test over every module route, run with the isolation suite).
- [ ] An insert refused by RLS produces exactly one `security.tenant_violation` and a `500` response with `{ code: "INTERNAL_ERROR" }`.
- [ ] `logs:prune --org` deletes all non-audit lines of that organization and none of another's (`--dry-run` counts match).
- [ ] Sentry and PostHog payloads (when adopted) contain the organization ID and no organization name or slug.

## 8. Tasks

| Task | Goal | Depends on |
|:---|:---|:---|
| MT-10 | Index, `security.tenant_violation` and alert, `logs:prune --org`, `org.purged`, vendor tags and groups when adopted (§2–6) | MT-01, MT-09 |
