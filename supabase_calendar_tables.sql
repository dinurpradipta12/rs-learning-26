create extension if not exists pgcrypto;

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  note text not null default '',
  event_date date not null,
  start_time time not null,
  end_time time not null,
  category text not null default 'class' check (category in ('class', 'review', 'qna', 'reminder')),
  accent text not null default 'purple' check (accent in ('lime', 'purple')),
  attendee_count integer not null default 0 check (attendee_count >= 0),
  is_done boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calendar_events
  add column if not exists title text not null default 'kelas baru',
  add column if not exists note text not null default '',
  add column if not exists event_date date not null default current_date,
  add column if not exists start_time time not null default time '09:00',
  add column if not exists end_time time not null default time '10:00',
  add column if not exists category text not null default 'class',
  add column if not exists accent text not null default 'purple',
  add column if not exists attendee_count integer not null default 0,
  add column if not exists is_done boolean not null default false,
  add column if not exists sort_order integer not null default 0,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists calendar_events_date_time_idx
  on public.calendar_events (event_date, start_time, sort_order);

create or replace function public.touch_calendar_events_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_calendar_events_updated_at on public.calendar_events;
create trigger touch_calendar_events_updated_at
before update on public.calendar_events
for each row
execute function public.touch_calendar_events_updated_at();

alter table public.calendar_events enable row level security;

drop policy if exists calendar_events_select on public.calendar_events;
drop policy if exists calendar_events_insert on public.calendar_events;
drop policy if exists calendar_events_update on public.calendar_events;
drop policy if exists calendar_events_delete on public.calendar_events;

create policy calendar_events_select on public.calendar_events for select using (true);
create policy calendar_events_insert on public.calendar_events for insert with check (true);
create policy calendar_events_update on public.calendar_events for update using (true) with check (true);
create policy calendar_events_delete on public.calendar_events for delete using (true);

insert into public.calendar_events (title, note, event_date, start_time, end_time, category, accent, attendee_count, is_done, sort_order)
values
  ('Content Planning', 'Zoom class strategi konten', date '2026-06-15', time '09:30', time '10:30', 'class', 'lime', 8, false, 1),
  ('Asset Review', 'Review task minggu ini', date '2026-06-16', time '10:00', time '11:00', 'review', 'purple', 5, false, 2),
  ('Mentor QNA Live', 'Tanya jawab bersama mentor', date '2026-06-17', time '11:00', time '12:00', 'qna', 'lime', 12, false, 3),
  ('Weekly Insight', 'Baca performa konten', date '2026-06-18', time '09:00', time '10:00', 'review', 'purple', 6, true, 4),
  ('Reels Practice', 'Latihan ide dan hook', date '2026-06-19', time '10:30', time '11:30', 'class', 'lime', 9, false, 5),
  ('Community Clinic', 'Diskusi kendala campaign', date '2026-06-20', time '11:30', time '12:30', 'qna', 'purple', 7, false, 6)
on conflict do nothing;
