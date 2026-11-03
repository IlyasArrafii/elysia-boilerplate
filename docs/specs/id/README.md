# Spesifikasi (Bahasa Indonesia)

Folder ini adalah **terjemahan** dari [`docs/specs/eng/`](../eng/README.md), dengan berkas dan nomor bagian yang sama. Bila keduanya berbeda, versi Inggris yang menang dan berkas Indonesia diperbaiki (DEC-031).

- `docs/specs/eng/` adalah **sumber kebenaran (kanonis)**.
- `docs/specs/id/` (folder ini) adalah terjemahannya.
- `docs/prd/` adalah paket PRD asli, dibekukan sebagai riwayat. Jangan pakai untuk memutuskan cara membangun apa pun.

## Urutan membaca

1. [PRD.md](PRD.md): apa yang dibangun, untuk siapa, cakupan, kebutuhan, metrik, risiko.
2. [DECISIONS.md](DECISIONS.md): semua keputusan arsitektur (DEC-001 dan seterusnya).
3. [ARCHITECTURE.md](ARCHITECTURE.md): bentuk sistem, monorepo, alur request, caching, variabel lingkungan.
4. Dokumen untuk area yang sedang dikerjakan:

| Area | Dokumen |
|:---|:---|
| Fitur dan kriteria penerimaan | [FEATURES.md](FEATURES.md) |
| Model data (PostgreSQL + Drizzle, log store MongoDB) | [DATABASE.md](DATABASE.md) |
| Kontrak HTTP | [API.md](API.md) |
| Autentikasi (Better Auth) | [auth/README.md](auth/README.md) |
| Access stage (tahap 1 static roles → tahap 2 single-org) | [auth/access/README.md](auth/access/README.md) |
| Tahap 1: role dan permission (default) | [auth/access/static-roles.md](auth/access/static-roles.md) |
| Tahap 2: role dan permission diberikan saat runtime (desain saja) | [auth/access/single-org.md](auth/access/single-org.md) |
| Memilih tahap dan Langkah A (tahap 1 → 2) | [auth/access/migration.md](auth/access/migration.md) |
| Lapisan SaaS (desain saja): multi-tenant, arsitektur dan row-level security, Langkah B, flag, observability, konsol platform, tenant rollout, plan dan billing | [saas/README.md](saas/README.md), [saas/DECISIONS.md](saas/DECISIONS.md) |
| Logging dan telemetry event | [observability/README.md](observability/README.md) |
| Redaksi data sensitif | [observability/redaction.md](observability/redaction.md) |
| Penyimpanan log (MongoDB) dan retensi manual | [observability/log-storage.md](observability/log-storage.md) |
| Migrasi ke Grafana Alloy + Loki | [observability/migration-loki.md](observability/migration-loki.md) |
| Migrasi ke ELK Stack (alternatif Loki) | [observability/migration-elk.md](observability/migration-elk.md) |
| Sentry (desain saja) | [observability/sentry.md](observability/sentry.md) |
| PostHog (desain saja) | [observability/posthog.md](observability/posthog.md) |
| Observability di access stage 1 dan 2 | [observability/access-stages.md](observability/access-stages.md) |
| Feature flag (desain saja) | [feature-flags/README.md](feature-flags/README.md), [targeting.md](feature-flags/targeting.md), [access-stages.md](feature-flags/access-stages.md), [database-provider.md](feature-flags/database-provider.md), [posthog-provider.md](feature-flags/posthog-provider.md) |
| Pengujian (unit, integrasi, E2E) | [TESTING.md](TESTING.md) |
| Design system UI | [DESIGN.md](DESIGN.md) |

5. Aturan coding per aplikasi (hanya dalam bahasa Inggris): [apps/api/README.md](../../../apps/api/README.md) dan [apps/web/README.md](../../../apps/web/README.md).
6. [TASKS.md](TASKS.md): backlog pembangunan.
7. Glosarium: [CONTEXT.md](../../../CONTEXT.md) di root repo.

## Aturan prioritas

1. `DECISIONS.md` mengalahkan dokumen lain di folder ini.
2. Dokumen lain di folder ini mengalahkan README aplikasi. Bila README aplikasi bertentangan dengan spec, berhenti dan tanyakan.
3. Keputusan berstatus **Proposed** tidak boleh diimplementasikan sampai berstatus **Answered**.
4. `TBD` tetap `TBD`. Jangan mengarang angka atau perilaku untuk mengisinya.
5. Tanda *verify* menandai paket, opsi, atau path pihak ketiga yang wajib dicek ke dokumentasi resmi versi yang terpasang sebelum dipakai.
6. Dokumen bertanda **Desain saja** menjelaskan sesuatu yang sengaja belum dibangun. Jangan pasang paketnya atau tulis kodenya sampai pemicu adopsinya terjadi dan dicatat dalam keputusan.

## Pertanyaan terbuka

Tidak ada untuk spec inti. Putaran 7 menjawab Q27 serta menuntaskan Q30 dan Q32 (DEC-047, DEC-048).

Pertanyaan SaaS (Q28, Q29, Q31, Q33 sampai Q39) dilacak di [saas/README.md](saas/README.md#6-pertanyaan-terbuka). Pertanyaan itu tidak bisa mengubah tahap 1 dan 2 (DEC-049).
