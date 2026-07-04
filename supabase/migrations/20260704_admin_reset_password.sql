-- ============================================================
-- admin_reset_password — admin menyetel password baru untuk user yang lupa.
-- Verifikasi token developer di server; hash bcrypt cost 12; cabut semua
-- sesi user tersebut agar sesi lama tak bisa dipakai lagi.
-- ============================================================
drop function if exists public.admin_reset_password(text, text, text);
create or replace function public.admin_reset_password(
  p_token text,
  p_target_username text,
  p_new_password text
)
returns json
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  caller record;
  target text := lower(trim(p_target_username));
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer', 'admin') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if p_new_password is null or length(p_new_password) < 6 then
    raise exception 'Password minimal 6 karakter';
  end if;
  if not exists (select 1 from public.app_users where lower(trim(username)) = target) then
    return json_build_object('ok', false, 'error', 'User tidak ditemukan');
  end if;

  update public.app_users
    set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf', 12)),
        updated_at = now()
    where lower(trim(username)) = target;

  -- Cabut semua sesi aktif user itu → wajib login ulang dengan password baru.
  delete from public.app_sessions where username = target;

  return json_build_object('ok', true);
end;
$$;
grant execute on function public.admin_reset_password(text, text, text) to anon, authenticated;
