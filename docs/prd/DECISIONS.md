# Keputusan Produk: BunForge

Dokumen ini mencatat jawaban pengguna sesuai pilihan dan teks yang diberikan. Label `Dijawab` berarti opsi dipilih, bukan berarti semua detail dalam opsinya sudah ditentukan. Deskripsi opsi adalah konteks, bukan izin untuk mengarang nominal, SLA, atau kebijakan. Jika detail belum eksplisit, tandai `TBD` pada spesifikasi turunannya.

## DEC-001 — Strategi caching seperti apa yang Anda inginkan untuk backend ElysiaJS?

**Status:** Dijawab

**Jawaban pengguna:** In-memory cache (Redis): Menggunakan Redis sebagai cache terpusat, cocok untuk produksi dengan skalabilitas horizontal.

## DEC-002 — Bagaimana Anda ingin menangani batasan antar modul dalam modular monolith?

**Status:** Dijawab

**Jawaban pengguna:** kamu bisa melihat dari adapt basic elysia js untuk modular monolith nya

## DEC-003 — Struktur modul ElysiaJS seperti apa yang ingin dijadikan pola bawaan boilerplate?

**Status:** Dijawab

**Jawaban pengguna:** Elysia plugin per modul: Setiap modul diekspor sebagai Elysia plugin mandiri dengan prefix route sendiri, lalu di-compose di app utama (pola resmi Elysia).

## DEC-004 — Cakupan fitur Better Auth apa yang harus sudah terpasang di boilerplate?

**Status:** Dijawab

**Jawaban pengguna:** email/password + oauth google sertai manajemen role (role & permissions setiap feature modul)

## DEC-005 — Bagaimana model role & permission yang ingin dijadikan pola bawaan di setiap modul?

**Status:** Dijawab

**Jawaban pengguna:** Access control ala Better Auth admin plugin: Memanfaatkan plugin admin/access-control Better Auth sebagai sumber kebenaran role dan permission.
