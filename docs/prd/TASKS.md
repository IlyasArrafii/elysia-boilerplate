# TASKS.md: BunForge

## 1. Konvensi Backlog

Setiap task adalah **slice end-to-end yang dapat diverifikasi** (API + data + UI bila relevan). Urutan mengikuti dependency. Task dengan keputusan belum final ditandai **BLOCKED** dan menyebut DEC/PRD yang harus diselesaikan. Status implementasi tidak diklaim selesai di dokumen ini.

Referensi: FR-XX (PRD §4), F-XX (FEATURES.md), DEC-XXX (DECISIONS.md). Detail endpoint/skema tidak diulang di sini — lihat API.md dan DATABASE.md.

## 2. Ringkasan Fase

| Fase | Fokus | Task |
|:---|:---|:---|
| P0 | Fondasi monorepo & toolchain | TASK-01, TASK-02 |
| P1 | Data layer & auth server | TASK-03, TASK-04 |
| P2 | RBAC guard & modul admin | TASK-05, TASK-06 |
| P3 | Modul posts + cache | TASK-07, TASK-08 |
| P4 | Frontend auth & form | TASK-09, TASK-10 |
| P5 | Operasional & DX | TASK-11 |

## 3. Daftar Task

### TASK-01 — Bootstrap Monorepo Bun
- **Objective:** Workspace `apps/api`, `apps/web`, `packages/{shared,auth,db,ui}` terinisialisasi; `bun run dev` menjalankan API & web paralel.
- **Sumber:** FR-01; PRD §3.
- **DEC:** —
- **Blocked by:** —
- **Acceptance:** `bun install` sukses; `bun run dev` menyalakan dua proses; `tsconfig` base dipakai bersama; lockfile ter-commit.
- **Verifikasi:** jalankan `bun run dev`, cek dua port listen; CI `bun install --frozen-lockfile` lulus.

### TASK-02 — Infrastruktur Dev (PostgreSQL + Redis)
- **Objective:** `docker compose up` menyediakan PostgreSQL 17 & Redis 7; variabel env terdokumentasi.
- **Sumber:** PRD §5 (Portabilitas), §9 (Constraints).
- **DEC:** DEC-001.
- **Blocked by:** TASK-01.
- **Acceptance:** container sehat; `DATABASE_URL` & `REDIS_URL` terbaca; health check DB/Redis via skrip.
- **Verifikasi:** `docker compose ps` healthy; koneksi `psql` & `redis-cli ping` → `PONG`.

### TASK-03 — Skema Drizzle & Migrasi
- **Objective:** 5 tabel inti (`user`, `role`, `session`, `account`, `post`) + migrasi Drizzle Kit + seed role default (`super_admin`, `admin`, `user`) dan user Super Admin awal.
- **Sumber:** FR-08; DATABASE.md §3–§4.
- **DEC:** DEC-005.
- **Blocked by:** TASK-02.
- **Acceptance:** `drizzle-kit generate` + `migrate` idempotent; seed menghasilkan 3 role & 1 user Super Admin; FK/index sesuai DATABASE.md.
- **Verifikasi:** jalankan migrasi dua kali (idempotent); query seed mengembalikan baris yang diharapkan.

### TASK-04 — Better Auth Server (Email/Password + Google)
- **Objective:** Better Auth ter-mount di `apps/api` via `/api/auth/*`; email/password + OAuth Google PKCE; plugin admin/access-control aktif.
- **Sumber:** FR-05, F-01, F-02; API.md §1.
- **DEC:** DEC-004, DEC-005.
- **Blocked by:** TASK-03.
- **Acceptance:** register/login/logout berfungsi; email duplikat → `409 EMAIL_TAKEN`; OAuth callback menerbitkan session cookie; user baru role default `user`.
- **Verifikasi:** uji manual + test integrasi (`POST /api/auth/sign-up/email`, `sign-in/email`, `sign-out`); cek cookie `better-auth.session_token`.

### TASK-05 — Guard Permission & Compose App
- **Objective:** `requirePermission` guard (default deny) + `apps/api/src/index.ts` meng-compose plugin modul (pola DEC-003); endpoint `GET /api/v1/health`.
- **Sumber:** FR-02, FR-03, FR-09; API.md §1, §3.1.
- **DEC:** DEC-002, DEC-003, DEC-005.
- **Blocked by:** TASK-04.
- **Acceptance:** tanpa session → `401`; tanpa permission → `403`; health mengembalikan `{db,redis,uptime}`; `503` bila dependency down.
- **Verifikasi:** test guard untuk 401/403; curl health saat Redis dimatikan → `503`.

### TASK-06 — Modul Admin (Role Management)
- **Objective:** `PATCH /api/v1/admin/users/:id/role` (permission `users:manage_role`) + `GET /api/v1/admin/roles` (permission `roles:read`); guard self-demotion.
- **Sumber:** FR-10, F-03; API.md §3.6.
- **DEC:** DEC-005.
- **Blocked by:** TASK-05.
- **Acceptance:** Super Admin ubah role sukses; non-Super-Admin → `403 FORBIDDEN`; role tak dikenal → `400 INVALID_ROLE`; user tak ada → `404`; self-demotion → `400`.
- **Verifikasi:** matriks test permission per role; uji tiap status code.

### TASK-07 — Helper Cache Redis
- **Objective:** Helper `get/set/del/wrap` dengan TTL konfigurable per modul (ioredis); fallback in-memory untuk dev/test.
- **Sumber:** FR-04; PRD §8 (mitigasi Redis).
- **DEC:** DEC-001.
- **Blocked by:** TASK-02.
- **Acceptance:** `wrap` mengisi cache & mengembalikan nilai; TTL berlaku; fallback aktif bila `REDIS_URL` kosong.
- **Verifikasi:** test unit cache hit/miss & TTL expiry; jalankan tanpa Redis → fallback lulus.

### TASK-08 — Modul Posts (RBAC + Cache)
- **Objective:** `GET /api/v1/posts` (cache `posts:list:{page}:{limit}`, TTL 60s) & `POST /api/v1/posts` (invalidasi pola `posts:list:*`).
- **Sumber:** FR-11, F-04; API.md §3.4–§3.5.
- **DEC:** DEC-001, DEC-003, DEC-005.
- **Blocked by:** TASK-05, TASK-07.
- **Acceptance:** list ter-cache (hit < 50ms p95); create menginvalidasi cache; `400` validasi; `403` tanpa `posts:write`.
- **Verifikasi:** test integrasi list→create→list (cache invalidated); ukur p95 cache-hit.

### TASK-09 — Frontend Auth Client & Session
- **Objective:** Better Auth client di `apps/web` (session provider, login/register, callback OAuth, logout) via Eden Treaty.
- **Sumber:** FR-06, F-05; API.md §4.
- **DEC:** DEC-004.
- **Blocked by:** TASK-04, TASK-05.
- **Acceptance:** login email/password & Google mengalihkan ke dashboard; refresh mempertahankan sesi; logout → redirect login.
- **Verifikasi:** uji E2E Playwright (login, refresh, logout); cek cookie `credentials: include`.

### TASK-10 — TanStack Form (Auth + Profile)
- **Objective:** Form login/register & form contoh profile update dengan validasi runtime TanStack Form.
- **Sumber:** FR-07.
- **DEC:** —
- **Blocked by:** TASK-09.
- **Acceptance:** validasi client menolak input invalid; submit sukses memanggil API; error server ditampilkan.
- **Verifikasi:** test form valid/invalid; cek pesan error `VALIDATION_ERROR`.

### TASK-11 — Operasional & DX
- **Objective:** Graceful shutdown, health check CI, skrip seed, dokumentasi setup; ukur baseline KPI bootstrap.
- **Sumber:** FR-01, PRD §5, §7.
- **DEC:** —
- **Blocked by:** TASK-01 s.d. TASK-10.
- **Acceptance:** SIGTERM menutup pool DB/Redis; CI menjalankan migrasi + health; waktu bootstrap dicatat.
- **Verifikasi:** kirim SIGTERM, cek log shutdown; CI hijau; catat metrik bootstrap.

## 4. Task BLOCKED / TBD

| Task | Blocker | Keputusan Dibutuhkan |
|:---|:---|:---|
| TASK-11 (metrik) | KPI PRD §7 `TBD` | Target waktu bootstrap & cache hit ratio belum ditetapkan |
| TASK-04 (rate limit) | API.md §3.3 `429 RATE_LIMITED` | Ambang & kebijakan rate limit `TBD` |
| TASK-09 (email reset) | PRD §10 out of scope | Template reset/verifikasi email hanya scaffold |

<!-- SDD_SOURCE_DOCS: api,database,decisions,design,features,prd -->
