-- ============================================================
-- One-on-One Booking Table
-- Run this in Supabase SQL Editor
-- ============================================================

create table if not exists public.one_on_one_bookings (
  id uuid primary key default gen_random_uuid(),
  requester_username text not null references public.app_users(username) on delete cascade,
  requester_display_name text not null default '',
  topic text not null,
  preferred_date date not null,
  preferred_time time not null,
  note text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  calendar_event_id uuid references public.calendar_events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookings_status_idx on public.one_on_one_bookings(status);
create index if not exists bookings_requester_idx on public.one_on_one_bookings(requester_username);
create index if not exists bookings_created_at_idx on public.one_on_one_bookings(created_at desc);

alter table public.one_on_one_bookings enable row level security;

drop policy if exists bookings_select on public.one_on_one_bookings;
drop policy if exists bookings_insert on public.one_on_one_bookings;
drop policy if exists bookings_update on public.one_on_one_bookings;
drop policy if exists bookings_delete on public.one_on_one_bookings;

create policy bookings_select on public.one_on_one_bookings for select using (true);
create policy bookings_insert on public.one_on_one_bookings for insert with check (true);
create policy bookings_update on public.one_on_one_bookings for update using (true) with check (true);
create policy bookings_delete on public.one_on_one_bookings for delete using (true);

-- Auto-fill requester_display_name from app_users
create or replace function public.fill_booking_display_name()
returns trigger language plpgsql as $$
begin
  if new.requester_display_name = '' then
    select display_name into new.requester_display_name
    from public.app_users
    where username = new.requester_username;
  end if;
  return new;
end;
$$;

drop trigger if exists on_booking_insert_fill_name on public.one_on_one_bookings;
create trigger on_booking_insert_fill_name
  before insert on public.one_on_one_bookings
  for each row execute procedure public.fill_booking_display_name();
