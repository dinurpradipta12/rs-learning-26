-- Tambah kolom proof_url ke topup_requests
ALTER TABLE topup_requests ADD COLUMN IF NOT EXISTS proof_url text;
