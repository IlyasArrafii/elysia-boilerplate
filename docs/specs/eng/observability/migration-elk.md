# Migration: MongoDB → ELK Stack (Elasticsearch, Logstash, Kibana)

> **Status: design only (DEC-041).** An alternative to [migration-loki.md](migration-loki.md): at migration time the team picks **one** of the two, never both. Do this when a trigger in §1 fires and a decision records it. Component names, settings and API paths were checked against Elastic docs for the 9.x line in 2026-11; *verify* every one against the installed version at migration time.

## 1. When to migrate, and when to pick ELK over Loki

The migration triggers are the same as Loki's ([migration-loki.md §1](migration-loki.md)): log writes load MongoDB or the API, more than one service needs central logs, the team needs dashboards and alerts, or pruning cannot keep up.

Pick **ELK** instead of Loki only if at least one of these is true:

| Pick ELK when | Why |
|:---|:---|
| Fast search on high-cardinality fields (`requestId`, `userId`, `code`, `err.message`) across weeks of logs is a daily need | Elasticsearch indexes every mapped field; Loki only indexes labels and scans the rest |
| The team or the company already runs Elasticsearch or Elastic Cloud | No new stack to learn or operate |
| Full-text search inside error messages and stack traces is needed | Loki's line filters are brute-force scans |

Otherwise pick **Loki**: Elasticsearch needs far more memory and disk (a JVM per node, ~1.5–3× the raw log size on disk with replicas) and more care to operate. That cost is the main trade-off of this document.

## 2. Target shape

```
apps/api ──stdout JSON──► container runtime ──► Filebeat ──► Logstash ──► Elasticsearch ──► Kibana
                                                │ tail          │ parse JSON   │ data stream per kind   │ Discover, dashboards,
                                                │ docker logs   │ route by kind│ manual retention       │ alerts
                                                │ buffer, retry │ safety redact│ (delete old indices)
```

- The app goes back to **stdout only**: the `mongo` sink is switched off. Filebeat ships the lines, so an Elasticsearch or Logstash outage never affects the API.
- The API has **no Elasticsearch credentials and no Elastic package**. Only Logstash writes to Elasticsearch.
- No app code changes: the log line shape ([README.md §5](README.md)) is already structured JSON.
- **Why Logstash and not Filebeat → Elasticsearch directly:** Logstash parses the JSON once, routes each line to a data stream by `kind`, and applies a last redaction pass (§5). If none of that is needed later, Filebeat can write to Elasticsearch directly with an ingest pipeline and Logstash is removed (new decision).
- Elastic Cloud runs the same Elasticsearch and Kibana; moving there later changes only the Logstash output `hosts` and API key.

## 3. Components and configuration

| Component | Role | Notes |
|:---|:---|:---|
| Elasticsearch 9.x | Storage and search | Security (TLS + auth) is on by default; keep it on |
| Logstash 9.x | Parse, route, redact | One pipeline, `api-logs` |
| Filebeat 9.x | Collect container stdout | `filestream` input on the Docker log files, with Docker metadata |
| Kibana 9.x | Query, dashboards, alerts | One data view: `logs-api.*` |

### 3.1 Filebeat (sketch, *verify* input and parser names)

```yaml
filebeat.inputs:
  - type: filestream
    id: api-containers
    paths: ["/var/lib/docker/containers/*/*.log"]
    parsers:
      - container: { stream: stdout }      # unwrap Docker's json-file format
processors:
  - add_docker_metadata: ~
  - drop_event:
      when.not.equals: { container.labels.logs: "api" }   # only the API container (label set in compose)
output.logstash:
  hosts: ["logstash:5044"]
  ssl.enabled: true
```

### 3.2 Logstash pipeline (sketch, *verify* plugin options)

```ruby
input { beats { port => 5044 ssl_enabled => true ssl_certificate => "..." ssl_key => "..." } }

filter {
  json { source => "message" target => "log" skip_on_invalid_json => true }
  if ![log][kind] { mutate { add_field => { "[log][kind]" => "app" } } }   # plain pino lines (log.debug) become kind "app"

  # move the parsed fields to the top level and drop the Beats wrapper
  ruby { code => "event.get('log').each { |k, v| event.set(k, v) }; event.remove('log')" }
  date { match => ["time", "ISO8601"] target => "@timestamp" remove_field => ["time"] }

  # safety net only: the scrubber in the API is the real redaction (redaction.md)
  prune { blacklist_names => ["^password$", "^token$", "^cookie$", "^authorization$", "^email$", "^name$", "^body$", "^url$"] }
  mutate { remove_field => ["message", "agent", "ecs", "input", "host", "container", "log.file"] }

  mutate {
    add_field => {
      "[data_stream][type]"      => "logs"
      "[data_stream][dataset]"   => "api.%{kind}"
      "[data_stream][namespace]" => "${APP_ENV}"
    }
  }
}

output {
  elasticsearch {
    hosts       => ["${ES_HOSTS}"]
    api_key     => "${ES_WRITER_API_KEY}"
    ssl_enabled => true
    data_stream => "true"            # routes by the [data_stream] fields above
  }
}
```

### 3.3 Data streams: one per kind

Retention differs by `kind` ([log-storage.md §5.1](log-storage.md)), so each kind gets its own data stream and can be pruned on its own:

| Kind | Data stream | Retention |
|:---|:---|:---|
| `http` | `logs-api.http-<env>` | 14 days |
| `app` | `logs-api.app-<env>` | 30 days |
| `error` | `logs-api.error-<env>` | 30 days |
| `product` | `logs-api.product-<env>` | 30 days |
| `audit` | `logs-api.audit-<env>` | 365 days |

`<env>` is `production`, `staging` or `development`.

### 3.4 Index template and mapping (sketch)

An explicit mapping with `dynamic: false`: unknown fields stay in `_source` (visible in Discover) but are not indexed, so a new event field can never cause a mapping explosion.

```json
PUT _index_template/logs-api
{
  "index_patterns": ["logs-api.*-*"],
  "data_stream": {},
  "priority": 200,
  "template": {
    "settings": { "index.lifecycle.name": "logs-api-rollover", "number_of_replicas": 1 },
    "mappings": {
      "dynamic": false,
      "properties": {
        "@timestamp":   { "type": "date" },
        "level":        { "type": "keyword" },
        "kind":         { "type": "keyword" },
        "event":        { "type": "keyword" },
        "service":      { "type": "keyword" },
        "env":          { "type": "keyword" },
        "module":       { "type": "keyword" },
        "sourceModule": { "type": "keyword" },
        "requestId":    { "type": "keyword" },
        "userId":       { "type": "keyword" },
        "method":       { "type": "keyword" },
        "route":        { "type": "keyword" },
        "status":       { "type": "short" },
        "durationMs":   { "type": "float" },
        "code":         { "type": "keyword" },
        "err": { "properties": {
          "name":    { "type": "keyword" },
          "code":    { "type": "keyword" },
          "message": { "type": "match_only_text" }
        } }
      }
    }
  }
}
```

- `priority: 200` puts it above Elasticsearch's built-in `logs-*-*` template (*verify* its priority and whether 9.x applies `logsdb` index mode to it).
- `err.stack` is not mapped: it is kept in `_source` and readable in Discover, but not searchable.
- Unlike Loki labels, `requestId` and `userId` are fine as indexed keywords here.

## 4. Retention in Elasticsearch: manual by default

Same periods and the same manual rule as MongoDB (Q18): nothing deletes logs automatically. Elasticsearch only **rolls over** to a new backing index every day; an operator deletes old backing indices.

### 4.1 Rollover-only policy

```json
PUT _ilm/policy/logs-api-rollover
{
  "policy": { "phases": { "hot": { "actions": {
    "rollover": { "max_age": "1d", "max_primary_shard_size": "50gb" }
  } } } }
}
```

No `delete` phase and no data stream lifecycle `data_retention`: that is what keeps deletion manual. Daily rollover makes each backing index hold about one day, so deletion is precise to a day.

### 4.2 Manual deletion

Deleting a whole backing index is cheap; deleting individual documents is expensive. So the prune script works on indices:

| Action | Request |
|:---|:---|
| List backing indices of a stream | `GET _data_stream/logs-api.http-production` |
| Newest document in one backing index | `GET .ds-logs-api.http-production-*-000042/_search` with `size: 0` and a `max` aggregation on `@timestamp` |
| Delete one old backing index | `DELETE .ds-logs-api.http-production-2026.10.01-000012` |
| Erase one user's lines (rare) | `POST logs-api.*-production/_delete_by_query` with `{ "query": { "term": { "userId": "usr_…" } } }` |

A script `scripts/elk-prune.ts` (written at migration time) does, for each kind:
1. List the stream's backing indices and skip the current write index (it cannot be deleted).
2. Delete an index only if its **newest** `@timestamp` is older than now minus the kind's retention. Using the newest document, not the index creation date, stays correct even for backfilled data (§6 step 7).
3. `--dry-run` prints the indices, their date range and document counts without deleting.
4. Emits one `app.logs_pruned` line per kind to stdout (same event as `logs:prune`).

It replaces `logs:prune` once MongoDB is gone, and runs with the `logs_pruner` key only.

### 4.3 Automatic alternative

If the team later prefers automatic deletion, add a delete phase per kind (one policy per kind) or set data stream lifecycle `data_retention`, and stop the manual script (new decision):

```json
PUT _ilm/policy/logs-api-http
{ "policy": { "phases": {
  "hot":    { "actions": { "rollover": { "max_age": "1d", "max_primary_shard_size": "50gb" } } },
  "delete": { "min_age": "14d", "actions": { "delete": {} } }
} } }
```

## 5. Security and access

| Principal | Privileges (on `logs-api.*`) | Used by |
|:---|:---|:---|
| `logs_writer` API key | `create_doc`, `auto_configure` | Logstash only |
| `logs_reader` role | `read`, `view_index_metadata` | People, through Kibana |
| `logs_pruner` API key | `read`, `view_index_metadata`, `delete_index`, `delete` | `elk-prune.ts` only |

- Same split as the MongoDB users ([log-storage.md](log-storage.md)): the writer cannot read or delete, people cannot delete.
- TLS between Filebeat → Logstash → Elasticsearch, and HTTPS for Kibana. Elasticsearch and Kibana are never exposed to the public internet.
- The `elastic` superuser is used only to bootstrap roles and keys, then its password is rotated and stored in the secret manager.
- Redaction stays in the API scrubber ([redaction.md](redaction.md)). The Logstash `prune` filter is a safety net for known key names, not a replacement.
- Licence: the free (Basic) tier covers everything in this document except some alert connectors (§7). *Verify* the current licence terms before adopting.

## 6. Migration steps

1. **Decision.** Record the migration and the choice of ELK over Loki (supersedes the MongoDB part of DEC-034; DEC-035 is not used).
2. **Deploy the stack.** Elasticsearch, Logstash, Kibana and Filebeat (`docker-compose.elk.yml` or the platform's equivalent). Production: at least 3 Elasticsearch nodes, or Elastic Cloud. Create the policy (§4.1), the index template (§3.4), the roles and keys (§5) before Logstash starts.
3. **Run both.** Keep the `mongo` sink on and let Filebeat read stdout. Both stores now receive the same lines.
4. **Check parity for at least 7 days.** Daily counts per `kind` and per `module` match between MongoDB and Elasticsearch (±0.5%); a `requestId` search in Kibana finds every line of a request; no unmapped field is needed for daily queries.
5. **Build the minimum dashboards and alerts** (§7).
6. **Switch off the sink.** Unset `LOG_MONGO_URL` and deploy. The API writes stdout only.
7. **History.** Elasticsearch accepts old timestamps, so backfill is possible but optional:
   - Recommended: backfill `audit` only, if its 365-day history must stay searchable in one place: `mongoexport --query '{"kind":"audit"}'` → Logstash file input → `logs-api.audit-<env>`.
   - Everything else: keep MongoDB read-only and keep running `logs:prune` until it is empty (`http` after 14 days, `app`/`error`/`product` after 30, `audit` after 365 if not backfilled).
8. **Decommission MongoDB** when `log_event` is empty (or after the audit backfill is verified); remove `utils/mongo`, the `mongo` sink, the `logs:*` scripts and the MongoDB env variables.
9. **Update the specs** (both `eng/` and `id/`): ARCHITECTURE, DATABASE §8, observability README and log-storage.

Rollback at any point before step 8: set `LOG_MONGO_URL` again.

## 7. Dashboards and alerts (minimum)

| Panel / alert | Kibana query idea (KQL / Lens, *verify*) |
|:---|:---|
| Request rate and 5xx rate per module | Lens on `logs-api.http-*`: count, broken down by `module`, filter `status >= 500` for the error series |
| p95 latency per module | Lens: 95th percentile of `durationMs` by `module` |
| Error spike per module | Rule "Elasticsearch query" on `logs-api.error-*`: count grouped by `module` over 5 min above a threshold |
| Sign-in failure spike | Rule on `logs-api.audit-*`: `event : "audit.auth.sign_in_failed"` count over 5 min |
| Role changes, bans, blocked endpoints | Saved search: `event : (audit.user.* or "audit.auth.blocked_endpoint")` |

On the free tier the built-in alert connectors are limited (index and server log); sending alerts to email or Slack may need a paid licence or Elastic Cloud. *Verify* before relying on notifications.

## 8. Acceptance criteria (future task)

- [ ] Filebeat ships only the API container's stdout; Logstash writes each line to `logs-api.<kind>-<env>` by its `kind`.
- [ ] Every mapped field in §3.4 is searchable; an unknown field is in `_source` but adds no mapping.
- [ ] A `requestId` from a response header finds every line of that request in Kibana.
- [ ] Parity check (§6 step 4) passes for 7 days before the sink is switched off.
- [ ] Stopping Elasticsearch or Logstash does not affect the API; lines from the outage arrive after it returns (within Filebeat's buffer).
- [ ] No policy has a `delete` phase and no stream has `data_retention`; a dry run of `elk-prune.ts` lists the old backing indices per kind; a real run deletes only indices whose newest document is past the period, never the write index.
- [ ] The writer key cannot read or delete; the reader role cannot delete.
- [ ] Dashboards and alerts in §7 exist.
