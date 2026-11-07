# Autentikasi

Konfigurasi Better Auth, mengikuti skill `better-auth-best-practices` dan `better-auth-security-best-practices` (DEC-007, DEC-019, DEC-020, DEC-032). Role dan permission bergantung pada access stage proyek ([access/README.md](access/README.md)); default-nya tahap 1, [static-roles.md](access/static-roles.md). Berkas ini menjelaskan default; tahap 2 dan 3 menambah organization plugin ([access/single-org.md](access/single-org.md)).

Opsi bertanda *verify* wajib dicek ke dokumentasi versi Better Auth yang terpasang (lihat versinya di lockfile, lalu baca dokumentasi versi yang sama).

## 1. Lokasi kode

| Berkas | Isi |
|:---|:---|
| `packages/auth/src/server.ts` | `createAuth({ db, redis, ac, roles, hooks, databaseHooks, logger })` mengembalikan `betterAuth({...})`. Satu-satunya tempat opsi Better Auth ditulis. |
| `packages/auth/src/client.ts` | `createAuthClient` dengan `adminClient()`. Tanpa `ac`/`roles` di client (DEC-023). |
| `apps/api/src/utils/auth/auth.ts` | `export const auth = createAuth({...})`. Berkas yang dibaca CLI Better Auth (`--config`). |
| `apps/api/src/utils/auth/roles.ts` | Role registry ([static-roles.md §2](access/static-roles.md)). |
| `apps/api/src/utils/auth/access.ts` | Menyusun `ac` dan `roles` dari berkas `permissions.ts` setiap modul ([static-roles.md §4](access/static-roles.md)). |
| `apps/api/src/utils/auth/hooks.ts` | Aturan guard `hooks.before` ([static-roles.md §7](access/static-roles.md)). |
| `apps/api/src/utils/auth/audit.ts` | `databaseHooks` dan `hooks.after` yang memancarkan event `audit.*` (§6). |
| `apps/api/src/utils/auth/index.ts` | Plugin bernama `auth`: memasang handler (log context `module: "auth"`) dan mendefinisikan macro `auth` serta `permission`. |

Impor plugin dari path masing-masing (`better-auth/plugins/admin`, `better-auth/plugins/access`) agar plugin yang tidak dipakai tidak ikut di-bundle.

## 2. Baseline konfigurasi

| Area | Nilai | Alasan |
|:---|:---|:---|
| `secret` | Hanya dari `BETTER_AUTH_SECRET`, ≥ 32 karakter, entropi tinggi, tidak pernah di-commit | Better Auth menolak secret placeholder di produksi |
| `baseURL` | Dari `BETTER_AUTH_URL` = origin web publik, HTTPS di produksi | Satu origin (DEC-020) |
| `basePath` | `/api/auth` (default) | Sesuai prefix `/api` (DEC-006) |
| `trustedOrigins` | `[WEB_URL]`, tanpa wildcard | `callbackURL` dan redirect di luarnya mendapat 403 |
| CSRF | `advanced.disableCSRFCheck: false` (default); `disableOriginCheck` tidak pernah diisi | Pertahankan kedua pengecekan |
| Cookie | Default: `httpOnly`, `secure` di HTTPS, `sameSite: "lax"`; `advanced.cookiePrefix: "app"` (netral; default `better-auth` menyebut nama library-nya, DEC-040); `crossSubDomainCookies` **mati** | Satu origin, tidak berbagi cookie |
| IP klien | `advanced.ipAddress.ipAddressHeaders: ["x-forwarded-for"]`, `ipv6Subnet: 64` | API selalu di balik proxy; rate limit butuh IP asli |
| Email/password | `emailAndPassword.enabled: true`, panjang minimum default (8) | |
| Verifikasi email | `sendVerificationEmail` memancarkan `auth.verification_link` hanya di dev; pengirim email asli wajib menggantikannya sebelum `requireEmailVerification` dinyalakan (`TBD`) | Tidak ada pengirim email di MVP |
| Reset password | `sendResetPassword` memancarkan `auth.reset_link` hanya di dev | |
| Google | `socialProviders.google` dari env; PKCE dan state otomatis; `account.storeStateStrategy: "cookie"` (default) | |
| Penautan akun | `account.accountLinking.enabled: true`, `trustedProviders: ["google"]` | Email Google terverifikasi ditautkan ke akun password yang ada |
| Token OAuth | `account.encryptOAuthTokens: true` | AES-256-GCM saat disimpan |
| Sesi | `expiresIn` 7 hari, `updateAge` 1 hari, `freshAge` 1 jam | Aksi sensitif butuh sesi yang masih segar |
| Cookie cache | **mati** | Lookup Redis sudah cepat; cookie cache menunda pencabutan sesi dan ban |
| Secondary storage | Redis (DEC-019) dengan `session.storeSessionInDatabase: true` | Admin bisa melihat dan mencabut sesi |
| Rate limit | `enabled: true`, `storage: "secondary-storage"`; `customRules`: sign-in email 5 / 60 dtk, sign-up email 3 / 60 dtk | *verify* apakah key aturan `/sign-in/email` atau `/api/auth/sign-in/email` |
| Logger | `logger` Better Auth diarahkan lewat scrubber telemetry ke pino dengan `module: "auth"` | Baris log-nya tidak boleh melewati redaksi |
| Admin plugin | `admin({ ac, roles, defaultRole: "user" })`; `adminUserIds` **tidak pernah** diisi | ID di `adminUserIds` melewati pengecekan role (DEC-032). *Verify* bahwa `adminRoles` tidak memberi apa pun di luar `roles` kita; bila memberi, isi `adminRoles: ["super_admin"]` |
| Background task | Tidak perlu (server Bun berjalan terus) | Hanya untuk platform serverless |

Variabel lingkungan: [ARCHITECTURE.md §7](../ARCHITECTURE.md).

## 3. Pemasangan di Elysia

- Pasang handler di dalam plugin bernama `auth`. Root app punya prefix `/api` dan `basePath` Better Auth adalah `/api/auth`, jadi path akhirnya harus `/api/auth/*`, tidak pernah `/api/api/auth/*`. *Verify* pola pemasangan terhadap dokumentasi integrasi Elysia dari Better Auth.
- Macro `auth: true` memuat `{ user, session }` dengan `auth.api.getSession({ headers })`, atau mengembalikan `401 { code: "UNAUTHORIZED" }`. Macro ini menambah `userId` ke log context request.
- Macro `permission: 'posts:read'` sekaligus berarti `auth: true`, mengubah string menjadi `{ posts: ['read'] }`, dan mengeceknya dengan `auth.api.userHasPermission(...)` (*verify* signature). Bila gagal: `403 { code: "FORBIDDEN" }`. Hanya nilai `Permission` yang lolos kompilasi.
- Route tanpa kedua opsi itu publik dan wajib tercantum sebagai **Publik** di [API.md](../API.md).

## 4. Alur

| Alur | Endpoint | Hasil |
|:---|:---|:---|
| Sign-up email | `POST /api/auth/sign-up/email` | User dengan role `user`; password di-hash; cookie sesi (kecuali verifikasi diwajibkan) |
| Sign-in email | `POST /api/auth/sign-in/email` | Cookie sesi; error generik untuk email tak dikenal atau password salah |
| Sign-in Google | `POST /api/auth/sign-in/social` `{ provider: "google", callbackURL }` → Google → `GET /api/auth/callback/google` | User baru dengan role `user`, atau ditautkan ke akun dengan email terverifikasi yang sama |
| Sign-out | `POST /api/auth/sign-out` | Sesi dihapus dari Redis dan PostgreSQL |
| Sesi | `GET /api/auth/get-session` | `{ user, session }` atau `null` |
| Ubah profil | `POST /api/auth/update-user` | Hanya `name` dan `image`; ganti email tetap mati (default) |

`callbackURL` harus berupa path di origin web.

## 5. Kode error di `/api/auth/*`

Format response dan kode Better Auth dipakai apa adanya (DEC-007). Aplikasi web memetakan `error.code` ke pesan di `features/auth/lib/errors.ts`. Kode yang sebenarnya **dicatat dari implementasi yang berjalan di TASK-04**; jangan pernah ditebak.

| Situasi | Status | `error.code` |
|:---|:---|:---|
| Email sudah terdaftar | `TBD` (TASK-04) | `TBD` |
| Email atau password salah | `TBD` | `TBD` |
| Kena rate limit | 429 | `TBD` |
| User yang di-ban sign-in | `TBD` | `TBD` |

## 6. Audit event (DEC-016)

Dipancarkan lewat telemetry dengan `module: "auth"` dari `audit.ts`:

| Sumber | Event | Payload |
|:---|:---|:---|
| `databaseHooks.session.create.after` | `audit.session.created` | `userId, sessionId, ip, userAgent` |
| `databaseHooks.session.delete.before` | `audit.session.revoked` | `userId, sessionId, actorId?` |
| `databaseHooks.user.update.after`, `role` berubah; `bun run role:set` | `audit.user.role_changed` | `userId, from, to, actorId` |
| `databaseHooks.user.update.after`, `banned` berubah | `audit.user.banned` / `audit.user.unbanned` | `userId, actorId, expiresAt?` (tidak pernah alasan ban) |
| `databaseHooks.account.create.after` | `audit.account.linked` | `userId, provider` |
| `hooks.after` saat `/sign-in/email` gagal | `audit.auth.sign_in_failed` | `ip, reason` (tanpa email) |
| Penolakan guard `hooks.before` | `audit.auth.blocked_endpoint` | `path, actorId?` |

`actorId` adalah user yang sedang login dan melakukan aksi, dari `ctx.context.session` (*verify* ketersediaannya di `databaseHooks`; bila tidak ada, pakai `hooks.after` di path admin). Perubahan role dari `bun run role:set` tidak punya user yang login: `actorId`-nya `cli`. Jangan pernah me-log email, nama, alasan ban, atau token ([redaction.md](../observability/redaction.md)).

## 7. Checklist produksi

- [ ] `BETTER_AUTH_SECRET` kuat dan unik per lingkungan
- [ ] `BETTER_AUTH_URL` memakai HTTPS
- [ ] `trustedOrigins` hanya berisi origin web
- [ ] Rate limit aktif, disimpan di Redis; `REDIS_URL` diisi
- [ ] Pengecekan CSRF dan origin aktif
- [ ] Reverse proxy mengisi `x-forwarded-for`; API tidak bisa diakses langsung dari internet
- [ ] `encryptOAuthTokens` aktif
- [ ] Cookie cache mati
- [ ] `adminUserIds` tidak diisi; endpoint admin yang tidak dipakai mengembalikan 404
- [ ] Event tautan khusus dev tidak bisa terpancar di produksi
- [ ] Audit event terlihat di log store MongoDB
