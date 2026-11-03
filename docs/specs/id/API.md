# API.md

Kontrak HTTP. Semua path berada di bawah `/api` tanpa versi (DEC-006).

## 1. Autentikasi dan otorisasi

| Aspek | Detail |
|:---|:---|
| Metode | Cookie sesi Better Auth (`httpOnly`, `sameSite=lax`, `secure` di HTTPS), prefix `app` (cookie `app.*`, `__Secure-app.*` di HTTPS) |
| Origin | Sama dengan aplikasi web (DEC-020). Tanpa CORS |
| Route terlindungi | Opsi route `{ auth: true }` atau `{ permission: '<resource>:<action>' }` (DEC-010) |
| Tanpa sesi | `401 { code: "UNAUTHORIZED" }` |
| Tanpa permission | `403 { code: "FORBIDDEN" }` |
| Default | Route tanpa kedua opsi itu publik. Hanya route bertanda **Publik** di sini yang boleh publik |

Role dan permission: [auth/access/static-roles.md](auth/access/static-roles.md).

## 2. Format response (DEC-017)

**Sukses:** objeknya langsung, tanpa wrapper.

**List:** `?page=1&limit=20` (default `page=1`, `limit=20`; `limit` maksimal 100).

```json
{ "items": [ … ], "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 } }
```

**Error:** status HTTP plus:

```json
{ "code": "VALIDATION_ERROR", "message": "Invalid request", "details": { "fields": [ { "path": "/title", "rule": "minLength" } ] } }
```

| Status | `code` | Sumber |
|:---|:---|:---|
| 400 | `VALIDATION_ERROR` | Validasi `t` gagal. `details.fields` berisi path dan nama aturan, tidak pernah nilainya |
| 400/404/409 | khusus modul, mis. `POST_NOT_FOUND`, `INVALID_STATUS` | `moduleError(...)` yang dilempar di service (DEC-037) |
| 401 | `UNAUTHORIZED` | Macro `auth` |
| 403 | `FORBIDDEN` | Macro `permission` atau aturan kepemilikan |
| 404 | `NOT_FOUND` | Route tidak dikenal |
| 429 | Format Better Auth | Rate limit hanya berlaku di `/api/auth/*` |
| 500 | `INTERNAL_ERROR` | Error tak tertangani. `message` generik; detail hanya di log, ditandai dengan `module` |
| 503 | `SERVICE_UNAVAILABLE` | Health check saat dependensi mati |

Setiap response membawa header `x-request-id`. Response tidak pernah mengungkap modul, stack, atau pesan library.

Route di bawah `/api/auth/*` **tidak** memakai format ini; mengikuti Better Auth (DEC-007).

## 3. Endpoint

### 3.1 Better Auth (bawaan, DEC-007, DEC-024)

Dipanggil lewat Better Auth client, tidak pernah lewat Eden. Di-log dengan `module: "auth"`.

| Method | Path | Fungsi | Permission |
|:---|:---|:---|:---|
| POST | `/api/auth/sign-up/email` | Sign-up email/password | Publik |
| POST | `/api/auth/sign-in/email` | Sign-in email/password | Publik |
| POST | `/api/auth/sign-in/social` | Memulai Google OAuth (`provider: "google"`) | Publik |
| GET | `/api/auth/callback/google` | Callback OAuth | Publik |
| POST | `/api/auth/sign-out` | Sign out | sesi |
| GET | `/api/auth/get-session` | Sesi saat ini | Publik (`null` bila tanpa sesi) |
| POST | `/api/auth/update-user` | Mengubah `name` / `image` sendiri | sesi |
| GET | `/api/auth/admin/list-users` | Daftar dan cari user | `user:list` |
| POST | `/api/auth/admin/set-role` | Mengubah role user | `user:set-role` + aturan guard ([static-roles.md §7](auth/access/static-roles.md)) |
| POST | `/api/auth/admin/ban-user` / `unban-user` | Ban / unban | `user:ban` |
| POST | `/api/auth/admin/list-user-sessions` | Sesi milik user | `session:list` |
| POST | `/api/auth/admin/revoke-user-session` / `revoke-user-sessions` | Cabut satu / semua sesi | `session:revoke` |
| POST | `/api/auth/admin/remove-user` | Hapus user | `user:delete` |

Endpoint admin plugin yang tidak ada di tabel ini dan tidak dipakai API (misalnya `impersonate-user`, `stop-impersonating`) diblokir dengan `404 NOT_FOUND` oleh `hooks.before` (DEC-032).

*Verify* method dan path terhadap versi Better Auth yang terpasang dan catat yang sebenarnya di sini saat TASK-04.

### 3.2 Health: Publik

- `GET /api/health` → **200** `{ "status": "ok", "db": "up", "redis": "up" | "disabled", "logStore": "up" | "disabled", "uptime": 12345 }`.
- **503** `{ "status": "degraded", … }` bila PostgreSQL mati, atau Redis mati padahal `REDIS_URL` diisi.
- Log store yang mati tidak pernah menggagalkan health (logging tidak boleh menjatuhkan API); dilaporkan `"logStore": "down"` dengan status 200.
- Di-log di level `debug` agar probe tidak membanjiri log.

### 3.3 Me

| Method | Path | Opsi | Response |
|:---|:---|:---|:---|
| GET | `/api/me/permissions` | `auth: true` | `{ "roles": ["admin"], "permissions": ["posts:read", …] }` |

Dipakai aplikasi web untuk menyembunyikan UI yang tidak bisa dipakai user. Tidak di-cache di server.

### 3.4 Posts (F-04)

| Method | Path | Opsi | Body / query | Sukses | Error |
|:---|:---|:---|:---|:---|:---|
| GET | `/api/posts` | `permission: 'posts:read'` | `?page&limit` | 200 list | 400, 401, 403 |
| GET | `/api/posts/:id` | `permission: 'posts:read'` | — | 200 post | 401, 403, 404 `POST_NOT_FOUND` |
| POST | `/api/posts` | `permission: 'posts:write'` | `{ title, content, status? }` | 201 post | 400, 401, 403 |
| PATCH | `/api/posts/:id` | `permission: 'posts:write'`; hanya penulis kecuali `posts:manage_all` | sebagian body POST | 200 post | 400, 401, 403, 404 |
| DELETE | `/api/posts/:id` | sama dengan PATCH | — | 204 | 401, 403, 404 |

- Objek post: `{ id, authorId, title, slug, content, status, createdAt, updatedAt }`.
- `title`: 3–`TBD` karakter. `content`: 10–`TBD` karakter. `status`: `draft` (default) atau `published`.
- `slug` dibuat dari `title`, dibuat unik dengan sufiks pendek bila bentrok, tidak bisa diubah.
- Cache list: `posts:list:{page}:{limit}`, TTL `POSTS_CACHE_TTL` (default `TBD`). Create, update, dan delete menghapus `posts:list:*` dengan `SCAN`.

### 3.5 Admin (F-03, DEC-024)

| Method | Path | Opsi | Response |
|:---|:---|:---|:---|
| GET | `/api/admin/roles` | `permission: 'role:read'` | `{ "items": [{ "role": "admin", "label": "Admin", "description": "…", "permissions": ["posts:read", …] }] }` |

### 3.6 Feature flag (desain saja, DEC-029)

Tidak dibangun di MVP. Kontrak di [feature-flags/database-provider.md §6](feature-flags/database-provider.md).

### 3.7 Organisasi, lapisan platform, dan konsol platform (desain saja, DEC-042, DEC-047, DEC-050)

Hanya di access stage 2 atau di lapisan SaaS. Endpoint organization plugin dan allowlist-nya: [auth/access/single-org.md §7, §9, §10.3](auth/access/single-org.md) (tahap 2) dan [saas/multi-tenant.md §11](saas/multi-tenant.md) (multi-tenant). Route lapisan platform (mulai tahap 2): [single-org.md §8.3](auth/access/single-org.md). Route konsol platform `/api/platform/organizations/*` dan `/api/platform/audit` (multi-tenant): [saas/platform-console.md §4](saas/platform-console.md). Kelompok route dan role database di multi-tenant: [saas/architecture.md §2](saas/architecture.md). Path sebenarnya dicatat di sini oleh ORG-01, ORG-07, dan PC-01.

## 4. Kontrak Eden (DEC-018)

```ts
// apps/api/src/index.ts
export type App = typeof app
export type { Permission } from './utils/auth/access'

// apps/web/src/lib/api.ts (sketsa)
const baseUrl = typeof window === 'undefined'
  ? process.env.API_INTERNAL_URL     // SSR: langsung ke API, Cookie diteruskan
  : window.location.origin           // browser: origin yang sama, /api di-proxy
export const api = treaty<App>(baseUrl)
```

- Tipe request dan response berasal dari `model.ts`; aplikasi web tidak pernah mendeklarasikannya ulang.
- `error.status` dan `error.value.code` menentukan tampilan error.
- *Verify* cara meneruskan header `Cookie` saat SSR (opsi `headers` treaty atau `fetcher` kustom).
