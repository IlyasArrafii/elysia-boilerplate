# Redaksi

Data sensitif tidak pernah ditulis ke log, disimpan di database log, atau dikirim ke vendor (DEC-027). Dokumen ini adalah kebijakan, mekanisme, dan test-nya. Berlaku untuk baris stdout, dokumen MongoDB, telemetry event, laporan error, dan payload vendor.

## 1. Kelas data

| Kelas | Contoh | Aturan |
|:---|:---|:---|
| **Rahasia** | password dan hash-nya, token sesi, cookie, header `Authorization`, API key, token OAuth access/refresh/ID, `code` dan `state` OAuth, token atau tautan verifikasi dan reset, `BETTER_AUTH_SECRET`, connection string berpassword (`DATABASE_URL`, `LOG_MONGO_URL`) | **Tidak pernah** di-log atau disimpan, di lingkungan mana pun (event tautan khusus dev di §6 satu-satunya pengecualian, hanya stdout, hanya dev) |
| **Data pribadi (PII)** | email, nama, URL avatar, telepon, teks alasan ban, input teks bebas user | Tidak pernah di-log. Pakai `userId` |
| **Data pelanggan** (access stage 2 dan SaaS) | nama, slug, dan logo organisasi, email undangan | Tidak pernah di-log. Pakai `organizationId` / `invitationId` |
| **Konten** | body request dan response, judul/isi post, data form | Tidak pernah di-log |
| **Identitas jaringan** | alamat IP, user agent | Hanya di event `audit.*` (tujuan keamanan); tidak pernah di `http.*` |
| **Aman** | ID (`userId`, `postId`, `sessionId`, `organizationId`, `roleId`), nama modul, pola route, method, status, durasi, kode error, nama role (kode dan runtime), nama provider, key flag | Boleh di-log |

Bila ragu, field itu tidak di-log. Setiap penambahan field ke event di-review terhadap tabel ini.

## 2. Lapisan

| # | Lapisan | Di mana | Menangkap |
|:---|:---|:---|:---|
| 1 | **Payload bertipe** | `utils/telemetry/events.ts` | Desain: tipe payload hanya punya field aman; review menolak field `email`, `name`, `body`, `url` |
| 2 | **Scrubber** | `utils/telemetry/scrub.ts`, di dalam `emit()` sebelum sink mana pun | Kesalahan: key sensitif atau pola nilai yang terselip |
| 3 | **`redact` pino** | `utils/logger/index.ts` | Panggilan `log.*` langsung yang melewati telemetry |
| 4 | **Scrubbing vendor** | `beforeSend` Sentry, allowlist property PostHog (saat diadopsi) | Apa yang dikumpulkan SDK sendiri ([sentry.md](sentry.md), [posthog.md](posthog.md)) |

Sink `mongo` hanya menerima baris yang sudah di-scrub (lapisan 2), sehingga database log tidak pernah menyimpan apa yang tidak akan ada di stdout.

## 3. Tidak pernah di-log sama sekali

- **URL mentah dan query string.** Log pola route (`/api/posts/:id`). Callback OAuth membawa `code` dan `state`; tautan reset membawa token.
- **Body request dan response**, saat sukses maupun gagal. Error validasi hanya me-log **path field dan nama aturan**.
- **Header**, kecuali `user-agent` (hanya audit), `x-request-id`, `content-type`, `content-length`.
- **Pesan error library apa adanya.** Error Postgres menaruh nilai di `detail` (`Key (email)=(a@b.com) already exists`); error Drizzle bisa memuat parameter query; error driver MongoDB bisa memuat connection string. Serializer error menyimpan `name`, `code`, `constraint`, `table`, `column`, dan stack, membuang `detail`, `params`, `query`, `where`, `keyValue`, dan menyimpan `message` hanya setelah pola nilai dijalankan, dipotong menjadi 500 karakter.
- **Internal Better Auth.** `logger`-nya diarahkan lewat scrubber.

## 4. Scrubber

Berjalan pada setiap payload, rekursif, sebelum sink. Fungsi murni, punya unit test.

**Aturan key.** Setiap key yang cocok dengan daftar ini (tidak peka huruf besar/kecil, termasuk objek bersarang dan array) nilainya diganti `"[REDACTED]"`:

```
password, passwd, pwd, secret, token, accessToken, refreshToken, idToken, apiKey, api_key,
authorization, cookie, set-cookie, session_token, sessionToken, code, state, otp, email,
name, firstName, lastName, phone, address, banReason, reason_text, body, content, url, keyValue
```

Pengecualian yang dibiarkan: `code` tingkat atas di `http.error` (`UPPER_SNAKE_CASE`), `err.code` (SQLSTATE atau kode driver), `err.name` (nama class error), dan `url` di event tautan khusus dev (§6).

**Aturan nilai.** Setiap string (termasuk `err.message`) dicek terhadap pola berikut; bagian yang cocok menjadi `[REDACTED:<type>]`:

| Tipe | Pola (sketsa) |
|:---|:---|
| `email` | `[^\s@]+@[^\s@]+\.[^\s@]+` |
| `jwt` | `eyJ[\w-]+\.[\w-]+\.[\w-]+` |
| `bearer` | `Bearer\s+\S+` |
| `url-secret` | `([?&](token\|code\|state\|key\|secret\|password)=)[^&\s]+` |
| `dsn` | `\w+(\+\w+)?://[^:\s]+:[^@\s]+@` (kredensial di connection string, termasuk `mongodb+srv://`) |

**Batas.** Kedalaman 6, 100 key per objek, string dipotong menjadi 2 000 karakter; selebihnya `"[TRUNCATED]"`. Scrubber tidak pernah melempar error; bila terjadi error internal, payload menjadi `{ "scrubFailed": true }`.

## 5. Konfigurasi pino

```ts
// sketsa
pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
      '*.password', '*.token', '*.secret', '*.email', '*.accessToken', '*.refreshToken', '*.idToken',
    ],
    censor: '[REDACTED]',
  },
  base: { service: 'api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
})
```

`redact` pino hanya mencocokkan path persis, itulah sebabnya scrubber ada. Jangan pernah mengandalkan `redact` saja.

## 6. Kasus khusus

| Kasus | Aturan |
|:---|:---|
| `auth.verification_link`, `auth.reset_link` | Memuat tautan rahasia. Hanya saat `NODE_ENV=development`, hanya stdout (tidak pernah sink `mongo`). Mendaftarkannya di produksi melempar error saat startup. |
| `audit.session.created` | Menyimpan `ip` dan `userAgent` untuk investigasi keamanan; disimpan 365 hari sebagai `audit`. |
| `audit.auth.sign_in_failed` | Hanya `ip` dan kode alasan. Tidak pernah email yang dicoba. |
| Alasan ban | Disimpan Better Auth di PostgreSQL; tidak pernah di event. |
| Evaluation context feature flag | Hanya `targetingKey` (user ID) ([feature-flags/targeting.md](../feature-flags/targeting.md)). |

## 7. Test wajib

Folder: `apps/api/tests/utils/telemetry/` ([TESTING.md](../TESTING.md)). Setiap test mengirim nilai sensitif lewat jalur asli dan memastikan nilai itu tidak ada di output yang ditangkap (sink memory, stream pino ke buffer, dan dokumen yang ditulis sink `mongo` ke MongoDB test):

- [ ] Header `Cookie` dan `Authorization` → nilainya tidak muncul.
- [ ] Body sign-up dan sign-in → password dan email tidak pernah muncul, termasuk saat validasi gagal.
- [ ] Callback OAuth dengan `code` dan `state` → keduanya tidak muncul; `route` berupa pola.
- [ ] Unique violation Postgres pada kolom email → email tidak muncul; `constraint` muncul.
- [ ] Error driver MongoDB yang memuat connection string → kredensial diganti.
- [ ] `emit()` dengan `{ user: { email } }` bersarang → `[REDACTED]`.
- [ ] `err.message` berisi email, JWT, dan URL `?token=` → ketiganya diganti.
- [ ] Output logger Better Auth sendiri → melewati scrubber.
- [ ] `auth.verification_link` di konfigurasi produksi → startup gagal; di dev tidak pernah sampai ke MongoDB.
- [ ] Sink vendor, saat dibangun: payload keluar yang ditangkap tidak memuat data Rahasia atau PII.

## 8. Hak penghapusan data

Log dikunci dengan `userId`, bukan data pribadi, sehingga menghapus akun memutus kaitan antara ID dan orangnya. Retensi menghapus barisnya ([log-storage.md §5](log-storage.md)). Bila sebuah deployment juga harus menghapus dokumen log milik user atas permintaan, perintah prune mendukung `--user <userId>` ([log-storage.md §5.3](log-storage.md)). Apakah ini memenuhi kewajiban hukum sebuah deployment adalah keputusan tim yang men-deploy.
