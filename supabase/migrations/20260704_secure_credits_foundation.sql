-- ============================================================
-- SECURE CREDITS — FOUNDATION (Stage 1)
-- Report: RS-2026-07-04-001
--
-- Konteks: role disimpan di localStorage & divalidasi di frontend,
-- dan SEMUA penambahan coin dihitung + ditulis langsung dari browser
-- memakai anon key. Akibatnya siapa pun bisa mencetak coin sendiri.
--
-- Stage ini bersifat ADITIF — tidak mengubah/mengunci apa pun yang
-- membuat app live rusak. Ia menambah:
--   1. Token sesi server (app_sessions) + penerbitan token saat login
--   2. Helper verifikasi sesi + role (sumber kebenaran = DB, bukan client)
--   3. RPC otoritatif untuk SEMUA penambahan coin (SECURITY DEFINER)
--
-- Penguncian RLS (deny-all write) ada di migration Stage 2 dan HANYA
-- boleh dijalankan SETELAH client sudah dideploy memakai RPC di sini.
-- ============================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ── 1. Tabel sesi server-side ───────────────────────────────
-- Yang disimpan adalah HASH token (sha256), bukan token mentah. Kalau DB
-- bocor, penyerang tetap tak bisa memakai sesi karena token asli hanya ada
-- di browser user. Verifikasi: hash token dari client, cocokkan ke sini.
-- Drop versi lama (mis. yang berkolom `token`) bila ada. Isi tabel ini
-- ephemeral — user cukup login ulang untuk mendapat sesi baru.
drop table if exists public.app_sessions cascade;
create table public.app_sessions (
  token_hash  text primary key,
  username    text not null,
  role        text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days'
);

create index if not exists app_sessions_username_idx on public.app_sessions (username);
create index if not exists app_sessions_expires_idx on public.app_sessions (expires_at);

-- Helper: hash token mentah → hex sha256 (dipakai internal RPC).
drop function if exists public._hash_token(text);
create or replace function public._hash_token(p_token text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

alter table public.app_sessions enable row level security;
-- Tidak ada akses langsung; hanya RPC SECURITY DEFINER yang menyentuh tabel ini.
drop policy if exists "app_sessions_deny_all" on public.app_sessions;
create policy "app_sessions_deny_all" on public.app_sessions
  as restrictive for all to anon, authenticated using (false) with check (false);

-- ── 2. Helper verifikasi sesi (dipakai semua RPC di bawah) ──
-- Mengembalikan (username, role) bila token valid & belum kedaluwarsa,
-- selain itu NULL. Role diambil dari DB, BUKAN dari klaim client.
drop function if exists public._session_identity(text);
create or replace function public._session_identity(p_token text)
returns table (username text, role text)
language sql
stable
security definer
set search_path = public
as $$
  select s.username, u.role
  from public.app_sessions s
  join public.app_users u on u.username = s.username
  where s.token_hash = public._hash_token(p_token)
    and s.expires_at > now()
    and u.is_active
  limit 1;
$$;

-- ── 3. Login menerbitkan token sesi ─────────────────────────
-- Menggantikan authenticate_app_user: sekarang mengembalikan kolom `token`.
drop function if exists public.authenticate_app_user(text, text);
create or replace function public.authenticate_app_user(p_username text, p_password text)
returns table (
  id uuid,
  username text,
  display_name text,
  role text,
  created_at timestamptz,
  token text
)
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  rec public.app_users%rowtype;
  new_token text;
begin
  select * into rec
  from public.app_users u
  where u.is_active
    and lower(trim(u.username)) = lower(trim(p_username))
  limit 1;

  if not found then
    return;
  end if;

  if rec.password_hash = extensions.crypt(p_password, rec.password_hash) then
    -- Token acak 256-bit dikembalikan ke client (satu-satunya salinan mentah).
    -- Server hanya menyimpan hash-nya.
    new_token := encode(extensions.gen_random_bytes(32), 'hex');

    insert into public.app_sessions (token_hash, username, role, expires_at)
    values (public._hash_token(new_token), rec.username, rec.role, now() + interval '30 days');

    -- Bersihkan sesi kedaluwarsa milik user ini (housekeeping ringan).
    -- Qualify kolom dg nama tabel agar tidak bentrok dengan OUT param `username`.
    delete from public.app_sessions
    where app_sessions.username = rec.username and app_sessions.expires_at <= now();

    id := rec.id;
    username := rec.username;
    display_name := rec.display_name;
    role := rec.role;
    created_at := rec.created_at;
    token := new_token;
    return next;
  end if;
end;
$$;

grant execute on function public.authenticate_app_user(text, text) to anon, authenticated;

-- Logout / invalidasi token
drop function if exists public.revoke_app_session(text);
create or replace function public.revoke_app_session(p_token text)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.app_sessions where token_hash = public._hash_token(p_token);
$$;
grant execute on function public.revoke_app_session(text) to anon, authenticated;

-- ── 4. RPC otoritatif: penambahan coin oleh ADMIN ───────────
-- Satu-satunya jalur sah untuk menambah coin ke user lain. Server
-- yang menghitung saldo baru & mencatat transaksi; client tidak
-- pernah mengirim "balance" hasil hitungannya sendiri.
drop function if exists public.admin_grant_credits(text, text, integer, text);
create or replace function public.admin_grant_credits(
  p_token text,
  p_target_username text,
  p_amount integer,
  p_description text
)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
  current_balance integer;
  new_balance integer;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer', 'admin') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then
    raise exception 'Jumlah coin tidak valid';
  end if;

  select balance into current_balance from public.user_credits
    where username = p_target_username;
  current_balance := coalesce(current_balance, 0);
  new_balance := current_balance + p_amount;

  insert into public.user_credits (username, balance)
  values (p_target_username, new_balance)
  on conflict (username) do update set balance = excluded.balance;

  insert into public.credit_transactions (username, amount, type, description, created_by)
  values (p_target_username, p_amount, 'topup',
          coalesce(p_description, 'Penambahan oleh admin'), caller.username);

  return json_build_object('ok', true, 'newBalance', new_balance);
end;
$$;
grant execute on function public.admin_grant_credits(text, text, integer, text) to anon, authenticated;

-- ── 5. RPC otoritatif: approve / reject topup oleh ADMIN ────
drop function if exists public.admin_approve_topup(text, uuid);
create or replace function public.admin_approve_topup(p_token text, p_topup_id uuid)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
  req record;
  current_balance integer;
  bonus integer;
  total_credits integer;
  new_balance integer;
  promo jsonb;
  perks_update jsonb := '{}'::jsonb;
  current_perks jsonb;
  feat text;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer', 'admin') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  select * into req from public.topup_requests
    where id = p_topup_id and status = 'pending' for update;
  if not found then
    return json_build_object('ok', false, 'error', 'Request tidak ditemukan / sudah diproses');
  end if;
  if req.proof_url is null then
    return json_build_object('ok', false, 'error', 'Topup tanpa bukti tidak dapat disetujui');
  end if;

  -- Bonus & promo diambil dari baris request yang tersimpan di server,
  -- bukan dari input client → client tidak bisa menggelembungkannya.
  bonus := coalesce(req.bonus_credits, 0);
  total_credits := req.credits + bonus;

  select balance into current_balance from public.user_credits where username = req.username;
  current_balance := coalesce(current_balance, 0);
  new_balance := current_balance + total_credits;

  insert into public.user_credits (username, balance)
  values (req.username, new_balance)
  on conflict (username) do update set balance = excluded.balance;

  insert into public.credit_transactions (username, amount, type, description, created_by)
  values (req.username, req.credits, 'topup',
          'Topup ' || coalesce(req.package_label, ''), caller.username);

  if bonus > 0 then
    insert into public.credit_transactions (username, amount, type, description, created_by)
    values (req.username, bonus, 'topup',
            '🎁 Bonus paket ' || coalesce(req.package_label, ''), caller.username);
  end if;

  -- Terapkan perk promo (fitur gratis / booking) bila promo aktif.
  promo := req.promo_bonus;
  if promo is not null and coalesce((promo->>'active')::boolean, false) then
    if coalesce((promo->>'bonus_booking')::boolean, false) then
      perks_update := perks_update || jsonb_build_object('free_booking', true);
    end if;
    for feat in select jsonb_array_elements_text(coalesce(promo->'bonus_features', '[]'::jsonb)) loop
      perks_update := perks_update || jsonb_build_object(feat, true);
    end loop;
    if perks_update <> '{}'::jsonb then
      select coalesce(perks, '{}'::jsonb) into current_perks from public.user_profiles
        where username = req.username;
      update public.user_profiles
        set perks = coalesce(current_perks, '{}'::jsonb) || perks_update
        where username = req.username;
    end if;
  end if;

  update public.topup_requests
    set status = 'approved', processed_at = now()
    where id = p_topup_id;

  return json_build_object('ok', true, 'newBalance', new_balance,
                           'username', req.username, 'totalCredits', total_credits);
end;
$$;
grant execute on function public.admin_approve_topup(text, uuid) to anon, authenticated;

drop function if exists public.admin_reject_topup(text, uuid, text);
create or replace function public.admin_reject_topup(p_token text, p_topup_id uuid, p_note text default null)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null or caller.role not in ('developer', 'admin') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  update public.topup_requests
    set status = 'rejected', processed_at = now(), note = p_note
    where id = p_topup_id and status = 'pending';

  return json_build_object('ok', true);
end;
$$;
grant execute on function public.admin_reject_topup(text, uuid, text) to anon, authenticated;

-- ── 6. Reward mandiri (claim_self_reward) → DIPINDAH ke stage2 ──
-- CATATAN PENTING: versi final claim_self_reward ada di
-- 20260704_secure_credits_stage2.sql (mengenali 5 key reward, membaca
-- coin_rewards dari learning_hub_content via _admin_settings).
-- Stub lama yang dulu ada di sini SENGAJA DIHAPUS — kalau tidak, menjalankan
-- ulang file foundation akan menimpa versi stage2 dan mematikan bonus
-- write_review / create_thread / complete_lesson. Jalankan stage2 setelah
-- foundation, dan JANGAN definisikan claim_self_reward di sini lagi.
