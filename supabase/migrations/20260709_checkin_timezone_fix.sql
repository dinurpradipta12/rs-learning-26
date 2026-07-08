-- ============================================================
-- FIX: claim_daily_checkin pakai timezone WIB (Asia/Jakarta), bukan UTC.
--
-- Masalah: RPC menghitung "today" dari UTC, sedangkan client memakai tanggal
-- lokal (WIB). Antara 00:00–07:00 WIB, client sudah menganggap hari baru
-- (tampil "bisa klaim") tapi server (UTC) masih hari kemarin → klaim ditolak
-- "Sudah check-in hari ini" tanpa menambah coin. Semua user di Indonesia,
-- jadi batas "harian" seharusnya tengah malam WIB (konsisten dgn birthday-check).
--
-- Satu-satunya perubahan dari versi lama: 'utc' → 'Asia/Jakarta'.
-- ============================================================

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
  today date := (now() at time zone 'Asia/Jakarta')::date;   -- WIB, bukan UTC
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
  last_dt := nullif(prof.last_checkin::text, '')::date;

  if last_dt = today then
    return json_build_object('ok', false, 'error', 'Sudah check-in hari ini');
  end if;
  if last_dt is not null and (today - last_dt) > 2 then streak := 0; end if;
  if streak >= 7 then streak := 0; end if;

  claim_day := streak + 1;
  is_day7 := (claim_day = 7);
  coins := case when is_day7 then coalesce((day7->>'coins')::int, 0) else 0 end;
  if is_day7 and coins = 0 then coins := daily_coins; end if;
  if not is_day7 then coins := daily_coins; end if;
  desc_text := case when is_day7 then 'Bonus: Check-in Hari ke-7' else 'Bonus: Login Harian' end;

  new_balance := public._add_credits(caller.username, coins, desc_text, null);

  update public.user_profiles
    set checkin_streak = claim_day, last_checkin = today
    where username = caller.username;

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
