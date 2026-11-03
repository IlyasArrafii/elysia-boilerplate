# FEATURES.md

Fitur yang dihadapi pengguna, dengan user story, kriteria penerimaan, dan edge case. Detail HTTP di [API.md](API.md); role dan permission di [auth/access/static-roles.md](auth/access/static-roles.md); test di [TESTING.md](TESTING.md).

## 1. Daftar fitur

| ID | Fitur | Modul API | Fitur web | Prioritas |
|:---|:---|:---|:---|:---|
| F-01 | Sign-up dan sign-in email/password | Better Auth (`auth`) | `auth` | P0 |
| F-02 | Sign-in Google | Better Auth (`auth`) | `auth` | P0 |
| F-03 | Manajemen user dan role | admin plugin + `admin` | `admin` | P0 |
| F-04 | Contoh modul: posts (RBAC + cache) | `posts` | `posts` | P0 |
| F-05 | Sesi di aplikasi web, profil | Better Auth, `me` | `auth`, `profile` | P0 |
| F-06 | Observability | `utils/logger`, `utils/telemetry` | — | P0 |
| F-07 | Struktur test | semua | semua | P0 |

## 2. F-01: Email/password

**Story**
- Sebagai tamu, saya ingin mendaftar dengan email dan password agar bisa memakai halaman yang butuh login.
- Sebagai user, saya ingin tetap login walau halaman di-refresh.
- Sebagai user, saya ingin sign out agar sesi saya berakhir.

**Kriteria penerimaan**
- Dengan input valid, `POST /api/auth/sign-up/email` membuat user dengan role `user` dan password ter-hash.
- Dengan kredensial benar, `POST /api/auth/sign-in/email` memasang cookie sesi.
- Setelah `POST /api/auth/sign-out`, route terlindungi mengembalikan 401.
- Email duplikat ditolak dengan error Better Auth (dicatat di [auth/README.md §5](auth/README.md)).
- Percobaan sign-in keenam dari satu IP dalam 60 detik mengembalikan 429.

**Edge case**
- Password kurang dari 8 karakter → error validasi, tidak ada yang dibuat.
- Email tidak dikenal atau password salah → error generik yang sama (tanpa enumerasi akun).
- Sesi kedaluwarsa → 401; aplikasi web mengarahkan ke `/login`.
- User yang di-ban mencoba sign-in → error banned dari Better Auth.

## 3. F-02: Google

**Story**
- Sebagai tamu, saya ingin sign-in dengan Google agar tidak perlu password.
- Sebagai user Google baru, saya ingin akun dibuat otomatis.

**Kriteria penerimaan**
- `POST /api/auth/sign-in/social` dengan `provider: "google"` mengembalikan URL redirect Google (termasuk PKCE dan state).
- `GET /api/auth/callback/google` membuat atau menautkan user lalu memasang cookie sesi.
- User Google baru mendapat role `user`.
- Sign-in Google yang email terverifikasinya sama dengan akun password yang ada akan ditautkan ke akun itu (satu user, dua baris `account`) dan memancarkan `audit.account.linked`.

**Edge case**
- State atau PKCE tidak cocok → error ditampilkan di `/login`.
- User membatalkan di Google → kembali ke `/login` dengan pesan, tidak ada akun dibuat.

## 4. F-03: Manajemen user dan role

**Story**
- Sebagai Super Admin, saya ingin mengubah role user, mem-ban user, dan mencabut sesinya.
- Sebagai Admin, saya ingin melihat daftar user dan sesinya.
- Sebagai Admin atau Super Admin, saya ingin melihat kemampuan setiap role.

**Kriteria penerimaan**
- `super_admin` mengubah role dengan `authClient.admin.setRole`; request berikutnya memakai permission baru; `audit.user.role_changed` dipancarkan.
- `admin` dan `user` mendapat 403 pada set-role, ban, remove, dan revoke (DEC-033).
- `admin` bisa melihat daftar user, detail user, dan daftar sesi user.
- Tidak ada yang bisa mengubah role-nya sendiri: `400 CANNOT_CHANGE_OWN_ROLE`. Role yang tidak ada di registry: `400 INVALID_ROLE`.
- Ban langsung mencabut semua sesi user dan memancarkan `audit.user.banned`.
- `GET /api/admin/roles` (`role:read`) mengembalikan setiap role registry beserta permission hasil kompilasinya.
- Endpoint impersonation admin plugin mengembalikan 404 untuk setiap role (DEC-032).

**Edge case**
- User target tidak ada → error not-found dari Better Auth.
- Mem-ban atau menghapus diri sendiri → `400 CANNOT_TARGET_SELF`.
- User yang memegang role yang sudah dihapus dari kode → tanpa permission, peringatan `rbac.unknown_role` saat startup.

## 5. F-04: Posts

**Story**
- Sebagai user, saya ingin melihat dan membaca post, membuat post, serta mengubah atau menghapus post milik saya.
- Sebagai admin, saya ingin mengubah atau menghapus post siapa pun.

**Kriteria penerimaan**
- `GET /api/posts` (`posts:read`) mengembalikan daftar berhalaman, di-cache dengan key `posts:list:{page}:{limit}`.
- `POST /api/posts` (`posts:write`) memvalidasi `title` ≥ 3 dan `content` ≥ 10 karakter, membuat post dengan pemanggil sebagai penulis, mengembalikan 201, menghapus `posts:list:*`.
- `GET /api/posts/:id` mengembalikan post atau `404 POST_NOT_FOUND`.
- PATCH dan DELETE: penulis berhasil; `user` lain → 403; `admin` (`posts:manage_all`) berhasil.
- Cache hit mengembalikan payload yang persis sama dengan miss; p95 saat hit < 50 ms.
- Setiap error di route ini di-log dengan `module: "posts"`.

**Edge case**
- Redis tidak tersedia di dev → fallback memori, satu peringatan `cache.fallback`, request tetap berhasil.
- Payload melebihi panjang maksimum → `400 VALIDATION_ERROR` hanya dengan path field.
- `limit` > 100 → 400.

## 6. F-05: Sesi di aplikasi web dan profil

**Kriteria penerimaan**
- `useSession()` menyediakan sesi di seluruh aplikasi.
- `/login`, `/register`, dan path kembali dari OAuth berfungsi; sukses mengarahkan ke `/`.
- Form login dan register memakai TanStack Form dan memvalidasi format email serta panjang password sebelum submit.
- Sign-out memanggil sign-out Better Auth dan membersihkan cache TanStack Query.
- Halaman terlindungi tanpa sesi diarahkan ke `/login` di `beforeLoad`; halaman yang butuh permission yang tidak dimiliki diarahkan ke `/` dengan pesan.
- Halaman profil mengubah `name` dan `image` lewat `updateUser`.

**Edge case**
- OAuth gagal → alert error di `/login`.
- Submit ganda → satu request.

## 7. F-06: Observability

**Kriteria penerimaan**
- Setiap request menghasilkan satu event `http.request` dengan `requestId` dan `module`, ditulis ke stdout dan (bila `LOG_MONGO_URL` diisi) ke MongoDB.
- Setiap error menghasilkan satu event `http.error` yang diidentifikasi dengan `module` dan `code`, dengan stack hanya di log.
- Audit event dipancarkan untuk sign-in, sign-out, perubahan role, ban, dan penautan Google.
- Tidak ada rahasia atau data pribadi di baris log maupun dokumen yang tersimpan.
- `bun run logs:prune --dry-run` melaporkan apa yang akan dihapus per kind; tanpa `--dry-run`, event yang lebih tua dari retensinya dihapus.
- Detail: [observability/README.md §10](observability/README.md), [redaction.md §7](observability/redaction.md), [log-storage.md §8](observability/log-storage.md).

## 8. F-07: Struktur test

**Kriteria penerimaan**
- Setiap modul API punya `apps/api/tests/modules/<module>/` dan, bila punya route, `apps/api/tests/e2e/<module>/`.
- Setiap fitur web punya `apps/web/tests/features/<feature>/` dan, bila punya halaman, `apps/web/e2e/<feature>/`.
- Test wajib per level ada di [TESTING.md](TESTING.md).

## 9. Di luar cakupan

Lihat [PRD.md §5](PRD.md).
