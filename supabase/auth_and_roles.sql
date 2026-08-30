-- ============================================================
-- Auth & roles: Owner / Admin, viewing stays public.
-- Run in Supabase SQL Editor, after everything else already run.
-- ============================================================

-- One row per Supabase Auth user we've assigned a role to.
CREATE TABLE profiles (
    id                    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email                 TEXT NOT NULL,
    role                  TEXT NOT NULL CHECK (role IN ('owner','admin')) DEFAULT 'admin',
    must_change_password  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helper functions (SECURITY DEFINER so RLS policies on profiles don't
-- recurse into themselves when checking the caller's own role).
CREATE OR REPLACE FUNCTION is_owner() RETURNS BOOLEAN AS $$
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_admin_or_owner() RETURNS BOOLEAN AS $$
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('owner','admin'));
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_own_or_owner ON profiles
  FOR SELECT USING (auth.uid() = id OR is_owner());

CREATE POLICY profiles_update_own_password_flag ON profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Owner-only: change roles / manage rows for other users.
CREATE POLICY profiles_owner_manages ON profiles
  FOR ALL USING (is_owner()) WITH CHECK (is_owner());

-- Seed the existing owner (already created in Supabase Auth manually).
INSERT INTO profiles (id, email, role, must_change_password)
SELECT id, email, 'owner', FALSE FROM auth.users
WHERE id = '37161e4e-f605-4931-b7d4-7e07e64fd866'
ON CONFLICT (id) DO UPDATE SET role = 'owner', must_change_password = FALSE;

-- ---- Tighten write access: viewing stays public (anon), writing now
-- requires being logged in as admin/owner. Replaces the blanket
-- "anon_insert ... WITH CHECK (true)" policies from Foundation 3.
DROP POLICY IF EXISTS anon_insert ON machines;
DROP POLICY IF EXISTS anon_insert ON inks;
DROP POLICY IF EXISTS anon_insert ON ink_batches;
DROP POLICY IF EXISTS anon_insert ON ink_receipts;
DROP POLICY IF EXISTS anon_insert ON consumables;
DROP POLICY IF EXISTS anon_insert ON consumable_receipts;
DROP POLICY IF EXISTS anon_insert ON projects;
DROP POLICY IF EXISTS anon_insert ON print_records;
REVOKE INSERT ON machines, inks, ink_batches, ink_receipts, consumables,
  consumable_receipts, projects, print_records FROM anon;

GRANT INSERT ON machines, inks, ink_batches, ink_receipts, consumables,
  consumable_receipts, projects, print_records TO authenticated;

CREATE POLICY authenticated_insert ON machines FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY authenticated_insert ON inks FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY authenticated_insert ON ink_batches FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY authenticated_insert ON ink_receipts FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY authenticated_insert ON consumables FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY authenticated_insert ON consumable_receipts FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY authenticated_insert ON projects FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY authenticated_insert ON print_records FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());

-- Issuing functions: now require login + admin/owner role too.
REVOKE EXECUTE ON FUNCTION issue_ink(BIGINT, NUMERIC, DATE) FROM anon;
REVOKE EXECUTE ON FUNCTION issue_consumable(BIGINT, NUMERIC, DATE) FROM anon;
GRANT EXECUTE ON FUNCTION issue_ink(BIGINT, NUMERIC, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION issue_consumable(BIGINT, NUMERIC, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION issue_ink(p_ink_id BIGINT, p_quantity NUMERIC, p_issue_date DATE)
RETURNS TABLE(batch_id BIGINT, quantity_allocated NUMERIC) AS $$
DECLARE
  v_machine_id BIGINT; v_unit TEXT; v_available NUMERIC;
  v_remaining NUMERIC := p_quantity; v_batch RECORD; v_take NUMERIC;
BEGIN
  IF NOT is_admin_or_owner() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero.'; END IF;

  SELECT machine_id, unit_of_measure INTO v_machine_id, v_unit FROM inks WHERE id = p_ink_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected ink was not found.'; END IF;

  SELECT COALESCE(SUM(remaining),0) INTO v_available FROM ink_batch_stock WHERE ink_id = p_ink_id;
  IF p_quantity > v_available THEN
    RAISE EXCEPTION 'Not enough stock. Requested %, but only % available.', p_quantity, v_available;
  END IF;

  FOR v_batch IN
    SELECT ibs.batch_id, ibs.remaining
    FROM ink_batch_stock ibs JOIN ink_batches b ON b.id = ibs.batch_id
    WHERE ibs.ink_id = p_ink_id AND ibs.remaining > 0
    ORDER BY b.received_date ASC, b.id ASC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_batch.remaining, v_remaining);
    INSERT INTO ink_issues (ink_id, batch_id, machine_id, quantity_issued, unit, issue_date)
    VALUES (p_ink_id, v_batch.batch_id, v_machine_id, v_take, v_unit, p_issue_date);
    v_remaining := v_remaining - v_take;
    batch_id := v_batch.batch_id; quantity_allocated := v_take;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION issue_consumable(p_consumable_id BIGINT, p_quantity NUMERIC, p_issue_date DATE)
RETURNS VOID AS $$
DECLARE v_machine_id BIGINT; v_unit TEXT; v_available NUMERIC;
BEGIN
  IF NOT is_admin_or_owner() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero.'; END IF;

  SELECT machine_id, unit_of_measure INTO v_machine_id, v_unit FROM consumables WHERE id = p_consumable_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Selected consumable was not found.'; END IF;

  SELECT current_stock INTO v_available FROM consumable_stock WHERE consumable_id = p_consumable_id;
  IF p_quantity > COALESCE(v_available,0) THEN
    RAISE EXCEPTION 'Not enough stock. Requested %, but only % available.', p_quantity, COALESCE(v_available,0);
  END IF;

  INSERT INTO consumable_issues (consumable_id, machine_id, quantity_issued, unit, issue_date)
  VALUES (p_consumable_id, v_machine_id, p_quantity, v_unit, p_issue_date);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT SELECT ON profiles TO authenticated;
