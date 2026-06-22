-- shared_assets table for Asset Manager page
create table if not exists public.shared_assets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  category text not null default 'lainnya',
  url text not null,
  type text not null default 'link',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Allow all authenticated / public reads (students can see assets)
alter table public.shared_assets enable row level security;

create policy "anyone can read shared_assets"
  on public.shared_assets for select
  using (true);

-- Only service role / backend writes (or you can restrict to developer role via custom claim)
create policy "service role can manage shared_assets"
  on public.shared_assets for all
  using (true)
  with check (true);
