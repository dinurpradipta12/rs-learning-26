-- ============================================================
-- Admin & Credit System Tables
-- Run this in Supabase SQL Editor
-- ============================================================

-- Credit balance per user
create table if not exists public.user_credits (
  username text primary key references public.app_users(username) on delete cascade,
  balance integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Transaction history (topup, usage, adjustment)
create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  username text not null references public.app_users(username) on delete cascade,
  amount integer not null,                      -- positif = masuk, negatif = keluar
  type text not null default 'topup'            -- 'topup' | 'usage' | 'adjustment' | 'refund'
    check (type in ('topup', 'usage', 'adjustment', 'refund')),
  description text not null default '',
  created_by text references public.app_users(username) on delete set null,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists credit_transactions_username_idx on public.credit_transactions(username);
create index if not exists credit_transactions_created_at_idx on public.credit_transactions(created_at desc);

-- Enable RLS
alter table public.user_credits enable row level security;
alter table public.credit_transactions enable row level security;

-- user_credits: semua bisa baca, hanya server yang update (via admin page pakai anon key)
drop policy if exists "user_credits_read" on public.user_credits;
create policy "user_credits_read" on public.user_credits for select using (true);

drop policy if exists "user_credits_write" on public.user_credits;
create policy "user_credits_write" on public.user_credits for all using (true);

-- credit_transactions: semua bisa baca, insert, update
drop policy if exists "credit_transactions_read" on public.credit_transactions;
create policy "credit_transactions_read" on public.credit_transactions for select using (true);

drop policy if exists "credit_transactions_insert" on public.credit_transactions;
create policy "credit_transactions_insert" on public.credit_transactions for insert with check (true);

-- app_users: tambahkan policy agar developer/admin bisa baca semua user
drop policy if exists "app_users_admin_read" on public.app_users;
create policy "app_users_admin_read"
  on public.app_users for select
  using (true);

-- Auto-init user_credits saat user baru dibuat
create or replace function public.init_user_credits()
returns trigger language plpgsql as $$
begin
  insert into public.user_credits(username, balance)
  values (new.username, 0)
  on conflict (username) do nothing;
  return new;
end;
$$;

drop trigger if exists on_user_created_init_credits on public.app_users;
create trigger on_user_created_init_credits
  after insert on public.app_users
  for each row execute procedure public.init_user_credits();

-- Init credits untuk user yang sudah ada
insert into public.user_credits(username, balance)
select username, 0 from public.app_users
on conflict (username) do nothing;

-- Aktifkan Realtime
alter publication supabase_realtime add table public.user_credits;
alter publication supabase_realtime add table public.credit_transactions;

-- ============================================================
-- Admin: Buat user baru dengan role tertentu (password di-hash bcrypt)
-- ============================================================
drop function if exists public.admin_create_user(text, text, text, text);
create or replace function public.admin_create_user(
  p_username     text,
  p_display_name text,
  p_password     text,
  p_role         text default 'student'
)
returns table (
  username     text,
  display_name text,
  role         text,
  created_at   timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_username text := lower(trim(p_username));
begin
  if v_username = '' then
    raise exception 'username wajib diisi';
  end if;
  if p_password = '' or p_password is null then
    raise exception 'password wajib diisi';
  end if;
  if p_role not in ('student', 'developer', 'admin') then
    raise exception 'role tidak valid';
  end if;
  if exists (select 1 from public.app_users u where lower(trim(u.username)) = v_username) then
    raise exception 'username sudah dipakai';
  end if;

  insert into public.app_users (username, display_name, password_hash, role, is_active)
  values (
    v_username,
    coalesce(nullif(trim(p_display_name), ''), v_username),
    extensions.crypt(p_password, extensions.gen_salt('bf')),
    p_role,
    true
  );

  return query
    select u.username, u.display_name, u.role, u.created_at
    from public.app_users u
    where u.username = v_username;
end;
$$;

grant execute on function public.admin_create_user(text, text, text, text) to anon, authenticated;
