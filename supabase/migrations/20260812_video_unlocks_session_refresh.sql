-- ============================================================
-- PERSISTENT VIDEO UNLOCKS + SLIDING APP SESSION
--
-- Fixes two production issues:
--   1. Paid video access used to live only in browser localStorage, so a
--      reload on another browser/device (or cleared site data) locked it.
--   2. app_sessions expires after 30 days, while the client-side session
--      stayed logged in and sensitive RPCs then returned HTTP 401.
--
-- Run this whole file once in Supabase SQL Editor.
-- ============================================================

-- Keep an active session alive for another 30 days whenever the app is used.
-- Expired/revoked tokens are never revived: the user must log in again once.
drop function if exists public.refresh_app_session(text);
create or replace function public.refresh_app_session(p_token text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_username text;
  v_role text;
  v_expires_at timestamptz;
begin
  update public.app_sessions s
     set expires_at = greatest(s.expires_at, now() + interval '30 days')
    from public.app_users u
   where s.token_hash = public._hash_token(p_token)
     and s.expires_at > now()
     and u.username = s.username
     and u.is_active
  returning s.username, u.role, s.expires_at
       into v_username, v_role, v_expires_at;

  if v_username is null then
    return json_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;

  return json_build_object(
    'ok', true,
    'username', v_username,
    'role', v_role,
    'expiresAt', v_expires_at
  );
end;
$$;

grant execute on function public.refresh_app_session(text) to anon, authenticated;


-- Server-side source of truth for videos that were actually bought with coin.
create table if not exists public.user_video_unlocks (
  username      text        not null,
  lesson_key    text        not null,
  unlock_method text        not null default 'coin'
    check (unlock_method in ('coin', 'legacy')),
  unlocked_at   timestamptz not null default now(),
  primary key (username, lesson_key)
);

create index if not exists user_video_unlocks_username_idx
  on public.user_video_unlocks (username);

alter table public.user_video_unlocks enable row level security;

-- Custom app auth is not Supabase Auth, so direct table access cannot safely
-- identify a row owner. All reads/writes go through token-checking RPCs below.
revoke all on table public.user_video_unlocks from anon, authenticated;
grant all on table public.user_video_unlocks to service_role;


-- Restore historical purchases from the existing transaction trail. First
-- match the current lesson title; then use video_views as a compatibility
-- bridge when a lesson title has changed since purchase.
do $$
begin
  if to_regclass('public.credit_transactions') is not null
     and to_regclass('public.lessons') is not null then
    execute $backfill$
      insert into public.user_video_unlocks (username, lesson_key, unlock_method, unlocked_at)
      select trim(t.username), l.lesson_key, 'legacy', min(t.created_at)
        from public.credit_transactions t
        join public.lessons l
          on t.description = 'Akses video: ' || l.title
       where t.amount < 0
         and nullif(trim(t.username), '') is not null
         and nullif(trim(l.lesson_key), '') is not null
         and (select count(*) from public.lessons l2 where l2.title = l.title) = 1
       group by trim(t.username), l.lesson_key
      on conflict (username, lesson_key) do nothing
    $backfill$;
  end if;

  if to_regclass('public.video_views') is not null
     and to_regclass('public.credit_transactions') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'video_views' and column_name = 'lesson_key'
     )
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'video_views' and column_name = 'video_title'
     ) then
    execute $backfill$
      insert into public.user_video_unlocks (username, lesson_key, unlock_method, unlocked_at)
      select trim(t.username), v.lesson_key, 'legacy', min(coalesce(v.viewed_at, t.created_at))
        from public.video_views v
        join public.credit_transactions t
          on lower(trim(t.username)) = lower(trim(v.username))
         and t.amount < 0
         and t.description = 'Akses video: ' || v.video_title
       where nullif(trim(v.username), '') is not null
         and nullif(trim(v.lesson_key), '') is not null
       group by trim(t.username), v.lesson_key
      on conflict (username, lesson_key) do nothing
    $backfill$;
  end if;
end;
$$;


drop function if exists public.get_my_video_unlocks(text);
create or replace function public.get_my_video_unlocks(p_token text)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  caller record;
  v_lesson_keys jsonb;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null then
    return json_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;

  select coalesce(jsonb_agg(u.lesson_key order by u.lesson_key), '[]'::jsonb)
    into v_lesson_keys
    from public.user_video_unlocks u
   where u.username = caller.username;

  return json_build_object('ok', true, 'lessonKeys', v_lesson_keys);
end;
$$;

grant execute on function public.get_my_video_unlocks(text) to anon, authenticated;


-- Atomic purchase: verify the custom session, lock the user's balance, recheck
-- idempotency, debit once, write the transaction, then persist the unlock.
drop function if exists public.unlock_video(text, text);
create or replace function public.unlock_video(p_token text, p_lesson_key text)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
  v_title text;
  v_settings jsonb := '{}'::jsonb;
  v_cost integer := 5;
  v_perks jsonb := '{}'::jsonb;
  v_free boolean := false;
  v_balance integer := 0;
  v_new_balance integer;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null then
    return json_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;

  select l.title into v_title
    from public.lessons l
   where l.lesson_key = p_lesson_key;
  if not found then
    return json_build_object('ok', false, 'error', 'VIDEO_NOT_FOUND');
  end if;

  if exists (
    select 1 from public.user_video_unlocks u
     where u.username = caller.username and u.lesson_key = p_lesson_key
  ) then
    return json_build_object('ok', true, 'already', true);
  end if;

  select coalesce(c.content, '{}'::jsonb) into v_settings
    from public.learning_hub_content c
   where c.content_key = 'feature_costs'
   limit 1;

  begin
    v_cost := coalesce(nullif(v_settings->>'video_learning', '')::integer, 5);
  exception when others then
    v_cost := 5;
  end;
  v_cost := greatest(0, least(v_cost, 1000000));

  select coalesce(p.perks, '{}'::jsonb)
         || case
              when p.referral_perks_expires_at is null or p.referral_perks_expires_at > now()
                then coalesce(p.referral_perks, '{}'::jsonb)
              else '{}'::jsonb
            end
    into v_perks
    from public.user_profiles p
   where p.username = caller.username;
  v_perks := coalesce(v_perks, '{}'::jsonb);

  v_free := caller.role in ('developer', 'admin')
    or coalesce((v_perks->>'credit_exempt')::boolean, false)
    or coalesce((v_perks->>'free_video')::boolean, false)
    or v_cost = 0;

  -- Free/perk access follows the perk lifetime; it is not converted into a
  -- permanent paid unlock.
  if v_free then
    return json_build_object('ok', true, 'free', true, 'cost', 0);
  end if;

  insert into public.user_credits (username, balance)
  values (caller.username, 0)
  on conflict (username) do nothing;

  select c.balance into v_balance
    from public.user_credits c
   where c.username = caller.username
   for update;

  -- A second request may have completed while this request waited for the
  -- balance lock. Recheck after locking so concurrent clicks charge once.
  if exists (
    select 1 from public.user_video_unlocks u
     where u.username = caller.username and u.lesson_key = p_lesson_key
  ) then
    return json_build_object('ok', true, 'already', true, 'newBalance', v_balance);
  end if;

  if coalesce(v_balance, 0) < v_cost then
    return json_build_object(
      'ok', false,
      'error', 'INSUFFICIENT_CREDITS',
      'needed', v_cost,
      'balance', coalesce(v_balance, 0)
    );
  end if;

  update public.user_credits
     set balance = balance - v_cost,
         updated_at = now()
   where username = caller.username
  returning balance into v_new_balance;

  insert into public.credit_transactions (username, amount, type, description, created_by)
  values (caller.username, -v_cost, 'usage', 'Akses video: ' || coalesce(v_title, p_lesson_key), null);

  insert into public.user_video_unlocks (username, lesson_key, unlock_method)
  values (caller.username, p_lesson_key, 'coin')
  on conflict (username, lesson_key) do nothing;

  return json_build_object(
    'ok', true,
    'cost', v_cost,
    'newBalance', v_new_balance
  );
end;
$$;

grant execute on function public.unlock_video(text, text) to anon, authenticated;


-- Return an application-level session error instead of an opaque HTTP 401.
-- The frontend can then clear the stale local session and ask for login once.
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
  today date := (now() at time zone 'Asia/Jakarta')::date;
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
    return json_build_object('ok', false, 'error', 'SESSION_EXPIRED');
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
     set checkin_streak = claim_day,
         last_checkin = today
   where username = caller.username;

  if is_day7 and jsonb_array_length(coalesce(day7->'features', '[]'::jsonb)) > 0 then
    select coalesce(referral_perks, '{}'::jsonb) into merged
      from public.user_profiles where username = caller.username;
    for feat in select jsonb_array_elements_text(day7->'features') loop
      merged := merged || jsonb_build_object(feat, true);
    end loop;
    update public.user_profiles
       set referral_perks = merged
     where username = caller.username;
  end if;

  return json_build_object(
    'ok', true,
    'newBalance', new_balance,
    'day', claim_day,
    'coins', coins
  );
end;
$$;

grant execute on function public.claim_daily_checkin(text) to anon, authenticated;
