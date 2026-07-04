-- ============================================================
-- SECURE CREDITS — LOCKDOWN (Stage 2) ⚠️ JALANKAN PALING AKHIR
-- Report: RS-2026-07-04-001
--
-- ⚠️ PERINGATAN: JANGAN jalankan file ini sampai SEMUA jalur
-- penambahan coin di client sudah dipindah ke RPC server
-- (lihat checklist di SECURITY_REMEDIATION.md). Begitu deny-all
-- di bawah aktif, setiap `supabase.from('user_credits').upsert()`
-- dari browser akan GAGAL — itu memang tujuannya, tapi flow client
-- yang belum dipindah juga akan ikut rusak.
--
-- Setelah aktif: satu-satunya cara menambah/mengurangi coin adalah
-- lewat RPC SECURITY DEFINER (admin_grant_credits, admin_approve_topup,
-- claim_self_reward, spend_credits, dst) yang memverifikasi token sesi
-- & role di server.
-- ============================================================

-- ── user_credits ────────────────────────────────────────────
-- RLS aktif + HANYA policy SELECT permissive → baca boleh, tulis ditolak
-- otomatis (tidak ada policy insert/update/delete yang mengizinkan).
-- CATATAN: JANGAN pakai policy RESTRICTIVE "FOR ALL" untuk memblok tulis —
-- itu ikut memblok SELECT (saldo jadi tak terbaca).
alter table public.user_credits enable row level security;
drop policy if exists "user_credits_read" on public.user_credits;
drop policy if exists "user_credits_no_write" on public.user_credits; -- bekas versi lama
create policy "user_credits_read" on public.user_credits
  for select to anon, authenticated using (true);

-- ── credit_transactions ─────────────────────────────────────
alter table public.credit_transactions enable row level security;
drop policy if exists "credit_tx_read" on public.credit_transactions;
drop policy if exists "credit_tx_no_write" on public.credit_transactions; -- bekas versi lama
create policy "credit_tx_read" on public.credit_transactions
  for select to anon, authenticated using (true);

-- ── topup_requests ──────────────────────────────────────────
-- User boleh MEMBUAT request topup (insert) & membaca; tapi tidak
-- boleh MENGUBAH status (approve/reject) — itu hanya lewat RPC.
-- Baca + buat request (pending) boleh; ubah status/hapus ditolak otomatis
-- (tidak ada policy update/delete) → hanya RPC admin yang bisa approve/reject.
alter table public.topup_requests enable row level security;
drop policy if exists "topup_read" on public.topup_requests;
drop policy if exists "topup_no_update" on public.topup_requests; -- bekas versi lama
drop policy if exists "topup_no_delete" on public.topup_requests; -- bekas versi lama
create policy "topup_read" on public.topup_requests
  for select to anon, authenticated using (true);
drop policy if exists "topup_insert" on public.topup_requests;
create policy "topup_insert" on public.topup_requests
  for insert to anon, authenticated with check (status = 'pending');

-- ── app_users ───────────────────────────────────────────────
-- Kolom sensitif (role, is_active, password_hash) DIBEKUKAN oleh trigger
-- `freeze_user_privileges` (Stage 2) — perubahannya hanya lewat RPC admin.
-- Kolom non-sensitif (mis. telegram_chat_id) tetap boleh ditulis user.
-- Karena itu app_users TIDAK di-deny-all; RLS cukup mengizinkan operasi
-- normal dan trigger yang menjaga privilese.
alter table public.app_users enable row level security;
drop policy if exists "app_users_no_write" on public.app_users;
drop policy if exists "app_users_read" on public.app_users;
create policy "app_users_read" on public.app_users
  for select to anon, authenticated using (true);
-- Update diizinkan RLS, TAPI trigger menolak perubahan role/is_active/hash.
drop policy if exists "app_users_update" on public.app_users;
create policy "app_users_update" on public.app_users
  for update to anon, authenticated using (true) with check (true);
-- Tidak boleh insert/delete langsung (registrasi & hapus lewat RPC).
drop policy if exists "app_users_no_insert" on public.app_users;
create policy "app_users_no_insert" on public.app_users
  as restrictive for insert to anon, authenticated with check (false);
drop policy if exists "app_users_no_delete" on public.app_users;
create policy "app_users_no_delete" on public.app_users
  as restrictive for delete to anon, authenticated using (false);

-- ── user_profiles ───────────────────────────────────────────
-- perks/referral_perks/referral_perks_expires_at DIBEKUKAN oleh trigger
-- `freeze_profile_perks` (Stage 2). Edit profil biasa (nama, avatar, bio)
-- tetap jalan. Jadi cukup izinkan operasi normal + andalkan trigger.
alter table public.user_profiles enable row level security;
drop policy if exists "profiles_read" on public.user_profiles;
create policy "profiles_read" on public.user_profiles
  for select to anon, authenticated using (true);
drop policy if exists "profiles_no_write" on public.user_profiles;
drop policy if exists "profiles_write" on public.user_profiles;
create policy "profiles_write" on public.user_profiles
  for all to anon, authenticated using (true) with check (true);

-- ── user_subscriptions ──────────────────────────────────────
alter table public.user_subscriptions enable row level security;
drop policy if exists "subs_read" on public.user_subscriptions;
drop policy if exists "subs_no_write" on public.user_subscriptions; -- bekas versi lama (memblok SELECT)
create policy "subs_read" on public.user_subscriptions
  for select to anon, authenticated using (true);

-- ── Catat event keamanan ────────────────────────────────────
insert into public.security_audit_log (event_type, details) values (
  'CREDITS_LOCKDOWN_APPLIED',
  jsonb_build_object('report_id', 'RS-2026-07-04-001', 'applied_at', now())
);
