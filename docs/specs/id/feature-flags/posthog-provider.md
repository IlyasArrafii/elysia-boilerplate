# PostHog Provider Feature Flag (opsional)

> **Status: desain saja (DEC-029, DEC-038).** Dipakai menggantikan [database provider](database-provider.md) hanya bila tim butuh eksperimen multivariat atau analitik flag. Provider Node dari PostHog berada di versi 0.1.x pada 2026-11; *verify* kematangan dan API-nya saat adopsi. Analitik PostHog (event) adalah rencana terpisah: [observability/posthog.md](../observability/posthog.md).

## 1. Paket

| Paket | Di mana | Peran |
|:---|:---|:---|
| `@openfeature/server-sdk` | `apps/api` | API OpenFeature (tidak berubah) |
| `posthog-node` | `apps/api` | Klien PostHog (dipakai bersama sink analitik bila keduanya digunakan) |
| `@posthog/openfeature-node-provider` | `apps/api` | Provider resmi: `new PostHogServerProvider(posthog, options)` |

Aplikasi web tidak memasang apa pun dan tetap membaca `GET /api/feature-flags/evaluate`.

## 2. Setup

| Env | Wajib | Catatan |
|:---|:---|:---|
| `POSTHOG_KEY` | ya | Project API key |
| `POSTHOG_HOST` | tidak | US, EU, atau self-hosted |
| `POSTHOG_PERSONAL_API_KEY` | ya | **Rahasia.** Mengaktifkan local evaluation (definisi flag diunduh, dievaluasi di memori). *Verify* apakah PostHog kini menyarankan key khusus feature flag. |

```ts
// utils/feature-flag/index.ts (sketsa)
const posthog = new PostHog(env.POSTHOG_KEY, {
  host: env.POSTHOG_HOST,
  personalApiKey: env.POSTHOG_PERSONAL_API_KEY,
  featureFlagsPollingInterval: 30_000,            // *verify* nama opsi
})
await OpenFeature.setProviderAndWait(new PostHogServerProvider(posthog, { sendFeatureFlagEvents: false }))
// shutdown: await OpenFeature.close(); await posthog.shutdown()
```

- **Local evaluation wajib**: tanpanya setiap pengecekan flag adalah panggilan jaringan di jalur request.
- `sendFeatureFlagEvents: false` secara default; nyalakan hanya untuk flag eksperimen yang butuh exposure event.

## 3. Targeting di PostHog, tanpa role

| Aturan kita ([targeting.md](targeting.md)) | PostHog |
|:---|:---|
| Kill switch | Flag dimatikan |
| Kecualikan user | Release condition pertama: distinct ID di daftar → rollout 0% |
| Sertakan user | Kondisi berikutnya: distinct ID di daftar → rollout 100% |
| Persentase | Kondisi terakhir: semua user → X% (di-hash dari distinct ID + key flag, lengket) |
| Eksperimen (hanya PostHog) | Flag multivariat dengan bobot; dibaca dengan `getStringValue` |

**Tanpa person property.** Context hanya mengirim `targetingKey` → `distinctId`. Jangan membuat release condition berdasarkan `role` atau property lain; review akan menolaknya (DEC-038). Tamu mendapat default kode (tanpa `defaultDistinctId`).

## 4. Perilaku dan catatan

| Kasus | Hasil |
|:---|:---|
| Flag tidak ada di PostHog | Default, `FLAG_NOT_FOUND` |
| Getter bertipe salah | Default, `TYPE_MISMATCH` |
| PostHog tidak terjangkau | Definisi terakhir yang diunduh tetap dipakai |
| Disabled vs tidak ada kondisi yang cocok | Tidak bisa dibedakan di provider Node (tanpa reason `DISABLED`) |

Katalog kode (`flags.ts`) tetap menjadi daftar flag yang dipakai kode. Script CI opsional membandingkannya dengan daftar flag PostHog dan memberi peringatan untuk flag yang hanya ada di satu sisi. Flag dikelola di UI PostHog yang menyimpan riwayatnya sendiri, jadi `audit.feature_flag.changed` tidak dipancarkan.

## 5. Migrasi: database provider → PostHog

1. Entri keputusan (product owner menyetujui harga dan region data).
2. Pasang paketnya; tambahkan variabel env ke `env.ts` dan `.env.example`.
3. Buat ulang setiap flag di PostHog dengan key dan tipe yang sama: kill switch → state enabled; daftar exclude, daftar include, dan persentase → release condition dengan urutan §3.
4. Pilih waktunya: bucket **berbeda** (hash berbeda), sehingga sebagian user berpindah sisi. Migrasikan saat tidak ada rollout di antara 1% dan 99%, atau terima pengacakan ulang itu.
5. Ganti `setProviderAndWait(...)` ke PostHog provider lewat deploy; staging dulu.
6. Pantau `flag.evaluation_failed` dan error per modul selama sehari.
7. Migrasi berikutnya: drop tabel `feature_flag` dan endpoint admin `feature-flags`; pertahankan `/api/feature-flags/evaluate`.
8. Perbarui spec di `eng/` dan `id/`.

Rollback sebelum langkah 7: ganti provider kembali; tabelnya masih ada.

## 6. Checklist

- [ ] Harga disetujui untuk trafik yang diperkirakan (*verify* cara penagihan local evaluation); region data dipilih.
- [ ] Hanya `distinctId` yang dikirim; dibuktikan oleh test dengan klien tiruan.
- [ ] Tidak ada release condition yang memakai person property.
- [ ] `POSTHOG_PERSONAL_API_KEY` disimpan sebagai rahasia dan tidak pernah di-log.
- [ ] `posthog.shutdown()` dan `OpenFeature.close()` ada di graceful shutdown.
