# Pindah Antar Access Stage

> **Status: desain saja (DEC-042, DEC-047, DEC-050).** Cara proyek memilih access stage di awal, dan cara pindah dari tahap 1 ke tahap 2 belakangan (**Langkah A**). Lanjut ke multi-tenancy adalah langkah SaaS dengan spec sendiri: [saas/migration.md](../../saas/migration.md). Script detail dan rollback ada di lampiran.

## 1. Alurnya

```
Tahap 1: static-roles (DEFAULT)  ──Langkah A──►  Tahap 2: single-org  ┊ ──Langkah B──► multi-tenant (saas/migration.md)
```

| | **Langkah A: tahap 1 → tahap 2** |
|:---|:---|
| Pindah bila | Non-developer harus membuat role atau mengubah permission yang diberikan sebuah role |
| Migrasi data? | **Ya**: buat organisasi utama, tambah `organization_id`, satu baris `member` per user, petakan role |
| Rilis | 3: expand → migrasi dan switch → bersih-bersih |
| User di-sign-out sekali? | Ya |
| Ikut berubah | Pengelolaan feature flag (§4.1) dan konteks log (§4.2) |
| Selesai bila | Setiap user punya permission yang persis sama sebelum dan sesudah (§3.5) |
| Kembali mundur | Hanya dalam 30 hari ([Lampiran B](#lampiran-b-rollback)) |

- **Mundur** (tahap 2 → 1) tidak didukung (§5).
- **Tahap 1 → multi-tenant** tidak punya jalan pintas: jalankan Langkah A, jalankan tahap 2 minimal satu siklus rilis, lalu ikuti [saas/migration.md](../../saas/migration.md). Melakukan keduanya sekaligus mencampur migrasi data dengan risiko isolasi baru.

## 2. Memulai proyek baru

Pilih tahap dengan [README.md §3](README.md) dan catat sebagai keputusan proyek ("Access stage: …") sebelum TASK-03.

| Tahap | Perubahan pada [TASKS.md](../../TASKS.md) |
|:---|:---|
| **1: static-roles** (default) | Tidak ada. Bangun TASK-01 sampai TASK-19 apa adanya |
| **2: single-org** | TASK-03 juga meng-generate tabel organisasi dan menambah `organization_id` ke `post`; seed-nya membuat organisasi utama. TASK-04 → ORG-01. TASK-05 → ORG-03. TASK-06 → ORG-07. TASK-17 → ORG-06 + ORG-08. Tambah ORG-02, ORG-04, ORG-05 ([single-org.md §15](single-org.md)). TASK-12 juga menambah field log dan event tahap 2 ([observability/access-stages.md §3](../../observability/access-stages.md)) |

Proyek yang harus langsung multi-tenant mulai di tahap 2 dan menambahkan [saas/migration.md §2](../../saas/migration.md) di build yang sama.

Mulai langsung di tahap 2 lebih murah daripada migrasi belakangan: tanpa backfill dan tanpa sign-out paksa.

## 3. Langkah A: tahap 1 → tahap 2

### 3.1 Sebelum mulai

- [ ] Keputusan pindah ke tahap 2 sudah dicatat.
- [ ] Backup penuh PostgreSQL sudah diambil dan restore sudah dites.
- [ ] Seluruh migrasi sudah dijalankan sekali di salinan data production.
- [ ] Jendela maintenance sudah diumumkan: semua orang di-sign-out sekali.
- [ ] **Snapshot permission** disimpan: untuk setiap user, user ID → daftar permission terurut di tahap 1. Ini adalah cek penerimaan (§3.5).
- [ ] Daftar user yang akan kehilangan `feature_flag:*` sudah ditinjau (§4.1).

### 3.2 Rilis 1: expand (tidak ada yang berubah bagi user)

- Tambah tabel organization plugin. Plugin dikonfigurasi, tetapi belum ada route yang memakainya.
- Tambah `organization_id` sebagai **nullable** ke setiap tabel modul.
- Tambah tabel `access_migration_backup` ([Lampiran A](#lampiran-a-script-migrasi)).

### 3.3 Rilis 2: migrasi dan switch

- Jalankan `bun run access:migrate-to-org` (`--dry-run` lebih dulu). Dalam satu transaksi, script membuat organisasi utama, memberi setiap user satu baris `member`, memetakan role, mengisi `organization_id`, menjadikannya `NOT NULL`, dan men-sign-out semua orang ([Lampiran A](#lampiran-a-script-migrasi)).
- Pemetaan role:

| Role tahap 1 | Role organisasi (`member.role`) | Role platform (`user.role`) |
|:---|:---|:---|
| `super_admin` | `owner` | `super_admin` |
| `admin` | `admin` | `user` |
| `user` | `member` | `user` |
| Role kode kustom (mis. `editor`) | Nama yang sama, sebagai role **kode** organisasi | `user` |

- Deploy kode tahap 2 (ORG-01 sampai ORG-08) tepat setelah script. Mulai saat itu, pengecekan memakai `member.role`.
- Script meng-emit `access.migrated { users, organizationId, unknownRoles }` (§4.2).

### 3.4 Rilis 3: bersih-bersih (setelah 30 hari)

- Hapus `access_migration_backup` dan script rollback.
- Hapus kode tahap 1: registry role modul di `roles.ts`, jalur `userHasPermission` di macro `permission`, dan cek startup `rbac.unknown_role` (digantikan `access.unknown_platform_role`).

### 3.5 Selesai bila

- [ ] Set permission organisasi setiap user sama dengan snapshot §3.1, kecuali `feature_flag:*`, yang dibandingkan terpisah (§4.1). Mantan `super_admin` memegang set yang sama sebagai `owner`; permission platform dilaporkan terpisah.
- [ ] Setiap user punya tepat satu baris `member`, dan tidak ada `organization_id` yang null.
- [ ] `access.member_missing` dan `access.unknown_platform_role` tidak di-emit saat startup.
- [ ] Test matriks tahap 1, dengan key diganti ke role organisasi, lolos.
- [ ] Sign-in, baca terproteksi, tulis terproteksi, dan ganti role berjalan end to end.
- [ ] Setiap baris log di dalam route yang ber-scope organisasi membawa `organizationId` (§4.2).

## 4. Apa lagi yang berubah di Langkah A

### 4.1 Feature flag

Detail: [feature-flags/access-stages.md §4](../../feature-flags/access-stages.md).

- `feature_flag:read|write` pindah dari statement modul ke statement **platform**. Setelahnya hanya `super_admin` (dan `platform_support` opsional) yang mengelola flag.
- User yang memegang `feature_flag:read` lewat role `admin` tahap 1 kehilangan permission itu. Script migrasi mencetak daftarnya; beri masing-masing `platform_support` atau terima kehilangannya.
- Halaman admin `/admin/feature-flags` menjadi `/platform/feature-flags`.
- Targeting **tidak** berubah: aturan tetap memakai user ID saja, jadi hasil flag tidak berubah bagi user mana pun.

### 4.2 Observability

Detail: [observability/access-stages.md §4](../../observability/access-stages.md).

- Konteks log mendapat `organizationId` di dalam route yang ber-scope organisasi. Baris lama di log store tidak memilikinya; query tidak boleh mengandalkannya.
- Event baru: `access.migrated`, `access.member_missing`, `access.unknown_platform_role`, `access.stale_permission`, dan event `audit.org.*` dari [single-org.md §13](single-org.md).
- `rbac.unknown_role` berhenti setelah Rilis 3. Dashboard atau query tersimpan yang memakainya pindah ke `access.unknown_platform_role`.
- Riwayat audit disimpan apa adanya: baris `audit.user.role_changed` tahap 1 tetap ada, dan perubahan role tahap 2 berupa `audit.org.member_role_changed`.

## 5. Tidak didukung

- **Tahap 2 → tahap 1:** role runtime tidak punya padanan di kode.

Bila suatu saat dibutuhkan, itu migrasi terpisah khusus proyek dengan keputusannya sendiri.

## 6. Task

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| MIG-01 | Skema Rilis 1 (§3.2) dan ekspor snapshot permission | Keputusan untuk migrasi |
| MIG-02 | Script `access:migrate-to-org` dan `access:rollback-from-org`, keduanya dengan `--dry-run`, dites di salinan production (Lampiran A, B) | MIG-01, ORG-01 |
| MIG-03 | Run penerimaan (§3.5), perubahan flag dan observability (§4), dan rilis bersih-bersih (§3.4) | MIG-02, ORG-06, ORG-08 |

Task Langkah B ada di [saas/migration.md §6](../../saas/migration.md).

## Lampiran A: script migrasi

`access_migration_backup (user_id text primary key, old_role text not null, migrated_at timestamptz not null)` dibuat di Rilis 1.

`bun run access:migrate-to-org --dry-run` mencetak hitungan. Tanpa `--dry-run`, script berjalan dalam **satu transaksi**:

1. Buat organisasi utama (slug `PRIMARY_ORG_SLUG`, default `app`). Owner-nya adalah `super_admin` tertua.
2. Salin setiap `user.role` ke `access_migration_backup`.
3. Sisipkan satu baris `member` per user, memetakan role seperti di §3.3, ditambah:

| Nilai tahap 1 | Role organisasi | Role platform |
|:---|:---|:---|
| Beberapa role (`"admin,editor"`) | Masing-masing dipetakan, duplikat dibuang, digabung dengan `,` tanpa spasi | `super_admin` bila salah satunya `super_admin`, selain itu `user` |
| Role tidak dikenal (`rbac.unknown_role`) | `member` | `user`, dan dicantumkan di output script |

4. Set `user.role` ke role platform.
5. Isi `organization_id` di setiap tabel modul dengan ID organisasi utama.
6. Jadikan `organization_id` `NOT NULL`, tambah foreign key serta index dan unique constraint per organisasi ([single-org.md §5](single-org.md)).
7. Cabut semua session: hapus dari `session` dan hapus key session dari Redis. Setiap user sign in ulang, dan session baru mendapat `activeOrganizationId` dari hook tahap 2.
8. Setelah commit, emit `access.migrated` dan cetak user yang kehilangan `feature_flag:*` (§4.1).

Role kode kustom pindah sebagai kode: `grants`-nya di `permissions.ts` setiap modul diganti key-nya dari nama role tahap 1 ke nama role organisasi yang sama. Role ini **tidak** diubah menjadi role runtime, sehingga tetap di-review dan bertipe. `super_admin` nanti bisa membuat ulang sebagai role runtime bila memang perlu bisa diedit.

## Lampiran B: rollback

| Titik | Caranya | Yang hilang |
|:---|:---|:---|
| Setelah Rilis 1 | Hapus tabel dan kolom baru | Tidak ada |
| Dalam 30 hari setelah Rilis 2 | Deploy ulang kode Rilis 1, jalankan `bun run access:rollback-from-org` (memulihkan `user.role` dari tabel backup, mencabut session) | Role runtime yang dibuat sejak switch. Baris yang dibuat sejak itu tetap punya `organization_id`, yang diabaikan Rilis 1 |
| Setelah Rilis 3 | Tidak mungkin | — |
