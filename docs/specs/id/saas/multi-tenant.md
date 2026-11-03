# Multi-Tenant

> **Status: desain saja (DEC-042, DEC-047, DEC-050).** Fondasi lapisan SaaS: banyak perusahaan pelanggan (**tenant**) dalam satu aplikasi. Butuh access **tahap 2** ([single-org.md](../auth/access/single-org.md)) dan memakai semua isinya **kecuali §10** (satu organisasi tersembunyi), yang digantikan oleh berkas ini. Keputusan lama menyebutnya "access stage 3". Arsitektur dan isolasi tenant, termasuk row-level security: [architecture.md](architecture.md). Pindah dari tahap 2: [migration.md](migration.md) (Langkah B). Mengoperasikannya butuh konsol platform: [platform-console.md](platform-console.md).

## 1. Yang berubah dari tahap 2

| Urusan | Tahap 2: single-org | Multi-tenant |
|:---|:---|:---|
| Organisasi | Satu, tersembunyi, dibuat oleh seed | Banyak; setiap perusahaan pelanggan adalah satu **tenant** |
| Membuatnya | Tidak ada yang bisa | User yang sudah sign in, saat onboarding (§4) |
| Bergabung | Otomatis saat sign-up | Undangan (§6) atau membuat organisasi sendiri |
| Organisasi aktif | Selalu organisasi utama | Dipilih user; diingat (§5) |
| Role runtime | Satu set | Satu set per organisasi (§7) |
| Mengeluarkan seseorang | Ban platform | Admin organisasi mengeluarkan member; ban platform untuk seluruh aplikasi |
| Platform | Lapisan platform: user, ban, flag ([single-org.md §8](../auth/access/single-org.md)) | Lapisan platform + konsol platform: organisasi, suspend, audit ([platform-console.md](platform-console.md)) |
| Isolasi tenant | Filter aplikasi (`scoped(orgId)`) | Filter aplikasi **ditambah PostgreSQL row-level security** ([architecture.md §3–4](architecture.md), DEC-051) |
| Feature flag | Hanya user | Persentase per organisasi ([feature-flags.md](feature-flags.md)) |
| Observability | `organizationId` di konteks log | Ditambah query per tenant, tag Sentry, group PostHog, purge tenant ([observability.md](observability.md)) |
| Risiko isolasi | Rendah (satu organisasi) | **Tinggi**: satu filter yang terlewat membocorkan data satu pelanggan ke pelanggan lain |

## 2. Perbedaan konfigurasi

```ts
// packages/auth/src/server.ts (sketsa): hanya yang berbeda dari single-org.md §2
organization({
  allowUserToCreateOrganization: async (user) => user.emailVerified === true,   // TBD: butuh pengirim email
  organizationLimit: 5,                     // organisasi yang boleh dibuat seorang user
  membershipLimit: 100,                     // member per organisasi (TBD per produk)
  invitationExpiresIn: 60 * 60 * 24 * 7,    // 7 hari
  invitationLimit: 50,                      // undangan tertunda per organisasi
  cancelPendingInvitationsOnReInvite: true,
  sendInvitationEmail: sendInvitation,      // butuh pengirim email sungguhan (§6)
})
```

Dua hook tahap 2 (bergabung otomatis dan organisasi aktif yang dipaksa, [single-org.md §10.1](../auth/access/single-org.md)) **dihapus**. `PRIMARY_ORG_SLUG` tidak dipakai.

## 3. Isolasi tenant

Desain lengkapnya ada di [architecture.md §3–5](architecture.md). Ini penghalang rilis. Singkatnya:

1. **Dua lapisan.** Aplikasi memfilter setiap query dengan organisasi aktif lewat `scoped(orgId)`, dan PostgreSQL row-level security menolak baris organisasi lain bahkan bila filter aplikasi terlewat (DEC-051).
2. **Organisasi berasal dari session, tidak pernah dari request.** Route modul mengabaikan `organizationId` di body, query, atau path. Pindah organisasi hanya lewat `set-active` (§5).
3. **Tidak ditemukan, bukan dilarang.** ID record tenant lain mengembalikan `404`, tidak pernah `403`.
4. **Cache, antrean, pub/sub, dan berkas membawa organisasi** di key, channel, atau path-nya.
5. **Pembacaan lintas tenant** hanya terjadi di modul `platform`, lewat role database terpisah yang hanya-baca ([architecture.md §4.2](architecture.md)).

## 4. Sign-up dan onboarding

| Situasi setelah sign in | Web app menuju |
|:---|:---|
| User punya satu keanggotaan atau lebih | Organisasi aktif terakhir (§5) |
| Tanpa keanggotaan, ada undangan tertunda untuk email-nya | `/onboarding/invitations`: terima atau tolak |
| Tanpa keanggotaan, tanpa undangan | `/onboarding/create-organization` |

- Membuat organisasi menjadikan pembuatnya `owner` (`creatorRole` plugin) dan mengaktifkannya.
- User tanpa keanggotaan hanya bisa memakai: profil, onboarding, menerima undangan, sign-out. Route modul mengembalikan `403 NO_ACTIVE_ORGANIZATION`.
- `slug`: huruf kecil, angka, dan `-`, 3–40 karakter, unik, dicek dengan pengecekan slug milik plugin. Slug yang dicadangkan (`platform`, `settings`, `api`, `admin`, `app`, `onboarding`) ditolak.

## 5. Organisasi aktif dan pindah organisasi

- Organisasi aktif disimpan di session (`session.activeOrganizationId`), bukan di URL. Semua tab di satu browser berbagi nilainya.
- Saat sign in, `databaseHooks.session.create.before` mengisinya dengan organisasi aktif terakhir user (disimpan sebagai `user.last_active_organization_id`, additional field) bila ia masih member, selain itu keanggotaan tertua, selain itu `null`.
- Pindah: `POST /api/auth/organization/set-active`. Plugin menolak organisasi yang user-nya bukan member (*verify*). Hook kita menolak organisasi `suspended` atau `deleted` dengan `403 ORGANIZATION_SUSPENDED`.
- Setelah pindah, web app mengosongkan seluruh cache TanStack Query dan mengambil ulang `/api/me/permissions`. Tidak ada data organisasi sebelumnya yang tersisa di layar.
- Header menampilkan pemilih organisasi yang hanya berisi keanggotaan user.

## 6. Undangan

| Langkah | Endpoint (*verify*) | Butuh |
|:---|:---|:---|
| Undang lewat email dengan sebuah role | `invite-member` | `invitation:create` |
| Daftar undangan tertunda | `list-invitations` | `invitation:read` (*verify* nama resource) |
| Batalkan undangan | `cancel-invitation` | `invitation:cancel` |
| Terima / tolak | `accept-invitation` / `reject-invitation` | Sign in sebagai email yang diundang |

- Hanya alamat email yang diundang yang bisa menerima (plugin). Link undangan menuju `/onboarding/invitations/{id}`.
- Kamu bisa mengundang dengan role yang kamu pegang atau lebih rendah: role yang semua permission-nya ada di set milikmu (aturan yang sama dengan memberi permission, [single-org.md §7](../auth/access/single-org.md)). `owner` hanya bisa ditawarkan oleh owner.
- **Penghalang:** undangan butuh pengirim email sungguhan. Boilerplate belum punya ([auth/README.md §2](../auth/README.md), `TBD`). Sampai ada, multi-tenant tidak bisa dirilis. URL undangan yang bisa dibagikan (`getInvitationURL`) bukan pengganti: ia melewati pengecekan email.
- Event: `audit.org.invitation_sent`, `invitation_accepted`, `invitation_rejected`, `invitation_cancelled` (§12).

## 7. Role per organisasi

- **Role kode** (`owner`, `admin`, `member`, role kode kustom) ada di setiap organisasi dan sama di mana pun.
- **Role runtime** milik satu organisasi. Organisasi baru dimulai hanya dengan role kode.
- `maximumRolesPerOrganization` membatasi jumlah role runtime (default 20).
- Konsol platform bisa melihat daftar role sebuah organisasi secara hanya-baca; tidak pernah mengubahnya.

## 8. Siklus hidup organisasi

| Status | Diset oleh | Efek |
|:---|:---|:---|
| `active` | Pembuatan | Normal |
| `suspended` | `super_admin` di konsol platform ([platform-console.md §4](platform-console.md)) | Semua route yang di-scope organisasi mengembalikan `403 ORGANIZATION_SUSPENDED`; member tetap bisa sign in, memakai organisasi lain, dan melihat halaman "suspended" untuk organisasi ini; data disimpan |
| `deleted` | Owner (settings, konfirmasi dengan mengetik slug) atau `super_admin` | Sama dengan suspended, ditambah disembunyikan dari pemilih organisasi; data disimpan 30 hari (`TBD` per produk) |
| Purged | Operator menjalankan `bun run org:purge --older-than 30d` (`--dry-run` dulu) dengan role database owner | Baris dihapus dari setiap tabel modul, lalu organisasinya. Baris log-nya ikut di-prune, kecuali event audit ([observability.md §5](observability.md)) |

`disableOrganizationDeletion: true` tetap aktif: hard delete milik plugin tidak pernah bisa dicapai. Purge dilakukan manual, seperti retensi log (DEC-034).

## 9. Member keluar dan dikeluarkan

- `admin` organisasi mengeluarkan member dengan `remove-member` (`member:delete`). Session member itu yang mengaktifkan organisasi tersebut mendapat `activeOrganizationId = null` di request berikutnya.
- Member boleh keluar (`leave`). Owner terakhir tidak bisa keluar atau dikeluarkan (plugin); kepemilikan dipindahkan dulu.
- Mengeluarkan member tidak pernah menghapus kontennya. Aturan kepemilikan pada konten itu lalu gagal untuknya, dan pemegang `posts:manage_all` bisa mengubahnya.

## 10. Batas

| Batas | Nilai |
|:---|:---|
| Organisasi yang boleh dibuat seorang user | 5 (`organizationLimit`) |
| Member per organisasi | 100 (`membershipLimit`, `TBD` per produk) |
| Undangan tertunda per organisasi | 50 |
| Role runtime per organisasi | 20 |
| Masa berlaku undangan | 7 hari |

Ini nilai default untuk setiap tenant. Batas yang berbeda per tenant (untuk pelanggan berbayar) masuk ke [plans-billing.md](plans-billing.md); tanpa spec itu, nilai ini berlaku untuk semua.

## 11. Endpoint organisasi yang diizinkan

Daftar single-org ([single-org.md §10.3](../auth/access/single-org.md)) ditambah: `create`, `update`, `check-slug`, `list` (organisasi milik user), `set-active`, `get-full-organization`, `remove-member`, `leave`, `invite-member`, `list-invitations`, `get-invitation`, `accept-invitation`, `reject-invitation`, `cancel-invitation`. Tidak diizinkan: `delete` (soft delete lewat modul `settings` kita), endpoint team, `add-member` dari client.

## 12. Event audit

Sebagai tambahan dari [single-org.md §13](../auth/access/single-org.md). Daftar lengkap event multi-tenant, termasuk event keamanan, ada di [observability.md §3](observability.md).

| Event | Payload |
|:---|:---|
| `audit.org.created` | `organizationId, actorId` |
| `audit.org.updated` | `organizationId, fields, actorId` (hanya nama field) |
| `audit.org.deleted` / `audit.org.restored` | `organizationId, actorId` |
| `audit.org.invitation_sent` | `organizationId, invitationId, role, actorId` (tanpa email) |
| `audit.org.invitation_accepted` / `rejected` / `cancelled` | `organizationId, invitationId, userId?, actorId?` |
| `audit.org.member_left` | `organizationId, userId` |
| `audit.org.switched` | `fromOrganizationId, toOrganizationId, userId` (info, bukan audit, bila volumenya tinggi) |

## 13. Test: suite isolasi

Penghalang rilis. Di `apps/api/tests/e2e/isolation/`, dibuat untuk **setiap** route yang di-scope organisasi:

- Dua organisasi A dan B, masing-masing dengan owner dan member, masing-masing punya data.
- Member A: membaca, mengubah, dan menghapus ID record B → `404`; daftar hanya berisi baris A; hitungan hanya cocok dengan A.
- Body, query, atau path yang membawa `organizationId` B → diabaikan (tetap data A).
- Setelah pindah ke B, tidak ada data A yang dikembalikan atau di-cache.
- B di-suspend → `403 ORGANIZATION_SUSPENDED` untuk member B di B; A tidak terpengaruh.
- Cek CI gagal bila route baru yang di-scope organisasi tidak punya kasus isolasi.
- Kasus row-level security dari [architecture.md §6](architecture.md) berjalan di suite yang sama.

Ditambah: redirect onboarding (§4), aturan undangan (§6), status siklus hidup (§8), perlindungan owner terakhir (§9).

## 14. Di luar cakupan

- Plan, billing, batas per tenant, dan tenant rollout: bagian SaaS lain ([README.md](README.md)).
- Custom domain atau subdomain per tenant.
- Database atau schema per tenant.
- SSO/SAML per tenant.
- Team di dalam organisasi.
- Impersonation atau "login sebagai pelanggan" (DEC-032).

## 15. Task bila diadopsi

Di atas [single-org.md §15](../auth/access/single-org.md) dan [platform-console.md §10](platform-console.md):

| Task | Tujuan | Bergantung pada |
|:---|:---|:---|
| MT-01 | Konfigurasi (§2), hook organisasi aktif terakhir (§5), cek suspended, allowlist (§11) | ORG-03 |
| MT-02 | Aturan lint isolasi dan suite isolasi (§3, §13, [architecture.md §3](architecture.md)) | ORG-02 |
| MT-03 | Pengirim email + undangan (§6) | Keputusan pengirim email (penghalang) |
| MT-04 | Siklus hidup: soft delete, restore, `org:purge` (§8) | MT-01, MT-09 |
| MT-05 | Halaman onboarding web (§4) | MT-01, TASK-09 |
| MT-06 | Pemilih organisasi di web dan reset cache (§5) | MT-01, TASK-14 |
| MT-07 | Settings web: undangan, keluarkan member, profil organisasi, hapus (§6, §8, §9) | ORG-06, MT-03, MT-04 |
| MT-08 | Flow E2E web: onboarding, undang dan terima, pindah, halaman suspended | MT-05, MT-06, MT-07 |
| MT-09 | Row-level security: role database, policy, transaksi `scoped(orgId)`, test RLS ([architecture.md §4, §6](architecture.md)) | ORG-02 |
| MT-10 | Observability multi-tenant ([observability.md §8](observability.md)) | MT-01, MT-09 |
