# PRD

Kebutuhan produk, disusun ulang dari spec yang sudah disepakati (DEC-031). Bila dokumen ini merangkum suatu topik, detailnya ada di spec yang ditautkan; keputusan di balik setiap baris ada di [DECISIONS.md](DECISIONS.md).

## 1. Ringkasan

Proyek ini adalah boilerplate monorepo Bun kelas produksi untuk aplikasi full-stack: API Elysia bergaya modular monolith, aplikasi web TanStack Start, Better Auth (email/password + Google), kontrol akses berbasis role, caching Redis, Drizzle di PostgreSQL, logging terstruktur ke MongoDB, serta Tailwind CSS v4 dengan shadcn/ui.

**Tujuan:** memangkas waktu bootstrap proyek dari hitungan hari menjadi menit, dengan arsitektur, baseline keamanan, dan aturan pengembangan yang sudah diputuskan dan didokumentasikan.

## 2. Masalah

Developer full-stack menghabiskan berhari-hari merangkai auth, role dan permission, caching, ORM, logging, dan struktur monorepo dari nol. Boilerplate yang ada terpecah-pecah, tidak memakai Bun, atau tidak mengikuti pola modul resmi Elysia. Akibatnya setiap proyek menciptakan ulang aturan yang sama untuk struktur, error, logging, dan test.

## 3. Pengguna

| Persona | Kebutuhan |
|:---|:---|
| Developer backend / full-stack | Memulai proyek Bun dengan cepat tanpa merancang ulang auth, RBAC, dan logging |
| Startup atau indie hacker | Auth, role, caching, dan database siap produksi sejak hari pertama |
| Tim engineering | Standar monorepo internal dengan aturan tertulis untuk modul, fitur, dan test |

## 4. Role di aplikasi bawaan

Role didefinisikan di kode; proyek bisa menambah role kustom ([auth/access/static-roles.md](auth/access/static-roles.md)).

| Role | Siapa | Bisa melakukan |
|:---|:---|:---|
| `super_admin` | Pemilik deployment | Semuanya: ubah role, ban, hapus user, cabut sesi |
| `admin` | Operator tepercaya | Kelola semua post; melihat daftar dan detail user serta sesinya; melihat katalog role |
| `user` | Siapa pun yang mendaftar (default) | Membaca post; membuat, mengubah, dan menghapus post miliknya; mengubah profilnya |
| Tamu | Tanpa sesi | Hanya endpoint publik (`/api/health`, sign-up, sign-in) |

## 5. Cakupan

### Termasuk (MVP)

| ID | Fitur | Spec |
|:---|:---|:---|
| F-01 | Sign-up, sign-in, sign-out email/password | [FEATURES.md §2](FEATURES.md) |
| F-02 | Sign-in Google dengan penautan akun | [FEATURES.md §3](FEATURES.md) |
| F-03 | Manajemen user dan role (admin plugin) serta katalog role | [FEATURES.md §4](FEATURES.md) |
| F-04 | Contoh modul `posts`: RBAC, kepemilikan, validasi, cache Redis | [FEATURES.md §5](FEATURES.md) |
| F-05 | Sesi di aplikasi web, halaman profil | [FEATURES.md §6](FEATURES.md) |
| F-06 | Observability: log JSON ke stdout dan MongoDB, error bertanda modul, audit event, redaksi, retensi manual | [FEATURES.md §7](FEATURES.md) |
| F-07 | Struktur test dan test dasar per modul dan per fitur, termasuk E2E | [TESTING.md](TESTING.md) |

### Tidak termasuk (MVP)

- Multi-tenancy (organisasi) di build default: didesain sebagai fondasi lapisan SaaS opsional, di atas access stage 2 ([saas/](saas/README.md), DEC-047, DEC-050). Billing dan pembayaran: didesain di lapisan SaaS yang sama.
- Microservices atau arsitektur event-driven.
- Database selain PostgreSQL untuk data aplikasi; framework web selain TanStack Start.
- Template email lengkap untuk verifikasi dan reset password (tautan ditulis ke log dev).
- Role yang bisa diubah saat runtime dari UI di build default (role adalah kode). Tersedia di access stage 2 ([auth/access/migration.md](auth/access/migration.md)).
- Impersonation. Bukan bagian dari boilerplate ini; endpoint admin plugin untuk itu diblokir (DEC-032).
- Feature flag di kode (desain di [feature-flags/](feature-flags/README.md)).
- Sentry dan PostHog (desain di [observability/sentry.md](observability/sentry.md) dan [observability/posthog.md](observability/posthog.md)).
- Grafana Alloy + Loki atau ELK Stack (migrasinya didesain di [observability/migration-loki.md](observability/migration-loki.md) dan [observability/migration-elk.md](observability/migration-elk.md); salah satunya dipilih saat pemicu terjadi).
- Telemetry frontend, distributed tracing, SDK metrik, UI penampil log.

## 6. Kebutuhan fungsional

| ID | Kebutuhan |
|:---|:---|
| FR-01 | Monorepo Bun dengan workspace `apps/*` dan `packages/*`; `bun run dev` menjalankan API dan web bersamaan. |
| FR-02 | API adalah modular monolith: setiap modul adalah plugin Elysia bernama dengan prefix route sendiri, disusun di `apps/api/src/index.ts` di bawah `/api` (tanpa segmen versi). |
| FR-03 | Modul saling berkomunikasi hanya lewat service yang diekspor; tidak ada state mutable bersama. |
| FR-04 | Cache Redis terpusat dengan `get`, `set`, `del`, `wrap`, `delPattern` dan TTL per modul; Redis wajib di produksi; fallback in-memory hanya di dev/test. |
| FR-05 | Better Auth di server: email/password, Google OAuth, admin plugin dengan access control. |
| FR-06 | Aplikasi web memakai Better Auth client: state sesi, login, register, kembali dari OAuth, logout. |
| FR-07 | TanStack Form untuk form auth dan form profil, dengan validasi runtime yang sama dengan API. |
| FR-08 | Drizzle ORM di PostgreSQL; migrasi dengan Drizzle Kit; seed dev membuat satu `super_admin`. |
| FR-09 | RBAC lewat access control Better Auth: setiap modul mendeklarasikan permission-nya; pengecekan di level route berjalan sebelum handler; default menolak. |
| FR-10 | Super Admin mengelola user dan role lewat endpoint admin plugin; pemegang `role:read` melihat katalog role. |
| FR-11 | Contoh modul `posts` menunjukkan pola lengkap: permission, aturan kepemilikan, validasi, cache, Drizzle. |
| FR-12 | Basis Tailwind CSS v4 + shadcn/ui dengan komponen siap untuk auth. |
| FR-13 | Observability: satu event `http.request` per request; event `http.error` ditandai dengan **modul** yang gagal; audit event untuk aksi keamanan; `x-request-id` di setiap baris log dan response; data sensitif diredaksi; event disimpan di MongoDB; event lama dihapus dengan perintah prune manual. |
| FR-14 | Test berada di satu folder per modul API dan satu folder per fitur web, untuk level unit, integrasi, dan E2E ([TESTING.md](TESTING.md)). |

## 7. Kebutuhan non-fungsional

| Kategori | Target |
|:---|:---|
| Performa | Cold start API < 200 ms; p95 < 50 ms pada endpoint cache-hit, diukur dari event `http.request` |
| Skalabilitas | Instans API stateless; Redis bersama untuk cache, sesi, dan rate limit; koneksi PostgreSQL ber-pool |
| Keamanan | Cookie sesi `httpOnly`; OAuth dengan PKCE dan state; pengecekan CSRF dan origin aktif; rate limit pada endpoint auth; RBAC default menolak; tanpa impersonation; tidak ada rahasia atau data pribadi di log |
| Keandalan | Graceful shutdown (mem-flush buffer log); endpoint health; migrasi idempoten; logging tidak pernah memblokir atau menggagalkan request |
| Observability | JSON di stdout selalu; log store MongoDB di produksi; retensi per kind, dihapus manual ([observability/log-storage.md](observability/log-storage.md)) |
| Portabilitas | `bun install && bun run dev` di lokal; docker compose untuk PostgreSQL, Redis, dan MongoDB |
| Kemudahan perawatan | Aturan tertulis per aplikasi ([apps/api/README.md](../../../apps/api/README.md), [apps/web/README.md](../../../apps/web/README.md)); folder test mencerminkan folder modul dan fitur |

## 8. Stack teknologi

| Komponen | Teknologi |
|:---|:---|
| Runtime | Bun 1.1+ |
| API | ElysiaJS 1.2+ |
| Web | TanStack Start 1.0+ (TanStack Router, Query, Form) |
| Database aplikasi | PostgreSQL 17 + Drizzle ORM + Drizzle Kit |
| Auth | Better Auth 1.x (plugin admin dan access-control) |
| Cache, sesi, rate limit | Redis 7 + ioredis |
| Logging | pino (stdout) + log store MongoDB 8 lewat driver resmi `mongodb` |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Test | `bun test` (API dan web), flow E2E workspace (web) |

*Verify* versi pasti saat monorepo di-bootstrap (TASK-01) dan kunci di lockfile.

## 9. Metrik keberhasilan

| Metrik | Target |
|:---|:---|
| Waktu dari clone sampai dev server berjalan | `TBD` (baseline diukur setelah MVP) |
| Contoh modul siap pakai | 2 (`auth` via Better Auth, `posts`) |
| Keberhasilan sign-in email/password dan Google | 100% dengan konfigurasi valid |
| Cakupan test matriks permission | Setiap route terlindungi × setiap role |
| Rasio cache hit pada endpoint contoh | `TBD` |
| Waktu menambah modul baru dengan RBAC dan test | `TBD` menit |

## 10. Rencana rilis

| Fase | Isi | Task |
|:---|:---|:---|
| P0 | Monorepo, infrastruktur dev | TASK-01, TASK-02 |
| P1 | Skema, logging, sink MongoDB dan perintah prune, cache, shutdown, test harness | TASK-03, TASK-07, TASK-12, TASK-13, TASK-15, TASK-18 |
| P2 | Auth dan RBAC | TASK-04, TASK-05 |
| P3 | Modul API | TASK-06, TASK-08 |
| P4 | Web | TASK-14, TASK-09, TASK-10, TASK-16, TASK-17 |
| P5 | Operasional: CI, suite E2E | TASK-11, TASK-19 |

Detail di [TASKS.md](TASKS.md).

## 11. Risiko

| Risiko | Dampak | Mitigasi |
|:---|:---|:---|
| Integrasi admin plugin Better Auth rumit | Tinggi | Satu tempat untuk konfigurasi auth; RBAC terdokumentasi; test matriks permission |
| Salah konfigurasi RBAC memberi akses | Tinggi | Default menolak; test matriks per role; snapshot compiled roles; audit event |
| Endpoint admin plugin yang tidak dipakai tetap bisa diakses | Tinggi | Diblokir oleh `hooks.before`; permission-nya tidak ada di statement; `adminUserIds` tidak pernah diisi (DEC-032) |
| Data sensitif bocor ke log atau vendor | Tinggi | Redaksi empat lapis beserta test ([observability/redaction.md](observability/redaction.md)) |
| Volume log MongoDB tumbuh tanpa batas | Sedang | Retensi per kind; perintah prune manual dengan dry-run; migrasi ke Loki atau ELK terdokumentasi |
| Gangguan log store memengaruhi API | Sedang | Sink asinkron berbatch dengan buffer terbatas; stdout selalu memuat setiap event |
| Perubahan versi TanStack Start | Sedang | Kunci versi; CI; lockfile di-commit |
| Modular monolith menjadi terlalu rumit | Sedang | Pola resmi Elysia; dua contoh modul; aturan tertulis |

## 12. Batasan dan asumsi

- Hanya Bun; tanpa fallback Node.js.
- PostgreSQL 17, Redis 7, dan MongoDB 8 lewat docker compose di dev.
- Better Auth adalah satu-satunya sumber kebenaran untuk autentikasi, role, dan permission.
- Pengguna memahami Bun, React, dan monorepo, serta menyediakan kredensial Google OAuth, database, Redis, dan MongoDB sendiri.
