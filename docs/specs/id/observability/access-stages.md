# Observability di Setiap Access Stage

> **Status: desain saja (DEC-044, DEC-050).** Perubahan log dan event telemetri antara access stage 1 (static-roles) dan tahap 2 (single-org) ([auth/access/README.md](../auth/access/README.md)), dan apa yang diubah Langkah A. Model dasarnya ada di [README.md](README.md). Observability di lapisan SaaS multi-tenant (query per tenant, Sentry dan PostHog per organisasi, purge tenant) ada di [saas/observability.md](../saas/observability.md).

## 1. Ringkasan

| | **Tahap 1: static-roles** (default) | **Tahap 2: single-org** |
|:---|:---|:---|
| Konteks log | `requestId, module, userId?` | `requestId, module, userId?, organizationId?` |
| Nilai `module` | Nama modul, `auth`, `core` | Sama, ditambah `platform` (modul lapisan platform) |
| Peringatan role saat startup | `rbac.unknown_role` | `access.unknown_platform_role`, `access.member_missing`, `access.stale_permission` |
| Event audit role | `audit.user.role_changed` (semua role) | `audit.user.role_changed` (hanya role platform) + `audit.org.*` (role organisasi) |
| Index MongoDB | [DATABASE.md §8](../DATABASE.md) | Tidak berubah (satu organisasi; tanpa index pada `organizationId`) |
| Sentry, PostHog | Hanya user ID | Tidak berubah: `organizationId` tidak dikirim (satu organisasi tidak menambah informasi) |
| Penghapusan data | `logs:prune --user` | Tidak berubah |

## 2. Tahap 1: static-roles

[README.md](README.md), [redaction.md](redaction.md), dan [log-storage.md](log-storage.md) berlaku apa adanya.

## 3. Tahap 2: single-org

### 3.1 Konteks log

- Macro `auth` menambahkan `organizationId` ke konteks log saat me-resolve `ctx.org` dari `session.activeOrganizationId` ([single-org.md §5](../auth/access/single-org.md)). Setiap event yang di-emit di dalam route yang ber-scope organisasi membawanya.
- Route yang tidak ber-scope organisasi (`/api/auth/*`, `/api/platform/*`, `/api/feature-flags/evaluate`, health) tidak punya `organizationId`, kecuali payload event menyebut satu organisasi (`audit.org.*`).
- Hanya ID yang di-log. **Nama, slug, dan logo** organisasi adalah data pelanggan dan tidak pernah di-log ([redaction.md §1](redaction.md)).

### 3.2 Event yang ditambahkan

Ditambahkan ke katalog event ([README.md §6](README.md)) hanya di tahap 2. Payload berisi ID dan hitungan, tidak pernah nama atau email.

| Event | Kind | Payload (plus field konteks) | Sink |
|:---|:---|:---|:---|
| `access.member_missing` | `app` | `count` | log, mongo (warn), saat startup |
| `access.unknown_platform_role` | `app` | `roles: { role, count }[]` | log, mongo (warn), saat startup. Menggantikan `rbac.unknown_role` |
| `access.stale_permission` | `app` | `roleIds, permissions` | log, mongo (warn), saat startup |
| `access.migrated` | `app` | `users, organizationId, unknownRoles` | log, mongo; sekali, oleh script Langkah A |
| `audit.org.member_added` | `audit` | `organizationId, userId, role, actorId?` | log, mongo |
| `audit.org.member_role_changed` | `audit` | `organizationId, userId, from, to, actorId` | log, mongo |
| `audit.org.member_removed` | `audit` | `organizationId, userId, actorId` | log, mongo |
| `audit.org.role_created` / `role_updated` / `role_deleted` | `audit` | `organizationId, roleId, roleName, permissionCount, actorId` | log, mongo |

Makna yang berubah:

- `audit.user.role_changed` hanya mencakup role **platform**, dengan `module: "platform"`.
- `audit.auth.blocked_endpoint` juga terpicu untuk path organization plugin yang tidak ada di allowlist ([single-org.md §9](../auth/access/single-org.md)).
- `audit.feature_flag.changed` punya `module: "platform"` ([feature-flags/access-stages.md §3](../feature-flags/access-stages.md)).

Nama role runtime (`roleName`) aman di-log: itu label yang dipilih staf, sama seperti nama role kode ([redaction.md §1](redaction.md)). Editor role menolak nama lebih dari 40 karakter atau di luar `snake_case` ([single-org.md §7](../auth/access/single-org.md)), jadi teks bebas tidak bisa masuk ke log lewat nama role.

### 3.3 Yang tidak berubah di tahap 2

- Periode retensi, perintah prune, dan index MongoDB.
- Sink Sentry dan PostHog: tanpa tag atau group organisasi.
- Metrik per modul ([README.md §8](README.md)).

## 4. Langkah A (tahap 1 → tahap 2)

| Yang berubah | Tindakan |
|:---|:---|
| Field baru `organizationId` | Baris lama tidak memilikinya. Query memperlakukannya sebagai opsional; log store tidak di-backfill |
| `rbac.unknown_role` → `access.unknown_platform_role` | Query tersimpan dan alert pindah setelah Rilis 3 ([migration.md §3.4](../auth/access/migration.md)) |
| Jejak audit role | Baris `audit.user.role_changed` tahap 1 tetap sebagai riwayat. Perubahan role organisasi di tahap 2 berupa `audit.org.member_role_changed`. Investigasi yang melewati masa switch meng-query keduanya |
| Catatan migrasi sekali jalan | `access.migrated` di-emit sekali setelah script commit |
| Session dicabut | Setiap user sign in ulang: siap-siap ada lonjakan `audit.session.created` saat switch |

## 5. Kriteria penerimaan (tahap 2)

- [ ] Setiap event di dalam route yang ber-scope organisasi punya `organizationId`; tidak ada event di luarnya yang punya, kecuali payload-nya menyebut sebuah organisasi.
- [ ] Tidak ada baris log atau dokumen MongoDB yang berisi nama atau slug organisasi (test redaction).
- [ ] Setiap event di §3.2 punya payload bertipe di `events.ts` dan test yang meng-emit-nya.
- [ ] Startup dengan user tanpa baris `member` meng-emit `access.member_missing { count: 1 }`.
- [ ] Mengubah role member meng-emit `audit.org.member_role_changed` dengan `from` dan `to`; mengubah role platform meng-emit `audit.user.role_changed` dengan `module: "platform"`.

## 6. Task

Tidak ada task terpisah: pekerjaannya bagian dari ORG-02 (konteks log), ORG-04 (event audit role), ORG-05 (cek startup), ORG-07 (tag modul platform), dan MIG-03 (Langkah A) di [single-org.md §15](../auth/access/single-org.md) dan [migration.md §6](../auth/access/migration.md).
