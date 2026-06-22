# Ruang Sosmed Learning Hub

Platform belajar sosial media: LMS video & materi, community forum, kalender,
booking sesi 1:1, ekonomi **Ruang Coin**, panel admin (inbox & analytics), dark
mode, dan notifikasi update otomatis. Dibangun dengan **React + TypeScript +
Vite** dan **Supabase** (database, auth kustom, storage, edge function).

## Prasyarat

- Node.js 18+
- Akun & project [Supabase](https://supabase.com)

## Setup lokal

```bash
# 1. Install dependency
npm install

# 2. Siapkan environment variables
cp .env.example .env.local
# lalu isi VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY
# (Supabase → Project Settings → API)

# 3. Jalankan dev server
npm run dev
```

## Environment variables

| Variable | Dipakai di | Keterangan |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Frontend | URL project Supabase |
| `VITE_SUPABASE_ANON_KEY` | Frontend | Anon/public key Supabase |
| `TG_TOKEN` | Edge function | Token bot Telegram (@BotFather) |
| `TG_CHAT` | Edge function | Chat/grup ID tujuan notifikasi |
| `SUPABASE_URL` | Edge function | Otomatis tersedia di runtime |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge function | Service role key (rahasia) |

> `.env.local` tidak di-commit. Edge function secret di-set lewat
> `supabase secrets set ...`, bukan di `.env.local`.

## Database

Skema dan policy ada di file `supabase_*.sql` di root. Jalankan di
**Supabase → SQL Editor**. Beberapa yang penting:

- `supabase_app_auth.sql` — tabel user & auth kustom
- `supabase_admin_tables.sql` — kredit & transaksi Ruang Coin
- `supabase_booking_tables.sql` — booking 1:1
- `supabase_lms_tables.sql`, `supabase_courses.sql` — LMS
- `supabase_inbox_clear_policies.sql` — izin DELETE untuk fitur reset inbox

Edge function notifikasi Telegram ada di
`supabase/functions/telegram-webhook/`.

## Build & deploy (Cloudflare Pages)

```bash
npm run build   # output ke folder dist/
```

- **Build command:** `npm run build`
- **Output directory:** `dist`
- Set environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) di
  dashboard Cloudflare Pages.

### Notifikasi versi baru

Setiap build menghasilkan `dist/version.json` berisi `buildId` unik. Klien
melakukan polling file ini; saat deploy baru selesai, semua user yang sedang
membuka app otomatis melihat notifikasi "Versi baru tersedia" dan bisa klik
**Refresh** untuk memuat versi terbaru.

## Scripts

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Dev server (HMR) |
| `npm run build` | Type-check + build produksi |
| `npm run preview` | Preview hasil build |
