create extension if not exists pgcrypto;

alter table public.lessons
  add column if not exists title text,
  add column if not exists duration text,
  add column if not exists meta text,
  add column if not exists description text,
  add column if not exists video_url text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.lesson_assets (
  asset_key text,
  lesson_key text not null,
  sort_order int not null default 0,
  title text not null,
  type text not null,
  note text not null,
  storage_path text,
  external_url text,
  updated_at timestamptz not null default now()
);

alter table public.lesson_assets
  add column if not exists asset_key text,
  add column if not exists lesson_key text,
  add column if not exists sort_order int not null default 0,
  add column if not exists title text,
  add column if not exists type text,
  add column if not exists note text,
  add column if not exists storage_path text,
  add column if not exists external_url text,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.lesson_reviews (
  id uuid primary key default gen_random_uuid(),
  lesson_key text not null,
  reviewer_name text not null,
  reviewer_username text,
  rating int not null default 5,
  feedback text not null,
  created_at timestamptz not null default now()
);

alter table public.lesson_reviews
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists lesson_key text,
  add column if not exists reviewer_name text,
  add column if not exists reviewer_username text,
  add column if not exists rating int not null default 5,
  add column if not exists feedback text,
  add column if not exists created_at timestamptz not null default now();

create table if not exists public.lesson_progress (
  session_username text not null,
  lesson_key text not null,
  completed_at timestamptz not null default now()
);

alter table public.lesson_progress
  add column if not exists session_username text,
  add column if not exists lesson_key text,
  add column if not exists completed_at timestamptz not null default now();

create unique index if not exists lessons_lesson_key_idx on public.lessons (lesson_key);
create unique index if not exists lesson_assets_asset_key_idx on public.lesson_assets (asset_key);
create index if not exists lesson_assets_lesson_key_idx on public.lesson_assets (lesson_key);
create index if not exists lesson_assets_sort_order_idx on public.lesson_assets (sort_order);
create index if not exists lessons_sort_order_idx on public.lessons (sort_order);
create index if not exists lesson_reviews_lesson_key_idx on public.lesson_reviews (lesson_key);
create unique index if not exists lesson_progress_unique_idx on public.lesson_progress (session_username, lesson_key);

alter table public.lessons enable row level security;
alter table public.lesson_assets enable row level security;
alter table public.lesson_reviews enable row level security;
alter table public.lesson_progress enable row level security;

drop policy if exists lessons_select on public.lessons;
drop policy if exists lessons_insert on public.lessons;
drop policy if exists lessons_update on public.lessons;
drop policy if exists lessons_delete on public.lessons;
drop policy if exists lessons_write on public.lessons;

create policy lessons_select on public.lessons for select using (true);
create policy lessons_insert on public.lessons for insert with check (true);
create policy lessons_update on public.lessons for update using (true) with check (true);
create policy lessons_delete on public.lessons for delete using (true);

drop policy if exists lesson_assets_select on public.lesson_assets;
drop policy if exists lesson_assets_insert on public.lesson_assets;
drop policy if exists lesson_assets_update on public.lesson_assets;
drop policy if exists lesson_assets_delete on public.lesson_assets;
drop policy if exists lesson_assets_write on public.lesson_assets;

create policy lesson_assets_select on public.lesson_assets for select using (true);
create policy lesson_assets_insert on public.lesson_assets for insert with check (true);
create policy lesson_assets_update on public.lesson_assets for update using (true) with check (true);
create policy lesson_assets_delete on public.lesson_assets for delete using (true);

drop policy if exists lesson_reviews_select on public.lesson_reviews;
drop policy if exists lesson_reviews_insert on public.lesson_reviews;
drop policy if exists lesson_reviews_update on public.lesson_reviews;
drop policy if exists lesson_reviews_delete on public.lesson_reviews;
drop policy if exists lesson_reviews_write on public.lesson_reviews;

create policy lesson_reviews_select on public.lesson_reviews for select using (true);
create policy lesson_reviews_insert on public.lesson_reviews for insert with check (true);
create policy lesson_reviews_update on public.lesson_reviews for update using (true) with check (true);
create policy lesson_reviews_delete on public.lesson_reviews for delete using (true);

drop policy if exists lesson_progress_select on public.lesson_progress;
drop policy if exists lesson_progress_insert on public.lesson_progress;
drop policy if exists lesson_progress_update on public.lesson_progress;
drop policy if exists lesson_progress_delete on public.lesson_progress;
drop policy if exists lesson_progress_write on public.lesson_progress;

create policy lesson_progress_select on public.lesson_progress for select using (true);
create policy lesson_progress_insert on public.lesson_progress for insert with check (true);
create policy lesson_progress_update on public.lesson_progress for update using (true) with check (true);
create policy lesson_progress_delete on public.lesson_progress for delete using (true);

insert into storage.buckets (id, name, public)
values ('lesson-assets', 'lesson-assets', true)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public;

drop policy if exists lesson_assets_bucket_select on storage.objects;
drop policy if exists lesson_assets_bucket_insert on storage.objects;
drop policy if exists lesson_assets_bucket_update on storage.objects;
drop policy if exists lesson_assets_bucket_delete on storage.objects;

create policy lesson_assets_bucket_select
  on storage.objects
  for select
  using (bucket_id = 'lesson-assets');

create policy lesson_assets_bucket_insert
  on storage.objects
  for insert
  with check (bucket_id = 'lesson-assets');

create policy lesson_assets_bucket_update
  on storage.objects
  for update
  using (bucket_id = 'lesson-assets')
  with check (bucket_id = 'lesson-assets');

create policy lesson_assets_bucket_delete
  on storage.objects
  for delete
  using (bucket_id = 'lesson-assets');

insert into public.lessons (lesson_key, course_key, sort_order, title, duration, meta, description, video_url)
values
  ('content-planning', 'lms', 1, '01: learn the basics', '18 menit', 'video class', 'membahas cara menyusun ide konten, menentukan angle, dan membangun ritme posting yang konsisten.', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'),
  ('asset-reels', 'lms', 2, '02: content asset workflow', '12 file', 'download asset', 'menjelaskan struktur asset kelas yang dipakai untuk reels, termasuk cover, subtitle, dan format file.', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'),
  ('weekly-review', 'lms', 3, '03: weekly performance review', '9 menit', 'case study', 'menunjukkan cara membaca insight mingguan, menemukan pola performa, dan menentukan next action.', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'),
  ('practice-recap', 'lms', 4, '04: practice and recap', '11 menit', 'exercise', 'latihan penerapan materi sebelumnya lalu merangkum poin penting agar mudah diulang kembali.', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'),
  ('platform-shift', 'lms', 5, '05: platform trend shift', '14 menit', 'trend update', 'membahas perubahan pola konsumsi konten di platform dan implikasinya ke strategi berikutnya.', 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4')
on conflict (lesson_key) do update
set course_key = excluded.course_key,
    sort_order = excluded.sort_order,
    title = excluded.title,
    duration = excluded.duration,
    meta = excluded.meta,
    description = excluded.description,
    video_url = excluded.video_url,
    updated_at = now();

delete from public.lesson_assets
where lesson_key in ('content-planning', 'asset-reels', 'weekly-review', 'practice-recap', 'platform-shift')
  and asset_key in (
    'asset-content-brief',
    'asset-hook-bank',
    'asset-reel-pack',
    'asset-subtitle-preset',
    'asset-insight-sheet',
    'asset-practice-checklist',
    'asset-trend-notes'
  );

insert into public.lesson_assets (asset_key, lesson_key, sort_order, title, type, note, storage_path, external_url)
values
  ('asset-content-brief', 'content-planning', 1, 'content brief template', 'pdf', 'outline singkat untuk planning', null, null),
  ('asset-hook-bank', 'content-planning', 2, 'hook bank sheet', 'sheet', 'list hook yang siap dipakai', null, null),
  ('asset-reel-pack', 'asset-reels', 1, 'reel cover pack', 'zip', 'cover visual siap edit', null, null),
  ('asset-subtitle-preset', 'asset-reels', 2, 'subtitle preset', 'srt', 'format subtitle dasar', null, null),
  ('asset-insight-sheet', 'weekly-review', 1, 'insight tracking sheet', 'sheet', 'rekap performa mingguan', null, null),
  ('asset-practice-checklist', 'practice-recap', 1, 'practice checklist', 'pdf', 'panduan latihan mandiri', null, null),
  ('asset-trend-notes', 'platform-shift', 1, 'trend notes', 'pdf', 'catatan update tren platform', null, null)
on conflict (asset_key) do update
set lesson_key = excluded.lesson_key,
    sort_order = excluded.sort_order,
    title = excluded.title,
    type = excluded.type,
    note = excluded.note,
    storage_path = excluded.storage_path,
    external_url = excluded.external_url,
    updated_at = now();

-- jika project lama pernah punya tabel legacy `learning_hub_content`,
-- migrasi review lama dilakukan manual. script utama ini sengaja tidak
-- lagi bergantung ke tabel tersebut agar aman dijalankan di project baru.
