# Feature Flag

> **Status: desain saja (DEC-012, DEC-029, DEC-038).** Tidak ada paket OpenFeature yang dipasang di MVP. Saat flag diadopsi, **database provider adalah default** dan targeting hanya **berdasarkan user, tidak pernah role**. Nama paket dan API dicek pada 2026-11; *verify* versinya saat adopsi.

| Dokumen | Isi |
|:---|:---|
| Berkas ini | Mengapa OpenFeature, kapan memakai flag, penempatan kode, evaluation context, konvensi, adopsi |
| [targeting.md](targeting.md) | Aturan targeting tanpa role: kill switch, kecualikan/sertakan user, rollout persentase |
| [access-stages.md](access-stages.md) | Yang berubah di access stage 2 dan di Langkah A: pengelolaan flag pindah ke lapisan platform |
| [../saas/feature-flags.md](../saas/feature-flags.md) | SaaS multi-tenant: `organizationId` di context, persentase per organisasi |
| [database-provider.md](database-provider.md) | Provider default: buatan sendiri, di atas tabel PostgreSQL yang dikelola lewat Drizzle |
| [posthog-provider.md](posthog-provider.md) | Provider opsional untuk eksperimen dan analitik flag, serta cara bermigrasi ke sana |

## 1. Mengapa OpenFeature

OpenFeature adalah API feature flag yang netral vendor (CNCF). Kode aplikasi hanya memanggil API OpenFeature; sebuah **provider** menentukan dari mana flag berasal. Mengganti provider cukup satu baris saat startup.

```
controller ──► klien OpenFeature ──► provider ──► tabel feature_flag (default)   database-provider.md
                                              └──► PostHog                        posthog-provider.md
                                              └──► in-memory                      test
```

## 2. Kapan memakai flag, dan kapan tidak

| Pakai flag untuk | Jangan pakai flag untuk |
|:---|:---|
| Rollout bertahap perilaku baru (5% → 25% → 100%) | **Access control.** Siapa boleh apa adalah permission ([auth/access/static-roles.md](../auth/access/static-roles.md)) |
| Kill switch untuk fitur berisiko | Konfigurasi permanen (variabel env) |
| Akses awal untuk user tertentu (penguji internal) | Menyembunyikan endpoint yang belum aman |
| Eksperimen singkat (hanya PostHog provider) | Menarget role ("semua admin"): pakai permission, atau daftar user eksplisit |

Aturan keras: flag hanya **mempersempit** perilaku. Flag tidak pernah memperluas akses. Route di balik flag tetap butuh `permission`-nya.

## 3. Penempatan kode: API

```
apps/api/src/utils/feature-flag/
  index.ts      plugin bernama 'feature-flag': mengatur provider sekali, men-decorate `flags`
  flags.ts      katalog flag bertipe: key, tipe, default aman, clientVisible, owner, removeBy
  context.ts    menyusun evaluation context dari sesi (§5)
  hook.ts       hook OpenFeature yang memancarkan telemetry event (§7)
  providers/
    database.ts (database-provider.md)
apps/api/src/modules/feature-flags/   admin API untuk database provider
```

```ts
// modules/posts/index.ts (sketsa)
.delete('/bulk', async ({ flags, user, body }) => {
  const enabled = await flags.getBooleanValue('posts.bulk-delete', false, toContext(user))
  if (!enabled) throw moduleError('posts', 404, 'NOT_FOUND', 'Not found')
  return PostService.bulkDelete(user.id, body.ids)
}, { permission: 'posts:manage_all' })
```

- Service tidak pernah membaca flag. Controller mengevaluasi flag dan mengoper hasilnya sebagai argumen biasa.
- Mengevaluasi key yang tidak ada di `flags.ts` adalah error TypeScript.
- Graceful shutdown memanggil `await OpenFeature.close()`.

## 4. Penempatan kode: web

Aplikasi web **tidak** mengevaluasi flag dan tidak memasang SDK OpenFeature:

- `GET /api/feature-flags/evaluate` (`auth: true`) mengembalikan `{ flags: { "posts.bulk-delete": true, … } }` untuk user saat ini, hanya flag yang ditandai `clientVisible`.
- Hook di `features/<feature>/hooks/` membacanya lewat TanStack Query (`useFlag('posts.bulk-delete')`).
- Flag di aplikasi web hanya untuk UI; apa pun yang memengaruhi data juga dicek di API.

Satu titik evaluasi: API dan UI tidak pernah berbeda pendapat, aturan dan persentase tidak pernah dikirim ke browser, dan mengganti provider tidak menyentuh aplikasi web.

## 5. Evaluation context

| Field | Sumber | Catatan |
|:---|:---|:---|
| `targetingKey` | `user.id` | Tidak ada untuk tamu |

Di lapisan SaaS multi-tenant context juga membawa `organizationId` ([saas/feature-flags.md §2](../saas/feature-flags.md)). **Tidak ada yang lain.** Tanpa role, email, nama, IP, paket, atau atribut lain ke provider mana pun (DEC-038, [redaction.md §6](../observability/redaction.md)). Lingkungan memakai database terpisah, jadi tidak ada atribut `env` juga.

## 6. Jalur provider

| Tahap | Provider | Kapan |
|:---|:---|:---|
| Test | `InMemoryProvider` dengan nilai eksplisit | Selalu |
| 1 (default) | **Database provider** | Adopsi pertama: flag diubah tanpa deploy, kill switch, daftar user, rollout persentase |
| 2 (opsional) | **PostHog provider** | Butuh eksperimen multivariat atau analitik flag; biaya vendor adalah keputusan product owner |

## 7. Observability

Satu hook OpenFeature global di `utils/feature-flag/hook.ts` memancarkan telemetry event (modul `"feature-flags"` untuk admin API, selain itu modul pemanggil):

| Event | Kind | Payload | Level |
|:---|:---|:---|:---|
| `flag.evaluation_failed` | `app` | `key, errorCode, defaultUsed` | warn |
| `flag.evaluated` | `app` | `key, variant, reason` | hanya debug (stdout, bukan MongoDB) |
| `flag.refresh_failed` | `app` | `provider, errorCode` | warn |
| `flag.orphaned` | `app` | `key` | warn |
| `audit.feature_flag.changed` | `audit` | `key, actorId, changes` (nama field dan nilai lama/baru; daftar user ID sebagai jumlah yang ditambah/dihapus, tidak pernah ID-nya) | info |

Ditambahkan ke `utils/telemetry/events.ts` saat adopsi.

## 8. Konvensi

- **Key:** `<module>.<kebab-name>`, mis. `posts.bulk-delete`.
- **Default** selalu nilai paling aman (biasanya `false` atau perilaku lama), di kode maupun di provider.
- Setiap flag punya `owner` dan, bila sementara, tanggal `removeBy`. Lewat `removeBy`, flag dan cabang kodenya dihapus; CI memberi peringatan untuk flag kedaluwarsa.
- Tidak pernah lebih dari satu flag menjaga jalur kode yang sama.
- Test memakai `InMemoryProvider`; folder `apps/api/tests/utils/feature-flag/` ([TESTING.md](../TESTING.md)).

## 9. Checklist adopsi

1. Entri keputusan: "feature flag diimplementasikan dengan database provider" (memperbarui DEC-012).
2. `bun add @openfeature/server-sdk` di `apps/api`; buat `utils/feature-flag/` sesuai §3.
3. Skema Drizzle dan migrasi untuk `feature_flag` ([database-provider.md §2](database-provider.md)).
4. Implementasikan provider dan modul `feature-flags`.
5. Tambahkan `OpenFeature.close()` ke graceful shutdown; tambahkan hook dan event (§7).
6. Tambahkan `GET /api/feature-flags/evaluate` dan hook web (§4).
7. Satu contoh flag di `posts` dengan test untuk on, off, include, exclude, rollout, dan provider gagal.
8. Perbarui spec di `eng/` dan `id/`.
