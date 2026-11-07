# Migration: MongoDB → Grafana Alloy + Loki

> **Status: design only (DEC-035).** Do this when a trigger in §1 fires and a decision records it. Component names and config keys were checked against Grafana docs in 2026-11; *verify* them at migration time.

## 1. When to migrate

Any one of these:
- Log writes noticeably load MongoDB or the API (sink drops in `telemetry.sink_dropped`, slow inserts).
- More than one service needs central logs.
- The team needs dashboards and alerts on logs (Grafana) rather than ad-hoc queries.
- `log_event` storage grows faster than weekly pruning can keep up with.

## 2. Target shape

```
apps/api ──stdout JSON──► container runtime ──► Grafana Alloy ──► Loki ──► Grafana
                                                 │ parse JSON      │ retention: manual (delete API)
                                                 │ set labels      │ or automatic (compactor)
                                                 │ buffer + retry
```

- The app goes back to **stdout only**: the `mongo` sink is switched off. Alloy ships the lines, so a Loki outage never affects the API.
- Use **Grafana Alloy**, not Promtail (Promtail reached end of life on 2026-03-02).
- Grafana Cloud runs the same Loki; moving there later changes only the `loki.write` endpoint and credentials.
- The log line shape ([README.md §5](README.md)) is already what Alloy parses, so the lines themselves do not change. The code that writes to, checks or closes the log store does: [§5.1](#51-what-still-uses-the-log-store) lists it.

## 3. Alloy configuration

```alloy
// sketch, verify component names and arguments against the Alloy docs
discovery.docker "containers" { host = "unix:///var/run/docker.sock" }

loki.source.docker "api" {
  host       = "unix:///var/run/docker.sock"
  targets    = discovery.docker.containers.targets
  forward_to = [loki.process.api.receiver]
}

loki.process "api" {
  stage.json   { expressions = { level = "level", kind = "kind", service = "service", env = "env", module = "module" } }
  stage.labels { values = { level = "", kind = "", service = "", env = "", module = "" } }
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint { url = env("LOKI_PUSH_URL") }
}
```

### Labels

| Label | Values | OK? |
|:---|:---|:---|
| `service`, `env` | few | yes |
| `kind` | `http`, `app`, `error`, `audit`, `product` | yes; drives retention |
| `level` | pino levels | yes |
| `module` | module names + `auth`, `core` (bounded, a few dozen at most) | yes; "errors per module" becomes a label query |
| `userId`, `requestId`, `route`, `event`, `sourceModule` | large or unbounded | **never labels**; query as JSON fields (`| json | requestId="…"`) |

## 4. Retention in Loki: manual by default

Same periods as MongoDB ([log-storage.md §5.1](log-storage.md)). To stay manual (Q18), automatic retention is disabled and old logs are deleted through Loki's delete API. The delete endpoints exist only while compactor retention is enabled.

```yaml
# Loki config sketch, verify keys against the Loki docs for the installed version
compactor:
  retention_enabled: true              # required for the delete API
  delete_request_store: filesystem     # or the object store in use
  delete_request_cancel_period: 24h
limits_config:
  retention_period: 0s                 # 0s = never delete automatically (manual mode)
  deletion_mode: filter-and-delete     # hide and remove matching lines
```

### Manual deletion

| Action | Request |
|:---|:---|
| Delete one kind older than its period | `POST /loki/api/v1/delete?query={kind="http"}&start=<epoch 0>&end=<now-14d>` → 204 |
| List delete requests | `GET /loki/api/v1/delete` |
| Cancel within the cancel period | `DELETE /loki/api/v1/delete?request_id=<id>` |
| Delete one user's lines | `POST /loki/api/v1/delete?query={service="api"} \|= "usr_…"&start=…&end=…` (line filter; heavy, use rarely) |

A script `scripts/loki-prune.ts` (written at migration time) loops over the retention table and sends one delete request per kind, with `--dry-run` printing the requests. It replaces `logs:prune` once MongoDB is gone. Deletion happens after the cancel period, when the compactor runs.

### Automatic alternative

If the team later prefers automatic deletion, set per-stream retention instead and stop the manual script (new decision):

```yaml
limits_config:
  retention_period: 720h               # default 30 days
  retention_stream:
    - { selector: '{kind="http"}',  priority: 1, period: 336h }   # 14 days
    - { selector: '{kind="audit"}', priority: 1, period: 8760h }  # 365 days
```

## 5. Migration steps

1. **Decision.** Record the migration (supersedes the MongoDB part of DEC-034).
2. **Deploy the stack.** Loki, Alloy and Grafana (`docker-compose.observability.yml` or the platform's equivalent). Object-storage versioning on before retention is enabled.
3. **Run both.** Keep the `mongo` sink on and point Alloy at stdout. Both stores now receive the same lines. Keep `LOG_LEVEL` equal to `LOG_MONGO_MIN_LEVEL` (both `info` by default): stdout carries only lines at or above `LOG_LEVEL` ([log-storage.md §1](log-storage.md)) and MongoDB only lines at or above `LOG_MONGO_MIN_LEVEL` ([log-storage.md §3](log-storage.md)), so any other setting fails the parity check.
4. **Check parity for at least 7 days.** Daily counts per `kind` and per `module` match between MongoDB and Loki (±0.5%); `requestId` lookups work in Grafana; labels are only those in §3.
5. **Build the minimum dashboards and alerts** (§6).
6. **Switch off the sink.** Production refuses to start without `LOG_MONGO_URL` (`readLogMongoUrl` in `apps/api/src/env.ts`), so first deploy a change that lets it start without one (part of the step 1 decision). Then unset `LOG_MONGO_URL` and deploy. The API writes stdout only: no `mongo` sink is registered, `GET /api/health` reports `logStore: "disabled"`, and the shutdown's `logStore` step has nothing to close. `logs:prune` keeps working with `LOG_MONGO_ADMIN_URL` for step 7, but its `app.logs_pruned` records now reach stdout only: keep its output with the operation record.
7. **History.** Do not backfill old documents into Loki (Loki rejects old samples by default). Keep MongoDB read-only and keep running `logs:prune` until it is empty: `http` after 14 days, `app`/`error` after 30, `audit` after 365. If audit must be kept longer, export it first (`mongoexport --query '{"kind":"audit"}'`) to encrypted object storage.
8. **Decommission MongoDB** when `log_event` is empty: remove or change everything in §5.1 in one change, then review what `git grep -il mongo -- ':!docs'` still finds.
9. **Update the docs in this folder** with the changes of steps 6 and 8 ([README.md](../README.md#keeping-this-folder-true), DEC-053): DECISIONS, ARCHITECTURE (environment variables, graceful shutdown), API §3.2 (`logStore`), DATABASE §8, TESTING (CI and §6.3), the observability README and log-storage, the root README's environment table (`LOG_MONGO_URL`), and the [log-retention runbook](../../../operations/log-retention.md). Never edit `docs/specs/`, the frozen design baseline (DEC-052).

Rollback at any point before step 8: set `LOG_MONGO_URL` again.

### 5.1 What still uses the log store

Step 6 changes the first row only, with its tests; step 8 removes or changes every row.

| Where | What it does with the log store | Step 6 (sink off) | Step 8 (decommission) |
|:---|:---|:---|:---|
| `apps/api/src/env.ts` | `LOG_MONGO_URL` (required in production), `LOG_MONGO_DB`, `LOG_MONGO_MIN_LEVEL`, `readLogMongoAdminUrl()` | Let production start without `LOG_MONGO_URL` | Remove the variables |
| `apps/api/src/utils/mongo/`, `utils/telemetry/sinks/mongo.ts`, the sink registration in `utils/telemetry/index.ts`, `'mongo'` in `SinkName` (`types.ts`) and in the event routes (`events.ts`) | The write path | Off once `LOG_MONGO_URL` is unset | Remove, with the `mongodb` dependency of `apps/api` |
| `GET /api/health` (`modules/health`) and the web health page (`apps/web/src/features/health/`) | Report `logStore` | Reports `disabled` | Remove the field from API, web and their tests together, or keep it as `disabled` (decide in step 1) |
| Graceful shutdown (`utils/lifecycle`) | The `logStore` step closes the client | Nothing to close | Remove the step |
| `bun run role:set` (`apps/api/scripts/role-set.ts`) | Closes the log store; warns when its audit event may not have reached it | Unchanged | Remove the close and that warning |
| `logs:setup`, `logs:prune` (`apps/api/scripts/`, `apps/api/package.json`) and the [log-retention runbook](../../../operations/log-retention.md) | Indexes and manual retention | Keep running `logs:prune` (step 7) | Remove; the new prune script replaces them (§4) |
| `docker-compose.yml`, `docker-compose.test.yml`, `docker-compose.dev.yml`, `infra/mongo/` | The `mongo` service, its volumes and `MONGO_PORT` | Unchanged | Remove |
| `.github/workflows/ci.yml`, `.trivyignore.yaml` | The test stack's MongoDB, `TEST_LOG_MONGO_URL` / `TEST_LOG_MONGO_ADMIN_URL`, the E2E step's `LOG_MONGO_URL` and `E2E_LOG_MONGO_URL` (the posts E2E reads logs as `log_reader`), the MongoDB image scan and its waivers | Unchanged | Remove in the same change as the tests: CI fails a run in which any test is skipped |
| `.env.example`, `scripts/setup.ts`, `scripts/doctor.ts`, `scripts/lib/probes.ts`, `scripts/lib/checks.ts`, `scripts/check-env.ts` (the CI env that `bun run check` reproduces) | Start, probe and check MongoDB and its variables | Unchanged | Remove the MongoDB parts |
| Tests (`git grep -il mongo -- apps/api/tests apps/web/tests`) | Live and in-memory checks of the rows above | Unchanged | Remove, or assert on stdout or the memory sink instead |

## 6. Dashboards and alerts (minimum)

| Panel / alert | Query idea (LogQL, *verify*) |
|:---|:---|
| Request rate and 5xx rate per module | `sum by (module) (rate({kind="http"}[5m]))` |
| p95 latency per module | `quantile_over_time(0.95, {kind="http"} \| json \| unwrap durationMs [5m]) by (module)` |
| Error spike per module | `sum by (module) (count_over_time({kind="error"}[5m])) > threshold` |
| Sign-in failure spike | `count_over_time({kind="audit"} \|= "audit.auth.sign_in_failed" [5m]) > threshold` |
| Role changes, bans, blocked endpoints | `{kind="audit"} \| json \| event=~"audit.user.*\|audit.auth.blocked_endpoint"` |

## 7. Acceptance criteria (future task)

- [ ] Alloy ships API logs to Loki with labels `service`, `env`, `kind`, `level`, `module` only.
- [ ] A `requestId` from a response header finds every line of that request in Grafana.
- [ ] Parity check (§5 step 4) passes for 7 days before the sink is switched off.
- [ ] Stopping Loki does not affect the API; lines from the outage arrive after Loki returns (within Alloy's buffer).
- [ ] Manual deletion: a dry run lists one request per kind; a real run deletes lines older than the period after the cancel period; `retention_period` is `0s`.
- [ ] Dashboards and alerts in §6 exist.
