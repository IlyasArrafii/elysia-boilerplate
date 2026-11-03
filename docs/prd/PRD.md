# PRD: BunForge

## 1. Executive Summary & Product Vision
BunForge adalah boilerplate monorepo produksi-grade berbasis Bun untuk membangun aplikasi fullstack modern. Boilerplate ini mengintegrasikan backend ElysiaJS modular monolith, frontend TanStack Start, autentikasi Better Auth, caching Redis terpusat, ORM Drizzle dengan PostgreSQL, serta styling Tailwind CSS v4 + shadcn/ui. Visi produk: memangkas waktu bootstrap proyek dari hari menjadi menit dengan fondasi arsitektur, keamanan, dan pola pengembangan yang sudah teruji.

## 2. Problem Statement & Target Users
**Masalah:** Developer fullstack sering menghabiskan waktu berhari-hari menyiapkan integrasi auth, role/permission, caching, ORM, dan struktur monorepo dari nol. Boilerplate yang ada umumnya terpisah-pisah, tidak memanfaatkan Bun, atau tidak mengikuti pola modular monolith resmi Elysia.

**Target Pengguna:**
- Developer backend/fullstack yang ingin memulai proyek Bun dengan cepat.
- Startup/indie hacker yang membutuhkan fondasi autentikasi, RBAC, cache, dan database siap produksi.
- Tim engineering yang ingin standar internal monorepo dengan pola modular monolith.

## 3. System Scope & User Roles
Sistem berupa monorepo Bun dengan workspace:
- `apps/api` — backend ElysiaJS modular monolith
- `apps/web` — frontend TanStack Start
- `packages/shared` — tipe & utilitas bersama
- `packages/auth` — integrasi Better Auth server & client
- `packages/db` — schema Drizzle & koneksi PostgreSQL
- `packages/ui` — komponen shadcn/ui

**Matriks Peran & Izin:**

| Peran | Izin |
|:---|:---|
| Super Admin | Semua izin: manajemen user, role, permission, semua modul |
| Admin | Izin modul tertentu (contoh: `posts:write`, `users:read`), tanpa mengubah role |
| User | Akses endpoint terautentikasi, baca/tulis data milik sendiri |
| Guest | Hanya endpoint publik (health, metadata) |

Role & permission bersumber dari Better Auth admin plugin (DEC-004, DEC-005).

## 4. Functional Requirements
- **FR-01** — Monorepo Bun dengan workspace `apps/*` dan `packages/*`; perintah `bun run dev` menjalankan API & web secara paralel.
- **FR-02** — Backend ElysiaJS menerapkan modular monolith; setiap modul diekspor sebagai Elysia plugin mandiri dengan prefix route sendiri, lalu di-compose di `apps/api/src/index.ts` (DEC-003).
- **FR-03** — Batasan antar modul mengikuti pola adaptasi basic ElysiaJS (DEC-002); modul berkomunikasi via export service/helper, tanpa berbagi state langsung.
- **FR-04** — Caching Redis terpusat menggunakan `ioredis` (DEC-001); helper cache menyediakan `get`, `set`, `del`, `wrap` dengan TTL konfigurable per modul.
- **FR-05** — Autentikasi Better Auth server-side di `apps/api` meliputi email/password, OAuth Google, dan plugin admin/access-control untuk role & permissions (DEC-004/DEC-005).
- **FR-06** — Frontend TanStack Start terintegrasi dengan Better Auth client-side: session provider, halaman login/register, callback OAuth, logout.
- **FR-07** — TanStack Form digunakan untuk form autentikasi dan satu form contoh modul (mis. profile update) dengan validasi runtime.
- **FR-08** — Drizzle ORM terhubung ke PostgreSQL; migrasi via Drizzle Kit; dev seed membuat user awal + role Super Admin.
- **FR-09** — RBAC mengikuti model access control Better Auth admin plugin: setiap modul mendeklarasikan permission (mis. `posts:read`, `posts:write`); middleware Elysia memeriksa permission sebelum handler.
- **FR-10** — Admin-facing: modul admin menyediakan manajemen user & role (assign/unassign role, daftar permission) menggunakan Better Auth admin client.
- **FR-11** — Modul contoh `posts` menampilkan pola end-to-end: endpoint terproteksi permission, validasi input, caching Redis, dan akses DB via Drizzle.
- **FR-12** — Tailwind CSS v4 + shadcn/ui disiapkan sebagai base styling; komponen auth-ready (Button, Input, Card) tersedia.

## 5. Non-Functional Requirements

| Kategori | Target |
|:---|:---|
| Performansi | Cold start API < 200 ms (Bun); p95 response < 50 ms untuk endpoint cache-hit |
| Skalabilitas | Redis cache terpusat mendukung horizontal scaling backend; pool koneksi PostgreSQL via Drizzle |
| Keamanan | Better Auth session aman, OAuth dengan PKCE, password hashing default; RBAC default deny |
| Portabilitas | Setup lokal via `bun install && bun run dev`; docker compose untuk PostgreSQL & Redis |
| Reliabilitas | Graceful shutdown, health check endpoint, migrasi idempotent |

## 6. Technology Stack & Rationale

| Komponen | Teknologi | Alasan |
|:---|:---|:---|
| Runtime | Bun 1.1+ | All-in-one runtime & package manager, native TypeScript, install/start cepat |
| Backend Framework | ElysiaJS 1.2+ | Type-safe, performa tinggi, pola plugin resmi untuk modular monolith (DEC-002/DEC-003) |
| Frontend Framework | TanStack Start 1.0+ | Fullstack React, SSR/routing, terintegrasi TanStack Query |
| Database & ORM | PostgreSQL 17 + Drizzle ORM 0.36+ | Relasional ACID, type-safe schema, ringan, migrasi via Drizzle Kit |
| Authentication | Better Auth 1.0+ | Dukungan email/password, OAuth Google, admin/access-control plugin (DEC-004/DEC-005) |
| Caching | Redis 7 + ioredis | Cache in-memory terpusat sesuai DEC-001, TTL, siap produksi |
| Styling | Tailwind CSS v4 + shadcn/ui | Utility-first, komponen siap pakai, mudah dikustomisasi |

## 7. Success Metrics & KPIs

| Metrik | Target |
|:---|:---|
| Waktu bootstrap dari clone ke dev server berjalan | TBD menit (baseline setelah MVP) |
| Jumlah modul contoh siap pakai | 2 (auth, posts) |
| Keberhasilan login email/password & OAuth Google | 100% sesuai konfigurasi |
| Cache hit ratio endpoint contoh | TBD |
| Waktu menambah modul baru dengan RBAC | TBD menit per modul |

## 8. Risk Analysis & Mitigation

| Risiko | Dampak | Mitigasi |
|:---|:---|:---|
| Kompleksitas integrasi Better Auth admin plugin | High | Abstraksi di `packages/auth`, dokumentasi pola, seed role default |
| Perbedaan versi TanStack Start boilerplate | Medium | Pin versi dependency, CI check, lockfile eksplisit |
| Redis menjadi hard dependency di dev | Medium | Fallback in-memory untuk dev/test, Redis hanya wajib di produksi |
| Modular monolith over-engineered | Medium | Ikuti pola resmi Elysia, batasi modul contoh dua, dokumentasi batasan |
| Misconfiguration RBAC menyebabkan akses tak sah | High | Middleware default deny, test matriks permission, audit log sederhana |

## 9. Constraints & Assumptions
**Constraints:**
- Runtime hanya Bun; tidak mendukung Node.js fallback.
- PostgreSQL 17 dan Redis 7 wajib tersedia via docker compose.
- Better Auth server-side menjadi satu-satunya sumber kebenaran autentikasi & RBAC (DEC-004/DEC-005).

**Assumptions:**
- Pengguna familiar dengan Bun, React, dan struktur monorepo.
- Environment variables untuk OAuth Google, database, dan Redis disediakan pengguna.
- Detail role & permission per modul ditentukan saat implementasi; nilai angka pada KPI masih TBD sampai baseline MVP diukur.

## 10. Out of Scope
- Multi-tenancy, billing, dan payment processing.
- Arsitektur microservices atau event-driven; tetap modular monolith.
- Database selain PostgreSQL.
- Framework frontend selain TanStack Start.
- Template email reset password/verifikasi email lengkap (hanya scaffold konfigurasi).