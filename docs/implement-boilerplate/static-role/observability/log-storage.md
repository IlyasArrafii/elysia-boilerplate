# Log Storage and Retention: MongoDB (manual)

> **Status: Answered (DEC-034, Q17, Q18).** Built in TASK-15. MongoDB is the log store for now; [migration-loki.md](migration-loki.md) (Grafana Alloy + Loki, the default) and [migration-elk.md](migration-elk.md) (ELK Stack, the alternative) are the planned paths away from it. Driver and server details were checked in 2026-11; *verify* versions at build time.

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
| Server | MongoDB 8 (`mongo:8` image in docker compose, resolved to 8.3 in TASK-02; *verify* current major) |
| Database | `LOG_MONGO_DB`, default `app_logs` |
| Collection | `log_event` (regular collection; not a time-series collection, so arbitrary deletes stay simple) |
| Driver | Official `mongodb` package in `apps/api/src/utils/mongo` (*verify* Bun compatibility of the installed version) |
| Writer user (API) | `log_writer` (TASK-02), custom role `logWriter` with `insert` on `log_event` only. Used by `LOG_MONGO_URL`. Cannot read, delete or drop. |
| Admin user (scripts) | `log_admin` (TASK-02), custom role `logAdmin` with `find`, `remove`, `createIndex` on `log_event`. Used by `LOG_MONGO_ADMIN_URL`, only in the prune/setup scripts, never by the API process. |
| Read-only user (people) | `log_reader` (TASK-02), custom role `logReader` with `find` on `log_event`. For mongosh and Compass ([§7](#7-querying)); no process uses it. |
| Indexes | Created by `bun run logs:setup` ([DATABASE.md §8](../DATABASE.md)) |

All three users and roles live in the `LOG_MONGO_DB` database, so their URLs carry `authSource=app_logs`. Roles are scoped to the one collection, so none of them can touch another collection or database.

In dev, `LOG_MONGO_URL` may be empty (stdout only). docker compose includes the `mongo` service so the sink can be tried locally. Its init script, `infra/mongo/init.js` (TASK-02), creates the three users with throwaway passwords, only on an empty data volume. To change a password or privilege on existing dev data, run `docker compose down -v` first, which deletes the dev logs. Production creates the same users with its own passwords, outside docker compose.

## 3. Write path: the `mongo` sink

`apps/api/src/utils/telemetry/sinks/mongo.ts`, registered only when `LOG_MONGO_URL` is set.

| Behaviour | Rule |
|:---|:---|
| Levels | Lines at `LOG_MONGO_MIN_LEVEL` (default `info`) and above. `debug` stays on stdout. |
| Excluded events | `telemetry.sink_failed`, `telemetry.sink_dropped` (avoid loops), dev-only link events |
| Document | The scrubbed log line as-is, `time` converted to a BSON `Date` |
| Batching | Buffer in memory; `insertMany(docs, { ordered: false })` every 1 s or at 500 docs, whichever comes first |
| Write concern | `w: 1` (logs are not worth waiting on a majority) |
| Back-pressure | Buffer capped at 10 000 docs. On overflow drop the oldest `http` docs first, never `audit` or `error` while others remain; count drops and emit `telemetry.sink_dropped` (stdout) at most once per minute |
| Failures | A failed batch is retried once after 2 s, then dropped and counted; `telemetry.sink_failed` (stdout) at most once per minute. stdout still has the lines. |
| Startup | Connects in the background. A MongoDB outage never blocks startup or requests. |
| Shutdown | `flush(timeoutMs)` writes the buffer, then `close()` closes the client (TASK-13) |
| Health | `GET /api/health` reports `logStore: up/down/disabled`, never fails because of it |

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
| `--batch <n>` | Batch size, default 10 000 |

Algorithm, per kind:
1. `cutoff = now - retention[kind]`.
2. Repeat: find up to `batch` `_id`s with `{ kind, time: { $lt: cutoff } }` (uses `{ kind: 1, time: 1 }`), `deleteMany({ _id: { $in: ids } })`, until none are left.
3. Emit `app.logs_pruned { kind, deleted, cutoff, dryRun }`.

The command is idempotent and safe to stop and re-run. It never touches PostgreSQL.

### 5.3 Deleting one user's logs

`bun run logs:prune --user <userId> [--dry-run]` deletes every document with that `userId`, all kinds included, and emits `app.logs_pruned { kind: "all", deleted, userId }`. Used only for a documented erasure request.

### 5.4 Operating it

- **Who:** an operator with access to `LOG_MONGO_ADMIN_URL`.
- **When:** at least weekly (`http` grows fastest), and whenever disk use passes 70%. Run `--dry-run`, check the counts, then run for real.
- **Where it is recorded:** the `app.logs_pruned` events, which are themselves `app` logs.
- The team may put the same command in a host cron or CI schedule. That is still the manual command; the API never schedules deletion itself.

### 5.5 Emergency deletion without the script

```js
// mongosh, admin user; delete http logs older than 14 days
db.log_event.deleteMany({ kind: "http", time: { $lt: new Date(Date.now() - 14 * 864e5) } })
```

Use only if the script cannot run, and record it in the incident notes.

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

// p95 latency per module, last hour (MongoDB 7+: $percentile, verify)
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
