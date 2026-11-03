# ARCHITECTURE.md

## 1. Bentuk sistem

```
Browser ──► origin web (https://app.example.com)
              │
              ├─ /*        → apps/web  (TanStack Start, SSR)
              └─ /api/*    → apps/api  (Elysia, modular monolith)
                               ├─ /api/auth/*   → handler Better Auth   (modul "auth")
                               ├─ /api/health                           (modul "health")
                               ├─ /api/me                               (modul "me")
                               ├─ /api/posts                            (modul "posts")
                               └─ /api/admin                            (modul "admin")
                                     │
                     PostgreSQL 17 ◄─┼─► Redis 7
                     (data aplikasi) │   (cache, sesi, rate limit)
                                     │
                                     └─► MongoDB 8 (log store, database terpisah)

apps/api ──stdout JSON──► terminal / log container   (selalu)
         ──sink mongo───► MongoDB log_event          (produksi; opsional di dev)
```

- **Satu origin** (DEC-020). Di lokal, dev server web mem-proxy `/api` ke API. Di produksi, reverse proxy (Caddy, Nginx, atau Traefik) mengirim `/api/*` ke API dan sisanya ke aplikasi web.
- Saat SSR, aplikasi web memanggil API lewat `API_INTERNAL_URL` dan **meneruskan header `Cookie` yang masuk**.
- API stateless. Sesi, rate limit, dan cache berada di Redis dan PostgreSQL, sehingga berapa pun instans API bisa berjalan di balik proxy.
- MongoDB hanya menyimpan log. Data aplikasi tidak pernah ke sana, dan log tidak pernah ke PostgreSQL (DEC-034).

## 2. Monorepo

```
apps/
  api/        Elysia. Aturan: apps/api/README.md
  web/        TanStack Start. Aturan: apps/web/README.md
packages/
  shared/     tipe dan helper murni (tanpa I/O)
  auth/       factory server createAuth() + factory auth client (tanpa definisi role; DEC-023)
  db/         skema Drizzle, koneksi, migrasi, seed (hanya PostgreSQL)
  ui/         primitif shadcn/ui dan design token
docs/
  specs/eng/  spesifikasi, kanonis
  specs/id/   spesifikasi, terjemahan Indonesia
  prd/        PRD asli, hanya riwayat
```

Arah dependensi (tidak pernah dibalik):

```
apps/web ──► packages/{ui, shared, auth (client saja)}  + `import type` dari apps/api
apps/api ──► packages/{db, auth, shared}
packages/auth ──► packages/db (tipe), packages/shared
packages/ui, packages/shared ──► tidak ada yang internal
```

`apps/web` hanya mengimpor **tipe** dari `apps/api` (`App`, `Permission`), tidak pernah kode runtime.

## 3. Backend: modular monolith (DEC-002, DEC-003, DEC-008 s.d. DEC-010, DEC-037)

```
apps/api/
  src/
    index.ts               root app: prefix '/api', utils global, .use() tiap modul, export type App
    env.ts                 membaca dan memvalidasi env sekali saat startup
    modules/<name>/
      index.ts             controller: new Elysia({ name, prefix }).use(moduleScope('<name>'))
      service.ts           abstract class <Name>Service { static ... }
      model.ts             skema t (body, query, params, response)
      permissions.ts       statement permission + grant role
    utils/
      auth/                roles, access, auth (config CLI), hooks, audit, macro
      logger/              instans pino, plugin request, moduleScope()
      telemetry/           emit(), katalog event, scrubber, tabel retensi, sink (log, mongo, memory)
      cache/               get/set/del/wrap/delPattern di Redis, fallback memori
      error/               moduleError(), global error handler → { code, message }
      redis/               klien ioredis bersama
      mongo/               klien MongoDB bersama untuk log store
  scripts/
    logs-prune.ts          retensi manual (bun run logs:prune)
  tests/                   mencerminkan modules dan utils (TESTING.md)
```

Modul awal: `health`, `me`, `posts`, `admin`. Aturan di [apps/api/README.md](../../../apps/api/README.md).

## 4. Frontend: berbasis fitur (DEC-011, DEC-018)

```
apps/web/
  src/
    routes/                routing berbasis berkas TanStack, tipis
    features/<feature>/    components, hooks, lib, pages, index.ts
    components/            komponen se-aplikasi (layout, shell)
    lib/api.ts             satu-satunya klien Eden
    lib/auth-client.ts     Better Auth client (dari packages/auth)
  tests/                   mencerminkan features (TESTING.md)
  e2e/<feature>/           flow E2E (YAML)
```

Fitur awal: `auth`, `profile`, `posts`, `admin`. Aturan di [apps/web/README.md](../../../apps/web/README.md).

## 5. Alur request

1. Reverse proxy mengisi `x-forwarded-for` dan meneruskan `/api/*`.
2. Plugin `logger` membaca atau membuat `x-request-id`, membuat log context request (`requestId`, `module: "core"`).
3. `/api/auth/*` → handler Better Auth (rate limit, CSRF, dan pengecekan origin sendiri); log context `module: "auth"`.
4. Route lain → `moduleScope` mengisi `module` dengan modul pemilik; macro `auth` memuat sesi dan menambah `userId`; `permission` mengecek grant (401/403 bila gagal).
5. Controller → service → Drizzle / cache.
6. Global error handler memetakan error ke `{ code, message }` dan memancarkan `http.error` dengan `module`.
7. `onAfterResponse` memancarkan satu `http.request` dengan `module`.
8. Sink: `log` menulis baris ke stdout secara sinkron; `mongo` menampungnya di buffer lalu meng-insert berbatch.

## 6. Caching dan Redis

**Produksi memakai Redis untuk semua hal di bawah. Redis wajib:** dengan `NODE_ENV=production` API menolak start tanpa `REDIS_URL`. Fallback in-memory hanya untuk dev dan test, karena memori bersifat per instans dan akan merusak sesi, rate limit, dan invalidasi cache antar-instans.

| Pengguna | Prefix key | Catatan |
|:---|:---|:---|
| `secondaryStorage` Better Auth (sesi) | dikelola Better Auth | DEC-019; sesi juga disimpan di PostgreSQL |
| Rate limit Better Auth | dikelola Better Auth | DEC-019 |
| Cache modul | `<module>:<entity>:<part>`, mis. `posts:list:1:20` | DEC-001; TTL per modul; diinvalidasi dengan `SCAN` |
| Notifikasi perubahan feature flag (saat diadopsi) | pub/sub `feature-flags:changed` | DEC-029 |

Tidak di-cache: `GET /api/me/permissions` di server (aplikasi web meng-cache-nya per sesi), cookie cache Better Auth (mati, agar pencabutan sesi dan ban langsung berlaku), response HTTP di proxy.

Tanpa `REDIS_URL` (dev/test): sesi hanya di PostgreSQL, rate limit dan cache di memori, satu event `cache.fallback` saat startup.

## 7. Variabel lingkungan

| Variabel | App | Wajib | Catatan |
|:---|:---|:---|:---|
| `NODE_ENV` | api, web | ya | `development` / `test` / `production` |
| `DATABASE_URL` | api | ya | PostgreSQL. Di lapisan SaaS multi-tenant ini adalah role `app_runtime`, dan `DATABASE_MIGRATION_URL` / `DATABASE_PLATFORM_URL` ditambahkan ([saas/architecture.md §4.2](saas/architecture.md)) |
| `REDIS_URL` | api | produksi | Kosong = fallback memori (hanya dev/test) |
| `LOG_MONGO_URL` | api | produksi | Log store MongoDB; kosong = sink `mongo` mati (dev/test) |
| `LOG_MONGO_ADMIN_URL` | api (script) | untuk `logs:setup` / `logs:prune` | User log admin; tidak pernah dibaca proses API |
| `LOG_MONGO_DB` | api | tidak | Default `app_logs` |
| `LOG_MONGO_MIN_LEVEL` | api | tidak | Default `info`; event `debug` tidak pernah masuk MongoDB di produksi |
| `BETTER_AUTH_SECRET` | api | ya | ≥ 32 karakter, `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | api | ya | Origin **web** publik (satu origin) |
| `WEB_URL` | api | ya | Nilai `trustedOrigins` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api | ya | Redirect URI `${BETTER_AUTH_URL}/api/auth/callback/google` |
| `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD` | api (seed) | dev | Hanya untuk script seed |
| `LOG_LEVEL` | api | tidak | Default `info` (`debug` di dev) |
| `APP_VERSION` | api | tidak | Ditambahkan ke `app.started`; diisi CI |
| `POSTS_CACHE_TTL` | api | tidak | Detik; default `TBD` |
| `API_INTERNAL_URL` | web | ya | URL API untuk SSR, mis. `http://localhost:3000` |
| `PORT` | api, web | tidak | Default API `3000`; default web *verify* milik TanStack Start |

Variabel yang masih desain (`SENTRY_*`, `POSTHOG_*`, `FEATURE_FLAGS_*`, `LOKI_*`) tercantum di spec masing-masing dan tidak dibaca oleh MVP.
