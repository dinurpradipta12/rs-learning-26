-- Tambah kolom referral_code ke user_profiles
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_code text;
