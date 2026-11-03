# API.md: BunForge

## 1. Authentication & Authorization

Autentikasi menggunakan **Better Auth session-based** (cookie `better-auth.session_token`) yang di-mount pada Elysia via handler `/api/auth/*`. Server-side source of truth adalah Better Auth admin plugin (DEC-004/DEC-005). Frontend memanggil API melalui **Eden Treaty** client yang otomatis menyertakan cookie session.

| Aspek | Detail |
|:---|:---|
| Metode | Session cookie (HttpOnly, SameSite=Lax) |
| Header wajib | `Cookie: better-auth.session_token=` |
| OAuth | Google OAuth PKCE via `GET /api/auth/sign-in/google` (redirect flow) |
| RBAC | Middleware Elysia memeriksa permission `:` via `auth.api.hasPermission` (default deny) |
| Error auth | `401 UNAUTHORIZED` bila tanpa session; `403 FORBIDDEN` bila permission tidak dimiliki |

Contoh guard plugin (dipakai tiap modul):

```ts
// apps/api/src/lib/guard.ts
import { Elysia } from "elysia";
import { auth } from "@bunforge/auth";

export const requirePermission = (perm: `${string}:${string}`) =>
  new Elysia({ name: `guard:${perm}` }).onBeforeHandle(
    async ({ request, set }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) { set.status = 401; return { success: false, error: { code: "UNAUTHORIZED" } }; }
      const ok = await auth.api.userHasPermission({
        body: { userId: session.user.id, permissions: { [perm.split(":")[0]]: [perm.split(":")[1]] } },
      });
      if (!ok.success) { set.status = 403; return { success: false, error: { code: "FORBIDDEN" } }; }
    }
  );
```

## 2. Standard Response & Pagination

**Success:** `{ "success": true, "data": <T> }`. **Error:** `{ "success": false, "error": { "code": "<CODE>", "message": "<msg>", "details"?: any } }`. **Pagination:** query `?page=1&limit=20`, response `data: { items: T[], meta: { page, limit, total, totalPages } }`.

## 3. API Endpoints

### 3.1 Health Check (public)

- **Method / Path:** `GET /api/v1/health`
- **Auth:** Guest
- **Response 200:**
```json
{ "success": true, "data": { "status": "ok", "db": "up", "redis": "up", "uptime": 12345 } }
```
- **Status:** `200` OK, `503` SERVICE_UNAVAILABLE (db/redis down)

### 3.2 Register Email/Password

- **Method / Path:** `POST /api/v1/auth/register`
- **Auth:** Guest
- **Request Body:**
```json
{ "name": "Ada Lovelace", "email": "ada@example.com", "password": "S3cure!Pass" }
```
- **Response 201:**
```json
{ "success": true, "data": { "user": { "id": "usr_01H...", "email": "ada@example.com", "role": "user" }, "session": { "token": "...", "expiresAt": "2025-12-31T00:00:00Z" } } }
```
- **Status:** `201` CREATED, `400` VALIDATION_ERROR, `409` EMAIL_TAKEN

### 3.3 Login Email/Password

- **Method / Path:** `POST /api/v1/auth/login`
- **Auth:** Guest
- **Request Body:**
```json
{ "email": "ada@example.com", "password": "S3cure!Pass" }
```
- **Response 200:** Set-Cookie `better-auth.session_token=...; HttpOnly; SameSite=Lax` + body:
```json
{ "success": true, "data": { "user": { "id": "usr_01H...", "email": "ada@example.com", "role": "user" } } }
```
- **Status:** `200` OK, `401` INVALID_CREDENTIALS, `429` RATE_LIMITED

### 3.4 List Posts (protected + cached)

- **Method / Path:** `GET /api/v1/posts?page=1&limit=20`
- **Auth:** User (permission `posts:read`)
- **Response 200** (cache key `posts:list:{page}:{limit}`, TTL 60s — DEC-001):
```json
{ "success": true, "data": { "items": [ { "id": "pst_01H...", "title": "Hello", "authorId": "usr_01H...", "createdAt": "2025-01-01T00:00:00Z" } ], "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 } } }
```
- **Status:** `200` OK, `401` UNAUTHORIZED, `403` FORBIDDEN

### 3.5 Create Post (protected + cache invalidation)

- **Method / Path:** `POST /api/v1/posts`
- **Auth:** User (permission `posts:write`)
- **Request Body:**
```json
{ "title": "Hello BunForge", "content": "Body text..." }
```
- **Response 201:**
```json
{ "success": true, "data": { "id": "pst_01H...", "title": "Hello BunForge", "authorId": "usr_01H...", "createdAt": "2025-01-01T00:00:00Z" } }
```
- **Side effect:** `redis.del("posts:list:*")` (pattern invalidation) setelah insert berhasil.
- **Status:** `201` CREATED, `400` VALIDATION_ERROR, `401` UNAUTHORIZED, `403` FORBIDDEN

### 3.6 Admin — Update User Role

- **Method / Path:** `PATCH /api/v1/admin/users/:id/role`
- **Auth:** Super Admin (permission `users:manage_role`)
- **Request Body:**
```json
{ "role": "admin" }
```
- **Response 200:**
```json
{ "success": true, "data": { "id": "usr_01H...", "email": "bob@example.com", "role": "admin" } }
```
- **Status:** `200` OK, `400` VALIDATION_ERROR, `401` UNAUTHORIZED, `403` FORBIDDEN, `404` NOT_FOUND

## 4. Eden Treaty Client Contract

Endpoint di atas diekspor sebagai `App` type dari `apps/api/src/index.ts` dan dikonsumsi frontend via:

```ts
// packages/shared/src/eden.ts
import { treaty } from "@elysiajs/eden";
import type { App } from "@bunforge/api";
export const api = treaty<App>(import.meta.env.VITE_API_URL, { fetch: { credentials: "include" } });
// pemakaian: const { data, error } = await api.api.v1.posts.get({ query: { page: 1, limit: 20 } });
```

Tipe request/response diturunkan otomatis dari skema Elysia `t.Object(...)` — tidak ada duplikasi tipe manual antara backend dan frontend.