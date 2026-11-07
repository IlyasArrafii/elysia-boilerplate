# Log retention operations

This runbook implements [log-storage.md §5.4](../implement-boilerplate/static-role/observability/log-storage.md#54-operating-it) for the current static-role build. Commands below run from **`apps/api`** after following the [root setup guide](../../README.md). They were checked against source and in-memory unit tests on 2026-11-04, and run live on 2026-11-05 against an isolated test MongoDB (the `docker-compose.test.yml` stack with throwaway data, never a development or production database). That run covered, with 12 back-dated test documents:

- `logs:setup` twice: five indexes created, the second run a no-op, both exit 0.
- `logs:prune --dry-run`: nothing deleted; the records said it would delete 3 `http`, 2 `app` and 1 `audit` document, 0 `error` and 0 `product`, which is the ground truth. The real run removed exactly those and kept the newer documents.
- `--user`: a dry-run (2), then the real run removed only that user's 2 documents, recorded as `prunedKind: "all"` with `erasedUserId`.
- `--older-than 7` without `--force`, `--force` alone, an unknown flag, and `--user` with `--kind` each exit 2; `--kind http --older-than 7 --force --dry-run` exits 0.
- The `app.logs_pruned` records read back through the read-only `log_reader` user.

Not exercised live: `--batch`, an interrupted or partly failed run, the recovery table below, and production settings.

## Store, credentials, and indexes

Logs live in MongoDB database `LOG_MONGO_DB` (default `app_logs`), regular collection `log_event`. PostgreSQL holds application data and is never touched by pruning. The API does not schedule deletions or expose a delete-logs endpoint. There is no TTL index.

| Identity | Privileges on `app_logs.log_event` | Use |
|:---|:---|:---|
| `log_writer` / `logWriter` | `insert` only | `LOG_MONGO_URL`, used by the API and by the prune script's telemetry to record its results. Cannot query or delete. |
| `log_admin` / `logAdmin` | `find`, `remove`, `createIndex` | `LOG_MONGO_ADMIN_URL`, used by setup/prune. Cannot insert result events, list indexes, drop the collection, or manage users. |
| `log_reader` / `logReader` | `find` only | Human queries in Compass/mongosh and read-only E2E verification. No dedicated reader env variable is consumed by the API. |

All three roles/users are created in `app_logs`; their URLs use `authSource=app_logs`. `LOG_MONGO_DB` selects the target database independently of the URL path. Point both script connections at the same intended server/database. A custom database name requires provisioning matching users and privileges there; changing the env value does not create them.

The managed [development Compose file](../../docker-compose.dev.yml) bootstraps these users only on an empty volume. Production credentials are provisioned separately. Keep credentials in private configuration, not commands copied to tickets or incident reports.

The scripts load the root `.env` explicitly and import the shared [environment validation](../../apps/api/src/env.ts). `LOG_MONGO_ADMIN_URL` is mandatory. Normal base requirements such as `DATABASE_URL` and `BETTER_AUTH_SECRET` still apply even though the scripts do not connect to PostgreSQL; production also enforces its Redis, Mongo, Google, and HTTPS-origin requirements. The scripts do not load the posts module and do not require post length limits.

`logs:prune` prints its outcome whatever `LOG_LEVEL` is: one line per finished kind (or one for a user erasure), such as `Dry run: would delete 3 documents of kind http older than 2026-10-20T00:00:00.000Z`, plus any argument error or failure. The `app.logs_pruned` result records themselves follow `LOG_LEVEL`; set `LOG_LEVEL=info` to see them on stdout. When retaining records in MongoDB, also set the writer `LOG_MONGO_URL` and `LOG_MONGO_MIN_LEVEL=info`; a higher threshold suppresses the `info` result events. Do not substitute the admin URL for the writer URL.

Before the first prune on a database, run:

```powershell
bun run logs:setup
```

[logs-setup.ts](../../apps/api/scripts/logs-setup.ts) uses `createIndexes` only; the limited admin role does not have `listIndexes`. An identical existing index is a no-op. The API never creates these indexes at startup.

| Index | Options / purpose |
|:---|:---|
| `{ kind: 1, time: 1 }` | Age-based pruning. |
| `{ module: 1, level: 1, time: -1 }` | Module/level investigations. |
| `{ requestId: 1 }` | Sparse; request correlation. |
| `{ userId: 1, time: -1 }` | Sparse; user investigations and erasure. |
| `{ event: 1, time: -1 }` | Event history, including prune records. |

## Routine retention

An operator with the admin connection runs this **at least weekly** and whenever disk utilization passes **70%**, as specified in the implementation record. No cron job or CI schedule is supplied by this ticket.

Periods come from [retention.ts](../../apps/api/src/utils/telemetry/retention.ts):

| Kind | Keep |
|:---|---:|
| `http` | 14 days |
| `app` | 30 days |
| `error` | 30 days |
| `product` | 30 days |
| `audit` | 365 days |

1. Confirm the target server/database and the operator's authorization. Check whether an investigation requires preserving the affected records.
2. **Always preview first**, using exactly the filters intended for deletion:

   ```powershell
   bun run logs:prune --dry-run
   ```

3. Check the outcome line printed for each kind, such as `Dry run: would delete 3 documents of kind http older than 2026-10-20T00:00:00.000Z`: the kind, the count and the cutoff. With `LOG_LEVEL=info`, the matching `app.logs_pruned` event carries the same values as `prunedKind`, `deleted`, `cutoff` and `dryRun`. A dry-run deletes nothing but can insert its own telemetry records when the writer connection is enabled.
4. After reviewing the counts and scope, run the same command without `--dry-run`. For all kinds at their normal periods:

   ```powershell
   bun run logs:prune
   ```

5. Retain stdout and the exit status with the operation record. Confirm result events with a read-only connection if Mongo storage is enabled. Record the target, filters, cutoffs, counts, and reason, never connection credentials.

The age filter is **`{ kind, time: { $lt: cutoff } }`**, where `cutoff` is the run's start time minus the selected number of 24-hour days. A document exactly at the cutoff is kept. The script finds batches of IDs and deletes those IDs; it does not drop the collection or delete another kind. A later run recomputes its cutoffs, so the preview and real counts may differ as time passes or new records arrive.

### Filters and limits

| Flag | Behavior |
|:---|:---|
| `--dry-run` | Count only; emit a result for each selected kind. |
| `--kind <kind>` | Repeatable, limited to the five kinds above; omitted means all five. |
| `--older-than <days>` | Whole number from 1 to 36,500; overrides every selected kind's period for this run. |
| `--force` | Allows an override below the normal period. Requires `--older-than`; it is rejected on its own. |
| `--batch <n>` | Whole number from 1 to 100,000; default 10,000. Limits delete batch size, not total deletions or dry-run count work. |
| `--user <userId>` | Separate erasure mode, described below. |

Preview only HTTP logs older than their normal 14-day period, with smaller deletion batches prepared for the eventual real run:

```powershell
bun run logs:prune --kind http --batch 1000 --dry-run
```

Preview app and error logs older than 60 days:

```powershell
bun run logs:prune --kind app --kind error --older-than 60 --dry-run
```

Shortening HTTP retention to seven days requires an explicit override even for the preview:

```powershell
bun run logs:prune --kind http --older-than 7 --force --dry-run
```

Use shortened retention only for an authorized exception. Removing `--dry-run` from any of these examples performs deletion. Without `--kind`, `--older-than 30` is refused because it would shorten the 365-day audit period; select the intended kinds instead of adding `--force` to bypass that protection. There are no `--module`, `--event`, or arbitrary query flags. Unknown flags/positional arguments are rejected; the parser has no `--help` option.

## Erasing one user's logs

For a documented erasure request, use the exact user **ID**, not an email. It must be nonempty after trimming and at most 255 characters. Replace the illustrative ID below before use:

```powershell
bun run logs:prune --user "user-id-from-the-approved-request" --dry-run
```

This matches **`{ userId }` across every kind and age**, including recent audit records. It cannot be combined with `--kind`, `--older-than`, or `--force`; `--batch` is allowed. Review the count, then repeat without `--dry-run` only for the authorized erasure.

The result uses `prunedKind: "all"` and `erasedUserId`. It deliberately does not use the base `userId` field, so repeating the erasure does not select its own operation record. It removes matching log documents, not the user's PostgreSQL account.

## Result records and partial runs

`app.logs_pruned` is an `info` event with base `kind: "app"`. Its `prunedKind` field identifies the kind removed. The script emits one event immediately after each kind finishes, or one for user erasure. These records use the normal telemetry path: stdout, plus the insert-only writer when enabled and admitted by the Mongo level threshold. They have the normal 30-day `app` retention; keep a separate operation record if it must last longer.

Using the reader connection with `app_logs` selected, a bounded query for recent operation records is:

```javascript
db.log_event.find({ event: "app.logs_pruned" }).sort({ time: -1 }).limit(20)
```

The command is not one transaction. If a later kind fails, earlier completed kinds have already emitted their records. A failure midway through one kind can leave deleted batches without that kind's final count; do not interpret the output as a complete accounting of a failed run. Stopping and re-running does not restore deleted documents. It processes the remaining matches, with a newly calculated cutoff.

CLI argument errors exit with code **2**; runtime failures exit with **1**. Shared-env validation can fail before argument parsing. A successful deletion exit does not prove telemetry was persisted: the Mongo sink is best-effort and shutdown flush is bounded to five seconds. Save stdout and inspect `telemetry.sink_failed` / `telemetry.sink_dropped` messages. `LOG_LEVEL=warn` hides the result records on stdout; `error`, `fatal` and `silent` also hide the `telemetry.sink_*` warnings; none of them hides the outcome lines.

## Failure and recovery

| Failure | Non-destructive response |
|:---|:---|
| Connection refused or authentication error | Check managed container status, actual host port, database, `authSource`, and the role-specific connection privately. Restore connectivity or correct credentials, then run a fresh preview. Do not reset volumes. |
| `not authorized` from setup/prune | Use the admin URL for `find`/`remove`/`createIndex`; the writer cannot do these. The admin also cannot insert telemetry or list indexes. Have an authorized database administrator repair exact grants in place, without granting broad roles to the API. |
| Changed bootstrap/password has no effect | Bootstrap only runs on an empty Mongo volume. Arrange an in-place user/role update by an administrator; neither `log_admin` nor `log_reader` can manage users. Restart only your affected local process after changing its private connection. |
| Index conflict | Save the error and inspect the existing index definition through an administrator with inspection privileges. Do not drop indexes or the collection as a retry step. Identical definitions can be safely re-run with `logs:setup`. |
| Count/index build appears stalled | Operator scripts intentionally use no socket-reply deadline (`socketTimeoutMS: 0`). Inspect the service and operation before deciding to interrupt your own command. Smaller `--batch` values reduce deletion chunks but do not bound counting/index-building time. |
| Partial deletion or interrupted command | Preserve output and note uncertainty in any unfinished kind. Restore service health, preview the remaining matches, then resume with the intended filters. Existing deletions remain effective. Avoid overlapping runs, whose counts can race. |
| Missing Mongo result record | Confirm the writer targets the same database, permits inserts, and `LOG_MONGO_MIN_LEVEL` admits `info`. Preserve stdout; do not repeat an expanded deletion just to manufacture a missing count. |
| Logs are missing during an outage | Check API stdout and sink-failure/drop events. The bounded buffer can drop events after retry/overflow; there is no automatic replay from stdout. Preserve available output for investigation. |
| Wrong records were deleted | Stop further pruning, record the exact command/cutoff and affected target, and assess available backups through the database owner. There is no undo command. Re-running setup or deleting a volume cannot recover logs. |

Mongo log-store health being down does not make API health fail. Check `logStore` explicitly and preserve API terminal output: these services run locally, so a container log is not a backup of API stdout. The script's recovery path does not require stopping PostgreSQL, Redis, or MongoDB.

Emergency direct deletion is reserved for the case where the script cannot run, as specified in [log-storage.md §5.5](../implement-boilerplate/static-role/observability/log-storage.md#55-emergency-deletion-without-the-script). It requires an authorized operator, a preview of the exact kind/time filter, and incident notes; it bypasses the script's batching and result events. Do not use it to bypass an unexplained validation or permission failure.
