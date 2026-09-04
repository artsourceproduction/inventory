-- ============================================================
-- User Management — Part 2: Users, Viewers, and real access
-- restrictions on the existing data tables.
--
-- Viewing (SELECT) is left exactly as it is today - unchanged, still
-- open - per "do not change existing application features". What
-- changes here is WRITING: creating/editing inventory, print records,
-- and machine service entries now requires being logged in with the
-- right role/permission. Nothing about the data itself, or how it's
-- currently viewed, is touched.
-- ============================================================

-- ---- Allow the 4th role ----
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('owner','admin','user','viewer'));

-- ---- Permission helpers ----
-- A Viewer NEVER qualifies here, regardless of any flags on their row -
-- "Viewer cannot create, modify, or manage inventory" is absolute.
-- A User's edit ability depends on their assigned permission flag.
CREATE OR REPLACE FUNCTION can_edit_inventory() RETURNS BOOLEAN AS $$
  SELECT role IN ('owner','admin') OR (role = 'user' AND can_manage_inventory)
  FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION can_edit_print_records() RETURNS BOOLEAN AS $$
  SELECT role IN ('owner','admin') OR (role = 'user' AND can_manage_print_records)
  FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION can_edit_machine_service() RETURNS BOOLEAN AS $$
  SELECT role IN ('owner','admin') OR (role = 'user' AND can_manage_machine_service)
  FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---- Inventory tables: restrict writes, leave reads untouched ----
DROP POLICY IF EXISTS anon_insert ON machines;
DROP POLICY IF EXISTS anon_insert ON inks;
DROP POLICY IF EXISTS anon_insert ON ink_batches;
DROP POLICY IF EXISTS anon_insert ON ink_receipts;
DROP POLICY IF EXISTS anon_insert ON consumables;
DROP POLICY IF EXISTS anon_insert ON consumable_receipts;
REVOKE INSERT ON machines, inks, ink_batches, ink_receipts, consumables, consumable_receipts FROM anon;
GRANT INSERT ON machines, inks, ink_batches, ink_receipts, consumables, consumable_receipts TO authenticated;

CREATE POLICY authenticated_insert ON machines FOR INSERT TO authenticated WITH CHECK (can_edit_inventory());
CREATE POLICY authenticated_insert ON inks FOR INSERT TO authenticated WITH CHECK (can_edit_inventory());
CREATE POLICY authenticated_insert ON ink_batches FOR INSERT TO authenticated WITH CHECK (can_edit_inventory());
CREATE POLICY authenticated_insert ON ink_receipts FOR INSERT TO authenticated WITH CHECK (can_edit_inventory());
CREATE POLICY authenticated_insert ON consumables FOR INSERT TO authenticated WITH CHECK (can_edit_inventory());
CREATE POLICY authenticated_insert ON consumable_receipts FOR INSERT TO authenticated WITH CHECK (can_edit_inventory());

-- Issuing goes through these functions, not raw INSERT - add the same
-- check inside them (logic otherwise unchanged from before).
CREATE OR REPLACE FUNCTION issue_ink(p_ink_id BIGINT, p_quantity NUMERIC, p_issue_date DATE)
RETURNS TABLE(batch_id BIGINT, quantity_allocated NUMERIC) AS $$
DECLARE
  v_machine_id BIGINT; v_unit TEXT; v_available NUMERIC;
  v_remaining NUMERIC := p_quantity; v_batch RECORD; v_take NUMERIC;
BEGIN
  IF NOT can_edit_inventory() THEN RAISE EXCEPTION 'Not authorized to issue inventory.'; END IF;
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
  IF NOT can_edit_inventory() THEN RAISE EXCEPTION 'Not authorized to issue inventory.'; END IF;
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

REVOKE EXECUTE ON FUNCTION issue_ink(BIGINT, NUMERIC, DATE) FROM anon;
REVOKE EXECUTE ON FUNCTION issue_consumable(BIGINT, NUMERIC, DATE) FROM anon;
GRANT EXECUTE ON FUNCTION issue_ink(BIGINT, NUMERIC, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION issue_consumable(BIGINT, NUMERIC, DATE) TO authenticated;

-- ---- Print records: restrict writes, leave reads untouched ----
DROP POLICY IF EXISTS anon_insert ON projects;
DROP POLICY IF EXISTS anon_insert ON print_records;
REVOKE INSERT ON projects, print_records FROM anon;
GRANT INSERT ON projects, print_records TO authenticated;

CREATE POLICY authenticated_insert ON projects FOR INSERT TO authenticated WITH CHECK (can_edit_print_records());
CREATE POLICY authenticated_insert ON print_records FOR INSERT TO authenticated WITH CHECK (can_edit_print_records());

-- ---- Machine service records: restrict writes, leave reads untouched ----
DROP POLICY IF EXISTS anon_insert ON machine_service_records;
REVOKE INSERT ON machine_service_records FROM anon;
GRANT INSERT ON machine_service_records TO authenticated;

CREATE POLICY authenticated_insert ON machine_service_records
  FOR INSERT TO authenticated WITH CHECK (can_edit_machine_service());
