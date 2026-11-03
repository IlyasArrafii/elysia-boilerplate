# Sentry: Error Tracking (desain saja)

> **Status: desain saja (DEC-036).** Baseline-nya adalah log manual (stdout + MongoDB). Dokumen ini adalah rencana pembangunan dan migrasi untuk menambah Sentry. Membangunnya butuh entri keputusan baru. Nama paket dan API dicek pada 2026-11; *verify* saat pembangunan.

## 1. Apa yang ditambahkan Sentry, dan apa yang tidak

| Sentry memberi | Tetap dari log manual |
|:---|:---|
| Error dikelompokkan dan dideduplikasi, per rilis | Setiap baris request, jejak audit, latensi |
| Stack trace dengan konteks source | Retensi dan penghapusan data (log-storage.md) |
| Alert (issue baru, regresi, lonjakan) | Error di bawah 500 |

Adopsi saat tim butuh pengelompokan dan alert untuk error 5xx yang lebih cepat daripada meng-query `log_event`. Sentry adalah **sink di samping** log manual, bukan pengganti: setiap error tetap masuk stdout dan MongoDB.

## 2. Pilihan paket

| Paket | Kondisi (2026-11) | Dipakai? |
|:---|:---|:---|
| `@sentry/bun` | SDK Bun resmi | **Ya**, capture manual dari sink |
| `@sentry/elysia` | Resmi, **alpha**; membungkus app dengan `Sentry.withElysia(app)` dan men-trace fase lifecycle | Tidak: masih alpha, dan membungkus app menaruh SDK di luar `sinks/` (melanggar DEC-014). Tinjau ulang saat stabil bila tracing dibutuhkan |

## 3. Konfigurasi

| Env | Wajib | Catatan |
|:---|:---|:---|
| `SENTRY_DSN` | untuk mengaktifkan | Kosong = sink tidak didaftarkan, SDK tidak pernah diimpor |
| `SENTRY_ENVIRONMENT` | tidak | Default `NODE_ENV` |
| `APP_VERSION` | tidak | Dikirim sebagai `release` |

```ts
// apps/api/src/utils/telemetry/sinks/sentry.ts (sketsa)
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
  release: env.APP_VERSION,
  tracesSampleRate: 0,          // hanya error
  sendDefaultPii: false,        // tanpa IP, cookie, atau header
  defaultIntegrations: false,   // *verify*; tambahkan kembali hanya yang perlu (mis. linked errors)
  beforeSend(event) {
    delete event.request?.cookies
    delete event.request?.headers
    delete event.request?.data
    delete event.request?.query_string
    delete event.request?.url
    if (event.user) event.user = { id: event.user.id }
    return event
  },
})
```

## 4. Yang ditangkap

| Event | Dikirim? | Cara |
|:---|:---|:---|
| `http.error` dengan status ≥ 500 | ya | `Sentry.captureException(err, { tags: { module, sourceModule, code, requestId }, user: { id: userId } })` |
| `http.error` dengan status < 500 | tidak | Error klien yang memang diharapkan hanya menjadi noise |
| Uncaught exception / unhandled rejection | ya | Handler proses memanggil sink, lalu jalur shutdown normal |
| Lainnya | tidak | |

- Fingerprint pengelompokan: `['{{ default }}', module]`, sehingga bug yang sama di dua modul menjadi dua issue.
- `module` adalah tag utama untuk aturan alert Sentry ("issue baru di `posts`").
- `flush(timeoutMs)` memanggil `Sentry.flush(timeoutMs)`.

## 5. Langkah implementasi

1. Entri keputusan yang mengadopsi Sentry (memperinci DEC-036).
2. `bun add @sentry/bun` di `apps/api`.
3. Tulis `sinks/sentry.ts` sesuai §3–§4, didaftarkan dengan `import()` dinamis hanya bila `SENTRY_DSN` diisi.
4. Di `events.ts`, tambahkan `'sentry'` ke `sinks` milik `http.error` saja.
5. Tambahkan `SENTRY_*` ke validasi `env.ts` (variabel opsional) dan `.env.example`.
6. Test di `apps/api/tests/utils/telemetry/sentry.test.ts` dengan test transport (§7).
7. Deploy ke staging dengan DSN untuk project staging; picu 500 percobaan; cek tag dan scrubbing di Sentry.
8. Atur aturan alert per modul di Sentry.
9. Deploy ke produksi.
10. Perbarui spec di `eng/` dan `id/` (status berkas ini, DECISIONS, tabel env ARCHITECTURE).

## 6. Melepasnya

Kosongkan `SENTRY_DSN` (sink langsung berhenti), lalu hapus berkas sink, entri `'sentry'` di `events.ts`, dan paketnya. Log manual tidak terpengaruh.

## 7. Kriteria penerimaan

- [ ] Tanpa `SENTRY_DSN`, `@sentry/bun` tidak pernah dimuat (dibuktikan oleh test).
- [ ] Error yang dilempar di route tiba di Sentry sekali, bertag `module`, `code`, dan `requestId`.
- [ ] Response 4xx tidak pernah sampai ke Sentry.
- [ ] Payload keluar (test transport) tidak memuat cookie, header, body, URL, query string, email, atau IP.
- [ ] Error yang sama tetap muncul di stdout dan MongoDB.
- [ ] SIGTERM mem-flush event yang tertunda dalam 3 detik.
