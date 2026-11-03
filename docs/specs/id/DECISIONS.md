# Keputusan Arsitektur

Setiap keputusan penting dicatat di sini. Keputusan tidak pernah diubah diam-diam: revisi adalah entri baru yang menyebut entri yang digantikannya.

**Nilai status**
- **Answered**: disetujui product owner.
- **Decided (lead)**: diputuskan tech lead dalam batasan yang sudah disetujui product owner. Product owner bisa memvetonya; sampai saat itu keputusan mengikat.
- **Proposed**: rekomendasi yang menunggu jawaban. Jangan diimplementasikan.
- **Superseded**: digantikan entri yang lebih baru. Disimpan hanya sebagai penunjuk.

---

## DEC-001: Strategi caching

**Status:** Answered. Diperjelas oleh DEC-034 (produksi).

- **Keputusan:** Redis adalah cache terpusat agar instans API bisa diskalakan horizontal. Di dev/test tanpa Redis dipakai fallback in-memory. Di produksi Redis wajib ([ARCHITECTURE.md §6](ARCHITECTURE.md)).

## DEC-002: Batas modul

**Status:** Answered

- **Keputusan:** Mengikuti pola modular monolith "basic" resmi Elysia. Modul hanya berkomunikasi lewat service yang diekspor.

## DEC-003: Bentuk modul

**Status:** Answered

- **Keputusan:** Satu plugin Elysia per modul, masing-masing dengan prefix route sendiri, disusun di root app.

## DEC-004: Cakupan fitur auth

**Status:** Answered

- **Keputusan:** Email/password dan Google OAuth, plus manajemen role dengan role dan permission per modul.

## DEC-005: Model role dan permission

**Status:** Answered

- **Keputusan:** Admin plugin Better Auth dengan access control adalah satu-satunya sumber kebenaran untuk role dan permission.

## DEC-006: Prefix route API

**Status:** Answered (Q1)

- **Keputusan:** Semua route berada di bawah `/api` tanpa segmen versi. Prefix ditulis sekali di root app (`new Elysia({ prefix: '/api' })`). Modul hanya mendeklarasikan prefix-nya sendiri (`/posts`, `/admin`).
- **Trade-off:** Perubahan breaking di masa depan butuh grup `/api/v2` di samping route yang ada.

## DEC-007: Endpoint auth

**Status:** Answered (Q2)

- **Keputusan:** Handler Better Auth dipasang apa adanya di `/api/auth/*` dengan email/password dan Google OAuth. Tidak ada wrapper kustom `/api/auth/register` atau `/api/auth/login`. Konfigurasi mengikuti skill `better-auth-best-practices` dan `better-auth-security-best-practices` ([auth/README.md](auth/README.md)).
- **Trade-off:** Response dan kode error di `/api/auth/*` memakai format Better Auth, bukan format kita.

## DEC-008: Berkas modul backend

**Status:** Answered (Q3)

- **Keputusan:** `apps/api/src/modules/<name>/{index,service,model,permissions}.ts`. `index.ts` adalah controller, `model.ts` berisi skema `t`, `permissions.ts` berisi statement permission dan grant role milik modul (DEC-023).

## DEC-009: Gaya service

**Status:** Answered (Q4)

- **Keputusan:** `abstract class <Name>Service` dengan method `static` saja. Service melempar error bisnis dengan `moduleError(...)` (DEC-037). Modul lain hanya memanggil service ini.

## DEC-010: Guard permission

**Status:** Answered (Q5)

- **Keputusan:** Sebuah macro Elysia pada plugin bernama di `apps/api/src/utils/auth/index.ts`. Route mendeklarasikan `{ permission: 'posts:read' }` atau `{ auth: true }`; macro memasukkan `user` dan `session` ke context. Default menolak.

## DEC-011: Struktur frontend

**Status:** Answered (Q6)

- **Keputusan:** `apps/web/src/features/<feature>/{components,hooks,lib,pages,index.ts}`. Berkas route di `src/routes/` tetap tipis. Komponen se-aplikasi di `src/components/`, primitif shadcn di `packages/ui`.

## DEC-012: Feature flag hanya desain

**Status:** Answered. Diperluas oleh DEC-029 dan DEC-038.

- **Keputusan:** Feature flag memakai standar OpenFeature, didesain di [feature-flags/README.md](feature-flags/README.md). Tidak ada paket OpenFeature yang dipasang di MVP.

## DEC-013: Logging dengan pino, tanpa OpenTelemetry

**Status:** Answered (Q7)

- **Keputusan:** pino, tanpa OpenTelemetry. JSON ke stdout; `pino-pretty` hanya di dev. Korelasi memakai request ID (`x-request-id`), bukan trace ID.
- **Trade-off:** Tidak ada distributed tracing dan tidak ada span Postgres/Redis otomatis. Bisa ditambah nanti sebagai sink baru tanpa mengubah pemanggil (DEC-014).

## DEC-014: Telemetry event manual dengan sink yang bisa diganti

**Status:** Answered (Q7/Q8)

- **Keputusan:** Kode aplikasi hanya memanggil `telemetry.emit(event, payload)` terhadap katalog event bertipe. Sink menentukan ke mana event dikirim ([observability/README.md](observability/README.md)).
- **Trade-off:** Satu lapisan kecil untuk dirawat. Sebagai gantinya, menambah atau mengganti tujuan cukup satu berkas sink baru dan pemanggil tidak berubah.

## DEC-015: Tempat melihat data observability

**Status:** Answered (Q8). Diperbarui oleh DEC-034.

- **Keputusan:** Di dev, log dibaca di terminal (pretty-print). Di produksi, telemetry event disimpan di MongoDB (DEC-034) dan di-query di sana. Tanpa SDK metrik: latensi dan error rate berasal dari event `http.request`. Telemetry frontend di luar cakupan.

## DEC-016: Audit log

**Status:** Answered (Q9)

- **Keputusan:** `databaseHooks` dan `hooks.after` Better Auth memancarkan telemetry event `audit.*`. Event ini disimpan bersama event lain di log store MongoDB (kind `audit`, retensi 365 hari). Tidak ada tabel audit di PostgreSQL.

## DEC-017: Format response modul kita

**Status:** Answered (Q10)

- **Keputusan:** Tanpa wrapper `{ success, data }`. Handler mengembalikan objek langsung. Error adalah status HTTP plus `{ code, message, details? }` lewat satu global error handler. List berbentuk `{ items, meta }`.

## DEC-018: Pengambilan data frontend dan batas fitur

**Status:** Answered (Q11)

- **Keputusan:** Satu klien Eden di `apps/web/src/lib/api.ts`. Hook TanStack Query di `features/*/hooks`. Fitur saling mengimpor hanya lewat `index.ts`, ditegakkan lint rule. `profile` tidak punya modul backend: ia memanggil `updateUser` Better Auth.

## DEC-019: Penyimpanan sesi dan rate limit

**Status:** Answered (Q12)

- **Keputusan:** Redis adalah `secondaryStorage` Better Auth; `session.storeSessionInDatabase: true` agar admin bisa melihat dan mencabut sesi. Rate limit di Redis (`storage: "secondary-storage"`). Tanpa `REDIS_URL` (hanya dev/test): tanpa secondary storage, rate limit di memori.

## DEC-020: Satu origin dan baseline keamanan Better Auth

**Status:** Answered (Q13)

- **Keputusan:** Web dan API berbagi **satu origin**. `/api/*` diteruskan ke API oleh proxy dev di lokal dan reverse proxy di produksi. `baseURL` adalah origin web publik, `trustedOrigins` hanya `[WEB_URL]`, `crossSubDomainCookies` mati, CSRF aktif ([auth/README.md](auth/README.md)).
- **Trade-off:** Produksi butuh reverse proxy. Sebagai gantinya: tanpa CORS, cookie biasa, jauh lebih sedikit salah konfigurasi cookie/CSRF.

## DEC-021: Tata letak dokumentasi

**Status:** Superseded oleh DEC-030, lalu DEC-031.

## DEC-022: Role didefinisikan di kode; tanpa tabel role

**Status:** Answered (Q14)

- **Keputusan:** Tidak ada tabel `role`. Role berada di role registry bertipe di kode. Proyek menambah role kustom dengan menambah entri registry dan memberi permission di berkas modul yang membutuhkannya. Satu user boleh memegang beberapa role (dipisah koma oleh Better Auth). Desain di [auth/access/static-roles.md](auth/access/static-roles.md).
- **Trade-off:** Mengubah kemampuan sebuah role butuh deploy.

## DEC-023: Tempat permission dideklarasikan dan cara penggabungannya

**Status:** Decided (lead)

- **Keputusan:** `permissions.ts` setiap modul mengekspor `statement` dan `grants` per role. `apps/api/src/utils/auth/access.ts` menggabungkannya. `packages/auth` mengekspor `createAuth({...})`; `apps/api/src/utils/auth/auth.ts` memanggilnya dan menjadi berkas yang dibaca CLI Better Auth. `super_admin` diturunkan (setiap action dari setiap statement). Aplikasi web mendapat permission user saat ini dari `GET /api/me/permissions`.
- **Trade-off:** CLI Better Auth butuh `--config apps/api/src/utils/auth/auth.ts`.

## DEC-024: Manajemen user memakai endpoint admin plugin

**Status:** Answered (Q15)

- **Keputusan:** Aplikasi web memanggil `authClient.admin.*` di `/api/auth/admin/*`. "User tidak bisa mengubah role-nya sendiri" adalah aturan `hooks.before`. Modul `admin` kita hanya menambah `GET /api/admin/roles`.

## DEC-025: Impersonation didesain tetapi dimatikan

**Status:** Superseded oleh DEC-032.

## DEC-026: Telemetry sink di MVP

**Status:** Answered (Q16). Diubah oleh DEC-034.

- **Keputusan:** MVP memuat sink `log` (stdout), sink `mongo` (DEC-034), dan sink `memory` (test). Sentry dan PostHog hanya desain (DEC-036).

## DEC-027: Data sensitif tidak pernah di-log

**Status:** Answered

- **Keputusan:** Empat lapis: payload bertipe yang membawa ID alih-alih data pribadi; scrubber di dalam `telemetry.emit` sebelum sink mana pun; path `redact` pino; scrubbing di sisi vendor. URL mentah, query string, body, cookie, dan header auth tidak pernah di-log ([observability/redaction.md](observability/redaction.md)).

## DEC-028: Penyimpanan log terpusat (usulan Loki)

**Status:** Superseded oleh DEC-034 dan DEC-035.

## DEC-029: Provider feature flag dan rollout persentase

**Status:** Decided (lead), desain saja. Targeting dipersempit oleh DEC-038.

- **Keputusan:** Dua provider di balik API OpenFeature yang sama: (1) **database provider**, default, di atas tabel PostgreSQL `feature_flag`, dievaluasi di memori, dengan rollout persentase deterministik; (2) **PostHog provider** untuk eksperimen dan analitik flag. Flag selalu dievaluasi di API; aplikasi web membaca `GET /api/feature-flags/evaluate`.
- **Trade-off:** Database provider harus kita rawat sendiri dan tanpa analitik. PostHog menambah vendor, biaya, dan ketergantungan jaringan.

## DEC-030: Spec mandiri dan berbahasa Inggris

**Status:** Superseded oleh DEC-031.

## DEC-031: Spec dwibahasa dan PRD yang disusun darinya

**Status:** Answered (putaran 4)

- **Keputusan:** Spec berada di `docs/specs/eng/` (kanonis) dan `docs/specs/id/` (terjemahan Indonesia, berkas dan nomor bagian sama). Bila berbeda, versi Inggris menang dan terjemahan diperbaiki dalam perubahan yang sama. `PRD.md` di setiap folder menggantikan `PRODUCT.md` lama dan diturunkan dari spec. `docs/prd/` tetap dibekukan sebagai riwayat. README aplikasi (aturan coding) hanya dalam bahasa Inggris.
- **Trade-off:** Setiap perubahan spec dikerjakan dua kali. Perubahan di `eng/` tanpa perubahan `id/` yang sesuai ditolak saat review.

## DEC-032: Tanpa impersonation

**Status:** Answered (putaran 4: "hapus impersonation, tidak diimplementasikan")

- **Konteks:** Admin plugin Better Auth selalu menyertakan endpoint impersonation dan tidak punya opsi untuk mematikannya. Statement default-nya memuat `user:impersonate` dan `user:impersonate-admins`, dan user ID mana pun di `adminUserIds` melewati pengecekan role.
- **Keputusan:** Impersonation bukan bagian dari boilerplate ini:
  1. Statement modul `admin` mendaftar action admin plugin yang kita pakai **secara eksplisit**, bukan menyebarkan `defaultStatements`, sehingga action impersonate tidak ada di access control kita dan tidak ada role (termasuk `super_admin` turunan) yang bisa memegangnya.
  2. Aturan `hooks.before` menolak `/admin/impersonate-user` dan `/admin/stop-impersonating` dengan `404 NOT_FOUND`.
  3. `adminUserIds` tidak pernah diisi.
  4. Tidak ada field impersonation di event, log, aplikasi web, maupun variabel lingkungan.
- **Trade-off:** Skema `session` hasil generate masih memuat kolom impersonation plugin yang tidak terpakai; kolom itu diabaikan. Menambah impersonation nanti butuh keputusan baru.

## DEC-033: Yang boleh dilakukan `admin` terhadap user dan sesi

**Status:** Answered (Q19)

- **Keputusan:** `admin` mendapat `user:list`, `user:get`, `session:list`, dan `role:read`. Hanya `super_admin` yang mendapat `user:create`, `user:update`, `user:set-role`, `user:ban`, `user:delete`, `user:set-password`, `session:revoke`, `session:delete`.

## DEC-034: Log store MongoDB dengan retensi manual

**Status:** Answered (Q17: "manual dulu, MongoDB sebagai default"; Q18: "setuju, retensi dihapus manual")

- **Konteks:** Product owner menginginkan log store yang dikelola sendiri sekarang, dan Grafana Alloy + Loki nanti.
- **Opsi:** (a) MongoDB, ditulis oleh sink `mongo`; (b) tabel PostgreSQL di database aplikasi; (c) Loki + Alloy sejak hari pertama.
- **Keputusan:** **(a).** Setiap telemetry event level `info` ke atas dikirim ke stdout **dan**, lewat sink `mongo` yang asinkron dan berbatch, ke database MongoDB terpisah (koleksi `log_event`). Retensi per kind: `http` 14 hari, `app` 30, `error` 30, `product` 30, `audit` 365. Penghapusan dilakukan **manual**: operator menjalankan `bun run logs:prune` (dry-run dulu); tanpa TTL index dan tanpa scheduler di dalam aplikasi. `telemetry.flush()` mengosongkan buffer sink saat shutdown. Redis wajib di produksi (DEC-001 diperjelas). Desain di [observability/log-storage.md](observability/log-storage.md).
- **Trade-off:** Satu database lagi untuk dijalankan, dan API kini mengirim log sendiri (buffer terbatas, tidak pernah memblokir request). Bukan (b): log akan bersaing dengan query aplikasi di PostgreSQL. Belum (c): tiga layanan tambahan sebelum ada trafik yang membenarkannya.

## DEC-035: Jalur migrasi ke Grafana Alloy + Loki

**Status:** Answered (Q17: "pindah ke Alloy nanti"), desain saja

- **Keputusan:** Saat pemicu di [observability/migration-loki.md](observability/migration-loki.md) terjadi, Alloy mengumpulkan stdout dan mengirimkannya ke Loki, lalu sink `mongo` dimatikan. Retensi Loki tetap manual secara default (`retention_period: 0s` + delete API), dengan periode yang sama. Promtail tidak dipakai (end of life 2026-03-02). ELK Stack adalah alternatif yang terdokumentasi (DEC-041); hanya satu dari keduanya yang diadopsi.

## DEC-036: Sentry dan PostHog punya spec implementasi terpisah

**Status:** Answered (putaran 4), desain saja

- **Keputusan:** [observability/sentry.md](observability/sentry.md) (error tracking dengan `@sentry/bun`) dan [observability/posthog.md](observability/posthog.md) (analitik produk dengan `posthog-node`) masing-masing adalah rencana pembangunan dan migrasi yang berdiri sendiri. Keduanya tidak dibangun sampai ada keputusan baru yang mengadopsinya. Log manual (stdout + MongoDB) tetap menjadi baseline. PostHog hanya untuk analitik produk: PostHog Logs dan tracing tidak dipakai, dan sink analitik serta provider feature flag PostHog adalah integrasi terpisah yang hanya berbagi client ([observability/posthog.md §1.1–1.2](observability/posthog.md)).

## DEC-037: Log dan error membawa nama modul

**Status:** Answered (putaran 4: "tangkap modul mana yang error, tanpa nama route")

- **Keputusan:** Setiap controller modul memakai `moduleScope('<name>')`, yang menandai context request dengan `module`. Setiap baris log dan event di dalam route modul itu membawa `module`. `http.error` diidentifikasi oleh `module` + `code` dan tidak membawa route. Service melempar `moduleError('<module>', status, code, message)`; bila modul yang melempar berbeda dengan modul yang menangani, `http.error` juga membawa `sourceModule`. Error di luar modul memakai `module: "core"`; handler Better Auth memakai `module: "auth"` ([observability/README.md §4](observability/README.md)).
- **Trade-off:** Satu baris per controller. Sebagai gantinya, error dikelompokkan per modul walaupun route berubah.

## DEC-038: Feature flag menarget user, tidak pernah role

**Status:** Answered (putaran 4: "default database, targeting user tanpa targeting role")

- **Keputusan:** Evaluation context hanya `targetingKey` (user ID). Aturan targeting: kill switch, kecualikan user, sertakan user, rollout persentase. Tanpa targeting role, tanpa person property. Desain di [feature-flags/targeting.md](feature-flags/targeting.md). Database provider tetap default (DEC-029).
- **Trade-off:** "Nyalakan untuk semua admin" butuh daftar user eksplisit. Sebagai gantinya, flag tidak pernah bisa menjadi sistem access control kedua.

## DEC-039: Tata letak test mencerminkan modul dan fitur

**Status:** Answered (putaran 4)

- **Keputusan:**
  - API: `apps/api/tests/modules/<module>/` (test service dan route), `tests/utils/<util>/`, `tests/e2e/<module>/` (test HTTP terhadap stack yang berjalan), `tests/helpers/`.
  - Web: `apps/web/tests/features/<feature>/`, `tests/lib/`, `tests/components/`, `tests/helpers/`; flow E2E di `apps/web/e2e/<feature>/*.yaml` yang dijalankan sistem E2E workspace.
  - Runner: `bun test` di kedua aplikasi. Nama folder sama persis dengan nama modul atau fitur. Desain di [TESTING.md](TESTING.md).
- **Trade-off:** Test tidak berada di samping kode. Sebagai gantinya, folder modul dan fitur mempertahankan tata letak berkasnya yang tetap (DEC-008, DEC-011) dan folder test mudah ditemukan dari namanya.

## DEC-040: Tanpa nama produk

**Status:** Answered (putaran 5: "hapus BunForge, itu hanya nama")

- **Konteks:** "BunForge" berasal dari PRD awal. Itu hanya nama, tetapi tertanam di package scope, prefix cookie auth, dan nama database, yang mahal untuk diganti setelah kode ada.
- **Keputusan:** Proyek tidak punya nama produk; spec menyebutnya "boilerplate". Identifier netral menggantikan nama itu:
  - Package scope `@repo/*` (`@repo/db`, `@repo/ui`, …), konvensi umum untuk paket internal monorepo yang tidak pernah dipublikasikan.
  - Better Auth `advanced.cookiePrefix: "app"`, menghasilkan `app.session_token` (`__Secure-app.session_token` di HTTPS). Bukan default Better Auth `better-auth`, yang memberi tahu siapa pun yang membaca cookie library auth apa yang berjalan di balik aplikasi.
  - Default database log MongoDB `app_logs`; database PostgreSQL test `app_test`; nama metadata provider feature flag `database`.
- **Trade-off:** Proyek yang dibangun dari boilerplate ini dan ingin identifier sendiri mengubahnya sebelum deploy pertama. Setelah itu, mengubah prefix cookie membuat semua user ter-sign-out sekali, dan mengganti nama database butuh migrasi data.

## DEC-041: ELK Stack sebagai target migrasi log alternatif

**Status:** Answered (putaran 5: "buat spec migrasi memakai ELK stack"), desain saja

- **Konteks:** DEC-035 merencanakan perpindahan dari MongoDB ke Grafana Alloy + Loki. Product owner ingin ELK Stack juga didokumentasikan.
- **Opsi:** (a) hanya Loki; (b) hanya ELK; (c) keduanya didokumentasikan, tepat satu dipilih saat migrasi.
- **Keputusan:** **(c).** [observability/migration-elk.md](observability/migration-elk.md) menjelaskan Filebeat → Logstash → Elasticsearch → Kibana, satu data stream per `kind`, rollover harian, dan penghapusan backing index lama secara **manual** (tanpa fase delete ILM, tanpa `data_retention`), dengan periode DEC-034. Loki tetap rekomendasi default; ELK dipilih bila salah satu kondisi di migration-elk.md §1 terpenuhi (pencarian ber-index pada field berkardinalitas tinggi, platform Elastic yang sudah ada, pencarian full-text di error). API sendiri tidak pernah berbicara dengan Elasticsearch.
- **Trade-off:** Dua spec migrasi yang harus dijaga tetap terbaru. ELK butuh memori, disk, dan operasional lebih besar dari Loki, sebagai ganti setiap field yang di-mapping ter-index.

## DEC-042: Satu access mode per proyek, default static roles

**Status:** Answered (putaran 6: Q20 "default static roles dengan admin plugin", Q26 "rename rbac")

- **Konteks:** Product owner ingin role yang bisa dibuat saat runtime dan jalur menuju multi-tenancy, sambil tetap menjadikan role berbasis kode yang sederhana sebagai default.
- **Opsi:** (a) hanya static roles; (b) ketiga mode di balik switch konfigurasi; (c) tiga mode terdokumentasi, satu dipilih per proyek.
- **Keputusan:** **(c).** Mode-nya adalah **static-roles** (default, admin plugin, role di kode), **single-org** (organization plugin dengan dynamic access control dan satu organisasi tersembunyi), dan **multi-tenant** (banyak organisasi). Proyek mencatat mode-nya sebelum TASK-03. Hanya mode itu yang dibangun. Perpindahan hanya maju (static-roles → single-org → multi-tenant) dan mengikuti [auth/access/migration.md](auth/access/migration.md). `auth/rbac.md` di-rename menjadi [auth/access/static-roles.md](auth/access/static-roles.md); aturannya tidak berubah. DEC-022 (tanpa tabel role) dan DEC-024 berlaku untuk static-roles; organization mode menambah tabel `organization_role` milik plugin. Desain di [auth/access/README.md](auth/access/README.md).
- **Trade-off:** Tiga spec yang harus dijaga tetap terbaru. Bukan (b): kode auth yang harus diamankan dan dites menjadi tiga kali lipat.

## DEC-043: Lapisan platform dan lapisan organisasi di organization mode

**Status:** Answered (putaran 6: Q21)

- **Keputusan:** Di organization mode, admin plugin tetap dipakai, hanya untuk platform. `user.role` memegang role platform (`super_admin`, `user`, role kode opsional seperti `platform_support`) dan tidak memberi permission modul. `member.role` (organization plugin) memegang role organisasi dan memberi semua permission modul. Route memakai `permission` (organisasi) atau `platformPermission` (platform), tidak pernah keduanya. Desain di [auth/access/single-org.md §4, §8](auth/access/single-org.md) dan [saas/platform-console.md](saas/platform-console.md).
- **Trade-off:** `super_admin` yang ingin mengubah konten harus juga menjadi member dengan role yang sesuai. Sebagai gantinya, kedua sistem tidak pernah tumpang tindih atau menyimpang.

## DEC-044: `organization_id` di tabel modul pada kedua organization mode

**Status:** Answered (putaran 6: Q22)

- **Keputusan:** Di single-org dan multi-tenant, setiap tabel modul punya `organization_id NOT NULL`, setiap fungsi repository menerima `orgId` sebagai argumen pertama, dan cache serta log membawa organisasi ([auth/access/single-org.md §5](auth/access/single-org.md)). Karena itu single-org bisa tumbuh menjadi multi-tenant tanpa migrasi data.
- **Trade-off:** Satu kolom, satu prefix index, dan satu filter per tabel di single-org, padahal hanya ada satu organisasi.

## DEC-045: Spec terpisah untuk inti organisasi, multi-tenancy, dan konsol platform

**Status:** Answered (putaran 6: Q23, Q24). Susunan berkas digantikan oleh DEC-047.

- **Keputusan:** `auth/access/organization.md` (kini [single-org.md](auth/access/single-org.md), DEC-047) memuat inti organisasi bersama dan mode single-org. [saas/multi-tenant.md](saas/multi-tenant.md) hanya memuat tambahan multi-tenant (aturan isolasi, onboarding, undangan, pindah organisasi, siklus hidup, suite test isolasi). `auth/access/platform-console.md` (kini [saas/platform-console.md](saas/platform-console.md), DEC-047) memuat konsol pemilik SaaS: user dan session lewat endpoint admin plugin, organisasi lewat `/api/platform/*`, hanya-baca terhadap konten pelanggan, setiap request diaudit, tanpa impersonation.
- **Trade-off:** Pembaca multi-tenant membaca dua berkas. Sebagai gantinya, tidak ada yang ditulis dua kali.

## DEC-046: Isolasi tenant tanpa row-level security database

**Status:** Superseded oleh DEC-051 (lapisan aplikasi tetap; row-level security ditambahkan)

- **Keputusan:** Isolasi multi-tenant ditegakkan di aplikasi: helper repository bertipe `scoped(orgId)`, cek CI terhadap query tanpa scope, `404` untuk record tenant lain, dan suite test isolasi wajib ([saas/multi-tenant.md §3, §13](saas/multi-tenant.md)). PostgreSQL RLS tidak dipakai di versi pertama.
- **Trade-off:** Bug di helper tidak tertangkap oleh database. RLS tetap menjadi opsi bila audit mewajibkan penegakan di level database.

## DEC-047: Access stage, dan SaaS dipisah dari access

**Status:** Answered (putaran 7: "pisahkan SaaS dan access; static-roles sebagai default, lalu single-org, lalu multi-tenant terakhir; buat alur migrasinya jelas")

- **Konteks:** Spec access mencampur tiga urusan: tahapnya, perpindahan antar tahap, dan menjalankan aplikasi sebagai bisnis SaaS. Product owner menginginkan alur maju yang jelas dan SaaS dipisah.
- **Keputusan:**
  - Tiga access mode dinamai **tahap (stage)**: tahap 1 static-roles (default), tahap 2 single-org, tahap 3 multi-tenant. Proyek berada di satu tahap dan maju satu langkah setiap kali: **Langkah A** (1 → 2) dan **Langkah B** (2 → 3). [auth/access/migration.md](auth/access/migration.md) ditulis ulang berdasarkan dua langkah itu, dengan detail di lampiran.
  - `auth/access/organization.md` diganti nama menjadi [single-org.md](auth/access/single-org.md). Tahap 3 memakai semuanya kecuali §10 (satu organisasi tersembunyi).
  - **Lapisan platform** (role platform, user, ban, session, pengelolaan flag) termasuk access dan dimulai di tahap 2 ([single-org.md §8](auth/access/single-org.md)). Task-nya ORG-07 dan ORG-08 (dulu PC-01 dan sebagian PC-04).
  - **Lapisan SaaS** ada di [saas/](saas/README.md): konsol platform (direktori organisasi, suspend, audit lintas tenant; dipindah dari `auth/access/platform-console.md`), tenant rollout, plan dan billing. Task-nya PC-01 sampai PC-03.
  - Ini menggantikan susunan berkas di DEC-045. Aturan di DEC-043 sampai DEC-046 tidak berubah.
- **Trade-off:** Pembaca tahap 3 membaca [single-org.md](auth/access/single-org.md), [multi-tenant.md](saas/multi-tenant.md), dan [saas/platform-console.md](saas/platform-console.md). Sebagai gantinya, setiap berkas mencakup satu tahap atau lapisan, dan tidak ada yang ditulis dua kali.

## DEC-048: Feature flag di setiap access stage

**Status:** Answered (putaran 7: Q27 "ID organisasi untuk multi-tenant"). Bagian Q30 (pengelolaan flag di lapisan platform) adalah Decided (lead).

- **Keputusan:**
  - Flag tetap **global** di setiap tahap: tabel `feature_flag` tidak punya `organization_id`, dan tenant tidak pernah mengelola flag.
  - **Tahap 2 dan 3:** `feature_flag:read|write` pindah dari statement modul ke statement **platform**, sehingga hanya role platform (`super_admin`, opsional `platform_support`) yang mengelola flag. Tidak ada role organisasi atau role runtime yang bisa memegangnya (keputusan lead untuk Q30: flag berlaku untuk seluruh aplikasi, dan memutuskannya di tahap 2 berarti tahap 3 tidak mengubah apa pun).
  - **Tahap 3:** evaluation context menambah `organizationId` (organisasi aktif), dan percentage rollout meng-hash `organizationId`, sehingga seluruh perusahaan mendapat jawaban yang sama (Q27). Daftar include/exclude user tetap berlaku. `organizationId` adalah satu-satunya atribut organisasi (tanpa plan, ukuran, atau negara). Ini mengubah "hanya ID user" di DEC-038 untuk tahap 3.
  - Daftar include/exclude organisasi dan urutan aturannya adalah tambahan SaaS ([saas/tenant-rollout.md](saas/tenant-rollout.md)), diputuskan di [saas/DECISIONS.md](saas/DECISIONS.md).
  - Desain di [feature-flags/access-stages.md](feature-flags/access-stages.md) (tahap 1 dan 2) dan [saas/feature-flags.md](saas/feature-flags.md) (multi-tenant, DEC-050).
- **Trade-off:** Di Langkah B, flag yang sedang di tengah percentage rollout teracak ulang. Di Langkah A, staf yang bisa melihat flag lewat `admin` butuh role platform agar tetap punya akses itu.

## DEC-049: Keputusan SaaS disimpan terpisah dan tidak bisa mengubah tahap 1 dan 2

**Status:** Answered (putaran 7: "buat keputusan SaaS terpisah; bisa bertentangan dengan static-roles, single-org, atau multi-tenant"). Aturan 1 diubah oleh DEC-050: lapisan SaaS kini dimulai dengan multi-tenant dan butuh tahap 2.

- **Keputusan:** Keputusan SaaS dicatat sebagai SAAS-xxx di [saas/DECISIONS.md](saas/DECISIONS.md), bukan di sini. Aturannya:
  1. Lapisan SaaS butuh tahap 3. Lapisan ini tidak pernah dibangun di tahap 1 atau 2.
  2. Keputusan SaaS boleh **menambah** ke tahap 3. Keputusan SaaS tidak boleh mengubah perilaku tahap 1 atau 2, atau aturan di DEC-042 sampai DEC-048.
  3. Bila keputusan SaaS butuh perubahan seperti itu, statusnya tetap **Proposed** sampai sebuah entri DEC di sini mencatat perubahan access-nya. Entri DEC di sini selalu menang atas entri SAAS.
- **Trade-off:** Dua log keputusan. Sebagai gantinya, proyek di tahap 1 atau 2 tidak perlu membaca keputusan SaaS, dan pilihan SaaS tidak bisa diam-diam merusak build default.

## DEC-050: Access mencakup tahap 1 dan 2; multi-tenant dan semua kebutuhannya pindah ke SaaS

**Status:** Answered (putaran 8: "untuk access cukup bahas static-roles dan single-org, karena single-org sudah bisa menangani role dan permission; pisahkan multi-tenant, observability, feature flag, dan arsitektur API-nya ke saas/")

- **Konteks:** Tahap 2 sudah menjawab pertanyaan access (role dibuat saat runtime, permission diberikan dari statement di kode). Multi-tenancy menambah jenis pekerjaan lain: memisahkan data pelanggan, onboarding, konsol, observability per tenant. Menyimpannya di `auth/access/` mencampur keduanya, dan flag serta observability belum punya dokumen per tahap untuk perpindahan dari tahap 1 ke tahap 2.
- **Keputusan:**
  - [auth/access/](auth/access/README.md) hanya mencakup **tahap 1** (static-roles, default) dan **tahap 2** (single-org). [auth/access/migration.md](auth/access/migration.md) mencakup memulai proyek dan **Langkah A**, termasuk perubahan pada flag dan observability.
  - Multi-tenant pindah ke [saas/multi-tenant.md](saas/multi-tenant.md) dan menjadi fondasi lapisan SaaS. Migrasinya (**Langkah B**) ada di [saas/migration.md](saas/migration.md); arsitektur dan isolasinya di [saas/architecture.md](saas/architecture.md); flag-nya di [saas/feature-flags.md](saas/feature-flags.md); observability-nya di [saas/observability.md](saas/observability.md).
  - Dokumen per tahap untuk tahap 1 dan 2: [feature-flags/access-stages.md](feature-flags/access-stages.md) dan [observability/access-stages.md](observability/access-stages.md) yang baru. Tahap 2 menambahkan `organizationId` ke konteks log, event startup `access.*`, dan event `audit.org.*`.
  - "Access stage 3" di DEC-042 sampai DEC-049 kini berarti "multi-tenant (SaaS)". Aturannya tidak berubah, kecuali DEC-046 (digantikan DEC-051) dan aturan 1 DEC-049 (lapisan SaaS butuh tahap 2 dan dimulai dengan multi-tenant).
  - ID task tetap: MT-01 sampai MT-10, MIG-04 dan MIG-05 (Langkah B) ada di `saas/`; FF-ORG-02 berganti nama menjadi FF-MT-01.
- **Trade-off:** Pembaca multi-tenant mulai di `saas/` dan mengikuti link ke `auth/access/single-org.md`. Sebagai gantinya, proyek yang tetap di tahap 1 atau 2 tidak pernah membaca apa pun tentang tenant.

## DEC-051: Row-level security sebagai lapisan isolasi kedua di multi-tenant

**Status:** Decided (lead), setelah product owner melaporkan "multi-tenant tidak memakai RLS" sebagai bug (putaran 8). Menggantikan DEC-046.

- **Konteks:** DEC-046 hanya mengandalkan lapisan aplikasi. Cek CI-nya hanya mencocokkan `db.select`/`db.update`/`db.delete` di `repository.ts`, jadi relational query, raw SQL, `insert … select`, join, dan background job bisa membaca atau menulis baris tenant lain tanpa ketahuan, dan satu bug di `scoped()` membocorkan semua modul sekaligus ([saas/architecture.md §3.2](saas/architecture.md)).
- **Opsi:** (a) tetap isolasi lapisan aplikasi saja dengan cek yang lebih ketat; (b) lapisan aplikasi **ditambah** PostgreSQL row-level security; (c) schema atau database per tenant.
- **Keputusan:** **(b).** Di multi-tenant:
  - Setiap tabel modul dengan `organization_id` mendapat `ENABLE` + `FORCE ROW LEVEL SECURITY` dan satu policy `tenant_isolation` yang membandingkan `organization_id` dengan setting lokal transaksi `app.org_id`. Tabel Better Auth dan `feature_flag` tanpa RLS.
  - `scoped(orgId)` membuka transaksi dan men-set `app.org_id` dengan `set_config(…, true)`; ia tetap satu-satunya jalan kode modul ke tabel modul (aturan lint terhadap import `db` di `modules/*`, menggantikan cek grep lama).
  - Tiga role database: `app_owner` (migrasi, purge), `app_runtime` (API, RLS ditegakkan), `app_platform` (hanya `*AcrossTenants`, hanya `SELECT`, melewati RLS).
  - Pelanggaran policy adalah bug: `500`, ditambah event `security.tenant_violation` dengan alert.
  - Tahap 2 tanpa RLS (satu organisasi, tidak ada yang perlu dilindungi). Langkah B menambahkannya di rilis tersendiri (B1) sebelum tenant dibuka (B2).
  - Desain di [saas/architecture.md §4](saas/architecture.md) dan [saas/migration.md §3.2](saas/migration.md).
- **Trade-off:** Satu transaksi dan satu statement tambahan per unit kerja, tiga URL database, dan migrasi yang harus berjalan sebagai role owner. Bukan (a): sebuah cek hanya bisa menemukan kesalahan yang memang ditulis untuknya. Bukan (c): migrasi dan pool koneksi berlipat dengan setiap tenant.

## DEC-052: Catatan implementasi berada di luar spec

**Status:** Dijawab (putaran 9: "jika implementasi task perlu memperbarui spec, buat docs/implement-boilerplate/static-role (default) dengan spec sebagai referensi")

- **Konteks:** Beberapa task menetapkan nilai yang dibiarkan terbuka oleh spec (kode error dan path Better Auth yang sebenarnya, port dev web, waktu bootstrap). Brief task sebelumnya meminta worker menulisnya ke `docs/specs/eng/` dan `docs/specs/id/`, sehingga desain bercampur dengan hasil build dan tiket yang berjalan paralel mengubah file spec yang sama.
- **Keputusan:**
  - `docs/specs/` tetap menjadi referensi desain. Tiket implementasi membacanya dan tidak pernah mengubahnya.
  - Semua yang perlu dicatat oleh task implementasi ditulis di [docs/implement-boilerplate/static-role/](../../implement-boilerplate/static-role/README.md), satu file per task (`TASK-NN-<slug>.md`), hanya dalam bahasa Inggris.
  - Folder ini per tahap akses: `static-role/` mencakup build default. Build tahap 2 nanti mendapat foldernya sendiri.
  - Penyimpangan tercatat yang bertentangan dengan entri DEC perlu diterima product owner sebelum di-merge.
- **Trade-off:** Pembaca melihat dua tempat: spec untuk desain, catatan untuk apa yang dibangun. Sebagai gantinya spec tetap stabil dan paritas dua bahasa tidak pernah rusak oleh pekerjaan build.
