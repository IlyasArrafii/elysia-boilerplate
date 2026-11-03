# Targeting Feature Flag: Hanya User, Tanpa Role

> **Status: desain saja (DEC-038).** Dokumen ini menentukan cara sebuah flag memilih siapa yang mendapat nilai "on". Berlaku untuk database provider dan, sejauh dimungkinkan PostHog, untuk PostHog provider.
>
> Aturan ini untuk access stage 1 dan 2. Di lapisan SaaS multi-tenant persentase meng-hash organisasi, bukan user: [saas/feature-flags.md](../saas/feature-flags.md). Menargetkan tenant tertentu adalah tambahan SaaS: [saas/tenant-rollout.md](../saas/tenant-rollout.md). Keduanya tidak menambah targeting role.

## 1. Mengapa tanpa targeting role

Role menentukan **akses** (permission). Bila flag bisa menarget role, "siapa yang bisa melihat bulk delete baru" akan diputuskan di dua tempat, dan perubahan flag bisa diam-diam berperilaku seperti perubahan permission. Karena itu:

- Evaluation context hanya memuat `targetingKey` (user ID).
- Flag tidak pernah bisa dinyalakan "untuk admin". Bila suatu perilaku milik admin, itu adalah **permission**. Bila itu rollout yang ingin dimulai dari beberapa admin, daftarkan user ID admin tersebut.

## 2. Empat aturan

Setiap flag punya field targeting berikut (nama kolom database provider dalam kurung):

| Aturan | Field | Arti |
|:---|:---|:---|
| Kill switch | `enabled` | `false` = semua orang mendapat nilai off, apa pun pengaturan lainnya |
| Kecualikan user | `excludeUserIds` | User ini selalu mendapat nilai off |
| Sertakan user | `includeUserIds` | User ini selalu mendapat nilai on |
| Rollout persentase | `rolloutPercentage` (0–100, dua desimal) | Persentase dari semua user lain yang login yang mendapat nilai on |

## 3. Urutan evaluasi

Yang pertama cocok menang:

| # | Kondisi | Nilai | Reason OpenFeature |
|:---|:---|:---|:---|
| 1 | Flag tidak ada di katalog atau tabel | default kode | `ERROR` (`FLAG_NOT_FOUND`) |
| 2 | Tipe yang diminta ≠ tipe flag | default kode | `ERROR` (`TYPE_MISMATCH`) |
| 3 | `enabled = false` | nilai off | `DISABLED` |
| 4 | `targetingKey` ada di `excludeUserIds` | nilai off | `TARGETING_MATCH` |
| 5 | `targetingKey` ada di `includeUserIds` | nilai on | `TARGETING_MATCH` |
| 6 | `rolloutPercentage = 100` | nilai on | `STATIC` |
| 7 | `targetingKey` ada dan `bucket(seed, targetingKey) < rolloutPercentage` | nilai on | `SPLIT` |
| 8 | selain itu | nilai off | `DEFAULT` |

Exclude mengalahkan include: user yang ada di kedua daftar mendapat off. Dengan begitu "keluarkan satu user ini dari rollout" selalu berhasil.

## 4. Bucketing persentase

```ts
// sketsa
function bucket(seed: string, targetingKey: string): number {   // 0.00 – 99.99
  const digest = createHash('sha256').update(`${seed}:${targetingKey}`).digest()
  return (digest.readUInt32BE(0) % 10_000) / 100
}
// seed = flag.bucketingSeed ?? flag.key
```

- **Lengket:** user yang sama mendapat jawaban yang sama di setiap request dan instans.
- **Monoton:** 10% → 30% mempertahankan 10% pertama dan menambah sisanya. Menurunkan persentase mengeluarkan user.
- **Independen per flag:** key ikut di-hash, jadi user yang sama tidak selalu menjadi yang pertama di setiap rollout.
- **Acak ulang:** ganti `bucketingSeed` untuk memilih kelompok lain.
- SHA-256 dari `node:crypto`, bukan `Bun.hash`, agar bucket tidak berubah karena upgrade runtime.

## 5. Tamu

Tamu tidak punya `targetingKey`. Aturan 4, 5, dan 7 tidak bisa cocok, jadi tamu mendapat nilai on hanya pada 100% (aturan 6), selain itu nilai off. Tidak ada ID tamu bersama: itu akan menaruh semua tamu di bucket yang sama.

## 6. Resep

| Tujuan | Pengaturan |
|:---|:---|
| Uji internal dulu | `enabled: true`, `includeUserIds: [ID penguji]`, `rolloutPercentage: 0` |
| Canary | tambahkan `rolloutPercentage: 5`, lalu 25, 50, 100, sambil memantau error per modul di log store |
| Keluarkan satu user | tambahkan ID-nya ke `excludeUserIds` |
| Hentikan darurat | `enabled: false` |
| Selesai | `rolloutPercentage: 100`, lalu hapus flag dan cabang kodenya sebelum `removeBy` |
| "Hanya admin" | Bukan flag. Tambahkan permission ([auth/access/static-roles.md §9](../auth/access/static-roles.md)) |

## 7. Batas

| Batas | Nilai | Alasan |
|:---|:---|:---|
| `includeUserIds` + `excludeUserIds` | ≤ 1 000 ID per flag | Snapshot ada di memori setiap instans; kelompok lebih besar memakai persentase |
| User ID tak dikenal di daftar | Ditolak admin API (dicek terhadap `user.id`) | Salah ketik akan diam-diam tidak berefek |
| User yang dihapus | Dibiarkan di daftar; tidak berbahaya; dibersihkan oleh aksi "clean lists" di admin API | |

## 8. Test

- Setiap baris §3, termasuk exclude-mengalahkan-include dan tamu.
- Bucketing: ID tetap memberi bucket yang sama di setiap run; 10 000 ID acak pada 25% jatuh di 24–26%; menaikkan 10% → 30% mempertahankan semua yang sebelumnya on.
- Penyusun context hanya menghasilkan `targetingKey` (test memastikan objeknya punya tepat satu key).
