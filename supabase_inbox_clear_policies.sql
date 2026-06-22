-- ============================================================
-- Inbox "Kosongkan Riwayat" — izin DELETE
-- Diperlukan agar admin bisa menghapus riwayat booking 1:1 &
-- request topup dari halaman Inbox.
-- Jalankan di Supabase SQL Editor. Aman dijalankan berulang.
-- ============================================================

-- ── Booking 1:1 ─────────────────────────────────────────────
alter table public.one_on_one_bookings enable row level security;

drop policy if exists bookings_delete on public.one_on_one_bookings;
create policy bookings_delete
  on public.one_on_one_bookings
  for delete
  using (true);

-- ── Request Topup ───────────────────────────────────────────
alter table public.topup_requests enable row level security;

drop policy if exists topup_requests_delete on public.topup_requests;
create policy topup_requests_delete
  on public.topup_requests
  for delete
  using (true);
