# Migrasi: MongoDB → Grafana Alloy + Loki

> **Status: desain saja (DEC-035).** Lakukan ini saat pemicu di §1 terjadi dan sebuah keputusan mencatatnya. Nama komponen dan key konfigurasi dicek terhadap dokumentasi Grafana pada 2026-11; *verify* saat migrasi.

## 1. Kapan bermigrasi

Salah satu dari ini:
- Tulis log terasa membebani MongoDB atau API (ada drop di `telemetry.sink_dropped`, insert lambat).
- Lebih dari satu layanan butuh log terpusat.
- Tim butuh dashboard dan alert atas log (Grafana), bukan query ad-hoc.
- Penyimpanan `log_event` tumbuh lebih cepat daripada yang bisa diimbangi prune mingguan.

## 2. Bentuk target

```
apps/api ──stdout JSON──► runtime container ──► Grafana Alloy ──► Loki ──► Grafana
                                                 │ parse JSON      │ retensi: manual (delete API)
                                                 │ pasang label    │ atau otomatis (compactor)
                                                 │ buffer + retry
```

- Aplikasi kembali ke **stdout saja**: sink `mongo` dimatikan. Alloy mengirim barisnya, sehingga gangguan Loki tidak pernah memengaruhi API.
- Pakai **Grafana Alloy**, bukan Promtail (Promtail mencapai end of life pada 2026-03-02).
- Grafana Cloud menjalankan Loki yang sama; pindah ke sana nanti hanya mengubah endpoint dan kredensial `loki.write`.
- Tidak ada perubahan kode aplikasi: bentuk baris log ([README.md §5](README.md)) sudah sesuai dengan yang diurai Alloy.

## 3. Konfigurasi Alloy

```alloy
// sketsa, verify nama komponen dan argumennya terhadap dokumentasi Alloy
discovery.docker "containers" { host = "unix:///var/run/docker.sock" }

loki.source.docker "api" {
  host       = "unix:///var/run/docker.sock"
  targets    = discovery.docker.containers.targets
  forward_to = [loki.process.api.receiver]
}

loki.process "api" {
  stage.json   { expressions = { level = "level", kind = "kind", service = "service", env = "env", module = "module" } }
  stage.labels { values = { level = "", kind = "", service = "", env = "", module = "" } }
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint { url = env("LOKI_PUSH_URL") }
}
```

### Label

| Label | Nilai | Boleh? |
|:---|:---|:---|
| `service`, `env` | sedikit | ya |
| `kind` | `http`, `app`, `error`, `audit`, `product` | ya; menentukan retensi |
| `level` | level pino | ya |
| `module` | nama modul + `auth`, `core` (terbatas, paling banyak beberapa lusin) | ya; "error per modul" menjadi query label |
| `userId`, `requestId`, `route`, `event`, `sourceModule` | besar atau tak terbatas | **tidak pernah jadi label**; query sebagai field JSON (`| json | requestId="…"`) |

## 4. Retensi di Loki: manual secara default

Periodenya sama dengan MongoDB ([log-storage.md §5.1](log-storage.md)). Agar tetap manual (Q18), retensi otomatis dimatikan dan log lama dihapus lewat delete API Loki. Endpoint delete hanya ada selama retensi compactor diaktifkan.

```yaml
# sketsa konfigurasi Loki, verify key terhadap dokumentasi Loki versi yang terpasang
compactor:
  retention_enabled: true              # wajib untuk delete API
  delete_request_store: filesystem     # atau object store yang dipakai
  delete_request_cancel_period: 24h
limits_config:
  retention_period: 0s                 # 0s = tidak pernah menghapus otomatis (mode manual)
  deletion_mode: filter-and-delete     # sembunyikan dan hapus baris yang cocok
```

### Penghapusan manual

| Aksi | Request |
|:---|:---|
| Hapus satu kind yang lebih tua dari periodenya | `POST /loki/api/v1/delete?query={kind="http"}&start=<epoch 0>&end=<now-14d>` → 204 |
| Lihat daftar delete request | `GET /loki/api/v1/delete` |
| Batalkan dalam periode pembatalan | `DELETE /loki/api/v1/delete?request_id=<id>` |
| Hapus baris milik satu user | `POST /loki/api/v1/delete?query={service="api"} \|= "usr_…"&start=…&end=…` (line filter; berat, jarang dipakai) |

Script `scripts/loki-prune.ts` (ditulis saat migrasi) melakukan loop atas tabel retensi dan mengirim satu delete request per kind, dengan `--dry-run` yang mencetak request-nya. Script ini menggantikan `logs:prune` setelah MongoDB tidak dipakai lagi. Penghapusan terjadi setelah periode pembatalan, saat compactor berjalan.

### Alternatif otomatis

Bila nanti tim memilih penghapusan otomatis, atur retensi per stream dan hentikan script manual (keputusan baru):

```yaml
limits_config:
  retention_period: 720h               # default 30 hari
  retention_stream:
    - { selector: '{kind="http"}',  priority: 1, period: 336h }   # 14 hari
    - { selector: '{kind="audit"}', priority: 1, period: 8760h }  # 365 hari
```

## 5. Langkah migrasi

1. **Keputusan.** Catat migrasinya (menggantikan bagian MongoDB dari DEC-034).
2. **Deploy stack.** Loki, Alloy, dan Grafana (`docker-compose.observability.yml` atau padanannya di platform). Aktifkan versioning object storage sebelum retensi diaktifkan.
3. **Jalankan keduanya.** Biarkan sink `mongo` menyala dan arahkan Alloy ke stdout. Kedua store kini menerima baris yang sama.
4. **Cek kesetaraan minimal 7 hari.** Jumlah harian per `kind` dan per `module` sama antara MongoDB dan Loki (±0,5%); pencarian `requestId` berfungsi di Grafana; label hanya yang ada di §3.
5. **Bangun dashboard dan alert minimum** (§6).
6. **Matikan sink.** Kosongkan `LOG_MONGO_URL` dan deploy. API hanya menulis stdout.
7. **Riwayat.** Jangan backfill dokumen lama ke Loki (Loki menolak sampel lama secara default). Biarkan MongoDB read-only dan terus jalankan `logs:prune` sampai kosong: `http` setelah 14 hari, `app`/`error` setelah 30, `audit` setelah 365. Bila audit harus disimpan lebih lama, ekspor dulu (`mongoexport --query '{"kind":"audit"}'`) ke object storage terenkripsi.
8. **Matikan MongoDB** saat `log_event` kosong; hapus `utils/mongo`, sink `mongo`, script `logs:*`, dan variabel env MongoDB.
9. **Perbarui spec** (di `eng/` dan `id/`): ARCHITECTURE, DATABASE §8, README observability, dan log-storage.

Rollback kapan pun sebelum langkah 8: isi lagi `LOG_MONGO_URL`.

## 6. Dashboard dan alert (minimum)

| Panel / alert | Ide query (LogQL, *verify*) |
|:---|:---|
| Laju request dan laju 5xx per modul | `sum by (module) (rate({kind="http"}[5m]))` |
| Latensi p95 per modul | `quantile_over_time(0.95, {kind="http"} \| json \| unwrap durationMs [5m]) by (module)` |
| Lonjakan error per modul | `sum by (module) (count_over_time({kind="error"}[5m])) > threshold` |
| Lonjakan kegagalan sign-in | `count_over_time({kind="audit"} \|= "audit.auth.sign_in_failed" [5m]) > threshold` |
| Perubahan role, ban, endpoint diblokir | `{kind="audit"} \| json \| event=~"audit.user.*\|audit.auth.blocked_endpoint"` |

## 7. Kriteria penerimaan (task mendatang)

- [ ] Alloy mengirim log API ke Loki dengan label `service`, `env`, `kind`, `level`, `module` saja.
- [ ] `requestId` dari header response menemukan semua baris request itu di Grafana.
- [ ] Cek kesetaraan (§5 langkah 4) lulus selama 7 hari sebelum sink dimatikan.
- [ ] Mematikan Loki tidak memengaruhi API; baris selama gangguan tiba setelah Loki kembali (dalam batas buffer Alloy).
- [ ] Penghapusan manual: dry run menampilkan satu request per kind; jalan sungguhan menghapus baris yang lebih tua dari periodenya setelah periode pembatalan; `retention_period` bernilai `0s`.
- [ ] Dashboard dan alert di §6 ada.
