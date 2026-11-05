# Log Storage and Retention: MongoDB (manual)

> **Status: Answered (DEC-034, Q17, Q18).** Built in TASK-15. MongoDB is the log store for now; [migration-loki.md](migration-loki.md) (Grafana Alloy + Loki, the default) and [migration-elk.md](migration-elk.md) (ELK Stack, the alternative) are the planned paths away from it. Driver and server versions were verified at build time: `mongodb` 7.8.0 on Bun 1.4.4 against MongoDB 8.3.13 (TASK-15).

## 1. Shape

```
telemetry.emit ──► scrubber ──┬─► log sink   ──► stdout (always, every level)
                              └─► mongo sink ──► buffer ──insertMany every 1 s / 500 docs──► MongoDB app_logs.log_event
                                                                                                │
                                         operator: bun run logs:prune  ──────────────────────────┘ deletes by kind and age
```

- stdout always carries every event, so nothing is lost if MongoDB is down; the container runtime keeps a short local history.
- MongoDB is a **separate database** with its own credentials. It never holds app data, and PostgreSQL never holds logs.
- Retention is **manual**: nothing deletes logs until an operator runs the prune command.

Why MongoDB now: JSON-shaped documents need no schema migrations as events evolve; deletes by indexed time range are cheap; it keeps log write load away from PostgreSQL. Why not Loki yet: three more services (Alloy, Loki, Grafana) before traffic justifies them ([migration-loki.md §1](migration-loki.md)).

## 2. Setup

| Item | Value |
|:---|:---|
| Server | MongoDB 8 (8.3.13 at build time (TASK-15); pinned to `mongo:8.3.13@sha256:e16e606f…cd2` with `GLIBC_TUNABLES=glibc.pthread.rseq=1` in TASK-024, see [TESTING.md §6.3](../TESTING.md#63-mongodb-on-the-hosted-runner-open-task-023)) |
| Database | `LOG_MONGO_DB`, default `app_logs` |
| Collection | `log_event` (regular collection; not a time-series collection, so arbitrary deletes stay simple) |
| Driver | Official `mongodb` package, pinned to 7.8.0, in `apps/api/src/utils/mongo`; works on Bun 1.4.4 (TASK-15). Driver 7 has no per-operation timeout (`timeoutMS` is deprecated and ignored), so every stage has its own limit: `serverSelectionTimeoutMS: 5000`, `connectTimeoutMS: 5000`, `socketTimeoutMS: 10000` and `waitQueueTimeoutMS: 5000`. The driver defaults are 30 s, 30 s, none and none, and with no socket limit one stalled reply would hold the sink's single write slot forever. The operator scripts set `socketTimeoutMS: 0` (no limit) because an index build or a count over a large collection can take minutes. The health probe races its own timer and shares one in-flight `ping` between callers. A bulk error counts as stored only when every write error is a duplicate key (a retried batch) and there is no write-concern error, read from `error.result.getWriteConcernError()` because the driver puts it only there when write errors are present (TASK-15). |
| Writer user (API) | `log_writer` (TASK-02), custom role `logWriter` with `insert` on `log_event` only. Used by `LOG_MONGO_URL`. Cannot read, delete or drop. |
| Admin user (scripts) | `log_admin` (TASK-02), custom role `logAdmin` with `find`, `remove`, `createIndex` on `log_event`. Used by `LOG_MONGO_ADMIN_URL`, only in the prune/setup scripts, never by the API process. |
| Read-only user (people) | `log_reader` (TASK-02), custom role `logReader` with `find` on `log_event`. For mongosh and Compass ([§7](#7-querying)); no process uses it. |
| Indexes | Created by `bun run logs:setup` ([DATABASE.md §8](../DATABASE.md)) |

All three users and roles live in the `LOG_MONGO_DB` database, so their URLs carry `authSource=app_logs`. Roles are scoped to the one collection, so none of them can touch another collection or database.

In dev, `LOG_MONGO_URL` may be empty (stdout only). The managed `docker-compose.dev.yml` includes the same pinned `mongo:8.3.13` image with an inline copy of `infra/mongo/init.js`, avoiding the managed engine's Windows bind-mount/build-path limitations. It creates the three users with throwaway passwords only on an empty data volume. Changing the bootstrap does not update an existing volume: have an authorized database administrator update users or privileges in place, then update the private connection configuration. Do not delete shared volumes to change credentials. Production creates the same users with its own passwords, outside docker compose. See the [operations runbook](../../../operations/log-retention.md#failure-and-recovery) (TASK-022).

## 3. Write path: the `mongo` sink

`apps/api/src/utils/telemetry/sinks/mongo.ts`, registered only when `LOG_MONGO_URL` is set. `LOG_MONGO_URL` is required in production; startup fails without it (TASK-15).

| Behaviour | Rule |
|:---|:---|
| Levels | Lines at `LOG_MONGO_MIN_LEVEL` (default `info`) and above. `debug` stays on stdout. In production a `LOG_MONGO_MIN_LEVEL` below `info` fails startup, so `debug` never reaches MongoDB there (TASK-15). |
| Excluded events | `telemetry.sink_failed`, `telemetry.sink_dropped` (avoid loops), dev-only link events. The catalogue routes them to stdout only, and the sink refuses them as well (TASK-15). |
| Document | The scrubbed log line as-is, `time` converted to a BSON `Date` |
| Batching | Buffer in memory; `insertMany(docs, { ordered: false })` every 1 s or at 500 docs, whichever comes first |
| Write concern | `w: 1` (logs are not worth waiting on a majority) |
| Back-pressure | Buffer capped at 10 000 docs. On overflow drop the oldest `http` docs first, never `audit` or `error` while others remain; count drops and emit `telemetry.sink_dropped` (stdout) at most once per minute. After `http`, the oldest `app` or `product` doc goes; `audit` or `error` only when nothing else is buffered. Drops counted in between are carried into the next report (TASK-15). |
| Failures | A failed batch is retried once after 2 s, then dropped and counted; `telemetry.sink_failed { sink, failedEvent, dropped }` (stdout) at most once per minute, where `dropped` is the documents lost since the last report and `failedEvent` the first event of the last failed batch (TASK-15). stdout still has the lines. One batch is written at a time. The driver sets each document's `_id` before sending, so a retry after a partial write gets duplicate-key errors for the stored documents, which count as written (TASK-15). |
| Startup | Connects in the background: the driver connects on the first write (the `app.started` batch), so creating the client does no I/O (TASK-15). A MongoDB outage never blocks startup or requests. |
| Shutdown | In this order: `await telemetry.flush(timeoutMs)` writes the buffer, `await telemetry.close()` stops the sink's timer, `await closeLogStore()` (`utils/mongo`) closes the client (TASK-15). Wired to SIGTERM and SIGINT by `installShutdown()` in `utils/lifecycle` (TASK-13, see [TASKS.md TASK-13](../TASKS.md)). The sink's `flush` resolves to the documents still buffered or in flight at the timeout, and its `dropped()` counts every document given up on (after the retry or by eviction) since the sink was created. Shutdown compares `dropped()` against a checkpoint taken before `app.stopping`, so losses while requests drain count as well as losses during the flush, and a written buffer is never mistaken for a lost one (TASK-13). |
| Health | `GET /api/health` reports `logStore: up/down/disabled`, never fails because of it. The probe is `probeLogStore()` from `utils/mongo`: a `ping` (no privilege needed, so the writer can run it) raced against a 1 s timer; `disabled` when `LOG_MONGO_URL` is empty. Wired into health (TASK-13). |

## 4. Document shape and indexes

Fields are the log line fields ([README.md §5](README.md)): `level, time, kind, event, service, env, module, requestId?, userId?, organizationId?` plus the event payload (`organizationId` from access stage 2 on, [access-stages.md](access-stages.md)). Indexes are listed in [DATABASE.md §8](../DATABASE.md).

## 5. Retention (manual)

### 5.1 Periods (Q18)

Defined once in `apps/api/src/utils/telemetry/retention.ts`:

| `kind` | Keep | Why |
|:---|:---|:---|
| `http` | 14 days | Highest volume; recent debugging and latency |
| `app` | 30 days | Startup, shutdown, warnings |
| `error` | 30 days | Investigate and spot repeats |
| `product` | 30 days | Only until PostHog is adopted ([posthog.md](posthog.md)) |
| `audit` | 365 days | Security investigations look back months |

### 5.2 The prune command

`apps/api/scripts/logs-prune.ts`, run as `bun run logs:prune` with `LOG_MONGO_ADMIN_URL`.

| Flag | Effect |
|:---|:---|
| `--dry-run` | Count what would be deleted per kind; delete nothing. **Always run first.** |
| `--kind <kind>` | Only one kind (repeatable) |
| `--older-than <days>` | Override the period for this run; must be ≥ the configured period unless `--force` is also given |
| `--batch <n>` | Batch size, default 10 000, at most 100 000 (TASK-15) |
| `--force` | Allows `--older-than` below the configured period; refused on its own (TASK-15) |

Algorithm, per kind:
1. `cutoff = now - retention[kind]`.
2. Repeat: find up to `batch` `_id`s with `{ kind, time: { $lt: cutoff } }` (uses `{ kind: 1, time: 1 }`), `deleteMany({ _id: { $in: ids } })`, until none are left.
3. Emit `app.logs_pruned { prunedKind, deleted, cutoff, dryRun }`. The field is `prunedKind`, not `kind`: `kind` is a base field of every line (`app` here) and would overwrite it (TASK-15). Each kind is emitted as soon as it finishes, so if a later kind fails, the deletions already done are still recorded (TASK-15).

The command is idempotent and safe to stop and re-run. It never touches PostgreSQL.

### 5.3 Deleting one user's logs

`bun run logs:prune --user <userId> [--dry-run]` deletes every document with that `userId`, all kinds included, and emits `app.logs_pruned { prunedKind: "all", deleted, erasedUserId, dryRun }`. `erasedUserId`, not `userId`: `userId` is the base field for the acting user, is indexed, and a later erasure of the same user would delete this record (TASK-15). `--user` cannot be combined with `--kind`, `--older-than` or `--force` (TASK-15). Used only for a documented erasure request.

### 5.4 Operating it

The [log-retention operations runbook](../../../operations/log-retention.md) supplies setup checks, exact command examples, filtering limits, partial-run caveats, and non-destructive recovery (TASK-022).

- **Who:** an operator with access to `LOG_MONGO_ADMIN_URL`.
- **When:** at least weekly (`http` grows fastest), and whenever disk use passes 70%. Run `--dry-run`, check the counts, then run for real.
- **Where it is recorded:** the `app.logs_pruned` events, which are themselves `app` logs: one line per kind on the script's stdout (the dry-run counts too), and in `log_event` when `LOG_MONGO_URL` is also set. The script records them through the normal telemetry path, so that write uses the insert-only writer; the admin user is used only to find, count, delete and create indexes. Storing the record therefore needs `LOG_MONGO_URL` (the writer) next to `LOG_MONGO_ADMIN_URL`; the admin user is not given `insert` (TASK-15).
- The team may put the same command in a host cron or CI schedule. That is still the manual command; the API never schedules deletion itself.

### 5.5 Emergency deletion without the script

```js
// mongosh, admin user; delete http logs older than 14 days
db.log_event.deleteMany({ kind: "http", time: { $lt: new Date(Date.now() - 14 * 864e5) } })
```

Use only if the script cannot run, and record it in the incident notes.

Both scripts run from `apps/api`, load the repo-root `.env` with `bun --env-file=../../.env` (a missing file is ignored) and need `LOG_MONGO_ADMIN_URL`. `logs:setup` uses `createIndexes` only, because the admin role has no `listIndexes` (TASK-15).

### 5.6 Why no TTL index

A TTL index would delete automatically, which is the opposite of what was agreed (Q18: manual). If the team later wants automatic deletion, a new decision can add one TTL index per kind via a partial filter; the prune command stays as the manual tool.

## 6. Flush vs purge

| Term | Meaning | Where |
|:---|:---|:---|
| **Flush** | Write buffered events so nothing is lost on shutdown | `telemetry.flush()` on SIGTERM |
| **Purge (prune)** | Delete events older than their retention | `bun run logs:prune`, run by an operator |

The API has no endpoint that deletes logs.

## 7. Querying

From mongosh or MongoDB Compass with a read-only user:

```js
// errors per module, last 24 h
db.log_event.aggregate([
  { $match: { kind: "error", time: { $gte: new Date(Date.now() - 864e5) } } },
  { $group: { _id: { module: "$module", code: "$code" }, count: { $sum: 1 } } },
  { $sort: { count: -1 } },
])

// every line of one request
db.log_event.find({ requestId: "4f1c…" }).sort({ time: 1 })

// p95 latency per module, last hour ($percentile, MongoDB 7+; checked on 8.3.13 with a find-only user (TASK-15))
db.log_event.aggregate([
  { $match: { event: "http.request", time: { $gte: new Date(Date.now() - 36e5) } } },
  { $group: { _id: "$module", p95: { $percentile: { input: "$durationMs", p: [0.95], method: "approximate" } } } },
])
```

A read-only user (`find` only) is created for people who query logs. No log viewer UI in the MVP.

## 8. Acceptance criteria (TASK-15)

- [ ] With `LOG_MONGO_URL` set, every event at `info`+ appears in `log_event` within 2 s with the same fields as the stdout line.
- [ ] With `LOG_MONGO_URL` empty, the API runs and writes stdout only.
- [ ] Stopping MongoDB does not fail or slow requests; `telemetry.sink_failed` appears at most once per minute; stdout keeps every line.
- [ ] Buffer overflow drops `http` docs first and emits `telemetry.sink_dropped`.
- [ ] SIGTERM writes the buffer before exit.
- [ ] The API user cannot read or delete (`find` and `deleteMany` fail with its credentials).
- [ ] `logs:setup` creates the indexes and is idempotent.
- [ ] `logs:prune --dry-run` deletes nothing and prints counts per kind; without it, documents older than the period are deleted and newer ones are kept, in batches; `app.logs_pruned` is emitted.
- [ ] `--older-than` below the configured period is refused without `--force`.
- [ ] `--user <id>` deletes only that user's documents.

The MongoDB checks run in `bun run test` when `TEST_LOG_MONGO_URL` (writer) and `TEST_LOG_MONGO_ADMIN_URL` (admin) point at `docker-compose.test.yml`; without them they are skipped. Separate names keep the app's own sink off during tests (TASK-15).
