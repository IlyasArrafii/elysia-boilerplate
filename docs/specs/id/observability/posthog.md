# PostHog: Analitik Produk (desain saja)

> **Status: desain saja (DEC-036).** Baseline-nya adalah log manual (stdout + MongoDB). Dokumen ini adalah rencana pembangunan dan migrasi untuk menambah analitik produk PostHog. PostHog sebagai **provider feature flag** adalah rencana terpisah: [feature-flags/posthog-provider.md](../feature-flags/posthog-provider.md). Nama paket dan opsi dicek pada 2026-11; *verify* saat pembangunan.

## 1. Apa yang ditambahkan PostHog, dan apa yang tidak

| PostHog memberi | Tetap dari log manual |
|:---|:---|
| Funnel, retention, tren ("berapa user yang membuat post") | Baris request, error, jejak audit |
| Riwayat event per user untuk pertanyaan produk | Investigasi keamanan |
| Error tracking opsional bila Sentry tidak dipakai | Retensi log teknis |

Adopsi saat product owner punya pertanyaan produk yang tidak bisa dijawab log dengan murah. Sampai saat itu, event `product.*` tetap di MongoDB dengan retensi 30 hari.

### 1.1 PostHog bukan store log atau trace

PostHog juga menawarkan Logs dan distributed tracing, keduanya diterima lewat OpenTelemetry (OTLP/HTTP, ditagih per GB; dicek 2026-11). Desain ini **tidak** memakainya:

- **Log** tetap di stdout + MongoDB, dan nanti Loki atau ELK ([migration-loki.md](migration-loki.md), [migration-elk.md](migration-elk.md)). Mengirimnya ke PostHog butuh exporter OTLP (OpenTelemetry sudah dihapus, DEC-013) dan menaruh log teknis di tool analitik produk.
- **Trace** tidak ada di desain ini ([README.md §9](README.md)); `requestId` adalah korelasinya.
- Memakai PostHog sebagai log store akan menjadi spec migrasi dan keputusan tersendiri, seperti spec Loki dan ELK, bukan perluasan dokumen ini.

### 1.2 Analitik dan feature flag adalah dua integrasi terpisah

| | Analitik (dokumen ini) | Feature flag ([posthog-provider.md](../feature-flags/posthog-provider.md)) |
|:---|:---|:---|
| Arah | API → PostHog: mengirim event | PostHog → API: mengunduh definisi flag, dievaluasi di memori |
| Dipanggil lewat | `telemetry.emit('product.*', …)` → `sinks/posthog.ts` | OpenFeature `client.getBooleanValue(…)` → `utils/feature-flag/` |
| Paket | `posthog-node` | `posthog-node`, `@openfeature/server-sdk`, `@posthog/openfeature-node-provider` |
| Key | `POSTHOG_KEY` | `POSTHOG_KEY` + `POSTHOG_PERSONAL_API_KEY` (rahasia, untuk evaluasi lokal) |
| Di jalur request | Tidak pernah di-await | Evaluasi di memori, tanpa panggilan jaringan |
| Keputusan | Hanya mengadopsi analitik | Hanya mengadopsi provider (database provider tetap default, DEC-029) |

Mengadopsi yang satu tidak pernah berarti mengadopsi yang lain. Bila keduanya diadopsi, keduanya berbagi satu client `posthog-node` (dibuat sekali, dimatikan sekali); tidak ada hal lain yang dibagi.

## 2. Paket dan konfigurasi

`posthog-node` hanya di `apps/api`. Aplikasi web tidak memasang apa pun (telemetry frontend di luar cakupan, DEC-015).

| Env | Wajib | Catatan |
|:---|:---|:---|
| `POSTHOG_KEY` | untuk mengaktifkan | Project API key (hanya-tulis) |
| `POSTHOG_HOST` | tidak | `https://us.i.posthog.com`, `https://eu.i.posthog.com`, atau self-hosted |

```ts
// apps/api/src/utils/telemetry/sinks/posthog.ts (sketsa)
const client = new PostHog(env.POSTHOG_KEY, {
  host: env.POSTHOG_HOST,
  flushAt: 20,             // ukuran batch
  flushInterval: 10_000,   // ms
  disableGeoip: true,      // *verify* nama opsi; tanpa lokasi berbasis IP
})
```

Bila PostHog juga menjadi provider feature flag, keduanya memakai satu klien ini.

## 3. Yang ditangkap

| Event | Dikirim? | Cara |
|:---|:---|:---|
| `product.*` dengan `userId` | ya | `client.capture({ distinctId: userId, event: '<nama tanpa product.>', properties })` |
| `product.*` tanpa `userId` (tamu) | tidak | Tanpa pelacakan anonim di sisi server |
| `http.*`, `audit.*`, `app.*` | tidak | Tetap di log |
| `http.error` ≥ 500 | hanya bila Sentry tidak dipakai | `client.captureException(err, userId, { module, code, requestId })` (*verify* API) |

**Allowlist property.** Setiap event `product.*` mendaftar property yang diizinkan di `events.ts` (mis. `post_created: ['postId', 'status']`). Sink membuang property lain. PostHog tidak pernah menerima teks bebas, email, nama, atau IP. `module` selalu ditambahkan sebagai property.

### Event produk yang ditambahkan saat adopsi

| Event | Property | Dipancarkan dari |
|:---|:---|:---|
| `product.user_signed_up` | `method` (`email` / `google`) | `user.create.after` Better Auth |
| `product.post_created` | `postId`, `status` | `PostService.create` |
| `product.post_published` | `postId` | `PostService.update` saat status berubah |

## 4. Langkah implementasi

1. Entri keputusan yang mengadopsi analitik PostHog (memperinci DEC-036); product owner menyetujui harga dan region data (US/EU).
2. `bun add posthog-node` di `apps/api`.
3. Tulis `sinks/posthog.ts`, didaftarkan dengan `import()` dinamis hanya bila `POSTHOG_KEY` diisi.
4. Tambahkan event `product.*` (§3) beserta allowlist-nya; tambahkan `'posthog'` ke `sinks`-nya.
5. Tambahkan `POSTHOG_*` ke `env.ts` dan `.env.example`.
6. Test di `apps/api/tests/utils/telemetry/posthog.test.ts` dengan klien tiruan (§6).
7. Project staging dulu; cek event dan property di PostHog; lalu produksi.
8. Setelah PostHog memegang riwayat produk, `product.*` boleh dikeluarkan dari sink `mongo` (keputusan).
9. Perbarui spec di `eng/` dan `id/`.

## 5. Melepasnya

Kosongkan `POSTHOG_KEY`, lalu hapus sink, entri `'posthog'`, dan paketnya. Event produk tetap masuk log.

## 6. Kriteria penerimaan

- [ ] Tanpa `POSTHOG_KEY`, `posthog-node` tidak pernah dimuat.
- [ ] Hanya event `product.*` dengan `userId` yang sampai ke PostHog, dengan property dalam allowlist plus `module`.
- [ ] Tidak ada email, nama, IP, atau konten di payload yang ditangkap (klien tiruan).
- [ ] SIGTERM memanggil `client.shutdown()` dan event yang tertunda terkirim (*verify* apakah menerima timeout).
