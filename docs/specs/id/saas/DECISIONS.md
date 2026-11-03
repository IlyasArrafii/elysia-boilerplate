# Keputusan SaaS

Keputusan untuk lapisan SaaS ([README.md](README.md)), dipisah dari log utama ([../DECISIONS.md](../DECISIONS.md)) oleh DEC-049.

**Aturan**

1. Lapisan SaaS dimulai dengan multi-tenant ([multi-tenant.md](multi-tenant.md), disebut "access stage 3" sebelum DEC-050) dan butuh access tahap 2. Tidak ada yang dibangun di sini pada tahap 1, dan tidak ada yang mengubah tahap 2.
2. Entri SAAS boleh **menambah** ke lapisan SaaS. Entri SAAS tidak boleh mengubah tahap 1 atau 2, atau aturan di DEC-042 sampai DEC-051.
3. Bila entri SAAS butuh perubahan seperti itu, statusnya tetap **Proposed** sampai sebuah entri DEC di log utama mencatatnya. Log utama selalu menang.
4. Nilai status sama dengan log utama: **Answered**, **Decided (lead)**, **Proposed** (jangan diimplementasi), **Superseded**.

## Titik singgung dengan access stage

Tempat keputusan SaaS bertemu aturan access. Masing-masing diselesaikan di sini atau ditandai butuh entri DEC.

| Topik SaaS | Aturan access yang ditemui | Penyelesaian |
|:---|:---|:---|
| Row-level security | Scoping tahap 2 lewat `scoped(orgId)` ([single-org.md §5](../auth/access/single-org.md)) | RLS hanya ditambahkan di Langkah B, di dalam `scoped()`; tahap 2 tanpa RLS (DEC-051, [architecture.md §4](architecture.md)). Tahap 2 tidak berubah |
| Flag dan observability | Perilaku tahap 2 ([feature-flags/access-stages.md](../feature-flags/access-stages.md), [observability/access-stages.md](../observability/access-stages.md)) | Tambahan multi-tenant ada di [feature-flags.md](feature-flags.md) dan [observability.md](observability.md); dokumen tahap 2 hanya menunjuk ke sana (DEC-050). Tahap 2 tidak berubah |
| Batas plan (member, role) | Batas tetap multi-tenant ([multi-tenant.md §10](multi-tenant.md)) | Nilai multi-tenant tetap default. Plan hanya boleh mengatur nilai berbeda per organisasi (SAAS-007). Tidak butuh DEC |
| Atribut plan di flag | Context flag hanya ID user + ID organisasi (DEC-048) | Plan tidak pernah sampai ke flag (SAAS-004). Menambah atribut butuh DEC baru |
| Permission `billing:*` | Statement modul dan role organisasi ([single-org.md §4](../auth/access/single-org.md)) | Modul `billing` baru dengan statement-nya sendiri, hanya dibangun bersama multi-tenant. Menambah modul adalah hal biasa. Tidak butuh DEC |
| Status read-only setelah pembayaran gagal | Status organisasi adalah `active`, `suspended`, `deleted` ([multi-tenant.md §8](multi-tenant.md)) | **Butuh DEC** untuk menambah status `read_only` sebelum SAAS-008 bisa dibangun |
| Onboarding lewat sales | Organisasi dibuat oleh user saat onboarding ([multi-tenant.md §4](multi-tenant.md)) | Route konsol membuat organisasi dan mengundang owner; alur undangan tidak berubah (SAAS-010). Tidak butuh DEC |
| Berhenti berlangganan dan purge | Soft delete, lalu `org:purge` manual setelah 30 hari ([multi-tenant.md §8](multi-tenant.md)) | Berhenti berlangganan berakhir di soft delete dan purge yang sama (SAAS-011). Tidak butuh DEC |

---

## SAAS-001: Cakupan konsol platform

**Status:** Answered (putaran 6: Q24 "berkas sendiri"; putaran 7: "pisahkan konsol platform ke SaaS")

- **Keputusan:** Konsol platform adalah area admin lintas tenant milik pemilik SaaS, dibangun di atas lapisan platform ([single-org.md §8](../auth/access/single-org.md)). Wajib bersama multi-tenant. Pembacaan lintas tenant hanya terjadi di sana, dengan role database `app_platform` yang hanya-baca ([architecture.md §4.2](architecture.md)), lewat fungsi `*AcrossTenants`. Konsol hanya-baca terhadap konten pelanggan, mengaudit setiap request, dan tidak pernah melakukan impersonation (DEC-032). Desain di [platform-console.md](platform-console.md).
- **Trade-off:** Tidak ada "lihat sebagai pelanggan" untuk support. Sebagai gantinya, konsol tidak pernah menjadi pintu belakang ke data pelanggan.

## SAAS-002: Urutan aturan tenant rollout

**Status:** Proposed (Q28)

- **Rekomendasi:** kill switch → exclude user → exclude organisasi → include user → include organisasi → 100% → persentase per organisasi → off. Desain di [tenant-rollout.md §2](tenant-rollout.md).
- **Alasan:** Bila sebuah perusahaan berkata "jangan beta untuk kami", satu user di daftar include tidak boleh melanggar janji itu.
- **Alternatif:** include user sebelum exclude organisasi, bila power user perorangan harus menang.

## SAAS-003: Tenant tidak bisa masuk atau keluar dari flag sendiri

**Status:** Proposed (Q29)

- **Rekomendasi:** Hanya lapisan platform yang mengelola flag (DEC-048). Tenant yang ingin masuk atau keluar meminta kepadamu, lalu kamu mengubah daftar organisasi.
- **Alasan:** Tempat kedua untuk mengubah flag berarti lebih banyak endpoint, permission, dan test, dan pelanggan bisa menyalakan fitur yang belum selesai.

## SAAS-004: Plan tidak pernah lewat flag

**Status:** Proposed (Q31)

- **Rekomendasi:** Fitur berbayar dicek dengan entitlements ([plans-billing.md §5](plans-billing.md)), bukan dengan flag. Flag tetap hanya membawa ID organisasi (DEC-048).
- **Alasan:** Flag bersifat sementara (punya tanggal `removeBy`). Aturan plan permanen dan terkait uang, jadi butuh cek, riwayat, dan test sendiri.

## SAAS-005: Billing netral terhadap penyedia, manual dulu

**Status:** Proposed (Q33: pasar, mata uang, dan pajak masih terbuka)

- **Rekomendasi:** Plan dan entitlements tidak bergantung pada penyedia pembayaran mana pun. Versi 1 **manual**: kamu mengatur plan dan periode sebuah perusahaan di konsol setelah perusahaan itu membayar lewat transfer bank atau invoice. Adapter `BillingProvider` menambah Stripe atau Xendit/Midtrans nanti.
- **Terbuka:** Indonesia, global, atau keduanya; IDR, USD, atau keduanya; apakah PPN berlaku. Ini menentukan penyedia dan format invoice, bukan model plan.

## SAAS-006: Plan flat, bulanan dan tahunan

**Status:** Proposed (Q34)

- **Rekomendasi:** Plan `free`, `pro`, `business` dengan harga tetap per bulan atau per tahun. Tanpa per seat, berbasis pemakaian, atau proration di versi 1.

## SAAS-007: Plan mengatur fitur dan batas; plan di kode, override di konsol

**Status:** Proposed (Q35)

- **Rekomendasi:** Setiap plan mencantumkan **fitur** ya/tidak dan **batas** angka. Plan ada di kode (di-review, bertipe, di-deploy), seperti role tahap 1. **Override** per organisasi dari konsol menangani kesepakatan khusus (misalnya Pro plus 500 member). Batas tahap 3 tetap menjadi default bila plan tidak mengatur nilainya.

## SAAS-008: Siklus hidup plan

**Status:** Proposed (Q36). **Langkah read-only butuh entri DEC dulu** (lihat Titik singgung).

- **Rekomendasi:** Plan gratis, trial 14 hari opsional. Upgrade berlaku langsung; downgrade di akhir periode. Melebihi batas setelah downgrade: hanya blokir penambahan baru, tidak pernah menghapus. Pembayaran gagal: masa tenggang 7 hari → read-only → suspend.

## SAAS-009: Siapa mengurus billing di tenant

**Status:** Proposed (Q37)

- **Rekomendasi:** Permission organisasi `billing:read` dan `billing:manage`. `owner` memegang keduanya secara default; yang lain hanya bila sebuah role memberikannya. Konsol menampilkan plan setiap organisasi dan pembayaran yang gagal; laporan MRR menyusul.

## SAAS-010: Onboarding lewat sales

**Status:** Proposed (Q38)

- **Rekomendasi:** Kamu bisa membuat organisasi dari konsol dan mengundang orang pertamanya sebagai `owner`. Field nama perusahaan di form sign-up tidak ada di versi 1.

## SAAS-011: Berhenti berlangganan

**Status:** Proposed (Q39)

- **Rekomendasi:** Setelah berhenti berlangganan, organisasi tetap bisa dipakai sampai akhir periode berbayar, lalu di-suspend, bisa mengekspor datanya selama 30 hari, lalu di-purge dengan `org:purge` ([multi-tenant.md §8](multi-tenant.md)). Setiap langkah memancarkan event audit.
