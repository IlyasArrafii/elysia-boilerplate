# Feature Flag di Setiap Access Stage

> **Status: desain saja (DEC-048, DEC-050).** Perilaku feature flag di access stage 1 (static-roles) dan tahap 2 (single-org) ([auth/access/README.md](../auth/access/README.md)), dan apa yang berubah di Langkah A. Flag tetap bebas role di setiap tahap (DEC-038). Flag di lapisan SaaS multi-tenant (persentase per organisasi, tenant bernama) ada di [saas/feature-flags.md](../saas/feature-flags.md).

## 1. Ringkasan

| | **Tahap 1: static-roles** (default) | **Tahap 2: single-org** |
|:---|:---|:---|
| Konteks evaluasi | `targetingKey` (user ID) | `targetingKey` (user ID) |
| Persentase rollout meng-hash | User ID | User ID |
| Aturan | [targeting.md](targeting.md) | [targeting.md](targeting.md), tidak berubah |
| Siapa mengelola flag | Permission modul `feature_flag:read|write` pada role kode | Permission **platform** `feature_flag:read|write` pada `user.role` |
| Opsi API di route pengelolaan | `permission` | `platformPermission` |
| Halaman web | `/admin/feature-flags` | `/platform/feature-flags` |
| Tabel `feature_flag` | Global | Global, tanpa `organization_id` |

Flag bersifat **global**: satu tabel `feature_flag` dan satu katalog untuk seluruh aplikasi. Flag tidak pernah dimiliki sebuah organisasi.

## 2. Tahap 1: static-roles

Semua isi [README.md](README.md), [targeting.md](targeting.md), dan [database-provider.md](database-provider.md) berlaku apa adanya. `permissions.ts` modul `feature-flags` mendeklarasikan `{ feature_flag: ['read', 'write'] }`; `admin` mendapat `read`, `super_admin` mendapat keduanya.

## 3. Tahap 2: single-org

- **Targeting tidak berubah.** Hanya ada satu organisasi, jadi menargetkannya tidak berarti apa-apa. Konteks tetap hanya `targetingKey`, dan setiap flag memberi hasil yang sama untuk setiap user seperti di tahap 1.
- **Pengelolaan pindah ke lapisan platform** ([single-org.md §8](../auth/access/single-org.md)). Flag berlaku untuk seluruh aplikasi, sedangkan role organisasi menjelaskan apa yang boleh dilakukan seseorang pada konten aplikasi, jadi kendali flag milik orang yang menjalankan aplikasi:
  - `feature_flag` keluar dari statement modul dan masuk ke statement platform. Ia tidak pernah ada di `orgAc`, jadi tidak ada role organisasi atau role runtime yang bisa memegangnya, dan `create-role` menolaknya.
  - Route pengelolaan di [database-provider.md §6](database-provider.md) memakai `{ platformPermission: 'feature_flag:read' }` / `'feature_flag:write'` alih-alih `permission`.
  - `super_admin` mendapat keduanya. Role kode platform seperti `platform_support` boleh mendapat `read`.
  - `GET /api/feature-flags/evaluate` tetap `auth: true` dan tidak ber-scope organisasi.
- Telemetri tidak berubah: `flag.*` dan `audit.feature_flag.changed` ([README.md §7](README.md)). Di tahap 2, `audit.feature_flag.changed` punya `module: "platform"`.
- Menaruh flag di lapisan platform sejak tahap 2 berarti lapisan SaaS tidak perlu mengubah permission untuknya.

## 4. Langkah A (tahap 1 → tahap 2)

| Yang berubah | Tindakan |
|:---|:---|
| `feature_flag:*` pindah dari role modul ke role platform | User yang memegang `feature_flag:read` lewat `admin` kehilangannya. Script migrasi mencantumkan mereka; beri masing-masing `platform_support` atau terima kehilangannya. Cek snapshot permission ([migration.md §3.5](../auth/access/migration.md)) membandingkan `feature_flag:*` secara terpisah karena alasan ini |
| `/admin/feature-flags` → `/platform/feature-flags` | Redirect path lama selama satu rilis |
| Targeting | Tidak ada: hashing user ID dan daftar tetap, jadi hasil flag tidak berubah bagi user mana pun |
| Baris flag | Tidak ada: tabel global dan tidak mendapat `organization_id` |

## 5. Test

- Tahap 2: route pengelolaan butuh permission platform; `owner` organisasi dengan role platform `user` mendapat 403; `create-role` menolak role runtime yang berisi `feature_flag:*`.
- Tahap 2: untuk set tetap 1 000 user, setiap flag memberi hasil yang sama dengan evaluator tahap 1 (targeting tidak berubah).
- Langkah A: daftar "kehilangan `feature_flag:*`" dari script migrasi cocok dengan user yang memegangnya lewat `admin`.

## 6. Task bila diadopsi

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| FF-ORG-01 | Tahap 2: pindahkan permission flag ke statement platform, `platformPermission` di route pengelolaan, halaman `/platform/feature-flags`, redirect | Flag diadopsi, ORG-07 |

Pekerjaan flag multi-tenant (FF-MT-01) ada di [saas/feature-flags.md §8](../saas/feature-flags.md).
