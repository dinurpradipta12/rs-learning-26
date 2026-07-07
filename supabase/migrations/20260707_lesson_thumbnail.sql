-- Cover/thumbnail per lesson (opsional). Kalau kosong, UI pakai thumbnail
-- YouTube otomatis dari video_url. Gambar dikompres di client sebelum upload
-- ke storage (bucket lesson-assets), jadi hanya URL yang disimpan di sini.
alter table public.lessons add column if not exists thumbnail_url text;
