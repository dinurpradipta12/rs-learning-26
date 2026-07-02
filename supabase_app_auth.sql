create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text not null,
  password_hash text not null,
  role text not null default 'student' check (role in ('student', 'developer', 'admin')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.app_users enable row level security;

drop policy if exists "app_users_self_read" on public.app_users;
create policy "app_users_self_read"
on public.app_users
for select
using (false);

drop policy if exists "app_users_write_staff" on public.app_users;
create policy "app_users_write_staff"
on public.app_users
for all
using (false)
with check (false);

-- Index fungsional agar pencarian username (yang dibungkus lower(trim(...)))
-- memakai index, bukan full-table scan. Tanpa ini, bcrypt crypt() dijalankan
-- untuk banyak baris → statement timeout ("Server sedang sibuk").
create index if not exists app_users_lower_username_idx
  on public.app_users (lower(trim(username)));

drop function if exists public.authenticate_app_user(text, text);
create or replace function public.authenticate_app_user(p_username text, p_password text)
returns table (
  id uuid,
  username text,
  display_name text,
  role text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  rec public.app_users%rowtype;
begin
  -- Ambil 1 baris user via index dulu (murah), baru verifikasi bcrypt SEKALI.
  select * into rec
  from public.app_users u
  where u.is_active
    and lower(trim(u.username)) = lower(trim(p_username))
  limit 1;

  if not found then
    return;
  end if;

  if rec.password_hash = extensions.crypt(p_password, rec.password_hash) then
    id := rec.id;
    username := rec.username;
    display_name := rec.display_name;
    role := rec.role;
    created_at := rec.created_at;
    return next;
  end if;
end;
$$;

grant execute on function public.authenticate_app_user(text, text) to anon, authenticated;

drop function if exists public.register_app_user(text, text, text);
create or replace function public.register_app_user(
  p_username text,
  p_display_name text,
  p_password text
)
returns table (
  id uuid,
  username text,
  display_name text,
  role text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  next_username text := lower(trim(p_username));
  next_display_name text := nullif(trim(p_display_name), '');
  next_password text := nullif(p_password, '');
  next_user_id uuid;
begin
  if next_username is null or next_username = '' then
    raise exception 'username wajib diisi';
  end if;

  if next_password is null then
    raise exception 'password wajib diisi';
  end if;

  if exists (
    select 1
    from public.app_users u
    where lower(trim(u.username)) = next_username
  ) then
    raise exception 'username sudah dipakai';
  end if;

  insert into public.app_users (username, display_name, password_hash, role)
  values (
    next_username,
    coalesce(next_display_name, next_username),
    extensions.crypt(next_password, extensions.gen_salt('bf')),
    'student'
  )
  returning app_users.id into next_user_id;

  return query
  select u.id, u.username, u.display_name, u.role, u.created_at
  from public.app_users u
  where u.id = next_user_id;
end;
$$;

grant execute on function public.register_app_user(text, text, text) to anon, authenticated;

-- RPC untuk menghapus user oleh admin (bypass RLS)
drop function if exists public.delete_app_user(text);
create or replace function public.delete_app_user(p_username text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.app_users where username = p_username;
end;
$$;

grant execute on function public.delete_app_user(text) to anon, authenticated;

insert into public.app_users (username, display_name, password_hash, role)
values (
  'arunika',
  'arunika',
  extensions.crypt('ar4925', extensions.gen_salt('bf')),
  'developer'
)
on conflict (username) do update
set
  display_name = excluded.display_name,
  password_hash = excluded.password_hash,
  role = excluded.role,
  is_active = true,
  updated_at = now();
