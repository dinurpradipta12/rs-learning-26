-- ============================================================
-- LOCKDOWN: learning_hub_content (CRITICAL #1)
--
-- Masalah: tabel ini bisa ditulis langsung oleh anon key. Ia menyimpan
-- admin_credit_settings (jumlah reward coin, birthday_bonus), feature_costs,
-- promo, referral, packages, dll. RPC reward server (claim_self_reward,
-- award_birthday_bonus) MEMBACA jumlah dari sini — jadi user bisa menaikkan
-- jumlah reward lalu klaim via RPC sah → mencetak coin tak terbatas.
--
-- Solusi (berlapis, aman — meniru pola secure_credits):
--   BAGIAN 1 (aditif, jalankan SEKARANG): RPC admin_set_hub_content yang
--     memverifikasi role developer/admin dari token server. Belum mengubah
--     akses — tidak merusak apa pun.
--   BAGIAN 2 (lockdown, jalankan PALING AKHIR setelah client baru dideploy):
--     enable RLS → anon hanya boleh SELECT, tulis hanya service_role/RPC.
-- ============================================================

-- ── BAGIAN 1 — RPC gateway (aditif, aman dijalankan kapan saja) ──
drop function if exists public.admin_set_hub_content(text, text, text, jsonb);
create or replace function public.admin_set_hub_content(
  p_token         text,
  p_content_key   text,
  p_content_group text,
  p_content       jsonb
)
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

  insert into public.learning_hub_content (content_key, content_group, content, updated_at)
  values (p_content_key, coalesce(p_content_group, 'admin'), p_content, now())
  on conflict (content_key) do update
    set content       = excluded.content,
        content_group = excluded.content_group,
        updated_at    = now();

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.admin_set_hub_content(text, text, text, jsonb) to anon, authenticated;


-- ── BAGIAN 2 — LOCKDOWN (JALANKAN PALING AKHIR) ─────────────
-- HANYA jalankan blok di bawah SETELAH client yang memakai
-- admin_set_hub_content sudah dideploy ke produksi. Kalau dijalankan
-- lebih awal, semua penyimpanan setting admin dari client lama akan gagal.
--
/*
alter table public.learning_hub_content enable row level security;

-- Hapus policy "buka semua" bawaan/lama yang mengizinkan anon/public menulis.
-- (RLS pakai logika OR — satu policy permisif saja bikin lockdown bocor.)
drop policy if exists "allow_all_content" on public.learning_hub_content;
drop policy if exists "lhc_insert"        on public.learning_hub_content;
drop policy if exists "lhc_update"        on public.learning_hub_content;
drop policy if exists "lhc_delete"        on public.learning_hub_content;
drop policy if exists "lhc_select"        on public.learning_hub_content;

drop policy if exists "hub_content_read" on public.learning_hub_content;
create policy "hub_content_read" on public.learning_hub_content
  for select to anon, authenticated using (true);

drop policy if exists "hub_content_service_write" on public.learning_hub_content;
create policy "hub_content_service_write" on public.learning_hub_content
  for all to service_role using (true) with check (true);

-- Verifikasi: harus tersisa TEPAT 2 policy (hub_content_read, hub_content_service_write).
-- select policyname, cmd, roles from pg_policies where tablename='learning_hub_content';
*/
