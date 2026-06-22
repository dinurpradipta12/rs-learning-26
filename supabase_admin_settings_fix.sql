-- Fix RLS policy untuk learning_hub_content agar bisa insert/update dari anon key
-- Jalankan ini di Supabase SQL Editor

-- Drop & recreate semua policy agar bersih
drop policy if exists "learning_hub_content_select" on public.learning_hub_content;
drop policy if exists "learning_hub_content_insert" on public.learning_hub_content;
drop policy if exists "learning_hub_content_update" on public.learning_hub_content;
drop policy if exists "learning_hub_content_delete" on public.learning_hub_content;
drop policy if exists learning_hub_content_select on public.learning_hub_content;
drop policy if exists learning_hub_content_insert on public.learning_hub_content;
drop policy if exists learning_hub_content_update on public.learning_hub_content;
drop policy if exists learning_hub_content_delete on public.learning_hub_content;

create policy "lhc_select" on public.learning_hub_content for select using (true);
create policy "lhc_insert" on public.learning_hub_content for insert with check (true);
create policy "lhc_update" on public.learning_hub_content for update using (true) with check (true);
create policy "lhc_delete" on public.learning_hub_content for delete using (true);
