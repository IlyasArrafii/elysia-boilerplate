# Tahap 1: Static Roles (RBAC, default)

> **Tahap 1, default (DEC-042).** Tahap pertama dari tiga access stage; cara memilih dan lanjut ke tahap berikutnya: [README.md](README.md). Dulu bernama `auth/rbac.md`.

Role dan permission memakai admin plugin Better Auth dengan access control (DEC-005). Role didefinisikan di kode dan proyek bisa menambah role kustom (DEC-022). Setiap modul mendeklarasikan permission-nya sendiri, lalu digabung di satu tempat (DEC-023).

Nama API Better Auth di bawah berasal dari dokumentasi admin plugin per 2026-11; *verify* terhadap versi yang terpasang.

## 1. Kosakata

| Istilah | Arti | Contoh |
|:---|:---|:---|
| **Resource** | Sesuatu yang bisa dikenai aksi, dimiliki tepat satu modul | `posts`, `role`, `user` |
| **Action** | Apa yang bisa dilakukan pada resource | `read`, `write`, `manage_all` |
| **Statement** | Peta resource → action yang diizinkan milik sebuah modul | `{ posts: ['read', 'write', 'manage_all'] }` |
| **Permission** | Satu pasangan `resource:action`, string yang dipakai route | `posts:write` |
| **Role** | Kumpulan permission bernama, disimpan sebagai string di `user.role` | `admin` |
| **Grant** | Permission yang diberikan sebuah modul kepada satu role | `user: { posts: ['read', 'write'] }` |
| **Aturan kepemilikan** | Pengecekan pada record tertentu, di service setelah permission lolos | "hanya penulis yang mengubah post ini" |

Permission menjawab "bolehkah role ini melakukan jenis aksi ini?". Kepemilikan menjawab "bolehkah user ini melakukannya pada record ini?". Feature flag menjawab "apakah perilaku ini menyala?" dan tidak pernah dipakai untuk akses ([feature-flags/targeting.md](../../feature-flags/targeting.md)).

## 2. Role registry

`apps/api/src/utils/auth/roles.ts` adalah satu-satunya daftar role:

```ts
// sketsa
export const roleRegistry = {
  super_admin: { label: 'Super Admin', description: 'Full access, including roles and bans.' },
  admin:       { label: 'Admin',       description: 'Manages all content; reads users and sessions.' },
  user:        { label: 'User',        description: 'Default role for every new account.' },
  // role kustom, mis. editor: { label: 'Editor', description: 'Manages all posts; no user access.' },
} as const satisfies Record<string, { label: string; description: string }>

export type RoleName = keyof typeof roleRegistry
export const DEFAULT_ROLE: RoleName = 'user'
```

- Nama role `snake_case`, stabil, disimpan di database. Mengganti nama berarti migrasi data.
- `super_admin` dan `user` harus selalu ada. `super_admin` tidak pernah diberi grant per modul: ia diturunkan (§4).
- Better Auth menyimpan beberapa role dipisah koma (`"admin,editor"`). Pengecekan lolos bila salah satu role yang dipegang memberi permission itu (*verify*). UI MVP memberi satu role.

## 3. Mendeklarasikan permission di modul

```ts
// apps/api/src/modules/posts/permissions.ts (sketsa)
export const postsPermissions = defineModulePermissions({
  statement: { posts: ['read', 'write', 'manage_all'] },
  grants: {
    admin: { posts: ['read', 'write', 'manage_all'] },
    user:  { posts: ['read', 'write'] },
  },
})
```

Modul `admin` mendeklarasikan action bawaan Better Auth **yang kita pakai**, didaftar eksplisit. Modul ini **tidak** menyebarkan `defaultStatements`, sehingga action impersonation admin plugin tidak pernah ada di access control kita (DEC-032):

```ts
// apps/api/src/modules/admin/permissions.ts (sketsa)
export const adminPermissions = defineModulePermissions({
  statement: {
    user:    ['create', 'list', 'get', 'update', 'set-role', 'ban', 'delete', 'set-password'],
    session: ['list', 'revoke', 'delete'],
    role:    ['read'],
  },
  grants: {
    admin: { user: ['list', 'get'], session: ['list'], role: ['read'] },   // DEC-033
  },
})
```

Aturan:
- Satu resource milik satu modul. Dua modul yang mendeklarasikan key resource yang sama menggagalkan startup.
- Key resource adalah nama modul (`posts`) atau nama bawaan Better Auth (`user`, `session`).
- Action berupa kata kerja `snake_case`, atau action kebab-case Better Auth untuk resource bawaan. Buat kasar (`read`, `write`, `manage_all`, `publish`); bukan satu action per endpoint.
- Setiap permission melindungi minimal satu route API. Tidak ada permission khusus UI.
- Action bawaan Better Auth ditambahkan ke statement hanya bila ada fitur yang memakainya, dengan keputusan bila sensitif dari sisi keamanan.

## 4. Menyusun access control Better Auth

`apps/api/src/utils/auth/access.ts` menggabungkan setiap modul secara eksplisit (tanpa globbing berkas):

```ts
// sketsa
const modules = [adminPermissions, postsPermissions /* , modul baru di sini */]

const statement = mergeStatements(modules)          // melempar error bila key resource duplikat
export const ac = createAccessControl(statement)

export const roles = {
  super_admin: ac.newRole(statement),               // setiap action dari setiap statement
  ...Object.fromEntries(
    roleNamesExcept('super_admin').map((r) => [r, ac.newRole(mergeGrants(modules, r))]),
  ),
}

export type Permission = PermissionKeys<typeof statement>   // 'posts:read' | 'user:list' | ...
```

- `super_admin` mendapat setiap action di statement. Modul baru otomatis tercakup; action yang tidak ada di statement (seperti impersonation) tidak pernah tercakup.
- Role tanpa grant itu valid: bisa sign-in dan memanggil route `auth: true` saja.
- `ac` dan `roles` diteruskan ke `admin({ ac, roles, defaultRole: 'user' })`.
- `Permission` diekspor sebagai tipe untuk opsi route `permission` dan `can()` di aplikasi web.

## 5. Matriks permission default

| Permission | `super_admin` | `admin` | `user` | Tamu |
|:---|:---:|:---:|:---:|:---:|
| `posts:read` | ✅ | ✅ | ✅ | ❌ |
| `posts:write` (post sendiri; aturan kepemilikan di service) | ✅ | ✅ | ✅ | ❌ |
| `posts:manage_all` | ✅ | ✅ | ❌ | ❌ |
| `role:read` | ✅ | ✅ | ❌ | ❌ |
| `user:list`, `user:get` | ✅ | ✅ | ❌ | ❌ |
| `session:list` | ✅ | ✅ | ❌ | ❌ |
| `user:create`, `user:update`, `user:set-role`, `user:ban`, `user:delete`, `user:set-password` | ✅ | ❌ | ❌ | ❌ |
| `session:revoke`, `session:delete` | ✅ | ❌ | ❌ | ❌ |

Tamu hanya menjangkau route bertanda **Publik** di [API.md](../../API.md).

## 6. Permission di aplikasi web

Aplikasi web tidak pernah memutuskan akses; ia menyembunyikan apa yang toh akan ditolak API.

- `GET /api/me/permissions` mengembalikan `{ roles, permissions }`. `usePermissions()` di `features/auth` meng-cache-nya per sesi dan menyediakan `can(permission)`. Dibersihkan saat sign-in, sign-out, dan setelah perubahan role.
- `beforeLoad` route memakai query yang sama (`ensureQueryData`) untuk redirect bila permission halaman tidak dimiliki.

| Fitur | Halaman / aksi | Butuh |
|:---|:---|:---|
| `posts` | Daftar, lihat | `posts:read` |
| `posts` | Buat; ubah/hapus milik sendiri | `posts:write` |
| `posts` | Ubah/hapus milik siapa pun | `posts:manage_all` |
| `admin` | Daftar user, detail user | `user:list`, `user:get` |
| `admin` | Ubah role | `user:set-role` |
| `admin` | Ban / unban | `user:ban` |
| `admin` | Daftar / cabut sesi | `session:list` / `session:revoke` |
| `admin` | Katalog role | `role:read` |
| `profile` | Ubah nama dan avatar sendiri | hanya `auth: true` |

Fitur yang butuh kemampuan baru menambah permission ke **modul** yang menyajikan datanya.

## 7. Aturan guard (`hooks.before` Better Auth)

Di `apps/api/src/utils/auth/hooks.ts`:

| Path | Aturan | Error |
|:---|:---|:---|
| `/admin/set-role` | `body.userId === session.user.id` | `400 CANNOT_CHANGE_OWN_ROLE` |
| `/admin/set-role` | setiap role yang diminta ada di registry | `400 INVALID_ROLE` |
| `/admin/ban-user`, `/admin/remove-user` | `body.userId === session.user.id` | `400 CANNOT_TARGET_SELF` |
| `/admin/impersonate-user`, `/admin/stop-impersonating`, dan path admin plugin lain yang tidak tercantum di [API.md §3.1](../../API.md) | selalu | `404 NOT_FOUND`, plus `audit.auth.blocked_endpoint` |

Aturan terakhir adalah **allowlist**: path admin plugin hanya diizinkan bila tercantum di API.md, sehingga upgrade Better Auth yang menambah endpoint tidak bisa membukanya diam-diam. Error dilempar sebagai `APIError` Better Auth agar format Better Auth tetap terjaga. Karena hanya `super_admin` yang memegang `user:set-role` dan tidak ada yang bisa mengubah role sendiri, minimal satu `super_admin` selalu tersisa.

Operator juga bisa mengatur role dari terminal: `bun run role:set <email> <role>` (`apps/api/scripts/role-set.ts`). Email dicocokkan tanpa membedakan huruf besar-kecil, dan user-nya harus sudah ada. Aturannya sama: role harus ada di registry, dan `super_admin` terakhir yang masih bisa dipakai tidak bisa diturunkan (exit 1). Seperti `/admin/set-role`, perintah ini berjalan di bawah user mutation lock dan memancarkan `audit.user.role_changed` dengan `actorId: "cli"`. Mengatur role yang sudah dimiliki user tidak mengubah apa pun dan exit 0.

Saat startup API menghitung user yang role-nya tidak ada di registry dan memancarkan `rbac.unknown_role` (warn). User tersebut tidak punya permission sampai diberi role lain.

## 8. Menambah role kustom

Contoh: `editor` yang mengelola semua post tetapi tidak bisa melihat user.

1. Tambah `editor` ke `roleRegistry` dengan label dan deskripsi.
2. Tambah grant di setiap modul yang dibutuhkan role itu: `editor: { posts: ['read', 'write', 'manage_all'] }`.
3. Perbarui matriks di §5 dan test matriks permission.
4. Deploy. `super_admin` memberikannya dengan `authClient.admin.setRole({ userId, role: 'editor' })`, atau operator dengan `bun run role:set <email> editor` (§7).

Menghapus role: pindahkan dulu user-nya (`rbac.unknown_role` menunjukkan siapa yang tersisa), lalu hapus entri dan grant-nya. Mengganti nama: tambah role baru, migrasikan user dengan migrasi SQL, lalu hapus yang lama.

## 9. Menambah permission kustom

Contoh: posts mendapat `publish`.

1. Tambah `'publish'` ke statement `posts`.
2. Berikan ke role yang membutuhkannya (`super_admin` otomatis mendapatkannya).
3. Pakai: `{ permission: 'posts:publish' }`.
4. Perbarui §5, §6 (bila dipakai UI), dan [API.md](../../API.md).
5. Perluas test.

Modul baru mengikuti langkah yang sama dengan key resource baru.

## 10. Role yang bisa diubah saat runtime (tahap berikutnya)

Di tahap 1 role berupa kode agar bisa di-review, bertipe, dan dites. Bila non-developer harus membuat atau mengubah role dari UI, pindah ke **tahap 2** dengan dynamic access control Better Auth ([single-org.md](single-org.md)), mengikuti Langkah A di [migration.md §3](migration.md). Tabel `role_definition` sendiri di samping admin plugin bukan pilihan: itu menjadi sumber kebenaran kedua dan melanggar DEC-005.

## 11. Test

Folder: `apps/api/tests/utils/auth/` dan `apps/api/tests/modules/<module>/` ([TESTING.md](../../TESTING.md)).

- **Test matriks:** setiap role registry × setiap route terlindungi → status yang diharapkan (2xx vs 403). Tamu → 401.
- **Snapshot compiled roles:** `role → daftar permission terurut`; perubahan grant tampil sebagai diff yang bisa di-review.
- **Test guard:** ubah role sendiri, role tak dikenal, ban diri sendiri, endpoint impersonation → 404 untuk `super_admin`, path admin yang tidak tercantum → 404.
- **Test statement:** statement gabungan tidak memuat action `impersonate` atau `impersonate-admins`.
- **Test startup:** key resource duplikat menggagalkan startup; role tak dikenal di database memancarkan `rbac.unknown_role`.
