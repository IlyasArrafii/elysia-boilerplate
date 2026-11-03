# Tahap 2: Single-Org

> **Status: desain saja (DEC-042, DEC-047, DEC-050).** Dibangun hanya bila proyek berada di **tahap 2** ([README.md §3](README.md)). Berkas ini memuat inti organisasi (§1–9, §11–14) dan setup satu organisasi tersembunyi (§10). Lapisan SaaS multi-tenant memakai semuanya kecuali §10: [saas/multi-tenant.md](../../saas/multi-tenant.md). Pindah ke sini dari tahap 1: [migration.md §3](migration.md) (Langkah A).

Nama Better Auth berasal dari dokumentasi organization plugin dan skill `organization-best-practices` per 2026-11. Semua yang bertanda *verify* harus dicek terhadap versi yang terpasang sebelum dipakai.

## 1. Yang diberikan tahap ini

- Role disimpan di database dan dibuat saat runtime (**dynamic access control** Better Auth), sementara permission tetap di kode.
- Statement `permissions.ts` modul yang sama dengan tahap 1. Bentuk modul tidak berubah.
- `organization_id` di setiap tabel modul sejak hari pertama (DEC-044), sehingga lanjut ke multi-tenancy ([saas/migration.md](../../saas/migration.md)) tidak butuh migrasi data.
- Dua lapisan terpisah: **platform** (`user.role`, admin plugin, §8) dan **organisasi** (`member.role`, organization plugin, §4–7) ([README.md §5](README.md), DEC-043).
- Bagi user, aplikasi terlihat sama seperti di tahap 1: hanya ada satu organisasi dan tidak pernah ditampilkan.

## 2. Setup plugin

```ts
// packages/auth/src/server.ts (sketsa)
plugins: [
  admin({ ac: platformAc, roles: platformRoles, defaultRole: 'user' }),   // hanya lapisan platform (§8)
  organization({
    ac: orgAc,
    roles: orgRoles,                       // role kode: owner, admin, member (+ role kode kustom)
    creatorRole: 'owner',
    dynamicAccessControl: {
      enabled: true,
      maximumRolesPerOrganization: 20,     // *verify* nama opsi
    },
    teams: { enabled: false },
    disableOrganizationDeletion: true,     // hanya soft delete (multi-tenant.md §8)
    allowUserToCreateOrganization: false,  // tahap 2; multi-tenant menimpanya (saas/multi-tenant.md §2)
    schema: {
      organization: { additionalFields: { status: { type: 'string', required: true, defaultValue: 'active' } } },
    },
    hooks: { /* event audit, §13 */ },
  }),
]
```

- Client: `organizationClient()` ditambahkan di samping `adminClient()`. *Verify* apakah client butuh `ac`/`roles` untuk `checkRolePermission`; kita tidak memakainya (web app hanya membaca `/api/me/permissions`).
- Import dari path plugin-nya sendiri (`better-auth/plugins/organization`, *verify* path import dynamic access control).
- `adminUserIds` tetap tidak di-set (DEC-032).

## 3. Skema yang ditambahkan

Dibuat oleh Better Auth CLI, lalu dimigrasi dengan Drizzle Kit seperti yang lain ([DATABASE.md §3](../../DATABASE.md)).

| Tabel / kolom | Tujuan |
|:---|:---|
| `organization` | `id`, `name`, `slug` (unik), `logo`, `metadata`, `created_at`, plus `status` milik kita (`active`, `suspended`, `deleted`) |
| `member` | `id`, `organization_id`, `user_id`, `role` (dipisah koma, tanpa spasi), `created_at`. Satu baris per user per organisasi |
| `invitation` | Undangan. Tetap kosong di tahap 2 |
| `organization_role` | Role runtime: `organization_id`, `role` (nama), `permission` (JSON), timestamp (*verify* nama tabel dan kolom) |
| `session.active_organization_id` | Organisasi yang dipakai setiap cek permission |

`member.role`, seperti `user.role`, bukan foreign key. Role kode tidak disimpan di `organization_role`.

## 4. Access control

`apps/api/src/utils/auth/access.ts` membangun dua access control:

```ts
// sketsa
const moduleStatement = mergeStatements([postsPermissions /* , modul baru */])  // throw bila duplikat

// Lapisan organisasi: default plugin + setiap modul
export const orgAc = createAccessControl({ ...orgDefaultStatements, ...moduleStatement })
export const orgRoles = {
  owner:  orgAc.newRole({ ...orgDefaultStatements, ...moduleStatement }),   // semuanya
  admin:  orgAc.newRole({ ...orgAdminDefaults, ...mergeGrants(modules, 'admin') }),
  member: orgAc.newRole({ ...mergeGrants(modules, 'member') }),
}

// Lapisan platform: hanya statement platform (§8.2)
export const platformAc = createAccessControl(platformStatement)
export const platformRoles = {
  super_admin: platformAc.newRole(platformStatement),
  user:        platformAc.newRole({}),
  // role kode platform kustom, mis. platform_support (§8.1)
}
```

- `orgDefaultStatements` adalah resource milik plugin (`organization`, `member`, `invitation`, `team`, `ac`). `ac:create|read|update|delete` mengatur role runtime (*verify* nama). Default yang kita pakai didaftar secara eksplisit, seperti modul admin untuk admin plugin.
- `grants` modul memakai key **role kode organisasi**: `owner` (diturunkan: semuanya), `admin`, `member`, plus role kode kustom.
- Resource modul tidak pernah masuk `platformStatement`, dan resource platform tidak pernah masuk `orgAc`. Cek startup gagal bila sebuah key muncul di keduanya.
- Default untuk member baru adalah `member`.

### 4.1 Matriks organisasi default

| Permission | `owner` | `admin` | `member` |
|:---|:---:|:---:|:---:|
| `posts:read`, `posts:write` (milik sendiri) | ✅ | ✅ | ✅ |
| `posts:manage_all` | ✅ | ✅ | ❌ |
| `member:read` (daftar member) | ✅ | ✅ | ❌ |
| `member:update` (ubah role) | ✅ | ✅ | ❌ |
| `ac:read` (lihat role) | ✅ | ✅ | ❌ |
| `ac:create`, `ac:update`, `ac:delete` (role runtime) | ✅ | ❌ | ❌ |
| `organization:update` (ganti nama, logo) | ✅ | ❌ | ❌ |

## 5. Data modul di-scope per organisasi

Berlaku di tahap 2 dan di lapisan SaaS multi-tenant (DEC-044).

- Setiap tabel modul mendapat `organization_id text not null references organization(id)`, di posisi pertama pada index utamanya (`idx_post_org_created (organization_id, created_at desc)`).
- Keunikan menjadi per organisasi: `post.slug` → `unique (organization_id, slug)`.
- Macro `auth` mengisi `ctx.org = { id }` dari `session.activeOrganizationId`. Route yang butuh data tanpa organisasi aktif mengembalikan `403 NO_ACTIVE_ORGANIZATION`.
- Setiap fungsi repository menerima `orgId` sebagai argumen **pertama** dan memasukkannya ke setiap `where`, `insert`, dan `update`. Fungsi repository tanpanya tidak bisa dikompilasi (helper bertipe `scoped(orgId)`).
- `scoped(orgId)` adalah **satu-satunya** jalan kode modul ke tabel modul: tidak ada import `db` langsung di `modules/*` (aturan lint). Multi-tenancy menambahkan row-level security database di dalam helper ini saja, tanpa menyentuh repository ([saas/architecture.md §4](../../saas/architecture.md), DEC-051). Tahap 2 tanpa RLS: dengan satu organisasi, RLS tidak melindungi apa pun.
- Record dari organisasi lain adalah **tidak ditemukan** (`404`), tidak pernah `403`: respons tidak boleh mengonfirmasi bahwa record itu ada.
- Key cache diawali organisasi: `org:{orgId}:posts:list:...`. Invalidasi cache per organisasi.
- Konteks log menambah `organizationId` ke setiap baris di dalam route yang di-scope organisasi ([observability/README.md](../../observability/README.md)). Tidak pernah nama organisasi.
- Hanya fungsi bernama `*AcrossTenants` yang boleh melewati filter, dan hanya modul `platform` yang boleh memanggilnya ([saas/platform-console.md §6](../../saas/platform-console.md)).
- **Tabel platform tidak di-scope.** `user`, `session`, `account`, `verification`, dan `feature_flag` milik seluruh aplikasi dan tidak punya `organization_id` (DEC-048).

## 6. Cek permission

- `{ permission: 'posts:write' }` memanggil `hasPermission` organization plugin dengan header session, untuk organisasi aktif (*verify* `auth.api.hasPermission({ headers, body: { permissions } })`). Tanpa organisasi aktif → `403 NO_ACTIVE_ORGANIZATION`.
- Satu permission per panggilan, seperti di tahap 1: dengan beberapa role, cek lolos hanya bila **satu** role memberi semuanya.
- `{ platformPermission: 'user:ban' }` adalah opsi macro terpisah untuk route platform (§8). Kedua opsi tidak bisa dicampur di satu route.
- Lookup role runtime di-cache di Redis per organisasi (`org:{orgId}:roles`, TTL 5 menit) dan dihapus setelah setiap perubahan role (§7). *Verify* apakah plugin sudah melakukan cache; bila ia membaca database di setiap cek, cache kita membungkusnya.
- `GET /api/me/permissions` mengembalikan:

```ts
{
  organization: { id, slug, name } | null,
  roles: string[],                  // member.role di organisasi aktif
  permissions: Permission[],        // permission organisasi
  platformRoles: string[],          // user.role
  platformPermissions: PlatformPermission[],
}
```

`can()` di web app membaca `permissions`; `canPlatform()` membaca `platformPermissions`.

## 7. Role runtime (dynamic access control)

| Aksi | Endpoint (*verify*) | Butuh |
|:---|:---|:---|
| Daftar role | `GET /api/auth/organization/list-roles` | `ac:read` |
| Buat role | `POST /api/auth/organization/create-role` | `ac:create` |
| Ubah role | `POST /api/auth/organization/update-role` | `ac:update` |
| Hapus role | `POST /api/auth/organization/delete-role` | `ac:delete` |
| Tetapkan role | `POST /api/auth/organization/update-member-role` | `member:update` |

Aturan (perilaku plugin bertanda *verify*; bila plugin tidak menegakkannya, `hooks.before` kita yang menegakkan):

| Aturan | Error |
|:---|:---|
| Nama role `snake_case`, 2–40 karakter, dan bukan nama role kode atau role platform | `400 INVALID_ROLE_NAME` |
| Setiap permission di role ada di `orgAc` (plugin) | `400` (kode plugin) |
| Kamu tidak bisa memberi permission yang tidak kamu pegang sendiri (*verify*) | `403 CANNOT_GRANT_UNHELD_PERMISSION` |
| Role yang masih dipakai member tidak bisa dihapus (plugin) | `400` (kode plugin) |
| Role kode (`owner`, `admin`, `member`, role kode kustom) tidak bisa diubah atau dihapus | `400 SYSTEM_ROLE` |
| Tidak ada yang mengubah role member-nya sendiri | `400 CANNOT_CHANGE_OWN_ROLE` |
| Hanya `owner` yang menetapkan atau mencabut `owner`; owner terakhir tetap memegangnya (plugin) | `403` / kode plugin |
| Role runtime melebihi `maximumRolesPerOrganization` | kode plugin |

Bila statement di kode kehilangan sebuah action, role runtime yang masih mencantumkannya tetap berfungsi untuk sisanya dan API memancarkan `access.stale_permission` (warn) saat startup beserta ID role-nya.

## 8. Lapisan platform

Bagian admin plugin yang tetap dipakai mulai tahap 2. Lapisan ini menjawab "siapa yang menjalankan aplikasinya" dan **tidak** memberi permission modul (DEC-043). Lapisan SaaS multi-tenant menambah konsol platform di atasnya ([saas/platform-console.md](../../saas/platform-console.md)).

### 8.1 Role platform

Didefinisikan di kode dengan admin plugin, persis seperti role tahap 1 ([static-roles.md §2](static-roles.md)):

| Role | Tujuan |
|:---|:---|
| `super_admin` | Semua yang ada di statement platform |
| `user` | Default. Tanpa permission platform |
| Kustom, mis. `platform_support` | Opsional, di kode: akses hanya-baca untuk staf support |

`user.role` tidak pernah memegang role organisasi. Cek startup memancarkan `access.unknown_platform_role` (warn) untuk nilai lain.

### 8.2 Statement platform

`apps/api/src/modules/platform/permissions.ts`:

```ts
// sketsa
export const platformPermissions = definePlatformPermissions({
  statement: {
    user:         ['list', 'get', 'ban', 'set-role', 'set-password', 'delete'],   // built-in admin plugin yang kita pakai
    session:      ['list', 'revoke'],
    feature_flag: ['read', 'write'],      // bila flag diadopsi (DEC-048)
    // multi-tenant (SaaS) menambah platform_org dan platform_audit (saas/platform-console.md §3)
  },
  grants: {
    platform_support: { user: ['list', 'get'], session: ['list'], feature_flag: ['read'] },
  },
})
```

- Action impersonate tidak dicantumkan (DEC-032).
- Route memakai `{ platformPermission: 'user:ban' }`, dicek dengan `userHasPermission` milik admin plugin.

### 8.3 Endpoint

User dan session tetap memakai endpoint admin plugin dan aturan guard dari [static-roles.md §7](static-roles.md): `list-users`, `get-user`, `ban-user`, `unban-user`, `set-role`, `set-user-password`, `remove-user`, `list-user-sessions`, `revoke-user-session`, `revoke-user-sessions`. `set-role` hanya menerima role platform.

| Method | Path | Butuh | Hasil |
|:---|:---|:---|:---|
| GET | `/api/platform/users/:id/memberships` | `user:get` | `{ organizationId, roles, createdAt }[]` (satu baris di tahap 2) |

Route pengelolaan feature flag pindah ke `platformPermission` ([feature-flags/access-stages.md §3](../../feature-flags/access-stages.md)).

### 8.4 Aturan

1. **Role platform tidak memberi permission organisasi**, dan role organisasi tidak memberi permission platform.
2. **Penulisan butuh session yang fresh** (`freshAge`, 1 jam, [auth/README.md §2](../README.md)): bila tidak, `403 SESSION_NOT_FRESH`, dan web app meminta user sign in ulang.
3. **Tanpa impersonation** dan tanpa "login sebagai user" (DEC-032).
4. **Tidak menargetkan diri sendiri:** kamu tidak bisa mem-ban dirimu atau mengubah role platform-mu sendiri.
5. **Selalu ada minimal satu `super_admin`.**
6. Setiap penulisan platform memancarkan event audit-nya (§13).

### 8.5 Web

Fitur `platform`, di bawah layout `/platform` terpisah dengan banner "Platform" yang terlihat. Link ke sana hanya muncul bila `canPlatform()` bernilai true; kunjungan langsung tanpa permission di-redirect ke halaman utama.

| Halaman | Butuh |
|:---|:---|
| `/platform/users`, `/platform/users/:id` (profil, session, ban, role platform) | `user:list` / `user:get`, `user:ban`, `user:set-role`, `session:*` |
| `/platform/feature-flags` (bila flag diadopsi) | `feature_flag:read` / `feature_flag:write` |

Halaman ini menggantikan halaman user di fitur `admin` tahap 1 (F-03). Lapisan SaaS multi-tenant menambah halaman organisasi dan audit ([saas/platform-console.md §7](../../saas/platform-console.md)).

## 9. Allowlist endpoint

Aturan dari [static-roles.md §7](static-roles.md) berlaku juga untuk organization plugin: sebuah path hanya bisa dicapai bila [API.md](../../API.md) mencantumkannya. Path `/organization/*` lain mengembalikan `404 NOT_FOUND` dan memancarkan `audit.auth.blocked_endpoint`. Tahap 2 mengizinkan §10.3; lapisan SaaS multi-tenant mengizinkan [saas/multi-tenant.md §11](../../saas/multi-tenant.md).

## 10. Khusus tahap 2: satu organisasi tersembunyi

Satu organisasi, dibuat oleh seed, tidak pernah ditampilkan ke user. Setiap user adalah member-nya. Lapisan SaaS multi-tenant **menggantikan seluruh bagian ini** dengan [saas/multi-tenant.md](../../saas/multi-tenant.md).

### 10.1 Konfigurasi

| Urusan | Caranya |
|:---|:---|
| Organisasinya | Seed atau migrasi membuatnya dengan `auth.api.createOrganization({ body: { name, slug: 'app', userId: superAdminId } })`; `super_admin` pertama menjadi `owner`-nya. *Verify* bahwa ini berjalan dengan `allowUserToCreateOrganization: false` |
| Menemukannya | Env `PRIMARY_ORG_SLUG` (default `app`). Startup mencarinya dan meng-cache ID-nya; startup **gagal** bila tidak ada |
| User baru bergabung | `databaseHooks.user.create.after` → `auth.api.addMember({ body: { userId, organizationId, role: 'member' } })` |
| Organisasi aktif selalu terisi | `databaseHooks.session.create.before` mengembalikan session dengan `activeOrganizationId` = organisasi utama |
| Tidak ada organisasi lain | `allowUserToCreateOrganization: false`; path create, delete, set-active, leave, dan undangan tidak ada di allowlist |
| Mengeluarkan seseorang | Tidak lewat organisasi: ban platform (§8) |

Saat startup API menghitung user tanpa baris `member` di organisasi utama dan memancarkan `access.member_missing` (warn). Mereka bisa sign in tetapi tidak punya permission modul sampai diperbaiki dengan `bun run access:repair` (menambah baris yang hilang sebagai `member`).

### 10.2 Siapa melakukan apa

| Orang | Role platform | Role organisasi |
|:---|:---|:---|
| Kamu, yang menjalankan aplikasi | `super_admin` | `owner` |
| Staf yang mengelola konten dan member | `user` | `admin` atau role runtime |
| Semua yang lain | `user` | `member` |

### 10.3 Endpoint organisasi yang diizinkan

`get-active-member`, `list-members`, `update-member-role`, `has-permission`, `list-roles`, `get-role`, `create-role`, `update-role`, `delete-role` (semua di bawah `/api/auth/organization/`; *verify* path pastinya di ORG-01 dan catat di [API.md](../../API.md)).

### 10.4 Web

| Fitur | Halaman | Butuh |
|:---|:---|:---|
| `settings` | `/settings/members`: daftar member, ubah role member | `member:read` / `member:update` |
| `settings` | `/settings/roles`: daftar, buat, ubah, hapus role runtime; role kode ditampilkan hanya-baca | `ac:read` / `ac:create`, `ac:update`, `ac:delete` |
| `platform` | §8.5 | permission platform |

Editor role menampilkan statement yang dikelompokkan per modul, dan hanya permission yang dipegang user saat ini yang bisa dipilih.

### 10.5 Sign-up dan sign-in

Tidak berubah dari [auth/README.md §4](../README.md), ditambah: user baru dimasukkan ke organisasi utama sebagai `member` sebelum session pertamanya dibuat, sehingga request pertamanya sudah punya permission. User yang baris `member`-nya hilang mendapat `403 NO_ACTIVE_ORGANIZATION` di route modul, bukan crash.

## 11. Feature flag

Flag tetap global: satu tabel `feature_flag` untuk seluruh aplikasi, dikelola lewat lapisan platform. Di tahap 2 targeting tidak berubah (hanya user). Detail per tahap: [feature-flags/access-stages.md](../../feature-flags/access-stages.md) (DEC-048).

## 12. Di luar cakupan tahap 2

- Lebih dari satu organisasi, undangan, pindah organisasi: SaaS multi-tenant ([saas/multi-tenant.md](../../saas/multi-tenant.md)).
- Direktori organisasi, suspend, audit lintas tenant: konsol platform SaaS, hanya multi-tenant ([saas/platform-console.md](../../saas/platform-console.md)).
- Plan dan billing ([saas/](../../saas/README.md)).

## 13. Event audit

Dipancarkan dengan `module: "auth"` (organisasi) atau `module: "platform"` (lapisan platform). Hanya ID, tidak pernah nama atau email.

| Event | Payload |
|:---|:---|
| `audit.org.member_added` | `organizationId, userId, role, actorId?` |
| `audit.org.member_role_changed` | `organizationId, userId, from, to, actorId` |
| `audit.org.member_removed` | `organizationId, userId, actorId` |
| `audit.org.role_created` / `role_updated` / `role_deleted` | `organizationId, roleId, roleName, permissionCount, actorId` |
| `audit.user.banned`, `audit.user.role_changed`, `audit.session.revoked` | Seperti di [auth/README.md §6](../README.md) |

Multi-tenant dan konsol platform menambah event-nya sendiri ([multi-tenant.md §12](../../saas/multi-tenant.md), [saas/platform-console.md §8](../../saas/platform-console.md)).

## 14. Test

Di `apps/api/tests/utils/auth/`, `apps/api/tests/modules/platform/`, dan `apps/api/tests/modules/<module>/`:

- **Matriks organisasi:** setiap role kode organisasi × setiap route terproteksi → status yang diharapkan. Role runtime dengan satu permission → hanya route itu yang lolos.
- **Matriks platform:** `super_admin`, `platform_support`, `user` × setiap route platform.
- **Test lapisan:** `super_admin` yang bukan member mendapat 403 di route modul; `owner` dengan role platform `user` mendapat 403 di route platform.
- **Role runtime:** setiap aturan di §7, termasuk memberi permission yang tidak dipegang dan menghapus role yang masih dipakai. Perubahan role berlaku di request berikutnya (cache dihapus).
- **Scoping:** dengan dua organisasi di database test (bahkan di tahap 2), member A mendapat 404 untuk record B dan tidak pernah melihatnya di daftar ([multi-tenant.md §13](../../saas/multi-tenant.md) adalah suite lengkapnya).
- **Hook tahap 2:** user baru mendapat baris `member` dan session pertamanya punya `activeOrganizationId`; startup gagal tanpa organisasi utama.
- **Aturan platform:** session basi → `403 SESSION_NOT_FRESH` saat menulis; ban diri sendiri dan mengubah role sendiri ditolak; `super_admin` terakhir dipertahankan.
- **Allowlist:** setiap path organisasi yang tidak ada di §10.3 → 404.

## 15. Task bila diadopsi

Menggantikan TASK-04, TASK-05, TASK-06, dan TASK-17 di [TASKS.md](../../TASKS.md) seperti dijelaskan di [migration.md §2](migration.md).

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| ORG-01 | Konfigurasi organization plugin (§2), skema (§3), kedua access control (§4); catat path endpoint dan kode error sebenarnya | TASK-03, TASK-07, TASK-12 |
| ORG-02 | `organization_id` di tabel modul, helper repository `scoped(orgId)`, key cache berprefix organisasi, `organizationId` di konteks log (§5) | ORG-01 |
| ORG-03 | Macro `permission` dan `platformPermission`, `GET /api/me/permissions` (§6) | ORG-01 |
| ORG-04 | Aturan role runtime, cache role di Redis, event audit (§7, §13) | ORG-03 |
| ORG-05 | Seed tahap 2, hook, cek startup, `access:repair`, allowlist (§10.1–10.3) | ORG-03 |
| ORG-06 | Fitur web `settings`: halaman member dan role (§10.4) | ORG-04, TASK-09 |
| ORG-07 | Modul `platform`: statement platform, aturan guard user/session untuk role platform, endpoint keanggotaan (§8.1–8.4) | ORG-03 |
| ORG-08 | Fitur web `platform`: halaman user (§8.5) | ORG-07, TASK-09 |

## 16. Verify sebelum membangun

- Perilaku `hasPermission` bila `activeOrganizationId` null.
- Apakah role runtime di-cache atau dibaca di setiap cek.
- Apakah `create-role` / `update-role` menolak permission yang tidak dipegang pemanggil.
- Path endpoint pasti, opsi `dynamicAccessControl`, dan nama tabel `organization_role`.
- `createOrganization` di sisi server dengan `allowUserToCreateOrganization: false`.
- Apakah `databaseHooks.session.create.before` boleh mengisi `activeOrganizationId`.
