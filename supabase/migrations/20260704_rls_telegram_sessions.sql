-- ============================================================
-- Tutup RLS telegram_sessions (RS-2026-07-04)
-- Tabel state percakapan bot, HANYA dipakai edge function (service_role).
-- Client tidak pernah mengaksesnya → tolak total anon/authenticated.
-- service_role mem-bypass RLS, jadi bot tetap jalan.
-- ============================================================
alter table public.telegram_sessions enable row level security;

drop policy if exists "telegram_sessions_deny_all" on public.telegram_sessions;
create policy "telegram_sessions_deny_all" on public.telegram_sessions
  as restrictive for all to anon, authenticated using (false) with check (false);
