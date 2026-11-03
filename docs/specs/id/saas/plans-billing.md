# Plan dan Billing

> **Status: Draft, desain saja.** Dibangun di atas jawaban **Proposed** SAAS-004 sampai SAAS-011. **Q33 (pasar, mata uang, pajak) masih terbuka.** Jangan bangun apa pun sampai entri itu dijawab ([DECISIONS.md](DECISIONS.md)). Butuh [multi-tenant.md](multi-tenant.md). Setiap nilai bertanda `TBD` tetap `TBD`.

## 1. Tujuan

Membuat setiap perusahaan pelanggan (organisasi) berada di sebuah plan yang menyalakan fitur dan menetapkan batas, dan membuat kamu, pemilik SaaS, bisa menagihnya. Versi 1 mengaktifkan plan **secara manual** di konsol platform. Penyedia pembayaran menyusul (SAAS-005).

## 2. Istilah

| Istilah | Arti |
|:---|:---|
| **Plan** | Paket bernama di kode: `free`, `pro`, `business` (SAAS-006) |
| **Fitur** | Entitlement ya/tidak, mis. `posts.export` |
| **Batas** | Angka, mis. `members: 10` |
| **Entitlements** | Yang didapat satu organisasi saat ini: fitur dan batas plan-nya, ditambah override |
| **Subscription** | Plan, interval, periode, dan status satu organisasi |
| **Override** | Pengecualian per organisasi yang diatur di konsol (kesepakatan khusus) |

## 3. Plan di kode (SAAS-007)

```ts
// apps/api/src/modules/billing/plans.ts (sketsa; harga dan batas TBD)
export const plans = definePlans({
  free:     { features: [],                               limits: { members: 3,   runtimeRoles: 0 } },
  pro:      { features: ['posts.export'],                 limits: { members: 25,  runtimeRoles: 5 } },
  business: { features: ['posts.export', 'audit.export'], limits: { members: 100, runtimeRoles: 20 } },
})
export const prices = { /* TBD setelah Q33: mata uang, bulanan dan tahunan per plan */ }
```

- Key fitur berbentuk `module.feature`, dideklarasikan oleh modul pemiliknya, dan dicek saat startup seperti permission.
- Batas yang tidak ada di plan kembali ke default multi-tenant ([multi-tenant.md §10](multi-tenant.md)).
- Mengubah plan adalah perubahan kode dengan review dan deploy. Pelanggan yang sudah di plan itu mendapat nilai barunya.

## 4. Data

Tabel yang di-scope organisasi di modul `billing` (DEC-044):

| Tabel | Kolom |
|:---|:---|
| `subscription` | `organization_id` (unik), `plan_key`, `interval` (`month`, `year`), `status` (`trialing`, `active`, `past_due`, `canceled`), `current_period_start`, `current_period_end`, `cancel_at_period_end`, `provider` (`manual` di v1), `provider_ref`, timestamp |
| `plan_override` | `organization_id` (unik), `features` (jsonb, tambah atau hapus), `limits` (jsonb), `reason` (disimpan, tidak pernah di-log), `expires_at`, `created_by`, timestamp |
| `billing_event` | Event webhook penyedia untuk idempotensi: `provider`, `event_id` (unik per penyedia), `received_at`. Dipakai mulai BIL-06 |

Organisasi baru mendapat `subscription(plan_key = 'free', status = 'active')`, atau `trialing` di `pro` selama 14 hari bila trial aktif (SAAS-008).

## 5. Mengecek entitlements

| Cek | Caranya | Gagal |
|:---|:---|:---|
| Fitur | Opsi route `{ entitlement: 'posts.export' }`, setelah `permission` | `403 PLAN_UPGRADE_REQUIRED` dengan `{ feature }` |
| Batas | Service pemiliknya mengecek sebelum membuat (mis. sebelum undangan atau role runtime) | `403 PLAN_LIMIT_REACHED` dengan `{ limit, max }` |

- Entitlements dihitung per organisasi dan di-cache di Redis (`org:{orgId}:entitlements`, TTL 5 menit), dihapus setiap ada perubahan plan, override, atau status.
- `GET /api/me/permissions` mendapat `entitlements: { features: string[], limits: Record<string, number> }` untuk organisasi aktif. Web app menyembunyikan atau menandai fitur berbayar dengannya, dan API tetap menjadi sumber kebenaran.
- Urutan dengan cek lain: permission → entitlement → flag ([README.md §4](README.md)).
- Member per organisasi: *verify* apakah `membershipLimit` organization plugin menerima fungsi per organisasi. Bila tidak, `hooks.before` kita pada invite dan add-member menegakkan batas plan.

## 6. Siklus hidup (SAAS-008)

| Kejadian | Efek |
|:---|:---|
| Trial berakhir tanpa plan | Kembali ke `free`; aturan melebihi batas berlaku |
| Upgrade | Berlaku langsung. Manual: kamu mengatur plan dan periode baru |
| Downgrade | Berlaku di `current_period_end` (perubahan tertunda ala `cancel_at_period_end`) |
| Melebihi batas setelah downgrade | Tidak ada yang dihapus; penambahan baru diblokir dengan `PLAN_LIMIT_REACHED` sampai di bawah batas |
| Pembayaran gagal | `past_due`, masa tenggang 7 hari dengan banner untuk pemegang `billing:read` |
| Masa tenggang habis | **Read-only** (butuh entri DEC untuk status organisasi baru, lihat [DECISIONS.md](DECISIONS.md#titik-singgung-dengan-access-stage)), lalu `suspended` setelah `TBD` hari |

## 7. Pembayaran

**Versi 1, manual (SAAS-005).** Pelanggan membayar lewat transfer bank atau invoice di luar aplikasi. Kamu membuka organisasinya di konsol dan mengatur plan, interval, dan periode, dengan nomor invoice sebagai `provider_ref`. Setiap perubahan memancarkan `audit.billing.subscription_changed`.

**Nanti, sebuah penyedia (BIL-06).** Terblokir oleh Q33.

```ts
// sketsa
interface BillingProvider {
  createCheckout(orgId: string, plan: PlanKey, interval: Interval): Promise<{ url: string }>
  cancel(orgId: string): Promise<void>
  parseWebhook(req: Request): Promise<BillingEvent>   // memverifikasi signature
}
```

- Kandidat: Stripe (global, kartu, subscription) atau Xendit/Midtrans (Indonesia: VA, QRIS, e-wallet). *Verify* dukungan subscription masing-masing saat adopsi.
- Webhook: `POST /api/billing/webhooks/:provider`, signature dicek, deduplikasi lewat `billing_event`, tidak pernah dipercaya untuk apa pun yang tidak dicakup signature.
- Mata uang, pajak (PPN), dan format invoice: `TBD` (Q33).

## 8. Halaman tenant

| Halaman | Butuh | Menampilkan |
|:---|:---|:---|
| `/settings/billing` | `billing:read` | Plan saat ini, periode, pemakaian terhadap batas, banner status |
| Ganti plan | `billing:manage` | Versi 1: "Minta upgrade" (memancarkan `billing.upgrade_requested`, kamu menindaklanjuti). Dengan penyedia: checkout |

`billing:read` dan `billing:manage` berasal dari statement modul `billing`. `owner` memegang keduanya secara default (SAAS-009).

## 9. Tambahan di konsol

Di `/platform/organizations/:id` ([platform-console.md §7](platform-console.md)):

| Aksi | Permission platform |
|:---|:---|
| Melihat plan, status, periode, override | `platform_billing:read` |
| Mengatur plan dan periode, memperpanjang trial, mengatur atau menghapus override | `platform_billing:write` |
| `/platform/billing`: organisasi per plan, daftar `past_due` | `platform_billing:read` |

Laporan MRR dan pendapatan menyusul.

## 10. Berhenti berlangganan (SAAS-011)

Batal → aktif sampai `current_period_end` → `suspended` → owner bisa mengekspor data selama 30 hari → soft delete dan `org:purge` ([multi-tenant.md §8](multi-tenant.md)). Format ekspor `TBD`.

## 11. Event audit

| Event | Payload |
|:---|:---|
| `audit.billing.subscription_changed` | `organizationId, fromPlan, toPlan, status, actorId` |
| `audit.billing.override_set` / `override_removed` | `organizationId, fields, actorId` (hanya nama field) |
| `billing.upgrade_requested` | `organizationId, plan, actorId` (event produk) |

## 12. Di luar cakupan (versi 1)

Harga per seat dan berbasis pemakaian, proration, kupon, beberapa mata uang (menunggu Q33), faktur pajak, checkout swalayan (sampai penyedia dipilih).

## 13. Test

- Matriks entitlement: setiap plan × setiap route dengan `entitlement` → status yang diharapkan.
- Batas: di batas → `PLAN_LIMIT_REACHED`; downgrade tidak pernah menghapus data.
- Override menang atas plan, dan bisa kedaluwarsa.
- Cache dihapus di setiap perubahan plan, override, dan status.
- `admin` organisasi tanpa `billing:read` mendapat 403 di halaman billing.

## 14. Task (draft, setelah entri SAAS dijawab)

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| BIL-01 | Modul `billing`: plan di kode, tabel, subscription default saat organisasi dibuat | MT-01 |
| BIL-02 | Service entitlement, opsi route `entitlement`, cek batas, cache, field di `/api/me/permissions` | BIL-01 |
| BIL-03 | Konsol: panel plan, override, `/platform/billing` | BIL-01, PC-03 |
| BIL-04 | Halaman tenant `/settings/billing` dan permintaan upgrade | BIL-02, ORG-06 |
| BIL-05 | Job siklus hidup: akhir trial, downgrade di akhir periode, masa tenggang (read-only menunggu DEC-nya) | BIL-02 |
| BIL-06 | Adapter penyedia pembayaran dan webhook | Q33 dijawab |
