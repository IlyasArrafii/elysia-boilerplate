# Access Stage

Cara boilerplate memutuskan **siapa boleh melakukan apa** di dalam satu aplikasi. Sebuah proyek berada di tepat **satu access stage (tahap)**, dicatat sebagai keputusan sebelum TASK-03 (DEC-042). **Tahap 1, static roles, adalah default.** Tahap 2 masih desain saja sampai ada proyek yang mengadopsinya.

Access hanya punya **dua tahap**. Menjual ke banyak perusahaan pelanggan yang terpisah (multi-tenancy) bukan access stage, melainkan fondasi lapisan SaaS: [saas/](../../saas/README.md) (DEC-050).

Nama Better Auth di bawah berasal dari dokumentasi admin plugin dan organization plugin per 2026-11. *Verify* terhadap versi yang terpasang.

## 1. Alurnya

```
Tahap 1: static-roles (DEFAULT)  ──Langkah A──►  Tahap 2: single-org          ┊  SaaS (saas/)
role di kode (admin plugin)                      1 organisasi tersembunyi      ┊  multi-tenant ──► konsol,
user.role                                        role + permission diberikan   ┊  rollout, plan
                                                 saat runtime (member.role)    ┊
```

- Tahap 2 dibangun di atas tahap 1: berkas `permissions.ts` setiap modul tetap sama, hanya pemegang permission yang berubah.
- Perpindahan hanya **maju**: [migration.md](migration.md) (Langkah A). Mundur tidak didukung.
- Proyek baru boleh **mulai** di tahap mana pun. Mulai langsung di tahap yang dibutuhkan lebih murah daripada migrasi belakangan.
- **Multi-tenancy adalah SaaS.** Ia butuh tahap 2 lebih dulu dan dijelaskan, berikut migrasinya sendiri, di [saas/](../../saas/README.md). Tidak ada isi `saas/` yang mengubah tahap 1 atau 2 (DEC-049).

## 2. Dua tahap

| | **Tahap 1: static-roles** (default) | **Tahap 2: single-org** |
|:---|:---|:---|
| Spec | [static-roles.md](static-roles.md) | [single-org.md](single-org.md) |
| Plugin Better Auth | `admin` | `admin` + `organization` (satu organisasi tersembunyi) |
| Tempat role user disimpan | `user.role` | `member.role` di organisasi utama |
| Tempat role didefinisikan | Hanya kode | Role kode + **role runtime** (`organization_role`) |
| Siapa membuat role dan memberi permission | Developer, lewat deploy | Super Admin atau `owner`, dari UI, memilih permission dari statement di kode |
| Beberapa role per user | Ya, dipisah koma | Ya, dipisah koma |
| Organisasi terlihat oleh user | Tidak | Tidak |
| `organization_id` di tabel modul | Tidak | Ya (DEC-044) |
| Lapisan platform (`user.role` = `super_admin`/`user`) | Tidak (satu sistem role) | Ya: user, ban, sesi, flag ([single-org.md §8](single-org.md)) |
| Feature flag | [feature-flags/access-stages.md §2](../../feature-flags/access-stages.md) | [feature-flags/access-stages.md §3](../../feature-flags/access-stages.md) |
| Observability | [observability/access-stages.md §2](../../observability/access-stages.md) | [observability/access-stages.md §3](../../observability/access-stages.md) |
| Biaya bangun | Terendah; [TASKS.md](../../TASKS.md) apa adanya | ORG-01 sampai ORG-08 menggantikan empat task |

## 3. Cara memilih

1. **Apakah orang non-developer harus membuat role atau mengubah permission yang diberikan sebuah role, tanpa deploy?** → **Tahap 2: single-org**.
2. Selain itu → **Tahap 1: static-roles**. Tambahkan role kustom di kode ([static-roles.md §8](static-roles.md)).

Pelanggan berupa perusahaan terpisah yang tidak boleh melihat data satu sama lain adalah pertanyaan SaaS, bukan pertanyaan ini: pindah ke tahap 2, lalu ikuti [saas/migration.md](../../saas/migration.md).

Bila ragu, mulai di tahap 1. Perpindahan belakangan direncanakan di [migration.md](migration.md).

**Hanya tahap yang dipilih yang dibangun.** Membangun keduanya di balik switch konfigurasi ditolak: kode auth yang harus diamankan dan dites jadi dua kali lipat (DEC-042).

## 4. Yang sama di kedua tahap

Bagian ini tetap sama, jadi bentuk modul tidak pernah berubah:

- Setiap modul mendeklarasikan permission-nya di `permissions.ts` sebagai **statement** (`resource → actions`). Aturan: [static-roles.md §3](static-roles.md).
- `apps/api/src/utils/auth/access.ts` menggabungkan statement dan menggagalkan startup bila ada kunci resource ganda.
- Route mendeklarasikan `{ permission: 'posts:write' }`. Macro menyembunyikan plugin mana yang menjawab pengecekan.
- Aturan kepemilikan ("hanya penulis yang boleh mengedit post ini") tetap di service.
- Web app mengecek permission dengan `can()`, tidak pernah nama role. `GET /api/me/permissions` mengembalikan permission user saat ini.
- Impersonation diblokir (DEC-032).
- Feature flag tidak pernah menentukan akses dan tidak pernah menarget role (DEC-038).

Yang berubah hanya **siapa yang memegang** permission:

| | Tahap 1 | Tahap 2 |
|:---|:---|:---|
| Grant di `permissions.ts` | `grants` per role kode (`admin`, `user`, kustom) | `grants` per role kode organisasi (`owner`, `admin`, `member`, kustom). Role runtime memilih dari statement |
| Pengecekan permission | Admin plugin `userHasPermission` pada `user.role` | Organization plugin `hasPermission` pada `member.role` di organisasi utama |
| Isi `user.role` | Semua role | Hanya role platform: `super_admin` atau `user` (DEC-043) |

## 5. Dua lapisan di tahap 2

| Lapisan | Pertanyaan yang dijawab | Disimpan di | Plugin | Spec |
|:---|:---|:---|:---|:---|
| **Platform** | "Siapa yang menjalankan aplikasi ini?" User, ban, sesi, feature flag | `user.role` = `super_admin` atau `user` | admin | [single-org.md §8](single-org.md) |
| **Organisasi** | "Apa yang boleh dilakukan orang ini pada konten aplikasi?" | `member.role` = `owner`, `admin`, `member` atau role runtime | organization | [single-org.md §4–7](single-org.md) |

Role platform **tidak** memberi permission modul apa pun. `super_admin` yang ingin mengedit post butuh role organisasi yang mengizinkannya (seed menjadikan `super_admin` pertama sebagai `owner`).

## 6. Dokumen

| Berkas | Isi |
|:---|:---|
| [static-roles.md](static-roles.md) | **Tahap 1** (default): role di kode, admin plugin |
| [single-org.md](single-org.md) | **Tahap 2**: inti organization plugin, role runtime, lapisan platform, satu organisasi tersembunyi |
| [migration.md](migration.md) | Memilih tahap di awal proyek, dan **Langkah A** (1 → 2), termasuk perubahan pada feature flag dan observability |
| [../../feature-flags/access-stages.md](../../feature-flags/access-stages.md) | Feature flag di tahap 1 dan 2 |
| [../../observability/access-stages.md](../../observability/access-stages.md) | Log dan event telemetri di tahap 1 dan 2 |
| [../../saas/README.md](../../saas/README.md) | Lapisan SaaS: multi-tenancy, arsitektur dan migrasinya, konsol platform, tenant rollout, plan dan billing |
