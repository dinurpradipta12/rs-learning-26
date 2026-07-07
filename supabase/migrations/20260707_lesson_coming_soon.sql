-- Lesson "Coming Soon" / jadwal rilis (gaya Netflix).
--  coming_soon = true → materi terkunci, cover redup, label "Coming Soon"
--  available_at (date) → kalau di masa depan, tampil "Tersedia [tanggal]" & terkunci
alter table public.lessons add column if not exists coming_soon boolean not null default false;
alter table public.lessons add column if not exists available_at date;
