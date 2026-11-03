# Lapisan SaaS

> **Status: desain saja (DEC-047, DEC-049, DEC-050).** Semua yang dibutuhkan untuk menjalankan boilerplate **sebagai bisnis** dengan banyak perusahaan pelanggan: multi-tenancy itu sendiri, arsitektur, flag, observability, dan migrasinya, konsol platform, tenant rollout, plan dan billing. Lapisan ini butuh access **tahap 2** ([auth/access/](../auth/access/README.md)) dan tidak pernah dibangun di tahap 1. Keputusan untuk folder ini ada di [DECISIONS.md](DECISIONS.md) (SAAS-xxx), terpisah dari log utama.

## 1. Posisinya

```
Access (auth/access/)                               SaaS (folder ini)
Tahap 1: static-roles ──Langkah A──► Tahap 2: single-org ──Langkah B──► Multi-tenant ──► konsol platform  wajib
(default)                            role + permission                 (fondasi)        tenant rollout   opsional
                                     diberikan saat runtime                             plan dan billing opsional
```

- **Access** menjawab "siapa boleh melakukan apa di dalam aplikasi": role di kode (tahap 1) atau role yang dibuat saat runtime beserta permission yang diberikannya (tahap 2).
- **SaaS** menjawab "bagaimana menjalankannya untuk banyak perusahaan": memisahkan data mereka, membiarkan mereka mendaftar dan mengundang rekan, melihat dan men-suspend mereka, merilis fitur per perusahaan, dan menagih mereka.
- Multi-tenant disebut "access stage 3" di DEC-042 sampai DEC-048. Ia pindah ke sini karena semua yang dibutuhkannya (isolasi tenant, konsol, observability per tenant) baru penting saat kamu menjual ke beberapa perusahaan (DEC-050).
- Lapisan SaaS hanya **menambah** ke tahap 2. Lapisan ini tidak pernah mengubah tahap 1 dan 2. Ide SaaS yang butuh perubahan access menunggu entri DEC di log utama dulu (DEC-049).

## 2. Bagian-bagiannya

| Bagian | Spec | Dibutuhkan | Status |
|:---|:---|:---|:---|
| Multi-tenant | [multi-tenant.md](multi-tenant.md) | **Fondasi**: banyak organisasi, onboarding, undangan, pindah organisasi, siklus hidup | Desain |
| Arsitektur dan isolasi | [architecture.md](architecture.md) | **Wajib**: pipeline request, kelompok route, filter aplikasi + row-level security, role database | Desain (DEC-051) |
| Pindah ke multi-tenant | [migration.md](migration.md) | Langkah B dari tahap 2, dan urutan menambah bagian lain | Desain |
| Feature flag | [feature-flags.md](feature-flags.md) | **Wajib** bila flag diadopsi: persentase per organisasi | Desain (DEC-048) |
| Observability | [observability.md](observability.md) | **Wajib**: query per tenant, alert isolasi, purge tenant, tag vendor | Desain |
| Konsol platform | [platform-console.md](platform-console.md) | **Wajib**: harus ada yang men-suspend tenant dan melihat siapa yang memakai aplikasi | Desain, dijawab (SAAS-001) |
| Tenant rollout | [tenant-rollout.md](tenant-rollout.md) | Bila sebuah fitur harus dinyalakan untuk perusahaan tertentu ("beta untuk Acme") | Desain, **Proposed** (SAAS-002 sampai SAAS-004) |
| Plan dan billing | [plans-billing.md](plans-billing.md) | Bila pelanggan membayar plan | **Draft**, Proposed (SAAS-005 sampai SAAS-011); Q33 terbuka |

## 3. Siapa adalah siapa

| Orang | Lapisan | Memakai |
|:---|:---|:---|
| **Kamu, pemilik SaaS**, dan stafmu | Platform: `user.role` = `super_admin` atau role kode platform | `/platform/*`: tenant, user, flag, plan |
| **Owner atau admin pelanggan** | Organisasi: `member.role` = `owner`, `admin`, atau role runtime | `/settings/*` organisasinya sendiri: member, role, billing |
| **Member pelanggan** | Organisasi: `member.role` = `member` atau role runtime | Produknya sendiri |

Tenant tidak pernah mengelola flag atau plan, dan tidak pernah melihat halaman platform.

## 4. Fitur berbayar melewati tiga cek

| # | Cek | Pertanyaan | Diputuskan oleh | Bila gagal |
|:---|:---|:---|:---|:---|
| 1 | **Permission** | Bolehkah orang ini melakukannya? | Role organisasi ([single-org.md §6](../auth/access/single-org.md)) | `403 FORBIDDEN` |
| 2 | **Plan** | Apakah perusahaan ini membayar untuk itu? | Entitlements ([plans-billing.md §5](plans-billing.md)) | `403 PLAN_UPGRADE_REQUIRED` |
| 3 | **Flag** | Apakah sudah dirilis ke perusahaan ini? | Feature flag ([feature-flags.md](feature-flags.md)) | Perilaku lama, atau fiturnya disembunyikan |

Cek berjalan dengan urutan itu ([architecture.md §1](architecture.md)). Masing-masing punya satu tugas, sehingga tidak ada yang menggantikan yang lain:

- Flag tidak pernah menggantikan plan. "Tenant Pro mendapat export" adalah aturan plan, bukan aturan targeting flag (SAAS-004).
- Plan tidak pernah menggantikan permission. `member` di perusahaan Pro tetap tidak bisa melakukan apa yang hanya boleh dilakukan `admin`.

## 5. Urutan adopsi

1. **Access tahap 2** ([auth/access/migration.md](../auth/access/migration.md)), bila proyek masih di tahap 1.
2. **Multi-tenant + arsitektur + observability + konsol platform**, di Langkah B ([migration.md](migration.md)): MT-01…10, PC-01…03, MIG-04, MIG-05; FF-MT-01 bila flag diadopsi.
3. **Tenant rollout**, setelah rollout ke perusahaan tertentu dibutuhkan (TR-01, TR-02).
4. **Plan dengan aktivasi manual**: kamu mengatur plan setiap perusahaan di konsol (BIL-01…05).
5. **Penyedia pembayaran**, setelah Q33 dijawab (BIL-06).

## 6. Pertanyaan terbuka

Ini pertanyaan untuk **pemilik SaaS**. Tenant tidak pernah mengelola flag atau plan. Tidak ada yang dibangun di sini sampai dijawab. Rekomendasi dicatat sebagai entri Proposed di [DECISIONS.md](DECISIONS.md).

**Tenant rollout**

- **Q28:** Urutan bila aturan user dan organisasi bertentangan? Rekomendasi: kill switch → exclude user → exclude organisasi → include user → include organisasi → persentase → off (SAAS-002).
- **Q29:** Bolehkah tenant memasukkan dirinya sendiri ke fitur beta? Rekomendasi: tidak di versi pertama (SAAS-003).
- **Q31:** Perilaku berbasis plan lewat entitlements, tidak pernah lewat atribut flag? Rekomendasi: ya (SAAS-004). Flag sudah hanya melihat ID organisasi (DEC-048).

**Plan dan billing**

- **Q33:** Pasar dan penyedia pembayaran. **Keputusanmu:** Indonesia, global, atau keduanya? IDR, USD, atau keduanya? Apakah invoice butuh PPN? Rekomendasi: netral terhadap penyedia, aktivasi manual dari konsol dulu, lalu Stripe (global) atau Xendit/Midtrans (Indonesia) (SAAS-005).
- **Q34:** Model harga? Rekomendasi: plan flat (Free / Pro / Business), bulanan dan tahunan. Tanpa harga per seat atau berbasis pemakaian di v1 (SAAS-006).
- **Q35:** Apa yang diatur plan? Rekomendasi: fitur dan batas, plan di kode, override per organisasi dari konsol (SAAS-007).
- **Q36:** Siklus hidup plan? Rekomendasi: plan gratis plus trial 14 hari opsional; upgrade langsung, downgrade di akhir periode; melebihi batas, hanya blokir penambahan baru; pembayaran gagal → masa tenggang 7 hari → read-only → suspend (SAAS-008).
- **Q37:** Siapa mengurus billing di tenant? Rekomendasi: `owner`, ditambah siapa pun yang diberi `billing:manage`. Konsol menampilkan plan setiap organisasi dan pembayaran yang gagal; MRR nanti (SAAS-009).

**Onboarding dan offboarding**

- **Q38:** Alur sign-up tambahan? Rekomendasi: lewat sales ya (kamu membuat organisasi di konsol dan mengundang owner-nya); nama perusahaan di form sign-up tidak (SAAS-010).
- **Q39:** Apa yang terjadi saat tenant berhenti berlangganan? Rekomendasi: aktif sampai akhir periode → suspend → ekspor data selama 30 hari → purge, dengan event audit (SAAS-011).
