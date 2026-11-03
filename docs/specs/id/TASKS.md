# TASKS.md

Backlog pembangunan. Setiap task adalah potongan yang bisa diverifikasi sendiri. Status implementasi ada di papan kanban, bukan di sini.

Referensi: FR-xx ([PRD.md §6](PRD.md)), F-xx ([FEATURES.md](FEATURES.md)), DEC-xxx ([DECISIONS.md](DECISIONS.md)).

## 0. Pilih access stage lebih dulu

Sebelum TASK-03, catat access stage proyek sebagai keputusan ([auth/access/README.md §3](auth/access/README.md)). **Tahap 1, static-roles, adalah default**, dan task di bawah ditulis untuknya. Untuk tahap 2 (single-org), tukar task seperti tercantum di [auth/access/migration.md §2](auth/access/migration.md). Proyek yang harus multi-tenant sejak awal juga menambahkan [saas/migration.md §2](saas/migration.md).

## 1. Fase

| Fase | Fokus | Task | Paralel? |
|:---|:---|:---|:---|
| P0 | Fondasi | TASK-01, TASK-02 | — |
| P1 | Kerangka API, data, observability, test harness | TASK-03, TASK-07, TASK-12, TASK-13, TASK-15, TASK-18 | Ya, setelah P0 |
| P2 | Auth dan RBAC | TASK-04, TASK-05 | Berurutan |
| P3 | Modul API | TASK-06, TASK-08 | Ya |
| P4 | Web | TASK-14, TASK-09, TASK-10, TASK-16, TASK-17 | TASK-14 bisa mulai di P1 |
| P5 | Operasional | TASK-11, TASK-19 | Ya |

## 2. Task

### TASK-01: Bootstrap monorepo Bun
- **Tujuan:** Workspace `apps/{api,web}`, `packages/{shared,auth,db,ui}`; `bun run dev` menjalankan API dan web.
- **Ref:** FR-01, [ARCHITECTURE.md §2](ARCHITECTURE.md).
- **Penerimaan:** `bun install` berhasil; kedua proses berjalan; `tsconfig` dasar bersama; lockfile di-commit; versi dikunci; dev server web mem-proxy `/api` ke API (DEC-020).

### TASK-02: Infrastruktur dev
- **Tujuan:** `docker compose up` menyediakan PostgreSQL 17, Redis 7, dan MongoDB 8 dengan health check; init MongoDB membuat user log penulis, admin, dan read-only ([log-storage.md §2](observability/log-storage.md)); `docker-compose.test.yml` untuk test; `.env.example` memuat setiap variabel di [ARCHITECTURE.md §7](ARCHITECTURE.md).
- **Bergantung pada:** TASK-01.
- **Penerimaan:** container sehat; `.env.example` tanpa rahasia asli.

### TASK-03: Skema dan migrasi Drizzle
- **Tujuan:** Skema Better Auth di-generate oleh CLI + tabel `post` sesuai [DATABASE.md](DATABASE.md); migrasi Drizzle Kit; seed dev.
- **Bergantung pada:** TASK-02. (Generate butuh `auth.ts` minimal; generate ulang di TASK-04 bila ada yang berubah.)
- **Penerimaan:** tanpa tabel `role`; migrasi idempoten; seed membuat satu `super_admin` dan contoh post, idempoten, menolak produksi; index sesuai [DATABASE.md §4](DATABASE.md).

### TASK-12: Logger, telemetry, tanda modul, redaksi, error handler
- **Tujuan:** `utils/logger` (dengan `moduleScope`), `utils/telemetry` (scrubber, sink `log` dan `memory`, tabel retensi), `utils/error` (`moduleError`, handler global), root app dengan prefix `/api`, modul `health`.
- **Ref:** FR-13, DEC-013 s.d. DEC-017, DEC-027, DEC-037, [observability/README.md](observability/README.md), [redaction.md](observability/redaction.md).
- **Bergantung pada:** TASK-01.
- **Penerimaan:** butir di [observability/README.md §10](observability/README.md) kecuali butir MongoDB; [redaction.md §7](observability/redaction.md) (kecuali butir vendor); health sesuai [API.md §3.2](API.md).

### TASK-15: Sink log MongoDB dan retensi manual
- **Tujuan:** `utils/mongo`, `sinks/mongo.ts`, `scripts/logs-setup.ts` (index), `scripts/logs-prune.ts` (`--dry-run`, `--kind`, `--older-than`, `--user`).
- **Ref:** DEC-034, [log-storage.md](observability/log-storage.md), [DATABASE.md §8](DATABASE.md).
- **Bergantung pada:** TASK-02, TASK-12.
- **Penerimaan:** [log-storage.md §8](observability/log-storage.md).

### TASK-07: Helper cache Redis
- **Tujuan:** `utils/redis` + `utils/cache` (`get/set/del/wrap/delPattern`), TTL per modul, fallback memori bila `REDIS_URL` kosong; startup menolak produksi tanpa `REDIS_URL`.
- **Bergantung pada:** TASK-02, TASK-12.
- **Penerimaan:** test untuk hit, miss, TTL; `delPattern` memakai `SCAN`; tanpa Redis test lulus dan `cache.fallback` dipancarkan sekali; `NODE_ENV=production` tanpa `REDIS_URL` menggagalkan startup.

### TASK-13: Graceful shutdown
- **Tujuan:** Saat SIGTERM/SIGINT: berhenti menerima request, `telemetry.flush()` (buffer MongoDB), tutup klien PostgreSQL, Redis, dan MongoDB, exit 0.
- **Bergantung pada:** TASK-12, TASK-15.
- **Penerimaan:** `app.stopping` di-log dan disimpan; event ber-buffer tertulis; keluar dalam < 10 dtk; tanpa koneksi menggantung.

### TASK-18: Test harness
- **Tujuan:** `apps/api/tests/{helpers,modules,utils,e2e}` dan `apps/web/tests/{helpers,features,lib,components}` sesuai [TESTING.md](TESTING.md); script `test` dan `test:e2e`; PostgreSQL test dan `docker-compose.test.yml`; pengecekan CI bahwa setiap modul dan fitur punya folder test.
- **Bergantung pada:** TASK-01, TASK-12.
- **Penerimaan:** [TESTING.md §7](TESTING.md) butir 3 dan 4; contoh test di setiap level lulus.

### TASK-04: Server Better Auth dan access control
- **Tujuan:** `createAuth` di `packages/auth` sesuai [auth/README.md §2](auth/README.md); `utils/auth/{roles,access,auth,hooks,audit}.ts` sesuai [auth/access/static-roles.md](auth/access/static-roles.md); dipasang di `/api/auth/*` dengan `module: "auth"`; secondary storage Redis; admin plugin dengan `ac` dan `roles` (grant DEC-033); tanpa `adminUserIds`.
- **Bergantung pada:** TASK-03, TASK-07, TASK-12.
- **Penerimaan:** sign-up, sign-in, sign-out, dan Google berfungsi; Google dengan email terverifikasi yang sudah ada ditautkan; sign-in keenam dalam 60 dtk → 429; audit event dari [auth/README.md §6](auth/README.md); aturan guard dari [static-roles.md §7](auth/access/static-roles.md), termasuk endpoint impersonation → 404 untuk `super_admin`; statement gabungan tanpa action impersonate; tanpa path `/api/api/auth`; key resource duplikat menggagalkan startup; kode error asli dicatat di [auth/README.md §5](auth/README.md) dan path asli di [API.md §3.1](API.md).

### TASK-05: Macro auth dan permission, modul `me`
- **Tujuan:** Macro `auth` dan `permission` (DEC-010, default menolak); `GET /api/me/permissions`.
- **Bergantung pada:** TASK-04.
- **Penerimaan:** 401 tanpa sesi; 403 tanpa permission; `user`/`session` bertipe di handler; hanya nilai `Permission` yang lolos kompilasi; test matriks dan snapshot compiled roles sesuai [static-roles.md §11](auth/access/static-roles.md); test di `tests/modules/me/`.

### TASK-06: Modul admin (F-03)
- **Tujuan:** `modules/admin` dengan `permissions.ts` (action bawaan eksplisit + `role:read`) dan `GET /api/admin/roles`.
- **Bergantung pada:** TASK-05.
- **Penerimaan:** [API.md §3.5](API.md) dan F-03; `user` → 403; setiap role registry tercantum dengan permission hasil kompilasinya; test di `tests/modules/admin/` dan `tests/e2e/admin/`.

### TASK-08: Modul posts (F-04)
- **Tujuan:** Endpoint di [API.md §3.4](API.md) dengan tata letak DEC-008, `moduleScope('posts')`, kode `moduleError`.
- **Bergantung pada:** TASK-05, TASK-07.
- **Penerimaan:** F-04; test wajib sesuai [TESTING.md §3.1](TESTING.md) di `tests/modules/posts/` dan alur di `tests/e2e/posts/`; p95 cache hit < 50 ms diukur dari `http.request`.

### TASK-14: Kerangka web
- **Tujuan:** Struktur sesuai [apps/web/README.md](../../../apps/web/README.md): `routes/`, `features/`, `lib/api.ts`, `lib/auth-client.ts`, QueryClient, lint rule batas fitur, Tailwind v4 + token `packages/ui`.
- **Bergantung pada:** TASK-01 (Eden butuh `type App` dari TASK-12).
- **Penerimaan:** deep import lintas fitur gagal lint; Eden memanggil `/api/health` dari browser dan saat SSR; port dev web dicatat di [TESTING.md §5](TESTING.md).

### TASK-09: Auth web (F-05)
- **Tujuan:** Fitur `auth`: login, register, Google, logout, redirect `beforeLoad`, `usePermissions()` / `can()`.
- **Bergantung pada:** TASK-05, TASK-14, TASK-18.
- **Penerimaan:** F-05; test di `tests/features/auth/`; flow di `e2e/auth/`.

### TASK-10: Form dan profil
- **Tujuan:** TanStack Form untuk form auth; fitur `profile` dengan `updateUser`.
- **Bergantung pada:** TASK-09.
- **Penerimaan:** validasi klien sama dengan API; error server per field; test di `tests/features/profile/`; flow di `e2e/profile/`.

### TASK-16: Fitur posts web
- **Tujuan:** Fitur `posts`: daftar, detail, buat, ubah, hapus, dijaga `can()`.
- **Bergantung pada:** TASK-08, TASK-09.
- **Penerimaan:** state loading, kosong, error, dan forbidden; ubah/hapus hanya pada post sendiri kecuali `posts:manage_all`; mutation menginvalidasi daftar; test di `tests/features/posts/`; flow di `e2e/posts/`.

### TASK-17: Fitur admin web
- **Tujuan:** Fitur `admin`: daftar dan detail user, ubah role, ban/unban, daftar dan cabut sesi, katalog role.
- **Bergantung pada:** TASK-06, TASK-09.
- **Penerimaan:** setiap halaman dan aksi dijaga sesuai [static-roles.md §6](auth/access/static-roles.md); aksi destruktif meminta konfirmasi dan menyebut user ID target; role sendiri tidak bisa diubah; test di `tests/features/admin/`; flow di `e2e/admin/`.

### TASK-19: Suite E2E
- **Tujuan:** Semua alur API E2E wajib ([TESTING.md §3.2](TESTING.md)) dan flow web E2E ([TESTING.md §5](TESTING.md)) lengkap dan masuk CI.
- **Bergantung pada:** TASK-08, TASK-10, TASK-16, TASK-17.
- **Penerimaan:** setiap alur yang tercantum ada di folder modul/fiturnya dan lulus; flow web divalidasi runner E2E; tag `smoke` diisi.

### TASK-11: Operasional dan DX
- **Tujuan:** CI (install, typecheck, lint, test, migrate, E2E), dokumen setup, runbook prune, baseline waktu bootstrap.
- **Bergantung pada:** semua task di atas.
- **Penerimaan:** CI hijau; waktu bootstrap dicatat di [PRD.md §9](PRD.md); runbook prune ([log-storage.md §5.4](observability/log-storage.md)) ada di dokumen setup.

## 3. Ditunda (desain saja, butuh keputusan sebelum menjadi task)

| Item | Spec | Pemicu |
|:---|:---|:---|
| Feature flag (database provider) | [feature-flags/database-provider.md](feature-flags/database-provider.md) | Fitur pertama yang butuh rollout bertahap atau kill switch |
| Feature flag (PostHog provider) | [feature-flags/posthog-provider.md](feature-flags/posthog-provider.md) | Butuh eksperimen atau analitik flag |
| Sentry | [observability/sentry.md](observability/sentry.md) | Butuh pengelompokan error dan alert melebihi query MongoDB |
| Analitik PostHog | [observability/posthog.md](observability/posthog.md) | Pertanyaan produk yang tidak bisa dijawab log |
| Grafana Alloy + Loki (default) | [observability/migration-loki.md](observability/migration-loki.md) | Salah satu pemicu di §1-nya |
| ELK Stack (pengganti Loki) | [observability/migration-elk.md](observability/migration-elk.md) | Pemicu di migration-loki.md §1 dan salah satu kondisi di migration-elk.md §1; tidak pernah bersamaan dengan Loki |
| Access stage 2: single-org | [auth/access/single-org.md](auth/access/single-org.md) (ORG-01…08) | Non-developer harus membuat atau mengubah role tanpa deploy |
| Langkah A: tahap 1 → 2 | [auth/access/migration.md](auth/access/migration.md) (MIG-01…03) | Proyek tahap 1 yang sudah berjalan butuh role runtime |
| Feature flag di tahap 2 | [feature-flags/access-stages.md](feature-flags/access-stages.md) (FF-ORG-01) | Flag diadopsi di tahap 2 |
| SaaS: multi-tenant | [saas/multi-tenant.md](saas/multi-tenant.md) (MT-01…10, termasuk row-level security) + [saas/platform-console.md](saas/platform-console.md) (PC-01…03) + [saas/feature-flags.md](saas/feature-flags.md) (FF-MT-01) | Pelanggan adalah perusahaan terpisah yang tidak boleh melihat data satu sama lain; butuh tahap 2 dan pengirim email |
| Langkah B: tahap 2 → multi-tenant | [saas/migration.md](saas/migration.md) (MIG-04, MIG-05) | Proyek tahap 2 yang sudah berjalan menjadi multi-tenant |
| Tambahan SaaS: tenant rollout, plan dan billing | [saas/README.md](saas/README.md) | Multi-tenant sudah berjalan, dan keputusan SaaS sudah Answered ([saas/DECISIONS.md](saas/DECISIONS.md)) |

## 4. Penghambat

| Penghambat | Memengaruhi |
|:---|:---|
| KPI `TBD` di PRD §9 | TASK-11 (hanya pengukuran) |
