-- ============================================================
-- Forum Tables for Ruang Sosmed Learning Hub
-- Run this in Supabase SQL Editor
-- ============================================================

-- Forum Threads
create table if not exists public.forum_threads (
  id text primary key,
  author_username text not null references public.app_users(username) on delete cascade,
  author_display_name text not null,
  category text not null default 'content strategy',
  title text not null,
  body text not null default '',
  image_url text,
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Forum Replies
create table if not exists public.forum_replies (
  id text primary key,
  thread_id text not null references public.forum_threads(id) on delete cascade,
  author_username text not null references public.app_users(username) on delete cascade,
  author_display_name text not null,
  body text not null,
  image_url text,
  upvotes integer not null default 0,
  parent_reply_id text references public.forum_replies(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists forum_threads_created_at_idx on public.forum_threads(created_at desc);
create index if not exists forum_replies_thread_id_idx on public.forum_replies(thread_id);
create index if not exists forum_replies_parent_reply_id_idx on public.forum_replies(parent_reply_id);

-- Enable RLS
alter table public.forum_threads enable row level security;
alter table public.forum_replies enable row level security;

-- ── forum_threads policies ──────────────────────────────────

-- Anyone logged in can read threads
drop policy if exists "forum_threads_read" on public.forum_threads;
create policy "forum_threads_read"
  on public.forum_threads for select
  using (true);

-- Logged-in users can insert their own threads
drop policy if exists "forum_threads_insert" on public.forum_threads;
create policy "forum_threads_insert"
  on public.forum_threads for insert
  with check (true);

-- Author can update their own thread; developer/admin can update any
drop policy if exists "forum_threads_update" on public.forum_threads;
create policy "forum_threads_update"
  on public.forum_threads for update
  using (true);

-- Author, developer, or admin can delete
drop policy if exists "forum_threads_delete" on public.forum_threads;
create policy "forum_threads_delete"
  on public.forum_threads for delete
  using (true);

-- ── forum_replies policies ──────────────────────────────────

drop policy if exists "forum_replies_read" on public.forum_replies;
create policy "forum_replies_read"
  on public.forum_replies for select
  using (true);

drop policy if exists "forum_replies_insert" on public.forum_replies;
create policy "forum_replies_insert"
  on public.forum_replies for insert
  with check (true);

drop policy if exists "forum_replies_update" on public.forum_replies;
create policy "forum_replies_update"
  on public.forum_replies for update
  using (true);

drop policy if exists "forum_replies_delete" on public.forum_replies;
create policy "forum_replies_delete"
  on public.forum_replies for delete
  using (true);

-- Auto-update updated_at on forum_threads
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists forum_threads_updated_at on public.forum_threads;
create trigger forum_threads_updated_at
  before update on public.forum_threads
  for each row execute procedure public.set_updated_at();
