# Database Feature Flag Provider (default)

> **Status: design only (DEC-029, DEC-038).** The default provider when flags are adopted: flag state in a PostgreSQL table defined with Drizzle, managed manually through an admin API (or SQL in an emergency), evaluated in memory by our own OpenFeature provider. Targeting rules: [targeting.md](targeting.md).

## 1. Shape

```
code catalogue (flags.ts) ──sync at startup──► feature_flag table ◄── PATCH /api/feature-flags/:key
                                                     │                       │
                                                     │ load all rows         │ publish "feature-flags:changed"
                                                     ▼                       ▼
                                    in-memory snapshot in every API instance ◄─ Redis pub/sub
                                                     │
                              OpenFeature DatabaseProvider.resolve*(key, default, { targetingKey })
```

- **Which flags exist** is decided in code (`flags.ts`). The table holds only their **state**.
- Evaluation never touches PostgreSQL or Redis; it reads the in-memory snapshot.

## 2. Table (Drizzle)

```ts
// packages/db/src/schema/feature-flag.ts (sketch)
export const featureFlag = pgTable('feature_flag', {
  key:               text('key').primaryKey(),                                  // 'posts.bulk-delete'
  description:       text('description').notNull(),
  type:              text('type', { enum: ['boolean', 'string', 'number', 'object'] }).notNull().default('boolean'),
  enabled:           boolean('enabled').notNull().default(false),               // kill switch
  onValue:           jsonb('on_value').notNull().default(true),
  offValue:          jsonb('off_value').notNull().default(false),
  rolloutPercentage: numeric('rollout_percentage', { precision: 5, scale: 2 }).notNull().default('0'),
  includeUserIds:    text('include_user_ids').array().notNull().default([]),
  excludeUserIds:    text('exclude_user_ids').array().notNull().default([]),
  bucketingSeed:     text('bucketing_seed'),                                    // null = key
  clientVisible:     boolean('client_visible').notNull().default(false),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy:         text('updated_by').references(() => user.id, { onDelete: 'set null' }),
})
```

- Checks: `rollout_percentage BETWEEN 0 AND 100`; `cardinality(include_user_ids) + cardinality(exclude_user_ids) <= 1000`.
- No role column (DEC-038). No environment column (environments use separate databases).
- `owner` and `removeBy` live in the code catalogue.
- Migration generated with Drizzle Kit like every other table.

## 3. Sync at startup

1. Each catalogue entry missing from the table is inserted with `enabled = false`, `rollout_percentage = 0`, the catalogue's description, type and safe default as `off_value`.
2. Each table row not in the catalogue emits `flag.orphaned { key }` (warn). Orphans are removed by a migration when their code is deleted, never automatically.
3. Load the snapshot.

## 4. Evaluation

`evaluate(snapshot, key, type, defaultValue, context)` is a pure function implementing [targeting.md §3](targeting.md). It returns OpenFeature `ResolutionDetails` and is unit-tested without a database.

## 5. Provider

```ts
// utils/feature-flag/providers/database.ts (sketch)
export class DatabaseProvider implements Provider {
  readonly metadata = { name: 'database' }
  readonly runsOn = 'server'
  private snapshot = new Map<string, FlagRow>()

  async initialize() { await syncCatalogue(); await this.reload(); this.startRefresh() }
  async onClose()    { this.stopRefresh() }

  resolveBooleanEvaluation(key, def, ctx) { return evaluate(this.snapshot, key, 'boolean', def, ctx) }
  // string, number, object the same way
}
```

### Refreshing the snapshot

| Trigger | Delay |
|:---|:---|
| `PATCH /api/feature-flags/:key` publishes `feature-flags:changed` on Redis; every instance reloads | ~1 s |
| Timer every `FEATURE_FLAGS_REFRESH_MS` (default 30 000) | ≤ 30 s; covers manual SQL and missed messages |
| No Redis (dev) | timer only |

A failed reload keeps the previous snapshot and emits `flag.refresh_failed`. If the first load fails, the provider is in error state and every evaluation returns the code default.

## 6. Managing flags (manual)

### Admin API (`modules/feature-flags/`)

`permissions.ts`: `{ feature_flag: ['read', 'write'] }`. Grants: `admin` gets `read`; `super_admin` gets both (derived). At access stage 2 (and in the SaaS layer) this moves to the platform statement and the routes use `platformPermission` ([access-stages.md §3](access-stages.md)).

| Method | Path | Option | Body / result |
|:---|:---|:---|:---|
| GET | `/api/feature-flags` | `permission: 'feature_flag:read'` | `{ items: FlagState[] }` with catalogue `owner`, `removeBy` |
| GET | `/api/feature-flags/:key` | `permission: 'feature_flag:read'` | `FlagState` or `404 FLAG_NOT_FOUND` |
| PATCH | `/api/feature-flags/:key` | `permission: 'feature_flag:write'` | Any of `enabled`, `rolloutPercentage`, `includeUserIds`, `excludeUserIds`, `onValue`, `offValue`, `bucketingSeed`, `clientVisible`. Values checked against `type`; user IDs must exist; list limit enforced. Emits `audit.feature_flag.changed`, publishes `feature-flags:changed`. |
| POST | `/api/feature-flags/:key/clean-lists` | `permission: 'feature_flag:write'` | Removes deleted users' IDs from both lists |
| GET | `/api/feature-flags/evaluate` | `auth: true` | `{ flags: Record<key, value> }` for `clientVisible` flags, current user |

No create or delete endpoint: flags come from the catalogue sync and go with a migration.

### Manual SQL (emergency only)

`UPDATE feature_flag SET enabled = false, updated_at = now() WHERE key = 'posts.bulk-delete';` takes effect within `FEATURE_FLAGS_REFRESH_MS`. It bypasses validation and the audit event; record it in the incident notes and prefer the API.

## 7. Web

The `admin` feature (the `platform` feature at access stage 2 and in the SaaS layer) can get a "Feature flags" page later (`feature_flag:read` to view, `feature_flag:write` to edit). User-facing pages read flags through `/api/feature-flags/evaluate`.

## 8. Tests

Folders: `apps/api/tests/utils/feature-flag/` and `apps/api/tests/modules/feature-flags/` ([TESTING.md](../TESTING.md)).

- `evaluate()` for every row of [targeting.md §3](targeting.md).
- Sync: missing keys inserted off; orphans warn and are not deleted.
- Refresh: a PATCH on one instance is visible on a second after the pub/sub message; a failed reload keeps the old snapshot.
- API: 403 without permission; invalid percentage, unknown user ID, list over the limit and wrong value type → 400; audit event emitted with counts, not IDs.

## 9. Limits

- Two values per flag (on/off): no multivariate experiments.
- No analytics per variant.
- Targeting is user lists and percentage only (by design, DEC-038).

If experiments or analytics are needed, see [posthog-provider.md](posthog-provider.md).
