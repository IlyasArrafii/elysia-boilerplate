# Observability

pino ditambah telemetry event manual, tanpa OpenTelemetry (DEC-013, DEC-014, DEC-016, DEC-026, DEC-027, DEC-034, DEC-037). Cakupan MVP: hanya API.

| Dokumen | Isi |
|:---|:---|
| Berkas ini | Model event, penandaan modul, logging request, katalog event, kontrak `telemetry` |
| [redaction.md](redaction.md) | Apa yang tidak boleh di-log dan cara menghapusnya |
| [log-storage.md](log-storage.md) | Log store MongoDB, jalur tulis, retensi manual (prune) |
| [migration-loki.md](migration-loki.md) | Pindah dari MongoDB ke Grafana Alloy + Loki (desain saja) |
| [migration-elk.md](migration-elk.md) | Pindah dari MongoDB ke ELK Stack: Elasticsearch, Logstash, Kibana (desain saja, alternatif Loki) |
| [sentry.md](sentry.md) | Menambah Sentry untuk error tracking (desain saja) |
| [posthog.md](posthog.md) | Menambah PostHog untuk analitik produk (desain saja) |
| [access-stages.md](access-stages.md) | Yang berubah di access stage 2 (single-org) dan di Langkah A: `organizationId`, event `access.*` dan `audit.org.*` |
| [../saas/observability.md](../saas/observability.md) | Lapisan SaaS multi-tenant: query per tenant, Sentry dan PostHog per organisasi, purge tenant, alert isolasi |

## 1. Gambaran

```
kode aplikasi ──► telemetry.emit('posts.created', { postId }, ctx)      ctx = { requestId, module, userId }
                  │
                  ▼
            scrubber (redaction.md)
                  │
                  ├─► sink log     (selalu)                     → pino → stdout (JSON)
                  ├─► sink mongo   (bila LOG_MONGO_URL diisi)   → insert berbatch → MongoDB log_event
                  ├─► sink memory  (hanya test)
                  ├─► sink sentry  (desain saja, sentry.md)
                  └─► sink posthog (desain saja, posthog.md)
```

- Kode aplikasi **tidak pernah** mengimpor SDK vendor atau driver MongoDB. Hanya `utils/telemetry/sinks/*` dan `utils/mongo` yang boleh.
- `log` (pino dari context) tetap boleh dipakai untuk baris teknis biasa (`log.debug(...)`); baris itu hanya masuk **stdout**. Apa pun yang harus bisa dicari nanti wajib berupa event.

## 2. Tata letak kode

```
apps/api/src/utils/
  logger/
    index.ts        instans pino (path redact, level dari LOG_LEVEL, pino-pretty hanya di dev)
    plugin.ts       plugin bernama 'logger' (as: 'global'): request ID, log context, http.request
    module.ts       moduleScope(name): menandai log context dengan modul (§4)
  telemetry/
    events.ts       katalog event bertipe (nama → tipe payload → kind → sink)
    retention.ts    jumlah hari retensi per kind (log-storage.md §5)
    scrub.ts        scrubber (redaction.md §4)
    index.ts        emit(), registri sink, flush()
    sinks/
      log.ts        → stdout pino
      mongo.ts      → MongoDB, berbatch (log-storage.md §3)
      memory.ts     → array di memori, hanya test
  error/
    index.ts        moduleError(), global onError → { code, message }, memancarkan http.error
  mongo/
    index.ts        klien MongoDB bersama untuk log store
```

## 3. Request ID dan log context

- Baca `x-request-id` bila valid (≤ 64 karakter, `[A-Za-z0-9_-]`); bila tidak, `crypto.randomUUID()`. Kembalikan di header response `x-request-id`.
- Plugin `logger` membuat **log context** per request `{ requestId, module: "core" }` dan child logger `log` yang terikat padanya.
- `moduleScope` mengisi `module` (§4). Macro `auth` menambah `userId`, dan di access stage 2 `organizationId` ([access-stages.md §3](access-stages.md)).
- Setiap event yang dipancarkan selama request mendapat context ini, sehingga `module`, `requestId`, dan `userId` tidak perlu dioper manual.

## 4. Penandaan modul (DEC-037)

API ini modular monolith, jadi pertanyaan pertama untuk setiap error adalah "modul yang mana?". Jawabannya datang dari modul itu sendiri, bukan dari mengurai route.

```ts
// apps/api/src/modules/posts/index.ts (sketsa)
export const posts = new Elysia({ name: 'posts', prefix: '/posts' })
  .use(moduleScope('posts'))     // baris pertama setiap controller
  .use(authPlugin)
  .get('/', ...)
```

- `moduleScope(name)` adalah plugin bernama (`name: 'module-scope', seed: name`) dengan hook **scoped** yang berjalan sebelum validasi, mengisi `logContext.module = name`, dan mengikat ulang `log` dengannya. Hook ini hanya berlaku untuk route controller yang memakainya.
- Nama modul sama dengan nama folder di `src/modules/` dan dicek saat startup terhadap daftar modul yang dipasang (salah ketik menggagalkan startup).
- Nilai `module`: nama modul, `"auth"` (handler, hook, dan logger Better Auth), atau `"core"` (route tak dikenal, gagal parse body sebelum routing, kode root app, startup, dan shutdown).

**Error yang dilempar di service** memakai `moduleError`, bukan `status(...)` biasa:

```ts
// sketsa
throw moduleError('posts', 404, 'POST_NOT_FOUND', 'Post not found')
```

- Response-nya `{ code, message }` biasa dengan status itu (DEC-017).
- `http.error` mendapat `sourceModule: "posts"`. Bila `PostService` dipanggil dari route modul lain, `module` adalah modul yang menangani dan `sourceModule` adalah modul yang melempar, sehingga kegagalan lintas modul terlihat.
- Error tak terduga (database mati, bug) tidak punya `sourceModule`; `module` dari scope tetap menunjukkan lokasinya.

`http.error` **tidak punya field route**: error dikelompokkan per `module` + `code` (+ `sourceModule`). `http.request` tetap menyimpan pola route untuk latensi per endpoint.

## 5. Bentuk baris log

Setiap baris (dan setiap dokumen tersimpan) punya field tingkat atas berikut:

| Field | Nilai | Dipakai untuk |
|:---|:---|:---|
| `level` | level pino | filter |
| `time` | ISO 8601 (BSON `Date` di MongoDB) | urutan, retensi |
| `kind` | `http`, `app`, `error`, `audit`, `product` | kelas retensi |
| `event` | nama di katalog | query |
| `service` | `api` | label |
| `env` | `NODE_ENV` | label |
| `module` | nama modul, `auth`, atau `core` | mengelompokkan error dan request per modul |
| `requestId` | di dalam request | korelasi |
| `userId` | saat login | audit, penghapusan data |
| `organizationId` | hanya access stage 2 dan SaaS, di dalam route yang ber-scope organisasi ([access-stages.md](access-stages.md)) | query per organisasi, purge tenant |

Contoh:

```json
{ "level": "info", "time": "2026-11-02T10:00:00.000Z", "kind": "http", "event": "http.request",
  "service": "api", "env": "production", "module": "posts", "requestId": "4f1c…",
  "method": "GET", "route": "/api/posts/:id", "status": 200, "durationMs": 12.4, "userId": "usr_…" }

{ "level": "error", "time": "2026-11-02T10:00:01.000Z", "kind": "error", "event": "http.error",
  "service": "api", "env": "production", "module": "posts", "sourceModule": "posts", "requestId": "9a2e…",
  "status": 500, "code": "INTERNAL_ERROR",
  "err": { "name": "PostgresError", "code": "57P01", "message": "terminating connection…", "stack": "…" } }
```

- `route` (hanya di `http.request`) adalah **pola** route, tidak pernah URL mentah.
- Level: `info` di bawah 400, `warn` untuk 4xx, `error` untuk 5xx. `/api/health` di-log di `debug`.

## 6. Katalog event

| Event | Kind | Payload (plus field context) | Sink |
|:---|:---|:---|:---|
| `http.request` | `http` | `method, route, status, durationMs` | log, mongo |
| `http.error` | `error` | `status, code, sourceModule?, err` ([redaction.md §3](redaction.md)) | log, mongo |
| `app.started` / `app.stopping` | `app` | `version, env` | log, mongo |
| `app.logs_pruned` | `app` | `kind, deleted, cutoff, dryRun` | log, mongo |
| `cache.fallback` | `app` | `reason` | log, mongo (warn) |
| `rbac.unknown_role` | `app` | `roles: { role, count }[]` | log, mongo (warn) |
| `telemetry.sink_failed` | `app` | `sink, event` | hanya log (warn), maksimal sekali per menit per sink |
| `telemetry.sink_dropped` | `app` | `sink, dropped` | hanya log (warn), maksimal sekali per menit |
| `audit.session.created` | `audit` | `sessionId, ip, userAgent` | log, mongo |
| `audit.session.revoked` | `audit` | `sessionId, actorId?` | log, mongo |
| `audit.user.role_changed` | `audit` | `from, to, actorId` | log, mongo |
| `audit.user.banned` / `audit.user.unbanned` | `audit` | `actorId, expiresAt?` | log, mongo |
| `audit.account.linked` | `audit` | `provider` | log, mongo |
| `audit.auth.sign_in_failed` | `audit` | `ip, reason` | log, mongo |
| `audit.auth.blocked_endpoint` | `audit` | `path, actorId?` | log, mongo |
| `auth.verification_link`, `auth.reset_link` | `app` | `url` | hanya log, **hanya dev**; mendaftarkannya di produksi melempar error saat startup |

Access stage 2 menambah event `access.*` dan `audit.org.*` ([access-stages.md §3.2](access-stages.md)); lapisan SaaS menambah event-nya sendiri ([saas/observability.md](../saas/observability.md)).

Audit event membawa `userId` yang terdampak di context (user target untuk aksi admin). Memanggil `emit()` dengan nama tak dikenal atau payload yang salah adalah error TypeScript.

## 7. Kontrak `telemetry` (sketsa)

```ts
export interface Sink {
  name: SinkName
  minLevel?: Level
  handle(line: LogLine): void            // sudah di-scrub, context sudah digabung
  flush?(timeoutMs: number): Promise<void>
  close?(): Promise<void>
}
export const telemetry = {
  emit<E extends keyof EventPayloads>(event: E, payload: EventPayloads[E], ctx?: Partial<LogContext>): void,
  flush(timeoutMs?: number): Promise<void>,
}
```

Aturan:
1. `emit` **tidak pernah melempar error** dan tidak pernah di-await di jalur request. Kegagalan sink ditangkap dan dilaporkan sebagai `telemetry.sink_failed` (dibatasi frekuensinya, hanya stdout agar tidak berputar).
2. Payload melewati scrubber **sebelum** sink mana pun.
3. `flush(timeoutMs)` mengosongkan sink yang ber-buffer (buffer `mongo`) saat graceful shutdown; default 3 detik. Flush tentang buffer, bukan menghapus data lama ([log-storage.md §6](log-storage.md)).

## 8. Metrik tanpa SDK metrik

Latensi (p50/p95), throughput, dan error rate per modul dihitung dari `http.request` dan `http.error` di MongoDB (aggregation pipeline, [log-storage.md §7](log-storage.md)). Target NFR (p95 < 50 ms pada cache hit) dicek dengan cara ini.

## 9. Di luar cakupan (MVP)

Sentry, PostHog, Loki, ELK, telemetry frontend, distributed tracing, span database/Redis, dashboard, UI penampil log.

## 10. Kriteria penerimaan (TASK-12, TASK-15)

- [ ] Setiap request menghasilkan tepat satu `http.request` yang `requestId`-nya sama dengan header response dan `module`-nya adalah modul pemilik route.
- [ ] Setiap baris log punya `level`, `time`, `kind`, `event`, `service`, `env`, `module`.
- [ ] Error 500 di dalam `posts` menghasilkan `http.error` dengan `module: "posts"`, stack di log, tanpa field route, dan body response hanya `{ code: "INTERNAL_ERROR", message }`.
- [ ] `moduleError` yang dilempar `PostService` saat menangani route modul lain punya `module` = modul penangan dan `sourceModule: "posts"`.
- [ ] Route tak dikenal dan body JSON rusak menghasilkan `module: "core"`; error Better Auth menghasilkan `module: "auth"`.
- [ ] Controller tanpa `moduleScope`, atau dengan nama yang bukan modul terpasang, menggagalkan startup.
- [ ] Setiap aturan di [redaction.md §7](redaction.md) punya test yang lulus.
- [ ] Sink yang melempar error tidak menggagalkan request dan menghasilkan maksimal satu `telemetry.sink_failed` per menit.
- [ ] Audit event di §6 muncul saat sign-in, sign-out, perubahan role, ban, penautan Google, dan endpoint yang diblokir.
- [ ] SIGTERM memanggil `telemetry.flush()` sebelum proses berhenti.
- [ ] Kriteria MongoDB di [log-storage.md §8](log-storage.md).
