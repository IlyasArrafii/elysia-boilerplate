# DESIGN.md: BunForge

## 1. Design Read (Evidence-Based)
- **Product:** BunForge — boilerplate monorepo Bun (ElysiaJS + TanStack Start + Better Auth + Drizzle).
- **Target Audience:** Developer fullstack, indie hacker, tim engineering (PRD §2).
- **Product Type:** Developer Tool.
- **Primary User Goal:** Clone repo → `bun run dev` → login → menambah modul baru dengan RBAC dan caching tanpa menulis ulang fondasi.
- **User Roles & Workflows:** Guest (health/metadata), User (endpoint terautentikasi, data milik sendiri), Admin (permission modul tertentu), Super Admin (manajemen user/role/permission). Layar inti: login/register, callback OAuth, dashboard admin user & role, contoh modul `posts` (list + form).
- **Brand / Aesthetic Direction:** Utilitarian, technical, editorial — grid rapi, hairline border, tipografi monospace untuk identifier, aksen tunggal untuk status. Bukan marketing landing page.
- **Key Personality Traits:** Presisi, Padat-informasi, Tenang.

## 2. Design Dials
- **DESIGN_VARIANCE: 3** — Konsistensi data & pola komponen lebih penting dari variasi visual. Developer tool butuh predictability; variasi tinggi memperlambat scanning tabel permission dan form.
- **MOTION_INTENSITY: 2** — Task velocity tinggi; animasi hanya untuk feedback interaksi (hover, focus, toast). Tidak ada transisi dekoratif.
- **VISUAL_DENSITY: 8** — Panel admin (user/role/permission) dan tabel data butuh density tinggi; whitespace dikontrol via spacing scale, bukan padding besar.

## 3. Visual Identity & Product-Type Adaptation
Karena ini Developer Tool, prioritas: **scanability tabel**, **keyboard navigation**, **hierarki tipografi tegas**, dan **status yang terbaca tanpa warna saja**. Distinctiveness dibangun dari: hairline border 1px `--color-border`, kontras heading vs body yang lebar, monospace untuk identifier (`posts:write`, `user_2abc`), dan grid 12 kolom yang konsisten. Hindari gradient dekoratif, frosted glass, atau rounded blob.

## 4. Semantic Color System
Neutral mendominasi 90% UI; aksen hanya untuk CTA primer, state aktif, dan status.
```css
:root {
  --color-primary:   #111827; /* heading, tombol primer */
  --color-secondary: #374151; /* tombol sekunder */
  --color-accent:    #2563eb; /* CTA aktif, focus ring, link */
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
**Aturan pakai:** `--color-accent` hanya untuk 1 CTA dominan per viewport, focus ring, dan link. `--color-success/warning/danger` hanya untuk badge status & alert. Dilarang gradient neon biru/ungu sebagai indikator "tech".

## 5. Typography & Type Scale
- **Sans (UI/body):** `Geist Sans` — netral, tinggi readability untuk tabel padat.
- **Mono (identifier & code):** `Geist Mono` — untuk permission string, endpoint, dan ID.
- **Justifikasi:** Inter/Geist dipilih karena x-height tinggi dan tabular numerals; bukan karena tren.
```html
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
```
| Level | Size | Weight | LH | Tracking | Rationale |
|:---|:---|:---|:---|:---|:---|
| h1 | 1.75rem | 700 | 1.2 | -0.02em | Page title |
| h2 | 1.25rem | 600 | 1.3 | -0.01em | Section |
| h3 | 1rem | 600 | 1.4 | 0 | Card/panel title |
| body | 0.875rem | 400 | 1.5 | 0 | Default |
| caption | 0.75rem | 500 | 1.4 | 0.02em | Label, badge |
| mono | 0.8125rem | 400 | 1.4 | 0 | Permission, code |

## 6. Layout Strategy & Anti-Repetition Rules
- **Pola struktural per konteks:** Auth = split-pane (form kiri, brand/konteks kanan); Admin user list = master/detail (tabel kiri, drawer kanan); Role editor = form + tabel permission; Modul `posts` = data list + form inline (bukan card grid).
- **Grid & Spacing:** 12-kolom, gutter `16px`, margin konten `24px`/`32px`, spacing scale `4·8·12·16·24·32·48`.
- **Dilarang:** pola "Hero → 3 Cards" berulang; setiap section dibungkus rounded card.

## 7. Anti-AI-Slop Rules
- **Avoid:** Grid 3-card fitur generik → **Prefer:** tabel terstruktur atau list baris.
- **Avoid:** Setiap section dalam rounded card → **Prefer:** hairline divider + whitespace.
- **Avoid:** Gradient ungu/biru & mesh blob → **Prefer:** flat neutral + aksen semantik.
- **Avoid:** Ikon dekoratif & badge tanpa makna → **Prefer:** hierarki tipografi + label status fungsional.
- **Avoid:** Animasi layout-heavy → **Prefer:** transisi `opacity`/`transform` ≤ 150ms untuk feedback.

## 8. Card & Container Discipline
- **Boleh:** widget dashboard, item draggable, panel form terisolasi, dialog/drawer.
- **Dilarang:** untuk section teks standar, list item tabel, atau wrapper paragraf.
- **Larangan nesting:** Card → Card → Card tidak diizinkan; gunakan divider atau sub-heading.

## 9. Component Rules & Action Hierarchy
- **Primary:** solid `--color-primary`/`--color-accent`, 1 per viewport (contoh: "Simpan", "Login").
- **Secondary:** outline 1px border, teks `--color-fg`.
- **Tertiary:** ghost text-only, untuk aksi destruktif sekunder.
- **State Visual:** hover = background `#f3f4f6`; focus = ring 2px `--color-accent` offset 2px; disabled = opacity 0.5 + `cursor:not-allowed`; selected = border kiri 2px accent. Kontras minimum WCAG AA.

## 10. Behavioral Responsive Design
- **Mobile (<640px):** master/detail menjadi stack (list → detail page); tabel permission collapse kolom sekunder (sembunyikan `createdAt`); nav atas → bottom bar; form full-width.
- **Tablet (640–1024px):** drawer detail menjadi modal; sidebar admin collapse ke icon rail.
- **Desktop (≥1024px):** split-pane penuh; tabel semua kolom; form dua kolom.

## 11. States
- **Loading:** skeleton dengan bentuk sama seperti container (baris tabel, field form). Tidak ada spinner generik.
- **Empty:** pesan kontekstual + aksi langsung, mis. "Belum ada user. Undang user pertama." + tombol "Undang User".
- **Error:** alert inline dengan kode error (`AUTH_INVALID_CREDENTIALS`), pesan, dan tombol "Coba lagi". Tidak ada toast-only untuk error kritis.

## 12. Accessibility (WCAG 2.1 AA)
- Keyboard navigable penuh; focus ring 2px offset 2px terlihat di semua elemen interaktif.
- ARIA roles pada tabel (`role="table"`), dialog (`role="dialog"` + `aria-modal`), alert (`role="alert"`).
- Touch target minimum 44×44px.
- Status wajib dikomunikasikan via teks/ikon, bukan warna saja (badge "Aktif" + ikon check, bukan hanya hijau).

## 13. Design Rationale
Density tinggi dan variance rendah melayani **Admin/Super Admin** yang bekerja di tabel user/role/permission (PRD §3, FR-10). Aksen tunggal menjaga CTA RBAC jelas. Monospace untuk identifier permission (`posts:write`) mengurangi salah baca saat assign role. Motion minimal menjaga task velocity saat iterasi modul baru (FR-02, FR-11).

## 14. NO Invented Design Content Rule
Dilarang membuat testimonial, logo klien, screenshot palsu, atau statistik fiktif. Semua konten harus berasal dari PRD/FEATURES atau mock data turunan fitur nyata (user seed, contoh `posts`). Nilai KPI yang belum diukur ditandai `TBD`.

## 15. Design Pre-Flight Checklist
- [ ] Design is derived from PRD/project context.
- [ ] Design Read is specific.
- [ ] Design dials are intentional.
- [ ] Visual direction is justified.
- [ ] Color hierarchy is intentional.
- [ ] Typography is intentional.
- [ ] Cards are not overused.
- [ ] Layouts are not repetitive.
- [ ] No generic AI aesthetic was introduced without justification.
- [ ] Motion has a purpose.
- [ ] Responsive behavior is defined.
- [ ] Loading states are defined where relevant.
- [ ] Empty states are defined where relevant.
- [ ] Error states are defined where relevant.
- [ ] Accessibility is defined.
- [ ] No fake content was invented.
- [ ] Design feels specific to the product.
- [ ] A coding agent can implement the design without inventing major visual decisions.
- [ ] Design System is cohesive and reusable.