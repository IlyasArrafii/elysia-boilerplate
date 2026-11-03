# Observability di Multi-Tenant

> **Status: desain saja (DEC-050, DEC-051).** Apa yang ditambahkan pada log, event telemetri, dan sink vendor setelah aplikasi menjadi multi-tenant ([multi-tenant.md](multi-tenant.md)). Model dasarnya ada di [observability/README.md](../observability/README.md); tahap 2 (tempat `organizationId` pertama kali muncul) ada di [observability/access-stages.md](../observability/access-stages.md).

## 1. Ringkasan

| | Tahap 2: single-org | **Multi-tenant** |
|:---|:---|:---|
| `organizationId` di konteks log | Di dalam route yang ber-scope organisasi | Sama, dan **wajib** di sana: yang hilang menggagalkan test di §7 |
| Index MongoDB | Tidak ada pada `organizationId` | `{ organizationId: 1, time: -1 }` (sparse) |
| Pertanyaan yang terjawab | Per modul | Per modul **dan** per tenant: error, latensi, jejak audit satu pelanggan |
| Event keamanan | — | `security.tenant_violation` (§3) |
| Sentry | User ID | User ID + tag `organizationId` (§6) |
| PostHog | `distinctId` = user ID | Ditambah group `organization` (§6) |
| Purge tenant | — | `logs:prune --org` (§5) |

## 2. Konteks log dan query

- Macro `auth` men-set `organizationId` dari organisasi aktif ([architecture.md §1](architecture.md)). Route platform tidak punya nilai ini di konteks; event-nya menyebut targetnya di payload (`targetOrganizationId`).
- Tidak pernah nama, slug, atau logo organisasi ([redaction.md §1](../observability/redaction.md)).
- Index, dibuat oleh `bun run logs:setup`: `{ organizationId: 1, time: -1 }`, sparse, di samping index di [DATABASE.md §8](../DATABASE.md).

```js
// error per tenant dan modul, 24 jam terakhir (sketsa)
db.log_event.aggregate([
  { $match: { kind: "error", time: { $gte: since24h }, organizationId: { $exists: true } } },
  { $group: { _id: { organizationId: "$organizationId", module: "$module", code: "$code" }, count: { $sum: 1 } } },
  { $sort: { count: -1 } }, { $limit: 20 },
])
```

Pencarian audit di konsol platform ([platform-console.md §4](platform-console.md)) membaca dengan index yang sama.

## 3. Event yang ditambahkan

| Event | Kind | Payload (plus field konteks) | Sink |
|:---|:---|:---|:---|
| `security.tenant_violation` | `error` | `module, sqlState, table` | log, mongo (error), Sentry bila diadopsi. **Alert pada setiap kejadian** ([architecture.md §4.4](architecture.md)) |
| `org.purged` | `app` | `organizationId, tables, rows, logsDeleted, dryRun` | log, mongo |
| `audit.org.*` (multi-tenant) | `audit` | [multi-tenant.md §12](multi-tenant.md) | log, mongo |
| `audit.platform.*` | `audit` | [platform-console.md §8](platform-console.md) | log, mongo |

Semuanya bertipe di `events.ts` seperti katalog dasar. `security.*` adalah prefix baru dengan kelas retensi `error`.

## 4. Langkah B (tahap 2 → multi-tenant)

| Rilis | Yang berubah |
|:---|:---|
| B1 (row-level security) | Tambah index `organizationId`; daftarkan `security.tenant_violation` dan alert-nya. Setiap kejadian selama B1 adalah query yang melewati `scoped()` dan harus diperbaiki sebelum B2 |
| B2 (membuka multi-tenancy) | Event `audit.org.*` multi-tenant dan `audit.platform.*`; tag Sentry dan group PostHog bila vendor itu diadopsi |

Baris lama tetap punya `organizationId` (tahap 2 sudah men-set-nya), jadi tidak perlu backfill.

## 5. Purge tenant dan retensi

- Periode retensi tetap per `kind` ([log-storage.md §5](../observability/log-storage.md)). Tidak ada retensi per tenant di versi pertama.
- `bun run logs:prune --org <organizationId> [--dry-run]` menghapus setiap dokumen organisasi itu **kecuali `audit`**. `org:purge` ([multi-tenant.md §8](multi-tenant.md)) menjalankannya, lalu meng-emit `org.purged`.
- Baris audit organisasi yang di-purge tetap ada sampai retensi normal 365 hari: itulah catatan siapa melakukan apa, dan hanya berisi ID.
- Penghapusan data user (`logs:prune --user`) tidak berubah dan berlaku lintas organisasi.

## 6. Vendor

| Vendor | Perubahan | Tidak pernah |
|:---|:---|:---|
| Sentry ([sentry.md](../observability/sentry.md)) | `tags.organizationId` pada error yang ditangkap. Aturan alert "issue baru yang mengenai lebih dari N organisasi" | Nama atau slug organisasi |
| PostHog analytics ([posthog.md](../observability/posthog.md)) | `client.capture({ distinctId: userId, groups: { organization: organizationId }, … })` (*verify* API) | `groupIdentify` dengan nama atau properti lain |
| PostHog flag | Group untuk persentase per organisasi ([feature-flags.md §6](feature-flags.md)) | |

Keduanya tetap opsional. Tanpa mereka, query MongoDB (§2) menjawab pertanyaan yang sama dengan lebih lambat.

## 7. Kriteria penerimaan

- [ ] Setiap event di dalam route yang ber-scope organisasi punya `organizationId` (test atas setiap route modul, dijalankan bersama suite isolasi).
- [ ] Insert yang ditolak RLS menghasilkan tepat satu `security.tenant_violation` dan respons `500` dengan `{ code: "INTERNAL_ERROR" }`.
- [ ] `logs:prune --org` menghapus semua baris non-audit organisasi itu dan tidak satu pun milik organisasi lain (hitungan `--dry-run` cocok).
- [ ] Payload Sentry dan PostHog (bila diadopsi) berisi ID organisasi dan tidak berisi nama atau slug organisasi.

## 8. Task

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| MT-10 | Index, `security.tenant_violation` dan alert-nya, `logs:prune --org`, `org.purged`, tag dan group vendor bila diadopsi (§2–6) | MT-01, MT-09 |
