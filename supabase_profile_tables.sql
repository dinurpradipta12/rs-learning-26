create extension if not exists pgcrypto;

create table if not exists public.user_profiles (
  username text primary key references public.app_users(username) on delete cascade,
  name text not null,
  email text not null,
  job_title text not null default 'student',
  birth_date date,
  joined_at date not null default current_date,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles
  add column if not exists username text,
  add column if not exists name text,
  add column if not exists email text,
  add column if not exists job_title text not null default 'student',
  add column if not exists birth_date date,
  add column if not exists joined_at date not null default current_date,
  add column if not exists avatar_path text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.user_subscriptions (
  username text primary key references public.app_users(username) on delete cascade,
  status text not null default 'aktif',
  started_at date not null default current_date,
  due_at date not null default (current_date + interval '30 days')::date,
  payment_method text not null default 'manual transfer',
  renewal_status text not null default 'siap diperpanjang',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_subscriptions
  add column if not exists username text,
  add column if not exists status text not null default 'aktif',
  add column if not exists started_at date not null default current_date,
  add column if not exists due_at date not null default (current_date + interval '30 days')::date,
  add column if not exists payment_method text not null default 'manual transfer',
  add column if not exists renewal_status text not null default 'siap diperpanjang',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_user_profiles_updated_at on public.user_profiles;
create trigger touch_user_profiles_updated_at
before update on public.user_profiles
for each row
execute function public.touch_updated_at();

drop trigger if exists touch_user_subscriptions_updated_at on public.user_subscriptions;
create trigger touch_user_subscriptions_updated_at
before update on public.user_subscriptions
for each row
execute function public.touch_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-avatars',
  'profile-avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.user_profiles enable row level security;
alter table public.user_subscriptions enable row level security;

drop policy if exists user_profiles_select on public.user_profiles;
drop policy if exists user_profiles_insert on public.user_profiles;
drop policy if exists user_profiles_update on public.user_profiles;
drop policy if exists user_profiles_delete on public.user_profiles;

create policy user_profiles_select on public.user_profiles for select using (true);
create policy user_profiles_insert on public.user_profiles for insert with check (true);
create policy user_profiles_update on public.user_profiles for update using (true) with check (true);
create policy user_profiles_delete on public.user_profiles for delete using (true);

drop policy if exists user_subscriptions_select on public.user_subscriptions;
drop policy if exists user_subscriptions_insert on public.user_subscriptions;
drop policy if exists user_subscriptions_update on public.user_subscriptions;
drop policy if exists user_subscriptions_delete on public.user_subscriptions;

create policy user_subscriptions_select on public.user_subscriptions for select using (true);
create policy user_subscriptions_insert on public.user_subscriptions for insert with check (true);
create policy user_subscriptions_update on public.user_subscriptions for update using (true) with check (true);
create policy user_subscriptions_delete on public.user_subscriptions for delete using (true);

drop policy if exists profile_avatars_select on storage.objects;
drop policy if exists profile_avatars_insert on storage.objects;
drop policy if exists profile_avatars_update on storage.objects;
drop policy if exists profile_avatars_delete on storage.objects;

create policy profile_avatars_select
  on storage.objects
  for select
  using (bucket_id = 'profile-avatars');

create policy profile_avatars_insert
  on storage.objects
  for insert
  with check (bucket_id = 'profile-avatars');

create policy profile_avatars_update
  on storage.objects
  for update
  using (bucket_id = 'profile-avatars')
  with check (bucket_id = 'profile-avatars');

create policy profile_avatars_delete
  on storage.objects
  for delete
  using (bucket_id = 'profile-avatars');

insert into public.user_profiles (username, name, email, job_title, birth_date, joined_at, avatar_path)
select
  u.username,
  u.display_name,
  u.username || '@ruangsosmed.local',
  case
    when u.role = 'developer' then 'developer'
    when u.role = 'admin' then 'admin'
    else 'student'
  end,
  date '2000-01-01',
  u.created_at::date,
  null
from public.app_users u
on conflict (username) do update
set
  name = coalesce(public.user_profiles.name, excluded.name),
  email = coalesce(public.user_profiles.email, excluded.email),
  job_title = coalesce(public.user_profiles.job_title, excluded.job_title),
  birth_date = coalesce(public.user_profiles.birth_date, excluded.birth_date),
  joined_at = coalesce(public.user_profiles.joined_at, excluded.joined_at),
  updated_at = now();

insert into public.user_subscriptions (username, status, started_at, due_at, payment_method, renewal_status)
select
  u.username,
  case when u.role = 'developer' then 'developer access' else 'aktif' end,
  u.created_at::date,
  (u.created_at::date + interval '30 days')::date,
  'manual transfer',
  'siap diperpanjang'
from public.app_users u
on conflict (username) do update
set
  status = coalesce(public.user_subscriptions.status, excluded.status),
  started_at = coalesce(public.user_subscriptions.started_at, excluded.started_at),
  due_at = coalesce(public.user_subscriptions.due_at, excluded.due_at),
  payment_method = coalesce(public.user_subscriptions.payment_method, excluded.payment_method),
  renewal_status = coalesce(public.user_subscriptions.renewal_status, excluded.renewal_status),
  updated_at = now();

create or replace function public.create_profile_for_new_app_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (username, name, email, job_title, birth_date, joined_at, avatar_path)
  values (
    new.username,
    new.display_name,
    new.username || '@ruangsosmed.local',
    case
      when new.role = 'developer' then 'developer'
      when new.role = 'admin' then 'admin'
      else 'student'
    end,
    null,
    new.created_at::date,
    null
  )
  on conflict (username) do nothing;

  insert into public.user_subscriptions (username, status, started_at, due_at, payment_method, renewal_status)
  values (
    new.username,
    case when new.role = 'developer' then 'developer access' else 'aktif' end,
    new.created_at::date,
    (new.created_at::date + interval '30 days')::date,
    'manual transfer',
    'siap diperpanjang'
  )
  on conflict (username) do nothing;

  return new;
end;
$$;

drop trigger if exists create_profile_after_app_user_insert on public.app_users;
create trigger create_profile_after_app_user_insert
after insert on public.app_users
for each row
execute function public.create_profile_for_new_app_user();
