# Tenant Rollout

> **Status: desain saja, Proposed (SAAS-002, SAAS-003, SAAS-004).** Jangan dibangun sampai entri itu dijawab. Butuh [multi-tenant.md](multi-tenant.md), feature flag yang sudah diadopsi, dan persentase per organisasi ([feature-flags.md](feature-flags.md), FF-MT-01). Spec ini menambah **perusahaan tertentu** ke targeting flag: "beta untuk Acme", "jangan pernah untuk Globex".

## 1. Yang ditambahkan

| Tanpa tenant rollout (dasar multi-tenant) | Dengan tenant rollout |
|:---|:---|
| Kill switch, include/exclude user, persentase organisasi | Sama, ditambah daftar **include organisasi** dan **exclude organisasi** per flag |

Tetap tanpa role, plan, atau atribut lain (DEC-038, DEC-048, SAAS-004). Hanya pemilik SaaS yang mengubah daftarnya (SAAS-003).

## 2. Urutan evaluasi (SAAS-002)

Kecocokan pertama menang:

| # | Kondisi | Nilai | Alasan OpenFeature |
|:---|:---|:---|:---|
| 1 | Flag tidak ada di katalog atau tabel | default kode | `ERROR` (`FLAG_NOT_FOUND`) |
| 2 | Tipe yang diminta ≠ tipe flag | default kode | `ERROR` (`TYPE_MISMATCH`) |
| 3 | `enabled = false` | nilai off | `DISABLED` |
| 4 | `targetingKey` ada di `excludeUserIds` | nilai off | `TARGETING_MATCH` |
| 5 | `organizationId` ada di `excludeOrgIds` | nilai off | `TARGETING_MATCH` |
| 6 | `targetingKey` ada di `includeUserIds` | nilai on | `TARGETING_MATCH` |
| 7 | `organizationId` ada di `includeOrgIds` | nilai on | `TARGETING_MATCH` |
| 8 | `rolloutPercentage = 100` | nilai on | `STATIC` |
| 9 | `organizationId` ada dan `bucket(seed, organizationId) < rolloutPercentage` | nilai on | `SPLIT` |
| 10 | selain itu | nilai off | `DEFAULT` |

**Contoh.** Flag `new-editor`: aktif, exclude organisasi **Acme**, include user **budi@acme.com**, include organisasi **Globex**, 10% organisasi.

- Budi (di Acme): aturan 5 cocok lebih dulu → **off**. Acme meminta tanpa beta, dan itu menang atas include pribadi Budi.
- Siapa pun di Globex → aturan 7 → **on**.
- Lainnya → sekitar 10% perusahaan, seluruh perusahaan sekaligus.

Exclude selalu menang atas include di tingkat yang sama, dan exclude organisasi menang atas include user.

## 3. Data

Dua kolom di tabel global `feature_flag` ([database-provider.md §2](../feature-flags/database-provider.md)):

| Kolom | Tipe | Catatan |
|:---|:---|:---|
| `include_org_ids` | `text[] not null default '{}'` | ID organisasi |
| `exclude_org_ids` | `text[] not null default '{}'` | ID organisasi |

- Tabel tetap global (DEC-048). Kolom ini menyimpan ID organisasi; kolom ini tidak men-scope flag.
- Batas: include + exclude organisasi ≤ 1 000 per flag. Kelompok lebih besar memakai persentase.
- ID organisasi yang tidak dikenal ditolak API (dicek terhadap `organization.id`).
- ID organisasi yang sudah di-purge dihapus oleh aksi "clean lists", sama seperti user yang dihapus.

## 4. API

Di atas [database-provider.md §6](../feature-flags/database-provider.md), dengan `platformPermission` (DEC-048):

| Method | Path | Butuh | Perubahan |
|:---|:---|:---|:---|
| PATCH | `/api/feature-flags/:key` | `feature_flag:write` | Juga menerima `includeOrgIds`, `excludeOrgIds` |
| POST | `/api/feature-flags/:key/clean-lists` | `feature_flag:write` | Juga menghapus ID organisasi yang sudah di-purge |

`audit.feature_flag.changed` melaporkan daftar organisasi sebagai jumlah yang ditambah dan dihapus, tidak pernah ID-nya.

## 5. Halaman konsol

`/platform/feature-flags/:key` mendapat dua pemilih organisasi (cari berdasarkan slug), menampilkan slug dan nama. Tenant tidak melihat apa pun: `/api/feature-flags/evaluate` hanya mengembalikan nilai, tidak pernah daftar atau aturan (SAAS-003).

## 6. Provider PostHog

Daftar organisasi menjadi release condition pada **group** `organization` (*verify* bahwa provider OpenFeature PostHog meneruskan groups). Bila tidak, tenant rollout tetap memakai provider database.

## 7. Test

- Setiap baris §2, termasuk contoh Budi.
- Organisasi yang ada di kedua daftar bernilai off.
- ID organisasi tidak dikenal dan yang sudah di-purge: ditolak saat menulis, dihapus oleh clean lists.
- `owner` organisasi dengan role platform `user` mendapat 403 pada PATCH.

## 8. Task bila diadopsi

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| TR-01 | Kolom, urutan evaluasi (§2–3), perubahan API dan audit (§4) | FF-MT-01, SAAS-002 dijawab |
| TR-02 | Pemilih di konsol (§5) | TR-01, PC-03 |
