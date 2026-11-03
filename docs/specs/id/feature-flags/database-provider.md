# Database Provider Feature Flag (default)

> **Status: desain saja (DEC-029, DEC-038).** Provider default saat flag diadopsi: state flag di tabel PostgreSQL yang didefinisikan dengan Drizzle, dikelola manual lewat admin API (atau SQL dalam keadaan darurat), dievaluasi di memori oleh provider OpenFeature buatan kita. Aturan targeting: [targeting.md](targeting.md).

## 1. Bentuk

```
katalog kode (flags.ts) ──sync saat startup──► tabel feature_flag ◄── PATCH /api/feature-flags/:key
                                                     │                       │
                                                     │ muat semua baris      │ publish "feature-flags:changed"
                                                     ▼                       ▼
                                    snapshot di memori setiap instans API ◄─ Redis pub/sub
                                                     │
                              OpenFeature DatabaseProvider.resolve*(key, default, { targetingKey })
```

- **Flag apa saja yang ada** diputuskan di kode (`flags.ts`). Tabel hanya menyimpan **state**-nya.
- Evaluasi tidak pernah menyentuh PostgreSQL atau Redis; ia membaca snapshot di memori.

## 2. Tabel (Drizzle)

```ts
// packages/db/src/schema/feature-flag.ts (sketsa)
export const featureFlag = pgTable('feature_flag', {
  key:               text('key').primaryKey(),                                  // 'posts.bulk-delete'
  description:       text('description').notNull(),
  type:              text('type', { enum: ['boolean', 'string', 'number', 'object'] }).notNull().default('boolean'),
  enabled:           boolean('enabled').notNull().default(false),               // kill switch
  onValue:           jsonb('on_value').notNull().default(true),
  offValue:          jsonb('off_value').notNull().default(false),
  rolloutPercentage: numeric('rollout_percentage', { precision: 5, scale: 2 }).notNull().default('0'),
  includeUserIds:    text('include_user_ids').array().notNull().default([]),
  excludeUserIds:    text('exclude_user_ids').array().notNull().default([]),
  bucketingSeed:     text('bucketing_seed'),                                    // null = key
  clientVisible:     boolean('client_visible').notNull().default(false),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy:         text('updated_by').references(() => user.id, { onDelete: 'set null' }),
})
```

- Check: `rollout_percentage BETWEEN 0 AND 100`; `cardinality(include_user_ids) + cardinality(exclude_user_ids) <= 1000`.
- Tanpa kolom role (DEC-038). Tanpa kolom lingkungan (lingkungan memakai database terpisah).
- `owner` dan `removeBy` ada di katalog kode.
- Migrasi di-generate dengan Drizzle Kit seperti tabel lainnya.

## 3. Sync saat startup

1. Setiap entri katalog yang tidak ada di tabel di-insert dengan `enabled = false`, `rollout_percentage = 0`, serta deskripsi, tipe, dan default aman dari katalog sebagai `off_value`.
2. Setiap baris tabel yang tidak ada di katalog memancarkan `flag.orphaned { key }` (warn). Baris yatim dihapus lewat migrasi saat kodenya dihapus, tidak pernah otomatis.
3. Muat snapshot.

## 4. Evaluasi

`evaluate(snapshot, key, type, defaultValue, context)` adalah fungsi murni yang mengimplementasikan [targeting.md §3](targeting.md). Mengembalikan `ResolutionDetails` OpenFeature dan dites tanpa database.

## 5. Provider

```ts
// utils/feature-flag/providers/database.ts (sketsa)
export class DatabaseProvider implements Provider {
  readonly metadata = { name: 'database' }
  readonly runsOn = 'server'
  private snapshot = new Map<string, FlagRow>()

  async initialize() { await syncCatalogue(); await this.reload(); this.startRefresh() }
  async onClose()    { this.stopRefresh() }

  resolveBooleanEvaluation(key, def, ctx) { return evaluate(this.snapshot, key, 'boolean', def, ctx) }
  // string, number, object dengan cara yang sama
}
```

### Memperbarui snapshot

| Pemicu | Jeda |
|:---|:---|
| `PATCH /api/feature-flags/:key` mem-publish `feature-flags:changed` di Redis; setiap instans memuat ulang | ~1 dtk |
| Timer setiap `FEATURE_FLAGS_REFRESH_MS` (default 30 000) | ≤ 30 dtk; mencakup SQL manual dan pesan yang terlewat |
| Tanpa Redis (dev) | hanya timer |

Reload yang gagal mempertahankan snapshot sebelumnya dan memancarkan `flag.refresh_failed`. Bila muat pertama gagal, provider berada di state error dan setiap evaluasi mengembalikan default kode.

## 6. Mengelola flag (manual)

### Admin API (`modules/feature-flags/`)

`permissions.ts`: `{ feature_flag: ['read', 'write'] }`. Grant: `admin` mendapat `read`; `super_admin` mendapat keduanya (turunan). Di access stage 2 (dan di lapisan SaaS) ini pindah ke statement platform dan route memakai `platformPermission` ([access-stages.md §3](access-stages.md)).

| Method | Path | Opsi | Body / hasil |
|:---|:---|:---|:---|
| GET | `/api/feature-flags` | `permission: 'feature_flag:read'` | `{ items: FlagState[] }` dengan `owner`, `removeBy` dari katalog |
| GET | `/api/feature-flags/:key` | `permission: 'feature_flag:read'` | `FlagState` atau `404 FLAG_NOT_FOUND` |
| PATCH | `/api/feature-flags/:key` | `permission: 'feature_flag:write'` | Salah satu dari `enabled`, `rolloutPercentage`, `includeUserIds`, `excludeUserIds`, `onValue`, `offValue`, `bucketingSeed`, `clientVisible`. Nilai dicek terhadap `type`; user ID harus ada; batas daftar ditegakkan. Memancarkan `audit.feature_flag.changed`, mem-publish `feature-flags:changed`. |
| POST | `/api/feature-flags/:key/clean-lists` | `permission: 'feature_flag:write'` | Menghapus ID user yang sudah dihapus dari kedua daftar |
| GET | `/api/feature-flags/evaluate` | `auth: true` | `{ flags: Record<key, value> }` untuk flag `clientVisible`, user saat ini |

Tanpa endpoint create atau delete: flag berasal dari sync katalog dan hilang lewat migrasi.

### SQL manual (hanya darurat)

`UPDATE feature_flag SET enabled = false, updated_at = now() WHERE key = 'posts.bulk-delete';` berlaku dalam `FEATURE_FLAGS_REFRESH_MS`. Cara ini melewati validasi dan audit event; catat di catatan insiden dan utamakan API.

## 7. Web

Fitur `admin` (fitur `platform` di access stage 2 dan di lapisan SaaS) bisa mendapat halaman "Feature flags" nanti (`feature_flag:read` untuk melihat, `feature_flag:write` untuk mengubah). Halaman yang dihadapi user membaca flag lewat `/api/feature-flags/evaluate`.

## 8. Test

Folder: `apps/api/tests/utils/feature-flag/` dan `apps/api/tests/modules/feature-flags/` ([TESTING.md](../TESTING.md)).

- `evaluate()` untuk setiap baris [targeting.md §3](targeting.md).
- Sync: key yang hilang di-insert dalam keadaan off; baris yatim memberi peringatan dan tidak dihapus.
- Refresh: PATCH di satu instans terlihat di instans kedua setelah pesan pub/sub; reload gagal mempertahankan snapshot lama.
- API: 403 tanpa permission; persentase tidak valid, user ID tak dikenal, daftar melebihi batas, dan tipe nilai salah → 400; audit event dipancarkan dengan jumlah, bukan ID.

## 9. Batas

- Dua nilai per flag (on/off): tanpa eksperimen multivariat.
- Tanpa analitik per varian.
- Targeting hanya daftar user dan persentase (sesuai desain, DEC-038).

Bila butuh eksperimen atau analitik, lihat [posthog-provider.md](posthog-provider.md).
