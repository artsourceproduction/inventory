-- ============================================================
-- Revert auth/roles: back to Foundation 3 state (anon can read + write
-- everything, no login required). Run this whole script once.
-- ============================================================

-- Restore the plain issue_ink / issue_consumable functions (no role check).
CREATE OR REPLACE FUNCTION issue_ink(p_ink_id BIGINT, p_quantity NUMERIC, p_issue_date DATE)
RETURNS TABLE(batch_id BIGINT, quantity_allocated NUMERIC) AS $$
DECLARE
  v_machine_id BIGINT; v_unit TEXT; v_available NUMERIC;
  v_remaining NUMERIC := p_quantity; v_batch RECORD; v_take NUMERIC;
BEGIN
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
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION issue_consumable(p_consumable_id BIGINT, p_quantity NUMERIC, p_issue_date DATE)
RETURNS VOID AS $$
DECLARE v_machine_id BIGINT; v_unit TEXT; v_available NUMERIC;
BEGIN
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
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION issue_ink(BIGINT, NUMERIC, DATE) TO anon;
GRANT EXECUTE ON FUNCTION issue_consumable(BIGINT, NUMERIC, DATE) TO anon;

-- Drop the authenticated-only insert policies.
DROP POLICY IF EXISTS authenticated_insert ON machines;
DROP POLICY IF EXISTS authenticated_insert ON inks;
DROP POLICY IF EXISTS authenticated_insert ON ink_batches;
DROP POLICY IF EXISTS authenticated_insert ON ink_receipts;
DROP POLICY IF EXISTS authenticated_insert ON consumables;
DROP POLICY IF EXISTS authenticated_insert ON consumable_receipts;
DROP POLICY IF EXISTS authenticated_insert ON projects;
DROP POLICY IF EXISTS authenticated_insert ON print_records;

-- Restore anon insert (Foundation 3 state).
GRANT INSERT ON machines, inks, ink_batches, ink_receipts, consumables,
  consumable_receipts, projects, print_records TO anon;

CREATE POLICY anon_insert ON machines FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON inks FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON ink_batches FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON ink_receipts FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON consumables FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON consumable_receipts FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON projects FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON print_records FOR INSERT TO anon WITH CHECK (true);

-- Remove the roles table and its helper functions entirely.
DROP TABLE IF EXISTS profiles CASCADE;
DROP FUNCTION IF EXISTS is_owner();
DROP FUNCTION IF EXISTS is_admin_or_owner();
