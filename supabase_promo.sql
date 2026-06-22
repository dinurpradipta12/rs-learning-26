-- Simpan snapshot promo yang berlaku saat user beli
ALTER TABLE topup_requests ADD COLUMN IF NOT EXISTS promo_bonus jsonb;
