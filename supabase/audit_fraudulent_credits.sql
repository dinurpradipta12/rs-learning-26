-- ============================================================
-- AUDIT — Deteksi penambahan coin mencurigakan  (RS-2026-07-04-001)
-- Jalankan di Supabase SQL editor. Query ini READ-ONLY (kecuali blok
-- KOREKSI di bawah yang dikomentari — buka hanya setelah yakin).
-- ============================================================

-- Daftar username admin/developer yang SAH (sesuaikan bila perlu).
-- Dipakai sebagai acuan "created_by yang sah".
--   → cek dulu: select username, role from app_users where role in ('developer','admin');

-- 1) Transaksi 'topup' yang TIDAK dibuat oleh admin sah.
--    created_by NULL = ditulis langsung dari client (jalur lama yang bocor).
--    created_by selain developer/admin = mencurigakan.
select t.id, t.username, t.amount, t.description, t.created_by, t.created_at
from credit_transactions t
where t.type = 'topup'
  and (
    t.created_by is null
    or t.created_by not in (select username from app_users where role in ('developer','admin'))
  )
  -- Abaikan reward sah (self-reward berlabel "Bonus:") bila diinginkan:
  and t.description not ilike 'Bonus:%'
order by t.amount desc, t.created_at desc;

-- 2) Transaksi topup bernilai janggal besar (mis. > 50.000 sekaligus)
--    tanpa request topup pendamping yang approved.
select t.id, t.username, t.amount, t.description, t.created_by, t.created_at
from credit_transactions t
where t.type = 'topup'
  and t.amount >= 50000
  and not exists (
    select 1 from topup_requests r
    where r.username = t.username
      and r.status = 'approved'
      and r.credits = t.amount
  )
order by t.amount desc;

-- 3) Rekap per user: total topup tercatat vs total topup approved yang sah.
--    Selisih positif = coin masuk tanpa jejak topup sah (indikasi dicetak).
with tx as (
  select username, sum(amount) filter (where type='topup') as tx_topup
  from credit_transactions group by username
),
appr as (
  select username, sum(credits + coalesce(bonus_credits,0)) as approved_topup
  from topup_requests where status='approved' group by username
)
select c.username,
       c.balance,
       coalesce(tx.tx_topup,0)      as tx_topup_total,
       coalesce(appr.approved_topup,0) as approved_total,
       coalesce(tx.tx_topup,0) - coalesce(appr.approved_topup,0) as unexplained
from user_credits c
left join tx   on tx.username   = c.username
left join appr on appr.username = c.username
where coalesce(tx.tx_topup,0) - coalesce(appr.approved_topup,0) > 0
order by unexplained desc;

-- ============================================================
-- KOREKSI MANUAL (JANGAN jalankan sebelum verifikasi hasil di atas)
-- Contoh: nolkan saldo curang seorang user & catat jejaknya.
-- ============================================================
-- begin;
--   insert into credit_transactions (username, amount, type, description, created_by)
--   values ('USERNAME', -SALDO_CURANG, 'adjustment', 'Koreksi saldo curang RS-2026-07-04-001', 'system');
--   update user_credits set balance = greatest(0, balance - SALDO_CURANG)
--     where username = 'USERNAME';
-- commit;
