-- ============================================================
-- supabase_courses.sql
-- Tabel katalog kursus untuk halaman Learning Center
-- Jalankan sekali di Supabase SQL Editor
-- ============================================================

create table if not exists public.courses (
  key          text primary key,
  title        text not null,
  subtitle     text not null default '',
  description  text not null default '',
  level        text not null default 'fundamental',
  thumbnail_url text,
  lesson_count int not null default 0,
  sort_order   int not null default 0,
  status       text not null default 'open',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.courses
  add column if not exists subtitle     text not null default '',
  add column if not exists description  text not null default '',
  add column if not exists level        text not null default 'fundamental',
  add column if not exists thumbnail_url text,
  add column if not exists lesson_count int not null default 0,
  add column if not exists sort_order   int not null default 0,
  add column if not exists status       text not null default 'open',
  add column if not exists created_at   timestamptz not null default now(),
  add column if not exists updated_at   timestamptz not null default now();

-- Index
create index if not exists courses_sort_order_idx on public.courses (sort_order);

-- RLS
alter table public.courses enable row level security;

drop policy if exists courses_select on public.courses;
drop policy if exists courses_insert on public.courses;
drop policy if exists courses_update on public.courses;
drop policy if exists courses_delete on public.courses;

create policy courses_select on public.courses for select using (true);
create policy courses_insert on public.courses for insert with check (true);
create policy courses_update on public.courses for update using (true) with check (true);
create policy courses_delete on public.courses for delete using (true);

-- ── Seed data kursus ──
-- course_key 'lms' = kursus yang sudah ada (lesson lama tetap jalan)
-- Tambah/edit kursus baru cukup insert baris baru di sini

insert into public.courses (key, title, subtitle, description, level, thumbnail_url, lesson_count, sort_order, status)
values
  (
    'lms',
    'Fundamental Social Media Specialist',
    'Series Fundamental',
    'Pelajari strategi konten, ritme posting, dan cara membaca performa sosial media dari nol.',
    'fundamental',
    null,
    5,
    1,
    'open'
  ),
  (
    'advance-sm',
    'Advance Social Media Strategy',
    'Series Advance',
    'Dalami growth hacking, paid strategy, dan optimasi campaign lintas platform secara mendalam.',
    'advance',
    null,
    0,
    2,
    'coming_soon'
  ),
  (
    'content-system',
    'Content System & Workflow',
    'Series Fundamental',
    'Bangun workflow pembuatan konten yang efisien mulai dari ide, asset, revisi, hingga approval.',
    'fundamental',
    null,
    0,
    3,
    'coming_soon'
  )
on conflict (key) do update
set title        = excluded.title,
    subtitle     = excluded.subtitle,
    description  = excluded.description,
    level        = excluded.level,
    lesson_count = excluded.lesson_count,
    sort_order   = excluded.sort_order,
    status       = excluded.status,
    updated_at   = now();

-- ── Catatan ──
-- Untuk menambah kursus baru:
--   1. INSERT baris baru ke tabel 'courses' dengan key unik
--   2. INSERT lesson ke tabel 'lessons' dengan course_key = key kursus baru
--   3. lesson_count bisa diupdate manual atau via trigger
--
-- Untuk upload thumbnail:
--   Simpan gambar di Supabase Storage lalu isi kolom thumbnail_url dengan public URL-nya
