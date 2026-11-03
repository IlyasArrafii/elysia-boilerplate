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
- No app code changes: the log line shape ([README.md §5](README.md)) is already what Alloy parses.

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
3. **Run both.** Keep the `mongo` sink on and point Alloy at stdout. Both stores now receive the same lines.
4. **Check parity for at least 7 days.** Daily counts per `kind` and per `module` match between MongoDB and Loki (±0.5%); `requestId` lookups work in Grafana; labels are only those in §3.
5. **Build the minimum dashboards and alerts** (§6).
6. **Switch off the sink.** Unset `LOG_MONGO_URL` and deploy. The API writes stdout only.
7. **History.** Do not backfill old documents into Loki (Loki rejects old samples by default). Keep MongoDB read-only and keep running `logs:prune` until it is empty: `http` after 14 days, `app`/`error` after 30, `audit` after 365. If audit must be kept longer, export it first (`mongoexport --query '{"kind":"audit"}'`) to encrypted object storage.
8. **Decommission MongoDB** when `log_event` is empty; remove `utils/mongo`, the `mongo` sink, the `logs:*` scripts and the MongoDB env variables.
9. **Update the specs** (both `eng/` and `id/`): ARCHITECTURE, DATABASE §8, observability README and log-storage.

Rollback at any point before step 8: set `LOG_MONGO_URL` again.

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
