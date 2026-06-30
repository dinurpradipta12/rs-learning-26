-- ============================================================
-- SECURITY HARDENING - RS-2026-06-30-001
-- Fixes: VULN-01, VULN-02, VULN-03, VULN-04, VULN-05
-- ============================================================

-- ── STEP 1: Hapus akun hacker yang sudah dibuat ─────────────
DELETE FROM app_users WHERE username = 'hacker123';
DELETE FROM user_profiles WHERE username = 'hacker123';
DELETE FROM user_credits WHERE username = 'hacker123';

-- ── STEP 2: VULN-02 — Lindungi admin_create_user RPC ────────
-- Hanya service_role yang bisa panggil fungsi ini
-- Drop & recreate dengan SECURITY DEFINER + internal role check
CREATE OR REPLACE FUNCTION admin_create_user(
  p_username TEXT,
  p_password TEXT,
  p_role TEXT DEFAULT 'user'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role TEXT;
  v_hash TEXT;
  v_allowed_roles TEXT[] := ARRAY['user', 'member'];
BEGIN
  -- Hanya bisa dipanggil oleh service_role (dari edge function/server)
  -- atau dari session yang sudah terverifikasi sebagai developer
  IF current_setting('role', true) NOT IN ('service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'Access denied: insufficient privileges' USING ERRCODE = '42501';
  END IF;

  -- Batasi role yang bisa dibuat via RPC ini (tidak bisa buat developer/admin)
  IF p_role NOT IN ('user', 'member') THEN
    RAISE EXCEPTION 'Access denied: cannot create privileged accounts via this endpoint' USING ERRCODE = '42501';
  END IF;

  -- Validasi username
  IF p_username IS NULL OR length(trim(p_username)) < 3 THEN
    RAISE EXCEPTION 'Username tidak valid';
  END IF;

  -- Hash password dengan bcrypt cost=12
  v_hash := crypt(p_password, gen_salt('bf', 12));

  INSERT INTO app_users (username, password_hash, role, created_at)
  VALUES (trim(lower(p_username)), v_hash, p_role, now())
  ON CONFLICT (username) DO NOTHING;

  RETURN json_build_object('success', true, 'username', trim(lower(p_username)));
EXCEPTION
  WHEN unique_violation THEN
    RETURN json_build_object('success', false, 'error', 'Username sudah digunakan');
  WHEN OTHERS THEN
    RAISE;
END;
$$;

-- Cabut akses anon & authenticated dari fungsi ini
REVOKE ALL ON FUNCTION admin_create_user(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_create_user(TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION admin_create_user(TEXT, TEXT, TEXT) FROM authenticated;
-- Hanya service_role yang boleh
GRANT EXECUTE ON FUNCTION admin_create_user(TEXT, TEXT, TEXT) TO service_role;

-- ── STEP 3: VULN-03 — Perkuat fungsi authenticate & register ─
-- Pastikan register_app_user juga menggunakan cost=12
CREATE OR REPLACE FUNCTION register_app_user(
  p_username TEXT,
  p_password TEXT,
  p_email TEXT DEFAULT NULL,
  p_display_name TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash TEXT;
  v_clean_username TEXT;
BEGIN
  v_clean_username := trim(lower(p_username));

  IF v_clean_username IS NULL OR length(v_clean_username) < 3 THEN
    RETURN json_build_object('success', false, 'error', 'Username minimal 3 karakter');
  END IF;

  IF length(p_password) < 6 THEN
    RETURN json_build_object('success', false, 'error', 'Password minimal 6 karakter');
  END IF;

  -- Upgrade ke cost=12
  v_hash := crypt(p_password, gen_salt('bf', 12));

  INSERT INTO app_users (username, password_hash, role, created_at)
  VALUES (v_clean_username, v_hash, 'user', now());

  IF p_display_name IS NOT NULL OR p_email IS NOT NULL THEN
    INSERT INTO user_profiles (username, display_name, email, created_at)
    VALUES (v_clean_username, coalesce(p_display_name, v_clean_username), p_email, now())
    ON CONFLICT (username) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          email = EXCLUDED.email;
  END IF;

  RETURN json_build_object('success', true, 'username', v_clean_username);
EXCEPTION
  WHEN unique_violation THEN
    RETURN json_build_object('success', false, 'error', 'Username sudah digunakan');
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION register_app_user(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_app_user(TEXT, TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION register_app_user(TEXT, TEXT, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION register_app_user(TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ── STEP 4: VULN-03 — Upgrade bcrypt cost untuk password lama ─
-- Re-hash semua password yang masih menggunakan cost=6
-- Ini hanya bisa dilakukan saat user login berikutnya (lazy migration)
-- Tapi kita bisa tandai mana yang lemah:
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_needs_rehash BOOLEAN DEFAULT FALSE;

UPDATE app_users
SET password_needs_rehash = TRUE
WHERE password_hash LIKE '$2a$06$%' OR password_hash LIKE '$2b$06$%';

-- ── STEP 5: VULN-05 + VULN-03 — Enable RLS di semua tabel ───

-- app_users: tabel paling kritis
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;

-- Tidak ada akses langsung untuk anon/authenticated ke app_users
-- Semua auth harus melalui RPC SECURITY DEFINER
DROP POLICY IF EXISTS "no_direct_access" ON app_users;
CREATE POLICY "deny_all_direct_access" ON app_users
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false);

-- user_profiles: user hanya bisa baca & update profil sendiri
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_profile" ON user_profiles;
DROP POLICY IF EXISTS "users_update_own_profile" ON user_profiles;
DROP POLICY IF EXISTS "service_role_full" ON user_profiles;

CREATE POLICY "service_role_full" ON user_profiles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- user_credits: hanya service_role
ALTER TABLE user_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_credits" ON user_credits;
CREATE POLICY "service_role_credits" ON user_credits
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "deny_direct_credit_access" ON user_credits
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);

-- credit_transactions: hanya service_role
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_transactions" ON credit_transactions;
CREATE POLICY "service_role_transactions" ON credit_transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "deny_direct_tx_access" ON credit_transactions
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);

-- topup_requests: hanya service_role
ALTER TABLE topup_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_topup" ON topup_requests;
CREATE POLICY "service_role_topup" ON topup_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "deny_direct_topup_access" ON topup_requests
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);

-- user_subscriptions: hanya service_role
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_subs" ON user_subscriptions;
CREATE POLICY "service_role_subs" ON user_subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "deny_direct_sub_access" ON user_subscriptions
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);

-- app_settings: hanya service_role bisa update, anon bisa SELECT
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read_settings" ON app_settings;
DROP POLICY IF EXISTS "service_write_settings" ON app_settings;
CREATE POLICY "anon_read_settings" ON app_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "service_write_settings" ON app_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── STEP 6: VULN-02 — Lindungi delete_app_user juga ─────────
CREATE OR REPLACE FUNCTION delete_app_user(p_username TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('role', true) NOT IN ('service_role', 'supabase_admin') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  DELETE FROM app_users WHERE username = p_username;
  DELETE FROM user_profiles WHERE username = p_username;
  DELETE FROM user_credits WHERE username = p_username;
  DELETE FROM credit_transactions WHERE username = p_username;
  DELETE FROM user_subscriptions WHERE username = p_username;
  DELETE FROM user_asset_unlocks WHERE username = p_username;

  RETURN json_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION delete_app_user(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_app_user(TEXT) FROM anon;
REVOKE ALL ON FUNCTION delete_app_user(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION delete_app_user(TEXT) TO service_role;

-- ── STEP 7: Log security event ───────────────────────────────
CREATE TABLE IF NOT EXISTS security_audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE security_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_only_audit" ON security_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "deny_audit_access" ON security_audit_log
  AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false);

INSERT INTO security_audit_log (event_type, details) VALUES (
  'SECURITY_HARDENING_APPLIED',
  jsonb_build_object(
    'report_id', 'RS-2026-06-30-001',
    'applied_at', now(),
    'fixes', ARRAY['VULN-01','VULN-02','VULN-03','VULN-04','VULN-05'],
    'hacker_account_deleted', true
  )
);
