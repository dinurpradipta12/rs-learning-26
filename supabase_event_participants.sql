-- Tabel peserta event (dipakai tab "Peserta Event" di admin + kode akses rekaman).
-- Idempotent: aman dijalankan ulang. Kunci masalah "peserta tidak terbaca" biasanya
-- karena unique constraint (event_id, username) belum ada → upsert onConflict gagal,
-- atau RLS memblokir select. Script ini memastikan keduanya benar.

create table if not exists public.event_participants (
  event_id text not null,
  username text not null,
  display_name text,
  event_title text,
  event_date text,
  access_code text,
  joined_at timestamptz not null default now()
);

alter table public.event_participants
  add column if not exists event_id text,
  add column if not exists username text,
  add column if not exists display_name text,
  add column if not exists event_title text,
  add column if not exists event_date text,
  add column if not exists access_code text,
  add column if not exists joined_at timestamptz not null default now();

-- Wajib untuk upsert onConflict: 'event_id,username'
create unique index if not exists event_participants_unique_idx
  on public.event_participants (event_id, username);
create index if not exists event_participants_joined_at_idx
  on public.event_participants (joined_at desc);

alter table public.event_participants enable row level security;

-- App memakai auth kustom (app_users) lewat anon key, jadi policy permisif.
drop policy if exists event_participants_select on public.event_participants;
drop policy if exists event_participants_insert on public.event_participants;
drop policy if exists event_participants_update on public.event_participants;
drop policy if exists event_participants_delete on public.event_participants;

create policy event_participants_select on public.event_participants for select using (true);
create policy event_participants_insert on public.event_participants for insert with check (true);
create policy event_participants_update on public.event_participants for update using (true) with check (true);
create policy event_participants_delete on public.event_participants for delete using (true);
