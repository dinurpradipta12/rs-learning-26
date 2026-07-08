-- ============================================================
-- BIRTHDAY APPRECIATION — Fase 1 (Fondasi DB)
--
-- Fitur: saat user ulang tahun → bonus koin + popup perayaan ke
-- semua user + ucapan/doa dari member yang tersimpan sebagai
-- "inbox letter" milik yang berulang tahun.
--
-- Komponen di file ini:
--   1. app_users.show_birthday  → toggle opt-out privasi
--   2. birthday_events          → 1 baris per user per tahun (idempoten:
--                                 penjamin bonus & popup hanya sekali)
--   3. birthday_wishes          → ucapan dari member
--   4. RPC award_birthday_bonus → award koin idempoten (dipanggil cron/
--                                 edge function `birthday-check` di Fase 2)
--
-- Jumlah bonus koin dibaca dari admin_credit_settings.birthday_bonus
-- (learning_hub_content, content_key = 'admin_credit_settings').
-- ============================================================

-- ── 1. Privasi: toggle tampilkan ulang tahun ────────────────
-- birth_date & avatar_path ada di user_profiles, jadi show_birthday
-- ikut di sana agar sekumpulan dengan data profil.
alter table public.user_profiles
  add column if not exists show_birthday boolean not null default true;

-- ── 2. Event ulang tahun (idempoten per user per tahun) ─────
create table if not exists public.birthday_events (
  username     text        not null,
  year         integer     not null,
  display_name text,
  avatar_path  text,
  bonus_amount integer     not null default 0,
  created_at   timestamptz not null default now(),
  primary key (username, year)
);

create index if not exists birthday_events_created_idx
  on public.birthday_events (created_at desc);

alter table public.birthday_events enable row level security;

-- Semua boleh baca (untuk tahu "siapa ultah hari ini").
create policy "birthday_events readable by all" on public.birthday_events
  for select using (true);

-- Hanya service role (edge function/cron) yang boleh menulis → integritas bonus.
create policy "birthday_events service write" on public.birthday_events
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ── 3. Ucapan / doa dari member ─────────────────────────────
create table if not exists public.birthday_wishes (
  id                uuid        primary key default gen_random_uuid(),
  birthday_username text        not null,
  birthday_year     integer     not null,
  from_username     text        not null,
  from_display_name text,
  from_avatar_path  text,
  message           text        not null,
  created_at        timestamptz not null default now()
);

-- Satu user hanya boleh mengirim satu ucapan per perayaan (bisa di-update).
create unique index if not exists birthday_wishes_unique
  on public.birthday_wishes (birthday_username, birthday_year, from_username);

create index if not exists birthday_wishes_recipient_idx
  on public.birthday_wishes (birthday_username, birthday_year, created_at desc);

alter table public.birthday_wishes enable row level security;

-- Ucapan tidak sensitif → boleh dibaca semua (dipakai untuk inbox letter).
create policy "birthday_wishes readable by all" on public.birthday_wishes
  for select using (true);

-- Member login (anon key) boleh menulis ucapan sendiri.
create policy "birthday_wishes insert" on public.birthday_wishes
  for insert with check (true);

create policy "birthday_wishes update own" on public.birthday_wishes
  for update using (true) with check (true);

-- ── 4. RPC: award bonus ulang tahun (idempoten) ─────────────
-- Dipanggil oleh edge function `birthday-check` (service role).
-- Mengembalikan { ok, awarded, amount, balance }.
drop function if exists public.award_birthday_bonus(text, integer, text, text);
create or replace function public.award_birthday_bonus(
  p_username     text,
  p_year         integer,
  p_display_name text default null,
  p_avatar_path  text default null
)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  settings    jsonb;
  amount      integer;
  new_balance integer;
  rows_added  integer := 0;
begin
  settings := public._admin_settings();
  amount := coalesce((settings->>'birthday_bonus')::int, 100);

  -- Idempoten: hanya sukses kalau baris tahun ini belum ada.
  insert into public.birthday_events (username, year, display_name, avatar_path, bonus_amount)
  values (p_username, p_year, p_display_name, p_avatar_path, greatest(0, amount))
  on conflict (username, year) do nothing;

  get diagnostics rows_added = row_count;

  if rows_added = 0 then
    return json_build_object('ok', false, 'already', true);
  end if;

  if amount > 0 then
    -- created_by = null: 'system:birthday' bukan username asli & akan ditolak
    -- foreign key credit_transactions.created_by → app_users.username.
    new_balance := public._add_credits(
      p_username, amount, 'Bonus: Selamat Ulang Tahun 🎂', null
    );
  end if;

  return json_build_object('ok', true, 'awarded', true, 'amount', amount, 'balance', new_balance);
end;
$$;

grant execute on function public.award_birthday_bonus(text, integer, text, text) to service_role;


-- ── 5. pg_cron: jalankan edge function `birthday-check` tiap pagi ────
-- Prasyarat (aktifkan di Supabase Dashboard → Database → Extensions):
--   1. pg_cron
--   2. pg_net (untuk HTTP call dari SQL)
-- Ganti <PROJECT_REF> dan <SERVICE_ROLE_KEY> dengan nilai proyekmu, lalu
-- jalankan blok di bawah SEKALI. Jadwal '0 0 * * *' UTC = 07:00 WIB.
--
-- Deploy fungsinya lebih dulu:
--   supabase functions deploy birthday-check
--
/*
SELECT cron.schedule(
  'birthday-check',
  '0 0 * * *',                  -- tiap hari 00:00 UTC (07:00 WIB)
  $$
    SELECT net.http_post(
      url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/birthday-check',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
      ),
      body    := '{}'::jsonb
    );
  $$
);
*/
