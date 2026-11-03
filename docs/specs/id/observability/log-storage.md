# Penyimpanan Log dan Retensi: MongoDB (manual)

> **Status: Answered (DEC-034, Q17, Q18).** Dibangun di TASK-15. MongoDB adalah log store untuk saat ini; [migration-loki.md](migration-loki.md) (Grafana Alloy + Loki, default) dan [migration-elk.md](migration-elk.md) (ELK Stack, alternatif) adalah jalur rencana untuk meninggalkannya. Detail driver dan server dicek pada 2026-11; *verify* versinya saat pembangunan.

## 1. Bentuk

```
telemetry.emit ──► scrubber ──┬─► sink log   ──► stdout (selalu, semua level)
                              └─► sink mongo ──► buffer ──insertMany tiap 1 dtk / 500 dok──► MongoDB app_logs.log_event
                                                                                                │
                                         operator: bun run logs:prune  ──────────────────────────┘ hapus per kind dan umur
```

- stdout selalu memuat setiap event, jadi tidak ada yang hilang bila MongoDB mati; runtime container menyimpan riwayat lokal yang pendek.
- MongoDB adalah **database terpisah** dengan kredensial sendiri. Tidak pernah menyimpan data aplikasi, dan PostgreSQL tidak pernah menyimpan log.
- Retensi bersifat **manual**: tidak ada log yang dihapus sampai operator menjalankan perintah prune.

Mengapa MongoDB sekarang: dokumen berbentuk JSON tidak butuh migrasi skema saat event berkembang; penghapusan berdasarkan rentang waktu ber-index murah; beban tulis log terpisah dari PostgreSQL. Mengapa belum Loki: tiga layanan tambahan (Alloy, Loki, Grafana) sebelum trafik membenarkannya ([migration-loki.md §1](migration-loki.md)).

## 2. Setup

| Item | Nilai |
|:---|:---|
| Server | MongoDB 8 (image `mongo:8` di docker compose; *verify* versi mayor terkini) |
| Database | `LOG_MONGO_DB`, default `app_logs` |
| Koleksi | `log_event` (koleksi biasa; bukan time-series collection, agar penghapusan bebas tetap sederhana) |
| Driver | Paket resmi `mongodb` di `apps/api/src/utils/mongo` (*verify* kompatibilitas Bun untuk versi yang terpasang) |
| User penulis (API) | Role kustom dengan `insert` pada `log_event` saja. Dipakai oleh `LOG_MONGO_URL`. Tidak bisa membaca, menghapus, atau drop. |
| User admin (script) | `find`, `remove`, `createIndex` pada `log_event`. Dipakai oleh `LOG_MONGO_ADMIN_URL`, hanya di script prune/setup, tidak pernah oleh proses API. |
| Index | Dibuat oleh `bun run logs:setup` ([DATABASE.md §8](../DATABASE.md)) |

Di dev, `LOG_MONGO_URL` boleh kosong (hanya stdout). docker compose menyertakan layanan `mongo` agar sink bisa dicoba di lokal.

## 3. Jalur tulis: sink `mongo`

`apps/api/src/utils/telemetry/sinks/mongo.ts`, hanya didaftarkan bila `LOG_MONGO_URL` diisi.

| Perilaku | Aturan |
|:---|:---|
| Level | Baris pada `LOG_MONGO_MIN_LEVEL` (default `info`) ke atas. `debug` tetap di stdout. |
| Event yang dikecualikan | `telemetry.sink_failed`, `telemetry.sink_dropped` (mencegah loop), event tautan khusus dev |
| Dokumen | Baris log yang sudah di-scrub apa adanya, `time` diubah menjadi BSON `Date` |
| Batching | Buffer di memori; `insertMany(docs, { ordered: false })` setiap 1 detik atau saat 500 dokumen, mana yang lebih dulu |
| Write concern | `w: 1` (log tidak layak menunggu mayoritas) |
| Back-pressure | Buffer dibatasi 10 000 dokumen. Saat penuh, buang dokumen `http` tertua lebih dulu, tidak pernah `audit` atau `error` selama yang lain masih ada; hitung yang dibuang dan pancarkan `telemetry.sink_dropped` (stdout) maksimal sekali per menit |
| Kegagalan | Batch gagal dicoba ulang sekali setelah 2 detik, lalu dibuang dan dihitung; `telemetry.sink_failed` (stdout) maksimal sekali per menit. stdout tetap memuat barisnya. |
| Startup | Terhubung di latar belakang. Gangguan MongoDB tidak pernah memblokir startup atau request. |
| Shutdown | `flush(timeoutMs)` menulis buffer, lalu `close()` menutup klien (TASK-13) |
| Health | `GET /api/health` melaporkan `logStore: up/down/disabled`, tidak pernah gagal karenanya |

## 4. Bentuk dokumen dan index

Field-nya adalah field baris log ([README.md §5](README.md)): `level, time, kind, event, service, env, module, requestId?, userId?, organizationId?` ditambah payload event (`organizationId` mulai access stage 2, [access-stages.md](access-stages.md)). Index tercantum di [DATABASE.md §8](../DATABASE.md).

## 5. Retensi (manual)

### 5.1 Periode (Q18)

Didefinisikan sekali di `apps/api/src/utils/telemetry/retention.ts`:

| `kind` | Simpan | Alasan |
|:---|:---|:---|
| `http` | 14 hari | Volume tertinggi; debugging terbaru dan latensi |
| `app` | 30 hari | Startup, shutdown, peringatan |
| `error` | 30 hari | Investigasi dan melihat pengulangan |
| `product` | 30 hari | Hanya sampai PostHog diadopsi ([posthog.md](posthog.md)) |
| `audit` | 365 hari | Investigasi keamanan menengok berbulan-bulan ke belakang |

### 5.2 Perintah prune

`apps/api/scripts/logs-prune.ts`, dijalankan sebagai `bun run logs:prune` dengan `LOG_MONGO_ADMIN_URL`.

| Flag | Efek |
|:---|:---|
| `--dry-run` | Menghitung apa yang akan dihapus per kind; tidak menghapus apa pun. **Selalu jalankan lebih dulu.** |
| `--kind <kind>` | Hanya satu kind (boleh diulang) |
| `--older-than <days>` | Mengganti periode untuk sekali jalan; harus ≥ periode yang dikonfigurasi kecuali `--force` juga diberikan |
| `--batch <n>` | Ukuran batch, default 10 000 |

Algoritma, per kind:
1. `cutoff = now - retention[kind]`.
2. Ulangi: ambil maksimal `batch` `_id` dengan `{ kind, time: { $lt: cutoff } }` (memakai `{ kind: 1, time: 1 }`), `deleteMany({ _id: { $in: ids } })`, sampai tidak ada yang tersisa.
3. Pancarkan `app.logs_pruned { kind, deleted, cutoff, dryRun }`.

Perintah ini idempoten dan aman dihentikan lalu dijalankan ulang. Tidak pernah menyentuh PostgreSQL.

### 5.3 Menghapus log milik satu user

`bun run logs:prune --user <userId> [--dry-run]` menghapus setiap dokumen dengan `userId` itu, semua kind, dan memancarkan `app.logs_pruned { kind: "all", deleted, userId }`. Hanya dipakai untuk permintaan penghapusan data yang terdokumentasi.

### 5.4 Menjalankannya

- **Siapa:** operator yang punya akses ke `LOG_MONGO_ADMIN_URL`.
- **Kapan:** minimal seminggu sekali (`http` tumbuh paling cepat), dan setiap kali pemakaian disk melewati 70%. Jalankan `--dry-run`, cek jumlahnya, lalu jalankan sungguhan.
- **Dicatat di mana:** event `app.logs_pruned`, yang juga merupakan log `app`.
- Tim boleh menaruh perintah yang sama di cron host atau jadwal CI. Itu tetap perintah manual yang sama; API tidak pernah menjadwalkan penghapusan sendiri.

### 5.5 Penghapusan darurat tanpa script

```js
// mongosh, user admin; hapus log http yang lebih tua dari 14 hari
db.log_event.deleteMany({ kind: "http", time: { $lt: new Date(Date.now() - 14 * 864e5) } })
```

Pakai hanya bila script tidak bisa berjalan, dan catat di catatan insiden.

### 5.6 Mengapa tanpa TTL index

TTL index menghapus otomatis, kebalikan dari yang disepakati (Q18: manual). Bila nanti tim menginginkan penghapusan otomatis, keputusan baru bisa menambah satu TTL index per kind lewat partial filter; perintah prune tetap menjadi alat manual.

## 6. Flush vs purge

| Istilah | Arti | Di mana |
|:---|:---|:---|
| **Flush** | Menulis event yang ter-buffer agar tidak hilang saat shutdown | `telemetry.flush()` saat SIGTERM |
| **Purge (prune)** | Menghapus event yang lebih tua dari retensinya | `bun run logs:prune`, dijalankan operator |

API tidak punya endpoint yang menghapus log.

## 7. Query

Dari mongosh atau MongoDB Compass dengan user read-only:

```js
// error per modul, 24 jam terakhir
db.log_event.aggregate([
  { $match: { kind: "error", time: { $gte: new Date(Date.now() - 864e5) } } },
  { $group: { _id: { module: "$module", code: "$code" }, count: { $sum: 1 } } },
  { $sort: { count: -1 } },
])

// semua baris dari satu request
db.log_event.find({ requestId: "4f1c…" }).sort({ time: 1 })

// latensi p95 per modul, satu jam terakhir (MongoDB 7+: $percentile, verify)
db.log_event.aggregate([
  { $match: { event: "http.request", time: { $gte: new Date(Date.now() - 36e5) } } },
  { $group: { _id: "$module", p95: { $percentile: { input: "$durationMs", p: [0.95], method: "approximate" } } } },
])
```

User read-only (hanya `find`) dibuat untuk orang yang meng-query log. Tidak ada UI penampil log di MVP.

## 8. Kriteria penerimaan (TASK-15)

- [ ] Dengan `LOG_MONGO_URL` diisi, setiap event `info`+ muncul di `log_event` dalam 2 detik dengan field yang sama seperti baris stdout.
- [ ] Dengan `LOG_MONGO_URL` kosong, API berjalan dan hanya menulis stdout.
- [ ] Mematikan MongoDB tidak menggagalkan atau memperlambat request; `telemetry.sink_failed` muncul maksimal sekali per menit; stdout tetap memuat setiap baris.
- [ ] Buffer penuh membuang dokumen `http` lebih dulu dan memancarkan `telemetry.sink_dropped`.
- [ ] SIGTERM menulis buffer sebelum proses berhenti.
- [ ] User API tidak bisa membaca atau menghapus (`find` dan `deleteMany` gagal dengan kredensialnya).
- [ ] `logs:setup` membuat index dan idempoten.
- [ ] `logs:prune --dry-run` tidak menghapus apa pun dan mencetak jumlah per kind; tanpa flag itu, dokumen yang lebih tua dari periode dihapus dan yang lebih baru disimpan, berbatch; `app.logs_pruned` dipancarkan.
- [ ] `--older-than` di bawah periode yang dikonfigurasi ditolak tanpa `--force`.
- [ ] `--user <id>` hanya menghapus dokumen user itu.
