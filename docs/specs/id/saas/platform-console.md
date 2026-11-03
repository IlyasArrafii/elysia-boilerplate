# Konsol Platform SaaS

> **Status: desain saja (DEC-047, SAAS-001).** Area admin untuk **kamu, pemilik SaaS**, lintas semua tenant. Wajib bersama [multi-tenant.md](multi-tenant.md); tidak dipakai di access tahap 1 dan 2. Konsol ini dibangun di atas **lapisan platform** di [auth/access/single-org.md §8](../auth/access/single-org.md) (role platform, user, ban, session, flag) dan menambah halaman lintas organisasi. Baca [README.md](README.md) dulu.

## 1. Dua area admin

| | **Konsol platform** | **Settings organisasi** |
|:---|:---|:---|
| Untuk | Pemilik SaaS dan stafnya | Owner atau admin pelanggan |
| Lapisan | Platform: `user.role` (admin plugin) | Organisasi: `member.role` (organization plugin) |
| Melihat | Semua organisasi, semua user, session, ban | Hanya organisasi aktif |
| API | `/api/auth/admin/*` (user, session), `/api/platform/*` | Endpoint organisasi dan route modul, selalu di-scope |
| Web | `/platform/*` | `/settings/*` |
| Spec | Lapisan platform ([single-org.md §8](../auth/access/single-org.md)) + berkas ini | [single-org.md §10.4](../auth/access/single-org.md), [multi-tenant.md](multi-tenant.md) |

Role platform **tidak** memberi permission organisasi, dan role organisasi **tidak** memberi permission platform (DEC-043).

## 2. Yang ditambahkan konsol ke lapisan platform

| Lapisan platform (tahap 2 dan multi-tenant) | Konsol (hanya multi-tenant) |
|:---|:---|
| User, ban, session, role platform | Direktori organisasi, detail, dan member |
| Pengelolaan feature flag | Suspend, restore, dan hapus organisasi |
| `/platform/users`, `/platform/feature-flags` | Pencarian audit lintas tenant |
| | Hitungan ringkasan |
| | Tambahan nanti: daftar tenant rollout ([tenant-rollout.md](tenant-rollout.md)), plan ([plans-billing.md](plans-billing.md)) |

## 3. Tambahan statement platform

Ditambahkan ke `apps/api/src/modules/platform/permissions.ts` ([single-org.md §8.2](../auth/access/single-org.md)):

```ts
// sketsa: di atas user, session, dan feature_flag
platform_org:   ['list', 'get', 'suspend', 'restore', 'delete'],
platform_audit: ['read'],
// grants
platform_support: { ..., platform_org: ['list', 'get'] },
```

Route memakai `{ platformPermission: 'platform_org:suspend' }`.

## 4. Endpoint

| Method | Path | Butuh | Hasil |
|:---|:---|:---|:---|
| GET | `/api/platform/organizations` | `platform_org:list` | `{ id, slug, name, status, memberCount, createdAt }` berhalaman; filter `status`, cari berdasarkan slug |
| GET | `/api/platform/organizations/:id` | `platform_org:get` | Detail, ID user para owner, jumlah member, nama role runtime |
| GET | `/api/platform/organizations/:id/members` | `platform_org:get` | `{ userId, roles, createdAt }[]` |
| POST | `/api/platform/organizations/:id/suspend` | `platform_org:suspend` | `status = suspended`; body `{ reason }` (disimpan, tidak pernah di-log) |
| POST | `/api/platform/organizations/:id/restore` | `platform_org:restore` | `status = active` |
| POST | `/api/platform/organizations/:id/delete` | `platform_org:delete` | Soft delete ([multi-tenant.md §8](multi-tenant.md)) |
| GET | `/api/platform/audit` | `platform_audit:read` | Event audit dari log store, difilter `organizationId`, `userId`, event, tanggal |

`GET /api/platform/users/:id/memberships` adalah bagian lapisan platform ([single-org.md §8.3](../auth/access/single-org.md)).

## 5. Aturan

Aturan lapisan platform berlaku ([single-org.md §8.4](../auth/access/single-org.md)): session fresh untuk penulisan, tanpa impersonation, tidak menargetkan diri sendiri, minimal satu `super_admin`. Ditambah:

1. **Pembacaan lintas tenant hanya terjadi di sini.** Route modul tidak pernah melewati filter organisasi, bahkan untuk `super_admin`.
2. **Hanya-baca terhadap konten pelanggan.** Konsol membaca metadata pelanggan (organisasi, member, hitungan). Konsol tidak membaca atau mengubah konten pelanggan (post). Melihat konten butuh keputusan baru.
3. **Setiap request diaudit**, termasuk pembacaan (`audit.platform.accessed`), dan penulisan dengan event-nya sendiri (§8).
4. **Men-suspend organisasi tidak pernah mem-ban user-nya.** Ban berlaku per user dan memblokir seluruh aplikasi.
5. Kamu tidak bisa men-suspend organisasi yang owner-nya hanya kamu tanpa mengetik slug-nya untuk konfirmasi.

## 6. Akses data

- Modul `platform` membaca modul lain hanya lewat service yang diekspor (DEC-002).
- Fungsi yang membaca lintas tenant diberi nama `*AcrossTenants` (`organizationsService.listAcrossTenants`, `postsService.countByOrganizationAcrossTenants`). Hanya modul `platform` yang boleh mengimpornya; aturan lint menegakkannya. Fungsi ini berjalan dengan role database `app_platform` yang hanya-baca, yang melewati row-level security tetapi tidak bisa menulis ([architecture.md §4.2](architecture.md)).
- Pembacaan audit menuju log store MongoDB dengan user read-only ([log-storage.md](../observability/log-storage.md)).

## 7. Web

Layout `/platform` dan banner yang sama dengan lapisan platform ([single-org.md §8.5](../auth/access/single-org.md)).

| Halaman | Butuh |
|:---|:---|
| `/platform` (ringkasan: jumlah organisasi, user, user yang di-ban) | permission platform apa pun |
| `/platform/organizations`, `/platform/organizations/:id` | `platform_org:list` / `platform_org:get` |
| Tombol suspend, restore, hapus (konfirmasi dengan mengetik slug) | `platform_org:*` yang sesuai |
| `/platform/users/:id` mendapat daftar keanggotaan | `user:get` |
| `/platform/audit` | `platform_audit:read` |

## 8. Event audit

| Event | Payload |
|:---|:---|
| `audit.platform.accessed` | `actorId, path, targetOrganizationId?, targetUserId?` |
| `audit.platform.org_suspended` / `org_restored` / `org_deleted` | `organizationId, actorId` (tidak pernah alasannya) |

## 9. Test

- Matriks permission platform untuk route di §4: `super_admin`, `platform_support`, `user`.
- Setiap request konsol memancarkan `audit.platform.accessed`.
- Lint: mengimpor fungsi `*AcrossTenants` di luar `platform` gagal.
- Suspend → member organisasi itu mendapat 403 di sana; restore → akses kembali.
- Session basi → `403 SESSION_NOT_FRESH` saat suspend, restore, dan hapus.

## 10. Task bila diadopsi

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| PC-01 | Endpoint organisasi, service `*AcrossTenants`, aturan lint, audit (§3–6, §8) | ORG-07, MT-01 |
| PC-02 | Endpoint query audit di atas log store | ORG-07, TASK-15 |
| PC-03 | Halaman web konsol (§7) | PC-01, PC-02, ORG-08 |

## 11. Tambahan yang diusulkan: onboarding lewat sales (SAAS-010)

Tidak dibangun sampai SAAS-010 dijawab.

| Method | Path | Butuh | Hasil |
|:---|:---|:---|:---|
| POST | `/api/platform/organizations` | `platform_org:create` | Membuat organisasi (`status = active`) dan mengirim undangan `owner` ke email yang diberikan lewat alur undangan biasa ([multi-tenant.md §6](multi-tenant.md)) |

- Orang yang diundang menerima seperti biasa dan menjadi `owner`. Kamu tidak pernah menjadi member.
- Memancarkan `audit.platform.org_created` (`organizationId, actorId`, tidak pernah email-nya).
