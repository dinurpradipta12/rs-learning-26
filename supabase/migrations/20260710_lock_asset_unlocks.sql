-- ============================================================
-- LOCKDOWN: user_asset_unlocks (P1 — ekonomi)
--
-- Masalah: coin dipotong server (spend_credits) TAPI record unlock ditulis
-- langsung dari client (upsert). User bisa upsert unlock tanpa memotong coin
-- → buka semua asset berbayar gratis.
--
-- Solusi: RPC unlock_asset(p_token, p_asset_id) yang ATOMIK — verifikasi
-- token → baca harga asset → potong coin (spend_credits) → catat unlock,
-- semuanya dalam satu transaksi. Lalu kunci tabel: hanya baca yang boleh
-- dari anon; tulis hanya lewat RPC (service/definer).
--
--   BAGIAN 1 (aditif, jalankan SEKARANG): RPC.
--   BAGIAN 2 (lockdown, jalankan PALING AKHIR setelah client baru live).
-- ============================================================

-- ── BAGIAN 1 — RPC atomik (aman dijalankan kapan saja) ──────
drop function if exists public.unlock_asset(text, text);
create or replace function public.unlock_asset(p_token text, p_asset_id text)
returns json
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  caller              record;
  v_cost              numeric;
  v_feature_claimable boolean;
  v_title             text;
  v_perks             jsonb;
  v_free              boolean := false;
  v_spend             json;
  v_new_balance       numeric := null;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  -- Idempoten: kalau sudah unlock, jangan charge lagi.
  if exists (
    select 1 from public.user_asset_unlocks
    where username = caller.username and asset_id = p_asset_id
  ) then
    return json_build_object('ok', true, 'already', true);
  end if;

  select coalesce(coin_cost, 10), coalesce(feature_claimable, true), title
    into v_cost, v_feature_claimable, v_title
  from public.shared_assets where id = p_asset_id;
  if not found then
    raise exception 'Asset tidak ditemukan';
  end if;

  -- Perk exemption (samakan dengan isUnlocked di client).
  select coalesce(perks, '{}'::jsonb) into v_perks
  from public.user_profiles where username = caller.username;
  if coalesce((v_perks->>'credit_exempt')::boolean, false)
     or (coalesce((v_perks->>'free_asset')::boolean, false) and v_feature_claimable)
     or caller.role in ('developer', 'admin') then
    v_free := true;
  end if;

  -- Potong coin bila perlu — atomik dalam transaksi ini.
  if not v_free and v_cost > 0 then
    v_spend := public.spend_credits(caller.username, v_cost, 'usage',
                 'Buka asset: ' || coalesce(v_title, p_asset_id));
    if not coalesce((v_spend->>'ok')::boolean, false) then
      return v_spend;  -- {ok:false, needed, balance, error} — belum ada unlock ditulis
    end if;
    v_new_balance := (v_spend->>'newBalance')::numeric;
  end if;

  insert into public.user_asset_unlocks (username, asset_id)
  values (caller.username, p_asset_id)
  on conflict do nothing;

  return json_build_object('ok', true, 'newBalance', v_new_balance);
end;
$$;

grant execute on function public.unlock_asset(text, text) to anon, authenticated;


-- ── BAGIAN 2 — LOCKDOWN (JALANKAN PALING AKHIR) ─────────────
-- HANYA setelah client yang memakai unlock_asset sudah live di produksi.
-- Blok DO menghapus SEMUA policy lama (termasuk allow-all) lalu memasang
-- tepat 2 policy yang benar.
--
/*
alter table public.user_asset_unlocks enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'user_asset_unlocks'
  loop
    execute format('drop policy if exists %I on public.user_asset_unlocks', p.policyname);
  end loop;
end $$;

create policy "asset_unlocks_read" on public.user_asset_unlocks
  for select to anon, authenticated using (true);

create policy "asset_unlocks_service_write" on public.user_asset_unlocks
  for all to service_role using (true) with check (true);

-- Verifikasi: select policyname, cmd, roles from pg_policies where tablename='user_asset_unlocks';
*/
