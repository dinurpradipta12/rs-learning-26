-- ============================================================
-- SECURE CREDITS — STAGE 2 (RS-2026-07-04-001)
-- Memindahkan SEMUA jalur self-reward & perk ke server, plus trigger
-- yang membekukan kolom sensitif dari tulisan client. Aditif & aman —
-- boleh dijalankan sebelum lockdown. Lockdown Stage 2b (di file
-- 20260704_secure_credits_lockdown.sql) dijalankan PALING AKHIR.
--
-- Sumber setting reward/referral = learning_hub_content
--   (content_key = 'admin_credit_settings').
-- ============================================================

-- ── Helper: baca admin settings sebagai jsonb ───────────────
drop function if exists public._admin_settings();
create or replace function public._admin_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  raw jsonb;
  c   text;
begin
  select content::text into c from public.learning_hub_content
    where content_key = 'admin_credit_settings' limit 1;
  if c is null then
    return '{}'::jsonb;
  end if;
  begin
    raw := c::jsonb;
  exception when others then
    raw := '{}'::jsonb;
  end;
  return coalesce(raw, '{}'::jsonb);
end;
$$;

-- Label reward → deskripsi transaksi (harus SAMA PERSIS dengan client).
drop function if exists public._reward_desc(text);
create or replace function public._reward_desc(p_key text)
returns text
language sql
immutable
as $$
  select case p_key
    when 'reply_thread'    then 'Bonus: Balas Thread / QNA'
    when 'create_thread'   then 'Bonus: Buat Thread Baru'
    when 'daily_login'     then 'Bonus: Login Harian'
    when 'complete_lesson' then 'Bonus: Selesai Materi / Video'
    when 'write_review'    then 'Bonus: Tulis Review Materi'
    else null
  end;
$$;

-- Helper internal: tambah saldo + catat transaksi (dipanggil RPC lain).
-- Tidak di-grant ke anon/authenticated.
drop function if exists public._add_credits(text, integer, text, text);
create or replace function public._add_credits(
  p_username text, p_amount integer, p_description text, p_created_by text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  new_balance integer;
begin
  insert into public.user_credits (username, balance)
  values (p_username, greatest(0, p_amount))
  on conflict (username) do update set balance = public.user_credits.balance + p_amount
  returning balance into new_balance;

  insert into public.credit_transactions (username, amount, type, description, created_by)
  values (p_username, p_amount, 'topup', p_description, p_created_by);

  return new_balance;
end;
$$;

-- ── 1. Reward generik (reply/create thread, complete lesson, review) ──
drop function if exists public.claim_self_reward(text, text);
create or replace function public.claim_self_reward(p_token text, p_reward_key text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
  settings jsonb;
  rule jsonb;
  amount integer;
  per_day integer;
  desc_text text;
  used_today integer;
  new_balance integer;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  desc_text := public._reward_desc(p_reward_key);
  if desc_text is null then
    raise exception 'Reward tidak dikenal';
  end if;

  settings := public._admin_settings();
  rule := settings->'coin_rewards'->p_reward_key;
  amount := coalesce((rule->>'amount')::int, 0);
  per_day := coalesce((rule->>'perDay')::int, 1);
  if amount <= 0 then
    return json_build_object('ok', false, 'error', 'Reward nonaktif');
  end if;

  select count(*) into used_today from public.credit_transactions
    where username = caller.username
      and description = desc_text
      and created_at >= date_trunc('day', now());
  if used_today >= per_day then
    return json_build_object('ok', false, 'error', 'Batas harian tercapai');
  end if;

  new_balance := public._add_credits(caller.username, amount, desc_text, null);
  return json_build_object('ok', true, 'newBalance', new_balance, 'amount', amount);
end;
$$;
grant execute on function public.claim_self_reward(text, text) to anon, authenticated;

-- ── 2. Daily check-in bertingkat (streak + bonus hari ke-7) ──
drop function if exists public.claim_daily_checkin(text);
create or replace function public.claim_daily_checkin(p_token text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
  settings jsonb;
  daily_coins integer;
  day7 jsonb;
  prof record;
  today date := (now() at time zone 'utc')::date;
  streak integer;
  last_dt date;
  claim_day integer;
  coins integer;
  desc_text text;
  is_day7 boolean;
  new_balance integer;
  merged jsonb;
  feat text;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  settings := public._admin_settings();
  daily_coins := coalesce((settings->'coin_rewards'->'daily_login'->>'amount')::int, 0);
  day7 := coalesce(settings->'checkin_day7', '{}'::jsonb);

  select checkin_streak, last_checkin into prof
    from public.user_profiles where username = caller.username for update;
  streak := coalesce(prof.checkin_streak, 0);
  -- String kosong '' bukan null → hindari cast ''::date yang error.
  last_dt := nullif(prof.last_checkin, '')::date;

  -- Sudah check-in hari ini.
  if last_dt = today then
    return json_build_object('ok', false, 'error', 'Sudah check-in hari ini');
  end if;
  -- Lewat 2 hari → reset streak (samakan dengan client).
  if last_dt is not null and (today - last_dt) > 2 then streak := 0; end if;
  -- Siklus 7 hari selesai → mulai baru.
  if streak >= 7 then streak := 0; end if;

  claim_day := streak + 1;
  is_day7 := (claim_day = 7);
  coins := case when is_day7 then coalesce((day7->>'coins')::int, 0) else 0 end;
  if is_day7 and coins = 0 then coins := daily_coins; end if;
  if not is_day7 then coins := daily_coins; end if;
  desc_text := case when is_day7 then 'Bonus: Check-in Hari ke-7' else 'Bonus: Login Harian' end;

  new_balance := public._add_credits(caller.username, coins, desc_text, null);

  update public.user_profiles
    set checkin_streak = claim_day, last_checkin = today::text
    where username = caller.username;

  -- Bonus fitur hari ke-7.
  if is_day7 and jsonb_array_length(coalesce(day7->'features', '[]'::jsonb)) > 0 then
    select coalesce(referral_perks, '{}'::jsonb) into merged
      from public.user_profiles where username = caller.username;
    for feat in select jsonb_array_elements_text(day7->'features') loop
      merged := merged || jsonb_build_object(feat, true);
    end loop;
    update public.user_profiles set referral_perks = merged where username = caller.username;
  end if;

  return json_build_object('ok', true, 'newBalance', new_balance, 'day', claim_day, 'coins', coins);
end;
$$;
grant execute on function public.claim_daily_checkin(text) to anon, authenticated;

-- ── 3. Journey reward (sekali seumur akun) ──────────────────
drop function if exists public.claim_journey_reward(text);
create or replace function public.claim_journey_reward(p_token text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
  already integer;
  new_balance integer;
  reward integer := 5; -- JOURNEY_REWARD
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  select count(*) into already from public.credit_transactions
    where username = caller.username and description = 'Bonus: Selesai Journey';
  if already > 0 then
    return json_build_object('ok', false, 'error', 'Journey sudah pernah diklaim');
  end if;

  new_balance := public._add_credits(caller.username, reward, 'Bonus: Selesai Journey', null);
  return json_build_object('ok', true, 'newBalance', new_balance);
end;
$$;
grant execute on function public.claim_journey_reward(text) to anon, authenticated;

-- ── 4. Klaim kode referral (coin / feature, sekali per user) ─
drop function if exists public.claim_referral_code(text, text);
create or replace function public.claim_referral_code(p_token text, p_code text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
  settings jsonb;
  code_up text := upper(trim(p_code));
  ref jsonb;
  ref_type text;
  credits integer;
  used integer;
  new_balance integer;
  merged jsonb;
  feat text;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  settings := public._admin_settings();
  select r into ref
  from jsonb_array_elements(coalesce(settings->'referralCodes', '[]'::jsonb)) r
  where upper(trim(r->>'code')) = code_up
  limit 1;

  if ref is null then
    return json_build_object('ok', false, 'error', 'Kode tidak ditemukan');
  end if;
  if coalesce((ref->>'active')::boolean, true) = false then
    return json_build_object('ok', false, 'error', 'Kode nonaktif');
  end if;
  -- String kosong '' bukan null → hindari cast ''::timestamptz yang error.
  if nullif(ref->>'expiresAt', '') is not null
     and (ref->>'expiresAt')::timestamptz < now() then
    return json_build_object('ok', false, 'error', 'Kode kedaluwarsa');
  end if;

  -- Sekali per user (cek jejak transaksi/klaim).
  select count(*) into used from public.credit_transactions
    where username = caller.username
      and description in ('Bonus kode referral: ' || code_up, 'Klaim akses fitur: ' || code_up);
  if used > 0 then
    return json_build_object('ok', false, 'error', 'Kode sudah pernah dipakai');
  end if;

  ref_type := coalesce(ref->>'type', 'coin');

  if ref_type = 'feature' and jsonb_array_length(coalesce(ref->'features', '[]'::jsonb)) > 0 then
    select coalesce(referral_perks, '{}'::jsonb) into merged
      from public.user_profiles where username = caller.username;
    for feat in select jsonb_array_elements_text(ref->'features') loop
      merged := merged || jsonb_build_object(feat, true);
    end loop;
    update public.user_profiles
      set referral_perks = merged,
          referral_perks_expires_at = nullif(ref->>'expiresAt', '')::timestamptz,
          referral_code = code_up
      where username = caller.username;
    insert into public.credit_transactions (username, amount, type, description)
      values (caller.username, 0, 'topup', 'Klaim akses fitur: ' || code_up);
    return json_build_object('ok', true, 'type', 'feature', 'features', ref->'features');
  end if;

  credits := coalesce((ref->>'credits')::int, 0);
  if credits <= 0 then
    return json_build_object('ok', false, 'error', 'Kode tidak memberi coin');
  end if;
  new_balance := public._add_credits(caller.username, credits, 'Bonus kode referral: ' || code_up, null);
  update public.user_profiles set referral_code = code_up where username = caller.username;
  return json_build_object('ok', true, 'type', 'coin', 'credits', credits, 'newBalance', new_balance);
end;
$$;
grant execute on function public.claim_referral_code(text, text) to anon, authenticated;

-- ── 5. Admin: set aktif/nonaktif & set perks (ganti tulis langsung) ──
drop function if exists public.admin_set_user_active(text, text, boolean);
create or replace function public.admin_set_user_active(p_token text, p_username text, p_active boolean)
returns json
language plpgsql volatile security definer set search_path = public
as $$
declare caller record;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer','admin') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  update public.app_users set is_active = p_active where username = p_username;
  return json_build_object('ok', true);
end;
$$;
grant execute on function public.admin_set_user_active(text, text, boolean) to anon, authenticated;

drop function if exists public.admin_set_perks(text, text, jsonb);
create or replace function public.admin_set_perks(p_token text, p_username text, p_perks jsonb)
returns json
language plpgsql volatile security definer set search_path = public
as $$
declare caller record;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer','admin') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  update public.user_profiles set perks = p_perks where username = p_username;
  return json_build_object('ok', true);
end;
$$;
grant execute on function public.admin_set_perks(text, text, jsonb) to anon, authenticated;

-- ── 5b. Admin: reset seluruh riwayat transaksi ─────────────
drop function if exists public.admin_clear_transactions(text);
create or replace function public.admin_clear_transactions(p_token text)
returns json
language plpgsql volatile security definer set search_path = public
as $$
declare caller record;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer','admin') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  delete from public.credit_transactions where true;
  return json_build_object('ok', true);
end;
$$;
grant execute on function public.admin_clear_transactions(text) to anon, authenticated;

-- ── 6. register_app_user (3-arg) menerbitkan token ──────────
-- Agar user yang BARU DAFTAR langsung punya token untuk memanggil RPC.
drop function if exists public.register_app_user(text, text, text);
create or replace function public.register_app_user(
  p_username text, p_display_name text, p_password text
)
returns table (id uuid, username text, display_name text, role text, created_at timestamptz, token text)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  next_username text := lower(trim(p_username));
  next_display text := nullif(trim(p_display_name), '');
  next_password text := nullif(p_password, '');
  new_id uuid;
  new_token text;
begin
  if next_username is null or next_username = '' then raise exception 'username wajib diisi'; end if;
  if next_password is null then raise exception 'password wajib diisi'; end if;
  if exists (select 1 from public.app_users u where lower(trim(u.username)) = next_username) then
    raise exception 'username sudah dipakai';
  end if;

  insert into public.app_users (username, display_name, password_hash, role)
  values (next_username, coalesce(next_display, next_username),
          extensions.crypt(next_password, extensions.gen_salt('bf', 12)), 'student')
  returning app_users.id into new_id;

  new_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.app_sessions (token_hash, username, role, expires_at)
  values (public._hash_token(new_token), next_username, 'student', now() + interval '30 days');

  return query
  select u.id, u.username, u.display_name, u.role, u.created_at, new_token
  from public.app_users u where u.id = new_id;
end;
$$;
grant execute on function public.register_app_user(text, text, text) to anon, authenticated;

-- ── 7. Trigger pembekuan kolom sensitif ─────────────────────
-- RPC di atas berjalan SECURITY DEFINER (current_user = owner/postgres),
-- sementara tulisan langsung dari PostgREST berjalan sebagai anon/
-- authenticated. Trigger menolak perubahan kolom sensitif oleh anon/
-- authenticated, tapi mengizinkan lewat RPC & service_role.
drop function if exists public._freeze_profile_perks();
create or replace function public._freeze_profile_perks()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if NEW.perks is distinct from OLD.perks
       or NEW.referral_perks is distinct from OLD.referral_perks
       or NEW.referral_perks_expires_at is distinct from OLD.referral_perks_expires_at then
      raise exception 'Perubahan perk hanya via server' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;
drop trigger if exists freeze_profile_perks on public.user_profiles;
create trigger freeze_profile_perks before update on public.user_profiles
  for each row execute function public._freeze_profile_perks();

drop function if exists public._freeze_user_privileges();
create or replace function public._freeze_user_privileges()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if NEW.role is distinct from OLD.role
       or NEW.is_active is distinct from OLD.is_active
       or NEW.password_hash is distinct from OLD.password_hash then
      raise exception 'Perubahan role/status hanya via server' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;
drop trigger if exists freeze_user_privileges on public.app_users;
create trigger freeze_user_privileges before update on public.app_users
  for each row execute function public._freeze_user_privileges();
