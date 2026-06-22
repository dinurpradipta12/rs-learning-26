-- ============================================================
-- Notifications Table
-- Run this in Supabase SQL Editor
-- ============================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_username text not null references public.app_users(username) on delete cascade,
  type text not null check (type in ('booking_approved','booking_rejected','lesson_new','credits_added','thread_reply')),
  title text not null,
  body text not null default '',
  link text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_recipient_idx on public.notifications(recipient_username);
create index if not exists notifications_created_at_idx on public.notifications(created_at desc);
create index if not exists notifications_unread_idx on public.notifications(recipient_username, is_read) where not is_read;

alter table public.notifications enable row level security;

drop policy if exists notifications_select on public.notifications;
drop policy if exists notifications_insert on public.notifications;
drop policy if exists notifications_update on public.notifications;
drop policy if exists notifications_delete on public.notifications;

create policy notifications_select on public.notifications for select using (true);
create policy notifications_insert on public.notifications for insert with check (true);
create policy notifications_update on public.notifications for update using (true) with check (true);
create policy notifications_delete on public.notifications for delete using (true);

-- Enable Realtime
alter publication supabase_realtime add table public.notifications;
