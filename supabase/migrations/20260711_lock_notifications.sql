-- ============================================================
-- LOCKDOWN: notifications (P2 — anti-spoof/phishing)
--
-- Masalah: anon bisa INSERT notifikasi ke user mana pun dengan judul/isi/link
-- bebas → bisa memalsukan notif sistem ("Topup disetujui, klik di sini") +
-- link phishing eksternal.
--
-- Catatan arsitektur: notif lintas-user yang SAH dikirim dari client
-- (balasan thread, ucapan ultah, aksi admin, bukti topup user→admin). Tipe
-- notif dipakai dua arah, jadi tidak bisa digating murni berdasar tipe.
--
-- Mitigasi (tanpa merusak alur sah):
--   RPC send_notification yang: (1) verifikasi token pengirim, (2) MENOLAK
--   link non-internal (harus null atau diawali '#') → matikan URL phishing,
--   (3) MEMAKSA actor_username = pengirim terverifikasi → tak bisa memalsukan
--   pengirim, (4) batasi panjang judul/isi.
--   Lalu: INSERT langsung oleh anon DITOLAK; SELECT/UPDATE/DELETE tetap
--   terbuka supaya lonceng (baca/tandai-dibaca/hapus) tetap jalan.
--
--   BAGIAN 1 (aditif, jalankan SEKARANG). BAGIAN 2 (lockdown, PALING AKHIR).
-- ============================================================

-- ── BAGIAN 1 — RPC (aman dijalankan kapan saja) ─────────────
drop function if exists public.send_notification(text, text, text, text, text, text);
create or replace function public.send_notification(
  p_token     text,
  p_recipient text,
  p_type      text,
  p_title     text,
  p_body      text,
  p_link      text default null
)
returns json
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  caller record;
begin
  select * into caller from public._session_identity(p_token);
  if caller.username is null then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if p_recipient is null or length(trim(p_recipient)) = 0 then
    raise exception 'Recipient wajib';
  end if;
  -- Cegah link phishing eksternal: hanya rute internal (hash) atau kosong.
  if p_link is not null and left(p_link, 1) <> '#' then
    raise exception 'Link notifikasi harus internal (#...)';
  end if;

  insert into public.notifications (recipient_username, type, title, body, link, actor_username)
  values (
    p_recipient,
    coalesce(p_type, 'thread_reply'),
    left(coalesce(p_title, ''), 200),
    left(coalesce(p_body, ''), 2000),
    p_link,
    caller.username           -- pengirim terverifikasi, bukan dari client
  );

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.send_notification(text, text, text, text, text, text) to anon, authenticated;


-- ── BAGIAN 2 — LOCKDOWN (JALANKAN PALING AKHIR) ─────────────
-- HANYA setelah client baru (memakai send_notification) live di produksi.
--
/*
alter table public.notifications enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies
           where schemaname = 'public' and tablename = 'notifications'
  loop
    execute format('drop policy if exists %I on public.notifications', p.policyname);
  end loop;
end $$;

-- Baca/tandai-dibaca/hapus tetap boleh (anon tak punya identitas per-user di
-- DB; ini operasi lonceng yang sah — risikонya cuma griefing id acak, rendah).
create policy "notif_read"   on public.notifications for select to anon, authenticated using (true);
create policy "notif_update" on public.notifications for update to anon, authenticated using (true) with check (true);
create policy "notif_delete" on public.notifications for delete to anon, authenticated using (true);
-- INSERT: TIDAK ada policy anon → ditolak. Hanya via RPC (definer)/service_role.
create policy "notif_service_write" on public.notifications for all to service_role using (true) with check (true);

-- Verifikasi: select policyname, cmd, roles from pg_policies where tablename='notifications';
*/
