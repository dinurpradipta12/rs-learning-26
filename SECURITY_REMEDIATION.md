# Security Remediation — RS-2026-07-04-001

## Akar masalah
Role disimpan di `localStorage` dan divalidasi **hanya di frontend**, sementara
**semua penambahan coin dihitung & ditulis langsung dari browser** memakai anon
key. Akibatnya siapa pun bisa (a) mengubah `role` di localStorage jadi
`developer` untuk membuka panel admin, atau (b) menjalankan
`supabase.from('user_credits').upsert(...)` langsung di console — dan mencetak
coin tak terbatas. Migration hardening 30 Jun (`20260630_security_hardening.sql`)
**tidak pernah benar-benar aktif**, karena kalau aktif tombol admin yang sah pun
akan rusak (client masih menulis tabel langsung).

## Prinsip perbaikan
Client **tidak boleh** jadi otoritas atas uang/role. Anon key hanya untuk baca
data publik + memanggil RPC `SECURITY DEFINER` yang memverifikasi **token sesi**
& role **di server**. Role di localStorage hanya untuk UX (sembunyikan menu);
server tetap menolak bila token bukan milik developer asli.

---

## Status

### ✅ Stage 1 — Fondasi + jalur admin (SELESAI di kode, perlu di-deploy)
File: `supabase/migrations/20260704_secure_credits_foundation.sql` (aditif, aman).
- Tabel `app_sessions` + penerbitan **token sesi acak** saat login.
- `authenticate_app_user` sekarang mengembalikan `token`; client menyimpannya di
  `AppSession.token`.
- Helper `_session_identity(token)` → sumber kebenaran role = DB.
- RPC otoritatif: `admin_grant_credits`, `admin_approve_topup`,
  `admin_reject_topup`, `claim_self_reward`, `revoke_app_session`.

Client sudah dialihkan ke RPC untuk:
- `handleAddCredits` (tombol **+Ruang Coin** admin) → `admin_grant_credits`
- `handleApproveTopup` → `admin_approve_topup` (bonus & perk promo dihitung server)
- `handleRejectTopup` → `admin_reject_topup`

### ✅ Stage 2 — Semua jalur self-reward & perk dipindah ke server
File: `supabase/migrations/20260704_secure_credits_stage2.sql` (aditif).
RPC baru (semua verifikasi token & aturan di server):
`claim_self_reward`, `claim_daily_checkin`, `claim_journey_reward`,
`claim_referral_code`, `admin_set_user_active`, `admin_set_perks`,
`admin_clear_transactions`, plus `register_app_user` kini menerbitkan token.
Trigger `freeze_profile_perks` & `freeze_user_privileges` membekukan kolom
sensitif (`perks`, `referral_perks`, `role`, `is_active`, `password_hash`) dari
tulisan langsung anon/authenticated — edit profil biasa tetap jalan.

Client sudah dialihkan penuh: reward reply/thread/lesson/review, daily check-in,
journey, klaim kode referral (registrasi + modal + halaman profil), admin
toggle aktif / perks / initial credits / reset transaksi, dan approve/reject
topup via Telegram. **Tidak ada lagi** tulisan langsung ke `user_credits` /
`credit_transactions` dari browser.

Setelah Stage 2 di-deploy & diverifikasi → jalankan
`supabase/migrations/20260704_secure_credits_lockdown.sql`.

> ⚠️ Sisa risiko (Stage 3): `useTelegramPolling` menjalankan bot Telegram **di
> dalam browser** dengan `TG_TOKEN` tertanam di bundle client — token bot bocor
> ke siapa pun yang inspect JS. Idealnya seluruh handling Telegram pindah ke
> edge function `telegram-webhook`. Kredit-nya sudah aman (lewat RPC), tapi
> token bot masih terekspos.

### Stage 3 — Pembersihan
- ✅ **Hash token** — `app_sessions` menyimpan `sha256(token)` (kolom
  `token_hash`), bukan token mentah. Verifikasi via `_hash_token()`. Bocornya DB
  tidak lagi membocorkan sesi aktif. (Sudah di foundation migration.)
- ✅ **SQL audit** siap pakai: `supabase/audit_fraudulent_credits.sql` — deteksi
  transaksi topup tanpa `created_by` admin sah, nilai janggal besar, dan selisih
  saldo tak berdasar. **Perlu dijalankan manual** di Supabase (butuh akses DB) +
  koreksi manual saldo curang.
- ✅ `admin-ops` edge function **dihapus** (yatim, sudah digantikan RPC).
- ✅ **Token bot Telegram dikeluarkan dari client.** Dulu `TG_TOKEN`, `TG_CHAT`,
  `STUDENT_BOT_TOKEN` di-hardcode di `src/App.tsx` (bocor di bundle & git
  history). Sekarang semua pengiriman lewat edge function baru `tg-notify`
  (token di env server). Polling bot di browser + `processTelegramCommand`
  (dead code) dihapus — command admin ditangani `telegram-webhook`.

  ⚠️ **WAJIB: rotate kedua token via BotFather** (`/revoke`) karena token lama
  sudah bocor di git history — lalu set ulang sebagai secret:
  ```
  supabase secrets set TG_TOKEN=<baru> TG_CHAT=<id> STUDENT_BOT_TOKEN=<baru>
  supabase functions deploy tg-notify
  ```
  Pertimbangkan juga membersihkan token lama dari git history (git filter-repo).

---

## Urutan deploy (PENTING)
1. Jalankan migration **foundation** (`20260704_secure_credits_foundation.sql`)
   — aditif. Catatan: ada `drop table app_sessions cascade`, jadi semua user
   perlu login ulang.
2. Jalankan migration **stage2** (`20260704_secure_credits_stage2.sql`) — aditif
   (RPC + trigger). Trigger mulai membekukan kolom sensitif → pastikan build
   frontend baru (yang pakai RPC) dideploy berbarengan.
3. Deploy build frontend baru.
4. Verifikasi flow sah masih jalan: login, daily check-in, klaim referral,
   tombol +Coin admin, approve/reject topup, toggle aktif/perks, edit profil.
   (Di titik ini `upsert` manual ke `user_credits` dari console **masih** bisa —
   RLS belum dikunci.)
5. **Terakhir**, jalankan **lockdown** (`20260704_secure_credits_lockdown.sql`).
   Verifikasi: `supabase.from('user_credits').upsert(...)` dari console kini
   **ditolak**, sementara semua flow sah tetap jalan.

> Jangan jalankan langkah 5 sebelum 2–4 beres & terverifikasi.

## Cara verifikasi exploit sudah tertutup (setelah langkah 5)
Di console browser (sebagai user student biasa):
```js
// harus GAGAL / tidak mengubah saldo:
await supabase.from('user_credits').upsert({ username: '<user>', balance: 999999 });
// mengubah role di localStorage lalu buka #admin → panel bisa muncul (UX),
// tapi semua aksi admin (grant/approve) DITOLAK server karena token bukan developer.
```
