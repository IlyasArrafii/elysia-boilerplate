# DESIGN.md

Design system UI untuk `apps/web`. Token berada di `packages/ui`.

## 1. Pembacaan desain

- **Produk:** boilerplate monorepo Bun (Elysia + TanStack Start + Better Auth + Drizzle).
- **Audiens:** developer full-stack, indie hacker, tim engineering.
- **Jenis produk:** developer tool.
- **Tujuan utama user:** clone → `bun run dev` → sign in → menambah modul dengan RBAC dan caching tanpa menulis ulang fondasi.
- **Layar inti:** sign-in dan register, kembali dari OAuth, admin users (daftar + detail), katalog role (hanya-baca), posts (daftar + form), profil.
- **Arah:** utilitarian, teknis, editorial. Grid rapi, border hairline, monospace untuk identifier, satu warna aksen untuk state. Bukan halaman marketing.
- **Kepribadian:** presisi, padat informasi, tenang.

## 2. Dial desain

| Dial | Nilai | Alasan |
|:---|:---|:---|
| Variasi | 3 / 10 | Pola yang bisa ditebak lebih baik daripada ragam visual untuk tabel dan form |
| Gerak | 2 / 10 | Hanya umpan balik (hover, focus, toast); tanpa transisi dekoratif |
| Kepadatan | 8 / 10 | Tabel admin butuh kepadatan; ruang kosong berasal dari skala spasi, bukan padding besar |

## 3. Identitas visual

Prioritas: tabel yang mudah dipindai, navigasi keyboard, hierarki tipografi yang kuat, state terbaca tanpa warna. Kekhasan datang dari border hairline 1px, kontras lebar antara heading dan body, identifier monospace (`posts:write`, `usr_2abc`), dan grid 12 kolom yang konsisten. Tanpa gradien dekoratif, frosted glass, atau blob.

## 4. Token warna

Warna netral mencakup sekitar 90% UI. Aksen hanya untuk CTA utama, state aktif, dan tautan.

```css
:root {
  --color-primary:   #111827; /* heading, tombol utama */
  --color-secondary: #374151; /* tombol sekunder */
  --color-accent:    #2563eb; /* CTA aktif, focus ring, tautan */
  --color-success:   #15803d;
  --color-warning:   #b45309;
  --color-danger:    #b91c1c;
  --color-bg:        #fafafa;
  --color-surface:   #ffffff;
  --color-fg:        #111827;
  --color-muted:     #6b7280;
  --color-border:    #e5e7eb;
}
```

Aturan: satu CTA aksen per viewport. Success/warning/danger hanya untuk badge status dan alert. Token mode gelap: `TBD` (definisikan di `packages/ui` sebelum merilis tema gelap).

## 5. Tipografi

- **Sans (UI/body):** Geist Sans.
- **Mono (identifier, kode):** Geist Mono, untuk string permission, endpoint, dan ID.

| Level | Ukuran | Ketebalan | Line height | Tracking | Pemakaian |
|:---|:---|:---|:---|:---|:---|
| h1 | 1.75rem | 700 | 1.2 | -0.02em | Judul halaman |
| h2 | 1.25rem | 600 | 1.3 | -0.01em | Bagian |
| h3 | 1rem | 600 | 1.4 | 0 | Judul panel |
| body | 0.875rem | 400 | 1.5 | 0 | Default |
| caption | 0.75rem | 500 | 1.4 | 0.02em | Label, badge |
| mono | 0.8125rem | 400 | 1.4 | 0 | Permission, kode |

## 6. Layout

- **Per layar:** auth = split pane (form kiri, konteks kanan); admin users = master/detail (tabel kiri, drawer kanan); katalog role = daftar role + tabel permission (hanya-baca, role adalah kode); posts = daftar data + form inline (bukan grid kartu).
- **Grid dan spasi:** 12 kolom, gutter 16px, margin konten 24px/32px, skala spasi 4 · 8 · 12 · 16 · 24 · 32 · 48.
- **Jangan pernah:** bagian "hero → 3 kartu" yang berulang; membungkus setiap bagian dengan kartu membulat.

## 7. Anti-pola

| Hindari | Utamakan |
|:---|:---|
| Grid fitur 3 kartu yang generik | Tabel terstruktur atau daftar baris |
| Setiap bagian dalam kartu membulat | Divider hairline dan ruang kosong |
| Gradien ungu/biru, blob mesh | Netral datar plus aksen semantik |
| Ikon dekoratif, badge tanpa makna | Hierarki tipografi dan label status fungsional |
| Animasi yang berat di layout | Transisi `opacity`/`transform` ≤ 150 ms untuk umpan balik |

## 8. Kartu dan container

- **Diizinkan:** widget dashboard, item yang bisa di-drag, panel form terisolasi, dialog dan drawer.
- **Tidak diizinkan:** bagian teks biasa, baris tabel, pembungkus paragraf.
- **Tanpa nesting** kartu → kartu → kartu; pakai divider atau sub-judul.

## 9. Komponen dan hierarki aksi

- **Utama:** solid `--color-primary` atau `--color-accent`, satu per viewport ("Save", "Sign in").
- **Sekunder:** outline 1px, teks `--color-fg`.
- **Tersier:** ghost, hanya teks; untuk aksi destruktif sekunder.
- **State:** hover = latar `#f3f4f6`; focus = ring `--color-accent` 2px, offset 2px; disabled = opacity 50% dan `cursor: not-allowed`; selected = border kiri aksen 2px. Kontras minimal WCAG AA.
- **Aksi destruktif** (ban, hapus, cabut sesi, ubah role) memakai dialog konfirmasi yang menyebut user ID target.

## 10. Perilaku responsif

| Breakpoint | Perilaku |
|:---|:---|
| Mobile < 640px | Master/detail bertumpuk (daftar → halaman detail); tabel menyembunyikan kolom sekunder (`createdAt`); nav atas menjadi bar bawah; form selebar layar |
| Tablet 640–1024px | Drawer detail menjadi modal; sidebar admin menyusut menjadi rail ikon |
| Desktop ≥ 1024px | Split pane penuh; semua kolom tabel; form dua kolom |

## 11. State

- **Loading:** skeleton berbentuk konten (baris tabel, field form). Tanpa spinner generik.
- **Kosong:** pesan kontekstual plus aksi langsung, mis. "No posts yet." dengan tombol "Create post" (hanya bila user punya `posts:write`).
- **Error:** alert inline dengan kode error monospace, pesan, dan tombol "Try again". Error kritis tidak pernah hanya berupa toast.
- **Forbidden:** halaman yang tidak bisa diakses user tidak ditampilkan di navigasi; kunjungan langsung diarahkan dengan pesan singkat.

## 12. Aksesibilitas (WCAG 2.1 AA)

- Bisa dinavigasi penuh dengan keyboard; focus ring 2px yang terlihat dengan offset 2px di setiap elemen interaktif.
- Role ARIA pada tabel (`role="table"`), dialog (`role="dialog"` + `aria-modal`), dan alert (`role="alert"`).
- Target sentuh minimal 44×44px.
- State selalu dinyatakan dengan teks atau ikon, tidak pernah warna saja (badge "Active" juga punya ikon centang).

## 13. Alasan

Kepadatan tinggi dan variasi rendah melayani Admin dan Super Admin yang bekerja di tabel user, role, dan post. Satu aksen menjaga aksi RBAC tetap jelas. Identifier monospace mengurangi salah baca saat memberi role. Gerak minimal menjaga kecepatan kerja.

## 14. Tanpa konten karangan

Tanpa testimoni palsu, logo klien, screenshot, atau statistik. Konten berasal dari seed (user seed, contoh post) atau fitur nyata. KPI yang belum diukur menampilkan `TBD`.

## 15. Checklist sebelum rilis

- [ ] Memakai token dari `packages/ui`; tanpa nilai hex lepas.
- [ ] Satu CTA utama per viewport.
- [ ] Kartu hanya di tempat yang diizinkan §8.
- [ ] State loading, kosong, error, dan forbidden terdefinisi.
- [ ] Perilaku responsif sesuai §10.
- [ ] Pengecekan keyboard dan screen reader sesuai §12.
- [ ] Tanpa konten karangan.
