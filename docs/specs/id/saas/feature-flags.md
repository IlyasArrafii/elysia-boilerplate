# Feature Flag di Multi-Tenant

> **Status: desain saja (DEC-048, DEC-050).** Perilaku feature flag setelah aplikasi menjadi multi-tenant ([multi-tenant.md](multi-tenant.md)). Tahap 1 dan 2 ada di [feature-flags/access-stages.md](../feature-flags/access-stages.md); sistem flag-nya sendiri ada di [feature-flags/](../feature-flags/README.md). Flag tetap bebas role (DEC-038) dan global (DEC-048). Menyebut nama perusahaan pada flag ("beta untuk Acme") adalah add-on opsional [tenant-rollout.md](tenant-rollout.md).

## 1. Ringkasan

| | Tahap 2: single-org | **Multi-tenant** |
|:---|:---|:---|
| Konteks evaluasi | `targetingKey` (user ID) | `targetingKey` (user ID) + `organizationId` (organisasi aktif) |
| Persentase rollout meng-hash | User ID | **Organization ID** (Q27) |
| Daftar include/exclude user | Ya | Ya, tidak berubah |
| Daftar include/exclude organisasi | Tidak | Hanya dengan [tenant-rollout.md](tenant-rollout.md) |
| Siapa mengelola flag | Lapisan platform | Lapisan platform, tidak berubah. Tenant tidak pernah mengelola flag (SAAS-003) |
| Tabel `feature_flag` | Global | Global, tanpa `organization_id`, tanpa RLS ([architecture.md §4.1](architecture.md)) |

## 2. Konteks evaluasi

| Field | Sumber | Catatan |
|:---|:---|:---|
| `targetingKey` | `user.id` | Tidak ada untuk tamu |
| `organizationId` | `session.activeOrganizationId` | Tidak ada untuk tamu dan user tanpa organisasi aktif (onboarding) |

`organizationId` adalah ID internal, bukan data pribadi. Ini satu-satunya atribut organisasi: tanpa nama, plan, ukuran, atau negara (DEC-048, SAAS-004). Test konteks berubah dari "tepat satu key" menjadi "tepat key-key ini".

## 3. Aturan

Urutan di [targeting.md §3](../feature-flags/targeting.md) tetap. Hanya aturan 7, persentase, yang berubah:

| # | Kondisi | Nilai |
|:---|:---|:---|
| 7 | `organizationId` ada dan `bucket(seed, organizationId) < rolloutPercentage` | nilai on (`SPLIT`) |

- Semua orang di satu perusahaan mendapat jawaban yang sama, jadi layar tidak pernah berbeda antar rekan kerja.
- Daftar include dan exclude user tetap berlaku, jadi kamu masih bisa menyalakan flag untuk satu orang.
- Tanpa `organizationId` (tamu, atau user yang masih onboarding): aturan 7 tidak bisa cocok, sama seperti tamu saat ini. Hanya 100% yang menyalakan flag.
- `rolloutPercentage` kini berarti "persentase organisasi". API admin dan halaman konsol memberi label seperti itu.
- Satu kunci bucketing untuk seluruh aplikasi. Pilihan per flag antara user dan organisasi tidak ada di versi pertama.

## 4. Caching dan web app

- Snapshot provider bersifat global, jadi cache-nya tidak berubah.
- `/api/feature-flags/evaluate` mengembalikan nilai untuk organisasi aktif. Query key di web app menyertakan ID organisasi, dan pindah organisasi tetap mengosongkan seluruh cache query ([multi-tenant.md §5](multi-tenant.md)).

## 5. Langkah B (tahap 2 → multi-tenant)

| Yang berubah | Tindakan |
|:---|:---|
| Persentase meng-hash organisasi alih-alih user | Flag di 0% atau 100% tidak terpengaruh. Flag di antaranya teracak ulang: sebelum rilis B2, tuntaskan (0 atau 100) atau terima grup barunya ([migration.md §3.4](migration.md)) |
| Konteks mendapat `organizationId` | Dirilis di B2 bersama pembaruan test konteks |
| Pengelolaan | Tidak ada: sudah di lapisan platform sejak tahap 2 |

## 6. Provider PostHog

PostHog mencocokkan organisasi dengan **group** (group type `organization`, dengan key `organizationId`). *Verify* bahwa provider OpenFeature PostHog meneruskan group. Bila tidak, multi-tenant tetap memakai provider database ([posthog-provider.md](../feature-flags/posthog-provider.md)).

## 7. Test

- Dua user di satu organisasi selalu mendapat hasil persentase yang sama.
- 1 000 organisasi di 25% jatuh di rentang 22–28%.
- User tanpa organisasi aktif mendapat nilai off di bawah 100%.
- Include dan exclude user tetap menang atas persentase.
- Pembentuk konteks menghasilkan tepat `targetingKey` dan `organizationId`.

## 8. Task bila diadopsi

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| FF-MT-01 | `organizationId` di konteks, persentase per organisasi, label (§2–4) | FF-ORG-01, MT-01 |
