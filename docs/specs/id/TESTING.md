# TESTING.md

Cara test diorganisasi dan apa yang wajib dimiliki setiap modul dan fitur (DEC-039). Aturan yang menegakkannya ada di [apps/api/README.md §10](../../../apps/api/README.md) dan [apps/web/README.md §9](../../../apps/web/README.md).

## 1. Level

| Level | App | Yang dibuktikan | Dijalankan terhadap | Folder |
|:---|:---|:---|:---|:---|
| Unit | api | Service, helper, atau fungsi murni benar | Tidak ada yang eksternal (mock, sink memory) | `apps/api/tests/modules/<module>/`, `tests/utils/<util>/` |
| Route (integrasi) | api | Route sebuah modul: validasi, auth, permission, error, tanda modul | `app.handle(new Request(...))` + PostgreSQL test | `apps/api/tests/modules/<module>/` |
| API E2E | api | Alur HTTP nyata lintas modul di stack yang berjalan | API berjalan + PostgreSQL + Redis + MongoDB | `apps/api/tests/e2e/<module>/` |
| Unit / komponen | web | Hook, helper `lib/`, form, halaman menampilkan state yang benar | happy-dom, klien API tiruan | `apps/web/tests/features/<feature>/` |
| Web E2E | web | Perjalanan user di browser sungguhan | Stack web + API yang berjalan | `apps/web/e2e/<feature>/*.yaml` |

## 2. Alat

| Kebutuhan | Alat |
|:---|:---|
| Runner (kedua app) | `bun test` (*verify* versi Bun mendukung fitur yang dipakai) |
| DOM untuk test web | `@happy-dom/global-registrator` di-preload lewat `bunfig.toml` (`[test] preload`) |
| Test React | `@testing-library/react` + `@testing-library/user-event` (*verify* kompatibilitas dengan versi React yang dipakai TanStack Start) |
| Mock modul | `mock.module()` dari `bun:test` |
| Asersi telemetry | sink `memory` |
| Web E2E | Sistem E2E workspace: flow YAML yang dijalankan runner-nya. Tanpa Playwright, Cypress, Puppeteer, atau Selenium |

## 3. Tata letak API

```
apps/api/tests/
  helpers/
    app.ts            menyusun app untuk app.handle(); sink memory; tanpa listen()
    db.ts             migrate sekali, truncate antar-berkas (PostgreSQL test)
    auth.ts           createUser(role), signIn(user) → header cookie
    mongo.ts          database MongoDB test untuk test sink mongo (di-drop setelah run)
  modules/<module>/   satu folder per src/modules/<module>, nama sama
    service.test.ts
    routes.test.ts
    permissions.test.ts
  utils/<util>/       satu folder per src/utils/<util>, nama sama (auth, telemetry, cache, error, logger, …)
  e2e/
    helpers/          client.ts (fetch dengan cookie jar ke API_E2E_URL), users.ts
    <module>/         satu folder per modul yang punya route, nama sama
      <flow>.test.ts
```

- Nama folder sama persis dengan nama folder modul atau util. Modul tanpa folder test ditolak saat review.
- `bun run test` (di `apps/api`) menjalankan `bun test tests/modules tests/utils`. `bun run test:e2e` menjalankan `bun test tests/e2e`. E2E tidak pernah ikut di `test`.
- PostgreSQL test: `DATABASE_URL` mengarah ke database terpisah `app_test`. `REDIS_URL` kosong (fallback memori) untuk test unit dan route.

### 3.1 Test wajib per modul

| Berkas | Wajib mencakup |
|:---|:---|
| `routes.test.ts` | Untuk setiap route: sukses; `400 VALIDATION_ERROR` hanya dengan path field; `401` tanpa sesi; `403` tanpa permission; `404` bila punya `:id`; aturan kepemilikan bila ada. Setiap response punya `x-request-id`. |
| `routes.test.ts` (logging) | Error yang dipaksa di route menghasilkan satu `http.error` di sink memory dengan `module: "<module>"` dan tanpa field route; `moduleError` membawa `sourceModule` |
| `service.test.ts` | Logika bisnis, payload cache hit = miss, invalidasi cache saat tulis, kode `moduleError` |
| `permissions.test.ts` | Grant modul muncul di snapshot compiled roles; setiap permission dipakai minimal oleh satu route |

Test lintas bagian di `tests/utils/`: matriks permission dan aturan guard (`auth/`, [auth/access/static-roles.md §11](auth/access/static-roles.md)), redaksi ([observability/redaction.md §7](observability/redaction.md)), sink `mongo` dan perintah prune (`telemetry/`, [log-storage.md §8](observability/log-storage.md)), pengecekan startup `moduleScope` (`logger/`).

### 3.2 API E2E

- **Stack:** `docker compose -f docker-compose.test.yml up` (PostgreSQL, Redis, MongoDB), migrasi dan seed, lalu API dijalankan dengan `NODE_ENV=test` dan `LOG_MONGO_URL` diisi. `API_E2E_URL` mengarah ke sana.
- **Isolasi:** setiap berkas test membuat user sendiri dengan email unik (`e2e+<run>-<n>@example.test`) lewat endpoint Better Auth; test tidak pernah bergantung pada urutan antar-berkas.
- **Alur wajib:**

| Folder | Alur |
|:---|:---|
| `e2e/auth/` | sign-up → sign-in → get-session → sign-out → 401; sign-in keenam dalam 60 dtk → 429; endpoint impersonation → 404 |
| `e2e/posts/` | user membuat, melihat daftar (cache hit setelah panggilan pertama), mengubah, dan menghapus post miliknya; user lain mendapat 403; admin mengubah post siapa pun; `x-request-id` dari request posts menemukan dokumen `http.request`-nya di MongoDB dengan `module: "posts"` |
| `e2e/admin/` | super_admin mengubah role dan `/api/me/permissions` berikutnya mencerminkannya; admin mendapat 403 pada set-role; katalog role |
| `e2e/me/` | permission per role |
| `e2e/health/` | 200 dengan semua dependensi; `logStore: "down"` tetap 200 saat MongoDB dimatikan |

Google OAuth tidak diotomatisasi secara end to end (butuh Google). Ia dicakup test route dengan provider tiruan dan dicek manual sebelum rilis.

## 4. Tata letak web

```
apps/web/tests/
  setup.ts            registrasi happy-dom, cleanup Testing Library
  helpers/
    render.tsx        render dengan QueryClient + context router test
    api-mock.ts       mock.module('@/lib/api') dan helper auth-client
  features/<feature>/ satu folder per src/features/<feature>, nama sama
    hooks.test.ts
    lib.test.ts
    <page-or-component>.test.tsx
  lib/                test untuk src/lib
  components/         test untuk src/components
apps/web/e2e/
  <feature>/          satu folder per fitur yang punya halaman, nama sama
    <flow>.yaml
```

- `bun run test` (di `apps/web`) menjalankan `bun test tests`.
- Komponen dites lewat apa yang dilihat user (role, label, teks), bukan nama class.

### 4.1 Test wajib per fitur

| Area | Wajib mencakup |
|:---|:---|
| Hook | Query key dari factory; `{ data, error }` diubah menjadi error yang dilempar dengan `status` dan `code`; mutation menginvalidasi key yang tepat |
| `lib/` | Skema form sama dengan batas API; pemetaan kode error |
| Form | Input valid ter-submit sekali; input tidak valid memblokir submit; `400 VALIDATION_ERROR` dari server tampil di field yang disebut |
| Halaman | State loading, kosong, error, dan forbidden; aksi tersembunyi tanpa permission (`can()` ditiru) |

## 5. Flow web E2E

Flow adalah berkas YAML yang dijalankan sistem E2E workspace. Setiap berkas adalah satu perjalanan.

**Dialek:** dokumen header, pemisah `---`, lalu langkah-langkahnya.

```yaml
# apps/web/e2e/auth/sign-in.yaml (sketsa)
url: http://localhost:3001/login      # port dev web: dikonfirmasi di TASK-14
name: auth - sign in with email
tags: [auth, smoke]
---
- launchApp
- tapOn: "Email"
- inputText: "${E2E_USER_EMAIL}"
- tapOn: "Password"
- inputText: "${E2E_USER_PASSWORD}"
- tapOn: "Sign in"
- assertVisible: "Posts"
- takeScreenshot: auth-signed-in
```

- Key header: `url` (wajib), `name`, `tags`, `env`, `clearState`. Tidak ada key header lain.
- Langkah berasal dari interpreter runner (`launchApp`, `openLink`, `tapOn`, `inputText`, `assertVisible`, `takeScreenshot`, `back`, …); cek namanya ke interpreter, jangan dari ingatan. Setiap flow divalidasi sebelum di-commit.
- `name` diawali nama fitur; `tags` memuat nama fitur.
- Selector memakai teks terlihat yang unik atau label aksesibel, tidak pernah class CSS yang dipakai bersama oleh baris berulang.
- Kredensial berasal dari nilai environment yang dikonfigurasi untuk lingkungan E2E, tidak pernah ditulis di YAML.
- *Verify* bahwa runner menemukan flow di folder bersarang `e2e/<feature>/`; bila tidak, pakai nama fitur sebagai prefix nama berkas (`auth-sign-in.yaml`) sampai didukung.

**Flow wajib:**

| Folder | Flow |
|:---|:---|
| `e2e/auth/` | sign-up, sign-in, refresh mempertahankan sesi, sign-out, halaman terlindungi mengarah ke `/login`, password salah menampilkan pesan generik |
| `e2e/posts/` | daftar, buat, ubah milik sendiri, tanpa tombol ubah di post user lain, hapus dengan konfirmasi, state kosong |
| `e2e/admin/` | admin melihat daftar user; super_admin mengubah role dengan konfirmasi; `user` yang membuka `/admin` diarahkan dengan pesan; katalog role |
| `e2e/profile/` | ubah nama, error validasi saat nama kosong |

## 6. CI

1. `bun install --frozen-lockfile`, typecheck, lint.
2. `bun run test` di `apps/api` dan `apps/web` (cepat; tanpa layanan eksternal selain PostgreSQL test).
3. Jalankan stack test; `bun run test:e2e` di `apps/api`.
4. Flow web E2E bertag `smoke` di setiap merge; set lengkap tiap malam atau sebelum rilis.

## 7. Kriteria penerimaan (TASK-18, TASK-19)

- [ ] Setiap modul di `src/modules/` punya folder `tests/modules/<module>/` yang sesuai; setiap modul dengan route punya `tests/e2e/<module>/`.
- [ ] Setiap fitur di `src/features/` punya folder `tests/features/<feature>/` yang sesuai; setiap fitur dengan halaman punya `e2e/<feature>/`.
- [ ] Pengecekan CI gagal bila folder modul atau fitur tidak punya folder test yang sesuai.
- [ ] `bun run test` lulus tanpa Redis atau MongoDB berjalan.
- [ ] Flow API dan web E2E wajib di atas ada dan lulus.
