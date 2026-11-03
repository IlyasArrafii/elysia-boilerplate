# Arsitektur SaaS

> **Status: desain saja (DEC-050, DEC-051).** Cara API disusun saat melayani banyak tenant ([multi-tenant.md](multi-tenant.md)): pipeline request, kelompok route, isolasi tenant dalam dua lapisan (filter aplikasi + PostgreSQL row-level security), dan role database. Arsitektur dasarnya ada di [ARCHITECTURE.md](../ARCHITECTURE.md); scoping tahap 2 ada di [single-org.md §5](../auth/access/single-org.md). Tidak ada isi berkas ini yang mengubah tahap 1 atau 2 (DEC-049).

## 1. Pipeline request

```
request
  → logger              requestId, module = "core"
  → moduleScope(name)   module = "<module>"
  → auth macro          session → user, organisasi aktif (session.activeOrganizationId)
                        status organisasi: suspended / deleted → 403 ORGANIZATION_SUSPENDED
                        konteks log += userId, organizationId
  → permission          organization plugin hasPermission pada member.role → 403 FORBIDDEN
  → cek plan            hanya bila plan diadopsi (plans-billing.md §5)     → 403 PLAN_UPGRADE_REQUIRED
  → handler / service   aturan kepemilikan, cek flag (feature-flags.md)
  → scoped(orgId)       satu transaksi: set app.org_id, lalu query repository
  → PostgreSQL          policy RLS di setiap tabel modul (§4)
```

- `orgId` hanya sampai ke `scoped()` dari `ctx.org`, yang dibaca macro `auth` dari session. Tidak ada handler yang bisa mengirim nilai lain: `scoped` menerima `OrgContext` bertipe khusus (branded), bukan string.
- Route platform melewati langkah organisasi dan memakai permission platform serta role database platform (§2, §4.2).

## 2. Kelompok route

| Kelompok | Path | Organisasi | Cek | Role database |
|:---|:---|:---|:---|:---|
| Inti Better Auth | `/api/auth/*` | Tidak ada | Better Auth, allowlist ([API.md](../API.md)) | runtime |
| Organization plugin | `/api/auth/organization/*` | Organisasi aktif | Plugin + allowlist ([multi-tenant.md §11](multi-tenant.md)) | runtime |
| Route modul | `/api/<module>/*` | **Selalu** organisasi aktif | `{ permission }` | runtime + RLS |
| User saat ini | `/api/me/permissions` | Organisasi aktif | `auth: true` | runtime |
| Feature flag | `/api/feature-flags/evaluate` | Dibaca dari session untuk konteks ([feature-flags.md](feature-flags.md)) | `auth: true` | runtime (tabel global) |
| Platform | `/api/platform/*` | Tidak ada (lintas tenant) | `{ platformPermission }` | **platform** (hanya-baca) untuk tabel modul; runtime untuk tabel Better Auth |

Aturan:

1. Route modul tidak pernah menerima `organizationId` di path, query, atau body. Route yang butuh itu adalah route platform.
2. Route modul tidak pernah membaca lintas tenant, bahkan untuk `super_admin` (DEC-043).
3. Hanya modul `platform` yang boleh meng-import fungsi `*AcrossTenants` atau client database platform (aturan lint).

## 3. Isolasi tenant

### 3.1 Lapisan aplikasi

1. **Tidak ada akses database langsung di modul.** `modules/*` tidak boleh meng-import `db`; satu-satunya jalan ke tabel modul adalah `scoped(orgId)` (aturan lint `no-restricted-imports`, dicek di CI). Ini mencakup `select`, `insert`, `update`, `delete`, relational query (`db.query.*`), dan raw SQL sekaligus.
2. Setiap fungsi repository menerima `OrgContext` lebih dulu dan menaruh `organization_id` di setiap `where`, `insert`, dan `update`.
3. **Foreign key tetap di dalam tenant.** Bila sebuah record menunjuk record lain (komentar pada post), service mengecek keduanya punya `organization_id` yang sama. Referensi lintas tenant adalah `404`. Foreign key komposit `(organization_id, post_id) → post (organization_id, id)` menegakkannya di database bila bentuk tabel memungkinkan.
4. **Tidak ditemukan, bukan dilarang.** ID record tenant lain mengembalikan `404`, dalam waktu yang sama dengan miss sungguhan (tanpa lookup tambahan yang membuka keberadaannya).

### 3.2 Mengapa lapisan aplikasi saja tidak cukup

Desain pertama (DEC-046) hanya mengandalkan lapisan aplikasi. Review menemukan celah berikut, dan masing-masing membocorkan data satu tenant ke tenant lain:

| Celah | Contoh |
|:---|:---|
| Cek CI hanya mencocokkan `db.select`/`db.update`/`db.delete` di `repository.ts` | `db.query.post.findMany()`, ``db.execute(sql`…`)``, `insert … select`, atau query di job atau script tidak dicek |
| Bug di dalam `scoped()` | Semua modul bocor sekaligus, dan tidak ada test yang gagal kecuali kebetulan mengenai jalur itu |
| Join | Filter ada di `post`, tetapi baris `comment` milik tenant lain yang ikut di-join tetap kembali |
| Insert dengan `organization_id` yang salah | `NOT NULL` lolos; tidak ada yang mengecek bahwa nilainya adalah organisasi aktif |
| Background job | Job tanpa request tidak punya session; `orgId` yang hilang menjadi query tanpa scope yang diam-diam |

Row-level security menutup semuanya: apa pun yang dilakukan kode, PostgreSQL hanya mengembalikan dan menerima baris organisasi yang terikat pada transaksi itu. Lapisan aplikasi tetap dipertahankan, karena ia memberi `404` yang benar, memakai index dengan baik, dan menjadi yang dibaca oleh test.

## 4. Row-level security (DEC-051)

### 4.1 Tabel mana

| Tabel | RLS | Alasan |
|:---|:---|:---|
| Setiap **tabel modul** dengan `organization_id` (`post`, …) | **Ya**, `ENABLE` + `FORCE` | Data tenant |
| Tabel Better Auth (`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `organization_role`) | Tidak | Better Auth membacanya lintas organisasi (keanggotaan user, undangan per email). Dilindungi oleh plugin dan allowlist endpoint |
| `feature_flag` | Tidak | Global (DEC-048) |
| Tabel plan ([plans-billing.md §4](plans-billing.md)) | Ya untuk baris per organisasi, bila dibangun | Data tenant |

Cek CI gagal bila migrasi membuat tabel dengan kolom `organization_id` tanpa policy.

### 4.2 Role database

| Role | Dipakai oleh | Hak | RLS |
|:---|:---|:---|:---|
| `app_owner` | Migrasi Drizzle Kit, `org:purge` | Pemilik tabel | Dilewati sebagai owner; tidak pernah dipakai API |
| `app_runtime` | API (`DATABASE_URL`) | `SELECT, INSERT, UPDATE, DELETE` pada tabel aplikasi; bukan owner; `NOBYPASSRLS` | **Ditegakkan** |
| `app_platform` | Fungsi `*AcrossTenants` di modul `platform` (`DATABASE_PLATFORM_URL`) | Hanya `SELECT` pada tabel modul; `BYPASSRLS` | Dilewati, tetapi hanya-baca, jadi konsol tidak pernah bisa mengubah konten pelanggan (SAAS-001) |

Di tahap 1 dan 2 API boleh tetap memakai satu role. Langkah B memperkenalkan tiga role ini ([migration.md §3](migration.md)).

### 4.3 Policy

Satu policy per tabel modul, di-generate bersama schema:

```sql
-- di-generate per tabel modul (sketsa)
ALTER TABLE post ENABLE ROW LEVEL SECURITY;
ALTER TABLE post FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON post
  FOR ALL TO app_runtime
  USING      (organization_id = current_setting('app.org_id', true))
  WITH CHECK (organization_id = current_setting('app.org_id', true));
```

```ts
// packages/db/src/schema/post.ts (sketsa, verify API Drizzle di versi yang di-pin)
export const post = pgTable('post', { /* … */ }, (t) => [
  pgPolicy('tenant_isolation', {
    for: 'all', to: appRuntime,
    using: sql`${t.organizationId} = current_setting('app.org_id', true)`,
    withCheck: sql`${t.organizationId} = current_setting('app.org_id', true)`,
  }),
]).enableRLS()
```

- **Gagal tertutup.** Bila `app.org_id` tidak diset, `current_setting(..., true)` bernilai `NULL` (atau `''` di koneksi yang dipakai ulang); keduanya tidak cocok dengan baris mana pun. Query di luar `scoped()` tidak mengembalikan apa pun dan insert gagal.
- `USING` menyembunyikan baris tenant lain dari `SELECT`, `UPDATE`, dan `DELETE`, jadi update pada ID tenant lain mengubah 0 baris dan service mengembalikan `404`.
- `WITH CHECK` menolak penulisan baris untuk organisasi lain (SQLSTATE `42501`).

### 4.4 `scoped(orgId)`

```ts
// apps/api/src/utils/db/scoped.ts (sketsa)
export function scoped<T>(org: OrgContext, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${org.id}, true)`)  // lokal transaksi
    return work(tx)
  })
}
```

Aturan:

1. Setting-nya **lokal transaksi** (`set_config(..., true)` / `SET LOCAL`), tidak pernah level session, jadi koneksi di pool tidak pernah membawa ID satu tenant ke request lain. Ini juga berjalan di belakang PgBouncer mode transaksi.
2. Satu panggilan `scoped()` per unit kerja. Redis, panggilan HTTP, dan `telemetry.emit` terjadi **di luar** transaksi, agar koneksi dipegang sesingkat mungkin.
3. Background job membawa `organizationId` di payload job dan menjalankan pekerjaannya lewat `scoped()`. Job tanpa itu gagal sebelum menyentuh database.
4. Error `42501` adalah bug, tidak pernah kesalahan user: request mengembalikan `500 INTERNAL_ERROR` dan meng-emit `security.tenant_violation` (error, alert, [observability.md §3](observability.md)).

### 4.5 Biaya

- Satu statement tambahan (`set_config`) per unit kerja, dan transaksi di sekitarnya. Cache hit tidak menyentuh PostgreSQL, jadi target p95 < 50 ms untuk cache hit tidak terpengaruh; MT-09 mengukur biaya saat cache miss.
- Predikat policy adalah `organization_id = …`, kolom pertama di setiap index modul ([single-org.md §5](../auth/access/single-org.md)), jadi query plan tidak berubah.
- Tiga URL database alih-alih satu, dan migrasi harus berjalan sebagai `app_owner`.

### 4.6 Verify sebelum membangun

- `pgPolicy`, `pgRole`, dan `.enableRLS()` Drizzle di versi yang di-pin, dan apakah Drizzle Kit menghasilkan `FORCE ROW LEVEL SECURITY` (bila tidak, migrasi kustom menambahkannya).
- Bahwa adapter Drizzle milik Better Auth berjalan tanpa perubahan dengan `app_runtime` (tabelnya tanpa RLS).
- Perilaku `current_setting('app.org_id', true)` di koneksi pool setelah transaksi sebelumnya men-set-nya (diharapkan `''`).

## 5. Cache, antrean, berkas

- Key cache diawali organisasi: `org:{orgId}:…`. Tipe key helper cache mewajibkan prefix itu.
- Job antrean dan pesan pub/sub membawa `organizationId`; channel dibuat per organisasi bila consumer mendengarkan satu tenant.
- Upload dan export (bila ada) disimpan di bawah `org/{orgId}/`.
- Flag bersifat global dan tidak pernah di-cache per organisasi di provider ([feature-flags.md §4](feature-flags.md)).

## 6. Test

Bagian dari suite isolasi ([multi-tenant.md §13](multi-tenant.md)), dijalankan terhadap PostgreSQL sebagai `app_runtime`:

- Raw query pada tabel modul **tanpa** `scoped()` mengembalikan 0 baris, dan insert gagal.
- Di dalam `scoped(A)`, `select` baris B mengembalikan 0; `update`/`delete` ID B mengubah 0 baris; `insert` dengan `organization_id` B gagal dengan `42501`.
- **Test mutasi:** dengan filter `organization_id` dibuang dari satu fungsi repository (switch khusus test), kasus isolasi tetap lolos berkat RLS.
- Dua request bersamaan untuk A dan B di koneksi pool yang sama tidak pernah melihat baris satu sama lain.
- `app_platform` bisa membaca setiap tenant dan tidak bisa menulis (`INSERT`/`UPDATE` ditolak).
- Cek CI gagal pada: import `db` di `modules/*`, dan tabel dengan `organization_id` tanpa policy.

## 7. Task

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| MT-02 | Aturan lint, foreign key komposit, suite isolasi (§3, §6) | ORG-02 |
| MT-09 | Role database, policy, transaksi `scoped()`, test RLS, cek CI policy, benchmark cache miss (§4, §6) | ORG-02 |
