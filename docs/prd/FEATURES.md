# FEATURES.md: BunForge

## 1. Prinsip Spesifikasi Fitur

Setiap fitur dalam BunForge didefinisikan sebagai **modul Elysia plugin mandiri** (DEC-003) dengan prefix route sendiri, dideklarasikan permission-nya melalui model access control Better Auth admin plugin (DEC-005), dan di-compose pada `apps/api/src/index.ts`. Batasan antar modul mengikuti pola adaptasi basic ElysiaJS (DEC-002): modul hanya berkomunikasi via export service/helper, tanpa berbagi state global.

Struktur kanonik setiap modul:

```
apps/api/src/modules/<module>/
├── index.ts        # Elysia plugin export (prefix + compose)
├── service.ts      # business logic + akses Drizzle
├── routes.ts       # definisi route + guard permission
├── schema.ts       # validasi input (TypeBox/Elysia t)
└── permissions.ts  # deklarasi permission modul (DEC-005)
```

Setiap modul wajib mendeklarasikan permission dengan format `<resource>:<action>` (contoh: `posts:read`, `posts:write`). Middleware Elysia memeriksa permission sebelum handler dijalankan, dengan prinsip **default deny** (PRD §5).

## 2. Matriks Fitur Inti

| ID | Fitur | Modul | DEC | Prioritas |
|:---|:---|:---|:---|:---|
| F-01 | Autentikasi Email/Password | `auth` | DEC-004 | P0 |
| F-02 | OAuth Google | `auth` | DEC-004 | P0 |
| F-03 | Manajemen Role & Permission | `admin` | DEC-005 | P0 |
| F-04 | Modul Contoh Posts (RBAC + Cache) | `posts` | DEC-001/003/005 | P0 |
| F-05 | Sesi Terautentikasi Frontend | `web` | DEC-004 | P0 |

## 3. F-01 — Autentikasi Email/Password

**Deskripsi:** Pengguna dapat mendaftar dan login menggunakan email + password melalui Better Auth server-side di `apps/api` (DEC-004). Session disimpan sebagai cookie HTTP-only yang dikelola Better Auth.

**User Stories:**
- Sebagai Guest, saya ingin mendaftar dengan email/password agar dapat mengakses endpoint terautentikasi.
- Sebagai User, saya ingin login dan tetap login antar refresh agar tidak perlu login ulang.
- Sebagai User, saya ingin logout agar sesi berakhir.

**Acceptance Criteria:**
- `POST /api/auth/sign-up/email` membuat user baru dengan role default `user`; password di-hash oleh Better Auth.
- `POST /api/auth/sign-in/email` mengembalikan session cookie valid; respons `200` dengan body `{ user, session }`.
- `POST /api/auth/sign-out` menghapus session; request berikutnya ke endpoint terproteksi mengembalikan `401`.
- Email duplikat mengembalikan `409` dengan `code: "EMAIL_TAKEN"`.

**Edge Cases:**
- Password kurang dari panjang minimum → `400` validasi.
- Login dengan email tidak terdaftar → `401` generik (tanpa membocorkan keberadaan email).
- Session kedaluwarsa → `401` dengan `code: "SESSION_EXPIRED"`.

## 4. F-02 — OAuth Google

**Deskripsi:** Login via Google OAuth menggunakan Better Auth social provider dengan PKCE (PRD §5).

**User Stories:**
- Sebagai Guest, saya ingin login dengan akun Google agar tidak perlu membuat password.
- Sebagai User Google, saya ingin akun otomatis dibuat jika belum terdaftar.

**Acceptance Criteria:**
- `GET /api/auth/sign-in/social?provider=google` mengembalikan redirect URL OAuth.
- Callback `GET /api/auth/callback/google` membuat/menautkan user lalu menerbitkan session cookie.
- User baru via Google mendapat role default `user`.

**Edge Cases:**
- State/PKCE mismatch → `400` dan redirect ke halaman login dengan pesan error.
- Email Google sudah terdaftar via password → akun ditautkan (linked), bukan duplikat.

## 5. F-03 — Manajemen Role & Permission

**Deskripsi:** Modul `admin` menyediakan endpoint untuk assign/unassign role dan melihat daftar permission, memakai Better Auth admin plugin sebagai sumber kebenaran (DEC-005, FR-10).

**User Stories:**
- Sebagai Super Admin, saya ingin mengubah role user agar hak akses sesuai tanggung jawab.
- Sebagai Super Admin, saya ingin melihat daftar permission per role agar dapat mengaudit akses.

**Acceptance Criteria:**
- Endpoint `PATCH /api/admin/users/:id/role` (permission `users:manage_role`) mengubah role user; hanya Super Admin yang memiliki izin ini.
- Endpoint `GET /api/admin/roles` (permission `roles:read`) mengembalikan daftar role beserta permission-nya.
- Percobaan assign role oleh non-Super-Admin → `403` dengan `code: "FORBIDDEN"`.
- Super Admin tidak dapat menurunkan role dirinya sendiri (guard khusus) → `400`.

**Edge Cases:**
- Role tidak dikenal → `400` `code: "INVALID_ROLE"`.
- User target tidak ada → `404`.

## 6. F-04 — Modul Contoh Posts (RBAC + Cache)

**Deskripsi:** Modul `posts` mendemonstrasikan pola end-to-end (FR-11): endpoint terproteksi permission, validasi input, caching Redis (DEC-001), dan akses Drizzle. Pola ini menjadi template untuk modul baru.

**User Stories:**
- Sebagai User, saya ingin melihat daftar post agar dapat membaca konten.
- Sebagai Admin, saya ingin membuat post agar konten tersedia untuk publik.
- Sebagai User, saya ingin mengubah/menghapus post milik sendiri.

**Acceptance Criteria:**
- `GET /api/posts` (permission `posts:read`) mengembalikan daftar post; hasil di-cache Redis dengan key `posts:list:<page>` dan TTL `POSTS_CACHE_TTL` (default `TBD`).
- `POST /api/posts` (permission `posts:write`) membuat post; body divalidasi `{ title: string(min 3), content: string(min 10) }`; cache `posts:list:*` di-invalidate setelah sukses.
- `GET /api/posts/:id` mengembalikan detail; `404` jika tidak ada.
- Cache-hit mengembalikan respons identik dengan cache-miss (konsistensi payload).

**Edge Cases:**
- Redis tidak tersedia di dev → fallback in-memory (PRD §8); log warning, request tetap sukses.
- Update/delete post milik user lain tanpa permission `posts:manage_all` → `403`.
- Payload melebihi batas → `400` validasi.

## 7. F-05 — Sesi Terautentikasi di Frontend

**Deskripsi:** Frontend TanStack Start terintegrasi Better Auth client-side (FR-06): session provider, halaman login/register, callback OAuth, logout, serta TanStack Form untuk validasi runtime (FR-07).

**User Stories:**
- Sebagai User, saya ingin melihat status login di seluruh halaman.
- Sebagai User, saya ingin form login/register dengan validasi instan.

**Acceptance Criteria:**
- Session context tersedia global; komponen membaca `useSession()` dari Better Auth client.
- Halaman `/login`, `/register`, `/auth/callback` berfungsi; redirect ke `/` setelah sukses.
- Form login/register memakai TanStack Form dengan validasi email format & password minimum sebelum submit.
- Logout dari UI memanggil endpoint sign-out dan membersihkan state client.

**Edge Cases:**
- Akses route terproteksi tanpa session → redirect ke `/login`.
- Callback OAuth gagal → tampilkan error toast, kembali ke `/login`.

## 8. Matriks Permission Modul

| Permission | Super Admin | Admin | User | Guest |
|:---|:---|:---|:---|:---|
| `posts:read` | ✅ | ✅ | ✅ | ❌ |
| `posts:write` | ✅ | ✅ | ✅ | ❌ |
| `posts:manage_all` | ✅ | ✅ | ❌ | ❌ |
| `users:read` | ✅ | ✅ | ❌ | ❌ |
| `users:manage_role` | ✅ | ❌ | ❌ | ❌ |
| `roles:read` | ✅ | ✅ | ❌ | ❌ |
| `health:read` | ✅ | ✅ | ✅ | ✅ |

Permission dideklarasikan per modul pada `permissions.ts` dan diregistrasi ke Better Auth access control (DEC-005).

## 9. Out of Scope Fitur

Mengikuti PRD §10: multi-tenancy, billing, microservices, database selain PostgreSQL, dan template email lengkap tidak termasuk fitur BunForge. Detail endpoint, skema DB, dan ERD dirujuk ke **API_SPEC.md** dan **DATABASE.md**.