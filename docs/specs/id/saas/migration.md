# Pindah ke Multi-Tenant dan Menambah Bagian SaaS

> **Status: desain saja (DEC-047, DEC-050, DEC-051).** Cara proyek di access stage 2 ([single-org.md](../auth/access/single-org.md)) menjadi multi-tenant (**Langkah B**), dan urutan menambah bagian SaaS lainnya. Langkah A (tahap 1 → 2) datang lebih dulu: [auth/access/migration.md](../auth/access/migration.md).

## 1. Alurnya

```
Tahap 1 ──Langkah A──► Tahap 2: single-org ──Langkah B──► Multi-tenant ──► + tenant rollout ──► + plan (manual) ──► + payment provider
(auth/access/migration.md)                   (berkas ini)    + konsol platform    (opsional)           (opsional)          (setelah Q33)
```

| | **Langkah B: tahap 2 → multi-tenant** |
|:---|:---|
| Pindah bila | Kamu menjual ke lebih dari satu perusahaan dan mereka tidak boleh melihat data satu sama lain |
| Migrasi data? | **Tidak**: `organization_id` dan keanggotaan sudah ada. Hanya skema: role database dan policy RLS |
| Rilis | 2: (B1) row-level security, tidak terlihat oleh user → (B2) membuka multi-tenancy |
| User di-sign-out? | Tidak |
| Ikut berubah | Persentase feature flag (§3.4), observability (§3.5) |
| Selesai bila | Suite isolasi, termasuk kasus RLS, lolos (§3.6) |
| Kembali mundur | B1 kapan saja; B2 hanya sebelum organisasi kedua punya user sungguhan (§5) |

- Melompati tahap 2 tidak mungkin: Langkah B mengandaikan inti organisasi, `scoped(orgId)`, dan lapisan platform sudah berjalan.
- Konsol platform dirilis **di dalam** rilis B2, karena sejak hari pertama harus ada yang bisa men-suspend tenant.

## 2. Memulai proyek baru langsung multi-tenant

Bangun tahap 2 seperti di [auth/access/migration.md §2](../auth/access/migration.md), kecuali ORG-05 (satu organisasi tersembunyi), dan tambahkan di build yang sama:

- MT-01 sampai MT-10 ([multi-tenant.md §15](multi-tenant.md)), termasuk RLS (MT-09);
- PC-01 sampai PC-03 ([platform-console.md §10](platform-console.md));
- FF-MT-01 bila flag diadopsi ([feature-flags.md §8](feature-flags.md)).

Terblokir sampai ada pengirim email (undangan).

## 3. Langkah B: tahap 2 → multi-tenant

### 3.1 Sebelum mulai

- [ ] Pengirim email sudah ada (undangan, [multi-tenant.md §6](multi-tenant.md)).
- [ ] Setiap repository modul lewat `scoped(orgId)`, dan aturan lint terhadap import `db` di `modules/*` aktif ([architecture.md §3.1](architecture.md)).
- [ ] Suite isolasi ([multi-tenant.md §13](multi-tenant.md)) lolos di tahap 2 dengan dua organisasi test.
- [ ] Setiap feature flag dengan persentase antara 0 dan 100 sudah dituntaskan (diset 0 atau 100) atau diterima akan teracak ulang (§3.4).

### 3.2 Rilis B1: row-level security (tidak ada yang berubah bagi user)

1. Buat role database `app_owner`, `app_runtime`, `app_platform` ([architecture.md §4.2](architecture.md)). Pindahkan kepemilikan tabel ke `app_owner`.
2. Tambahkan policy RLS ke setiap tabel modul ([architecture.md §4.3](architecture.md)) dan cek CI untuk tabel tanpa policy.
3. Ubah `scoped()` agar membuka transaksi dan men-set `app.org_id` ([architecture.md §4.4](architecture.md)).
4. Ganti API ke `DATABASE_URL` = `app_runtime`, migrasi ke `app_owner`, dan fungsi `*AcrossTenants` modul `platform` ke `DATABASE_PLATFORM_URL` = `app_platform`.
5. Jalankan test RLS ([architecture.md §6](architecture.md)) terhadap salinan data production, lalu deploy.

Dengan satu organisasi, setiap baris cocok dengan `app.org_id`, jadi user tidak melihat perbedaan. Query yang melewati `scoped()` sekarang tidak mengembalikan apa pun: pantau `http.error` dan `security.tenant_violation` selama satu siklus rilis sebelum B2.

### 3.3 Rilis B2: membuka multi-tenancy

1. Konfigurasi: [multi-tenant.md §2](multi-tenant.md) (membuat organisasi diizinkan, batas, undangan).
2. Hapus dua hook tahap 2 ([single-org.md §10.1](../auth/access/single-org.md)) dan tambah hook organisasi aktif terakhir.
3. Perluas allowlist endpoint ([multi-tenant.md §11](multi-tenant.md)).
4. Rilis halaman onboarding, pemilih organisasi, dan settings di web (MT-05 sampai MT-07) serta halaman organisasi di konsol platform (PC-01, PC-03).
5. User lama tetap menjadi member organisasi utama, yang menyimpan data dan role runtime-nya. Owner-nya boleh mengganti nama; slug-nya tetap.
6. User baru membuat organisasi atau menerima undangan ([multi-tenant.md §4](multi-tenant.md)).
7. Hapus `PRIMARY_ORG_SLUG` dari environment setelah rilis.

### 3.4 Feature flag

Detail: [feature-flags.md §5](feature-flags.md).

- Konteks evaluasi mendapat `organizationId`, dan persentase rollout meng-hash `organizationId` alih-alih user ID.
- Flag di 0% atau 100% tidak terpengaruh. Flag di antaranya teracak ulang: sebelum B2, tuntaskan atau terima grup barunya.
- Pengelolaan flag tidak berubah: sudah di lapisan platform sejak tahap 2.

### 3.5 Observability

Detail: [observability.md §4](observability.md).

- Index MongoDB `{ organizationId: 1, time: -1 }` ditambahkan (`bun run logs:setup`) di B1.
- Event baru: `security.tenant_violation` (B1), event `audit.org.*` multi-tenant dan event `audit.platform.*` (B2).
- Sentry mendapat tag `organizationId`, dan PostHog group `organization`, bila keduanya diadopsi.

### 3.6 Selesai bila

- [ ] B1: test RLS lolos, dan `security.tenant_violation` tetap 0 selama satu siklus rilis di production.
- [ ] User lama sign in dan masuk ke organisasi utama dengan permission yang tidak berubah.
- [ ] User baru membuat organisasi, menjadi `owner`, dan tidak melihat data organisasi utama sama sekali.
- [ ] Flow undang, terima, pindah, dan suspend lolos ([multi-tenant.md §13](multi-tenant.md)).
- [ ] Konsol platform menampilkan kedua organisasi, dan `super_admin` bisa men-suspend yang baru.

## 4. Menambah bagian SaaS lainnya

Setiap bagian ditambahkan setelah multi-tenant berjalan, satu per satu ([README.md §5](README.md)):

| Bagian | Spec | Prasyarat | Migrasi |
|:---|:---|:---|:---|
| Tenant rollout | [tenant-rollout.md](tenant-rollout.md) | Flag diadopsi, FF-MT-01 selesai, SAAS-002 sampai SAAS-004 Answered | Dua kolom daftar kosong di `feature_flag`; perilaku tidak berubah sampai sebuah daftar diisi |
| Plan, manual | [plans-billing.md](plans-billing.md) | SAAS-005 sampai SAAS-011 Answered | Setiap organisasi yang sudah ada mendapat plan default (`free`, atau plan khusus pelanggan lama) dalam satu migrasi, jadi tidak ada yang kehilangan fitur di hari rilis |
| Payment provider | [plans-billing.md §7](plans-billing.md) | Q33 terjawab | Langganan manual yang sudah ada tetap manual sampai diperpanjang |

## 5. Rollback dan yang tidak didukung

| Titik | Caranya | Yang hilang |
|:---|:---|:---|
| Setelah B1 | Hapus policy, kembalikan `DATABASE_URL` ke satu role, kembalikan `scoped()` | Tidak ada |
| Setelah B2, sebelum organisasi kedua punya user sungguhan | Set `allowUserToCreateOrganization: false` dan pulihkan hook tahap 2 | Organisasi yang dibuat di antaranya tetap ada; user-nya kehilangan akses sampai dipindahkan |
| Setelah organisasi kedua punya user sungguhan | Tidak didukung | — |

- **Multi-tenant → tahap 2:** tidak didukung. Itu akan menggabungkan data dan role antar tenant.
- Bila suatu saat dibutuhkan, itu migrasi terpisah khusus proyek dengan keputusannya sendiri.

## 6. Task

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| MIG-04 | Rilis B1: role database, policy, transaksi `scoped()`, index Mongo (§3.2, §3.5) | MT-09 |
| MIG-05 | Rilis B2 (§3.3), cek flag yang teracak ulang (§3.4), run penerimaan (§3.6) | MIG-04, MT-01 sampai MT-08, PC-01, PC-03 |
