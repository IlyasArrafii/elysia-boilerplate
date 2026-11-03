# Migrasi: MongoDB → ELK Stack (Elasticsearch, Logstash, Kibana)

> **Status: desain saja (DEC-041).** Alternatif dari [migration-loki.md](migration-loki.md): saat migrasi, tim memilih **satu** dari keduanya, tidak pernah keduanya. Lakukan ini saat pemicu di §1 terjadi dan sebuah keputusan mencatatnya. Nama komponen, setting, dan path API dicek terhadap dokumentasi Elastic untuk lini 9.x pada 2026-11; *verify* semuanya terhadap versi yang terpasang saat migrasi.

## 1. Kapan migrasi, dan kapan memilih ELK dibanding Loki

Pemicu migrasinya sama dengan Loki ([migration-loki.md §1](migration-loki.md)): penulisan log membebani MongoDB atau API, lebih dari satu layanan butuh log terpusat, tim butuh dashboard dan alert, atau prune tidak bisa mengimbangi.

Pilih **ELK** dibanding Loki hanya bila minimal satu dari ini benar:

| Pilih ELK bila | Alasan |
|:---|:---|
| Pencarian cepat pada field berkardinalitas tinggi (`requestId`, `userId`, `code`, `err.message`) atas log berminggu-minggu adalah kebutuhan harian | Elasticsearch meng-index setiap field yang di-mapping; Loki hanya meng-index label dan memindai sisanya |
| Tim atau perusahaan sudah menjalankan Elasticsearch atau Elastic Cloud | Tidak ada stack baru yang perlu dipelajari atau dioperasikan |
| Dibutuhkan pencarian full-text di dalam pesan error dan stack trace | Line filter Loki adalah pemindaian brute-force |

Selain itu pilih **Loki**: Elasticsearch butuh memori dan disk jauh lebih banyak (satu JVM per node, ~1,5–3× ukuran log mentah di disk dengan replika) dan lebih teliti dalam operasionalnya. Biaya itu adalah trade-off utama dokumen ini.

## 2. Bentuk target

```
apps/api ──stdout JSON──► container runtime ──► Filebeat ──► Logstash ──► Elasticsearch ──► Kibana
                                                │ tail          │ parse JSON   │ data stream per kind   │ Discover, dashboard,
                                                │ log docker    │ rute per kind│ retensi manual         │ alert
                                                │ buffer, retry │ redaksi cadangan (hapus index lama)
```

- Aplikasi kembali ke **stdout saja**: sink `mongo` dimatikan. Filebeat yang mengirim baris log, jadi gangguan Elasticsearch atau Logstash tidak pernah memengaruhi API.
- API **tidak punya kredensial Elasticsearch dan tidak punya paket Elastic**. Hanya Logstash yang menulis ke Elasticsearch.
- Tidak ada perubahan kode aplikasi: bentuk baris log ([README.md §5](README.md)) sudah berupa JSON terstruktur.
- **Mengapa Logstash, bukan Filebeat → Elasticsearch langsung:** Logstash mem-parse JSON sekali, merutekan setiap baris ke data stream berdasarkan `kind`, dan menerapkan redaksi terakhir (§5). Bila semua itu nanti tidak dibutuhkan, Filebeat bisa menulis langsung ke Elasticsearch dengan ingest pipeline dan Logstash dihapus (keputusan baru).
- Elastic Cloud menjalankan Elasticsearch dan Kibana yang sama; pindah ke sana nanti hanya mengubah `hosts` dan API key pada output Logstash.

## 3. Komponen dan konfigurasi

| Komponen | Peran | Catatan |
|:---|:---|:---|
| Elasticsearch 9.x | Penyimpanan dan pencarian | Security (TLS + auth) aktif secara default; biarkan aktif |
| Logstash 9.x | Parse, rute, redaksi | Satu pipeline, `api-logs` |
| Filebeat 9.x | Mengumpulkan stdout container | Input `filestream` pada berkas log Docker, dengan metadata Docker |
| Kibana 9.x | Query, dashboard, alert | Satu data view: `logs-api.*` |

### 3.1 Filebeat (sketsa, *verify* nama input dan parser)

```yaml
filebeat.inputs:
  - type: filestream
    id: api-containers
    paths: ["/var/lib/docker/containers/*/*.log"]
    parsers:
      - container: { stream: stdout }      # membuka format json-file Docker
processors:
  - add_docker_metadata: ~
  - drop_event:
      when.not.equals: { container.labels.logs: "api" }   # hanya container API (label diset di compose)
output.logstash:
  hosts: ["logstash:5044"]
  ssl.enabled: true
```

### 3.2 Pipeline Logstash (sketsa, *verify* opsi plugin)

```ruby
input { beats { port => 5044 ssl_enabled => true ssl_certificate => "..." ssl_key => "..." } }

filter {
  json { source => "message" target => "log" skip_on_invalid_json => true }
  if ![log][kind] { mutate { add_field => { "[log][kind]" => "app" } } }   # baris pino biasa (log.debug) menjadi kind "app"

  # pindahkan field hasil parse ke level atas dan buang pembungkus Beats
  ruby { code => "event.get('log').each { |k, v| event.set(k, v) }; event.remove('log')" }
  date { match => ["time", "ISO8601"] target => "@timestamp" remove_field => ["time"] }

  # hanya jaring pengaman: scrubber di API adalah redaksi yang sesungguhnya (redaction.md)
  prune { blacklist_names => ["^password$", "^token$", "^cookie$", "^authorization$", "^email$", "^name$", "^body$", "^url$"] }
  mutate { remove_field => ["message", "agent", "ecs", "input", "host", "container", "log.file"] }

  mutate {
    add_field => {
      "[data_stream][type]"      => "logs"
      "[data_stream][dataset]"   => "api.%{kind}"
      "[data_stream][namespace]" => "${APP_ENV}"
    }
  }
}

output {
  elasticsearch {
    hosts       => ["${ES_HOSTS}"]
    api_key     => "${ES_WRITER_API_KEY}"
    ssl_enabled => true
    data_stream => "true"            # merutekan berdasarkan field [data_stream] di atas
  }
}
```

### 3.3 Data stream: satu per kind

Retensi berbeda per `kind` ([log-storage.md §5.1](log-storage.md)), jadi setiap kind punya data stream sendiri dan bisa di-prune sendiri:

| Kind | Data stream | Retensi |
|:---|:---|:---|
| `http` | `logs-api.http-<env>` | 14 hari |
| `app` | `logs-api.app-<env>` | 30 hari |
| `error` | `logs-api.error-<env>` | 30 hari |
| `product` | `logs-api.product-<env>` | 30 hari |
| `audit` | `logs-api.audit-<env>` | 365 hari |

`<env>` adalah `production`, `staging`, atau `development`.

### 3.4 Index template dan mapping (sketsa)

Mapping eksplisit dengan `dynamic: false`: field yang tidak dikenal tetap ada di `_source` (terlihat di Discover) tetapi tidak di-index, sehingga field event baru tidak pernah menyebabkan ledakan mapping.

```json
PUT _index_template/logs-api
{
  "index_patterns": ["logs-api.*-*"],
  "data_stream": {},
  "priority": 200,
  "template": {
    "settings": { "index.lifecycle.name": "logs-api-rollover", "number_of_replicas": 1 },
    "mappings": {
      "dynamic": false,
      "properties": {
        "@timestamp":   { "type": "date" },
        "level":        { "type": "keyword" },
        "kind":         { "type": "keyword" },
        "event":        { "type": "keyword" },
        "service":      { "type": "keyword" },
        "env":          { "type": "keyword" },
        "module":       { "type": "keyword" },
        "sourceModule": { "type": "keyword" },
        "requestId":    { "type": "keyword" },
        "userId":       { "type": "keyword" },
        "method":       { "type": "keyword" },
        "route":        { "type": "keyword" },
        "status":       { "type": "short" },
        "durationMs":   { "type": "float" },
        "code":         { "type": "keyword" },
        "err": { "properties": {
          "name":    { "type": "keyword" },
          "code":    { "type": "keyword" },
          "message": { "type": "match_only_text" }
        } }
      }
    }
  }
}
```

- `priority: 200` menempatkannya di atas template bawaan Elasticsearch `logs-*-*` (*verify* prioritasnya dan apakah 9.x menerapkan index mode `logsdb` padanya).
- `err.stack` tidak di-mapping: tetap disimpan di `_source` dan bisa dibaca di Discover, tetapi tidak bisa dicari.
- Berbeda dengan label Loki, `requestId` dan `userId` aman sebagai keyword ber-index di sini.

## 4. Retensi di Elasticsearch: manual secara default

Periode dan aturan manual sama dengan MongoDB (Q18): tidak ada yang menghapus log secara otomatis. Elasticsearch hanya melakukan **rollover** ke backing index baru setiap hari; operator yang menghapus backing index lama.

### 4.1 Policy khusus rollover

```json
PUT _ilm/policy/logs-api-rollover
{
  "policy": { "phases": { "hot": { "actions": {
    "rollover": { "max_age": "1d", "max_primary_shard_size": "50gb" }
  } } } }
}
```

Tanpa fase `delete` dan tanpa `data_retention` dari data stream lifecycle: itulah yang membuat penghapusan tetap manual. Rollover harian membuat setiap backing index berisi kira-kira satu hari, jadi penghapusan presisi sampai satu hari.

### 4.2 Penghapusan manual

Menghapus satu backing index utuh itu murah; menghapus dokumen satu per satu itu mahal. Jadi skrip prune bekerja per index:

| Aksi | Request |
|:---|:---|
| Daftar backing index sebuah stream | `GET _data_stream/logs-api.http-production` |
| Dokumen terbaru di satu backing index | `GET .ds-logs-api.http-production-*-000042/_search` dengan `size: 0` dan agregasi `max` pada `@timestamp` |
| Hapus satu backing index lama | `DELETE .ds-logs-api.http-production-2026.10.01-000012` |
| Hapus baris milik satu user (jarang) | `POST logs-api.*-production/_delete_by_query` dengan `{ "query": { "term": { "userId": "usr_…" } } }` |

Skrip `scripts/elk-prune.ts` (ditulis saat migrasi), untuk setiap kind:
1. Mendaftar backing index stream dan melewati write index saat ini (tidak bisa dihapus).
2. Menghapus sebuah index hanya bila `@timestamp` **terbarunya** lebih tua dari sekarang dikurangi retensi kind itu. Memakai dokumen terbaru, bukan tanggal pembuatan index, tetap benar walaupun ada data backfill (§6 langkah 7).
3. `--dry-run` mencetak index, rentang tanggal, dan jumlah dokumennya tanpa menghapus.
4. Mengeluarkan satu baris `app.logs_pruned` per kind ke stdout (event yang sama dengan `logs:prune`).

Skrip ini menggantikan `logs:prune` setelah MongoDB tidak dipakai, dan hanya berjalan dengan key `logs_pruner`.

### 4.3 Alternatif otomatis

Bila tim nanti lebih memilih penghapusan otomatis, tambahkan fase delete per kind (satu policy per kind) atau set `data_retention` pada data stream lifecycle, lalu hentikan skrip manual (keputusan baru):

```json
PUT _ilm/policy/logs-api-http
{ "policy": { "phases": {
  "hot":    { "actions": { "rollover": { "max_age": "1d", "max_primary_shard_size": "50gb" } } },
  "delete": { "min_age": "14d", "actions": { "delete": {} } }
} } }
```

## 5. Keamanan dan akses

| Principal | Privilege (pada `logs-api.*`) | Dipakai oleh |
|:---|:---|:---|
| API key `logs_writer` | `create_doc`, `auto_configure` | Hanya Logstash |
| Role `logs_reader` | `read`, `view_index_metadata` | Orang, lewat Kibana |
| API key `logs_pruner` | `read`, `view_index_metadata`, `delete_index`, `delete` | Hanya `elk-prune.ts` |

- Pembagian sama dengan user MongoDB ([log-storage.md](log-storage.md)): writer tidak bisa membaca atau menghapus, orang tidak bisa menghapus.
- TLS antara Filebeat → Logstash → Elasticsearch, dan HTTPS untuk Kibana. Elasticsearch dan Kibana tidak pernah terbuka ke internet publik.
- Superuser `elastic` hanya dipakai untuk menyiapkan role dan key, lalu password-nya dirotasi dan disimpan di secret manager.
- Redaksi tetap di scrubber API ([redaction.md](redaction.md)). Filter `prune` di Logstash adalah jaring pengaman untuk nama key yang dikenal, bukan pengganti.
- Lisensi: tier gratis (Basic) mencakup semua isi dokumen ini kecuali sebagian connector alert (§7). *Verify* ketentuan lisensi terbaru sebelum adopsi.

## 6. Langkah migrasi

1. **Keputusan.** Catat migrasi dan pilihan ELK dibanding Loki (menggantikan bagian MongoDB dari DEC-034; DEC-035 tidak dipakai).
2. **Deploy stack.** Elasticsearch, Logstash, Kibana, dan Filebeat (`docker-compose.elk.yml` atau padanannya di platform). Produksi: minimal 3 node Elasticsearch, atau Elastic Cloud. Buat policy (§4.1), index template (§3.4), role dan key (§5) sebelum Logstash dijalankan.
3. **Jalankan keduanya.** Biarkan sink `mongo` aktif dan biarkan Filebeat membaca stdout. Kedua store kini menerima baris yang sama.
4. **Cek paritas minimal 7 hari.** Jumlah harian per `kind` dan per `module` cocok antara MongoDB dan Elasticsearch (±0,5%); pencarian `requestId` di Kibana menemukan semua baris sebuah request; tidak ada field yang belum di-mapping yang dibutuhkan untuk query harian.
5. **Bangun dashboard dan alert minimum** (§7).
6. **Matikan sink.** Kosongkan `LOG_MONGO_URL` dan deploy. API hanya menulis ke stdout.
7. **Riwayat.** Elasticsearch menerima timestamp lama, jadi backfill bisa dilakukan tetapi opsional:
   - Disarankan: backfill `audit` saja, bila riwayat 365 harinya harus tetap bisa dicari di satu tempat: `mongoexport --query '{"kind":"audit"}'` → input file Logstash → `logs-api.audit-<env>`.
   - Sisanya: biarkan MongoDB read-only dan terus jalankan `logs:prune` sampai kosong (`http` setelah 14 hari, `app`/`error`/`product` setelah 30, `audit` setelah 365 bila tidak di-backfill).
8. **Matikan MongoDB** saat `log_event` kosong (atau setelah backfill audit terverifikasi); hapus `utils/mongo`, sink `mongo`, skrip `logs:*`, dan variabel env MongoDB.
9. **Perbarui spec** (`eng/` dan `id/`): ARCHITECTURE, DATABASE §8, README observability, dan log-storage.

Rollback kapan saja sebelum langkah 8: set `LOG_MONGO_URL` lagi.

## 7. Dashboard dan alert (minimum)

| Panel / alert | Ide query Kibana (KQL / Lens, *verify*) |
|:---|:---|
| Laju request dan laju 5xx per modul | Lens pada `logs-api.http-*`: count, dipecah per `module`, filter `status >= 500` untuk seri error |
| Latensi p95 per modul | Lens: persentil ke-95 dari `durationMs` per `module` |
| Lonjakan error per modul | Rule "Elasticsearch query" pada `logs-api.error-*`: count per `module` selama 5 menit di atas ambang |
| Lonjakan gagal sign-in | Rule pada `logs-api.audit-*`: count `event : "audit.auth.sign_in_failed"` selama 5 menit |
| Perubahan role, ban, endpoint diblokir | Saved search: `event : (audit.user.* or "audit.auth.blocked_endpoint")` |

Di tier gratis, connector alert bawaan terbatas (index dan server log); mengirim alert ke email atau Slack mungkin butuh lisensi berbayar atau Elastic Cloud. *Verify* sebelum mengandalkan notifikasi.

## 8. Kriteria penerimaan (task mendatang)

- [ ] Filebeat hanya mengirim stdout container API; Logstash menulis setiap baris ke `logs-api.<kind>-<env>` sesuai `kind`-nya.
- [ ] Setiap field yang di-mapping di §3.4 bisa dicari; field tak dikenal ada di `_source` tetapi tidak menambah mapping.
- [ ] `requestId` dari header respons menemukan semua baris request itu di Kibana.
- [ ] Cek paritas (§6 langkah 4) lulus selama 7 hari sebelum sink dimatikan.
- [ ] Mematikan Elasticsearch atau Logstash tidak memengaruhi API; baris selama gangguan tiba setelah layanan kembali (dalam batas buffer Filebeat).
- [ ] Tidak ada policy dengan fase `delete` dan tidak ada stream dengan `data_retention`; dry run `elk-prune.ts` mendaftar backing index lama per kind; run sungguhan hanya menghapus index yang dokumen terbarunya sudah melewati periode, tidak pernah write index.
- [ ] Key writer tidak bisa membaca atau menghapus; role reader tidak bisa menghapus.
- [ ] Dashboard dan alert di §7 ada.
