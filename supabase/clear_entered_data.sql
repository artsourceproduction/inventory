-- ============================================================
-- Owner-only "Clear" actions. Each deletes only entered transaction
-- data for its area - master/reference data (machines, ink colour
-- definitions) is never touched.
-- ============================================================

CREATE OR REPLACE FUNCTION clear_print_records() RETURNS VOID AS $$
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'Only the Owner can clear print records.'; END IF;
  DELETE FROM print_records;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Clears all ink transaction history (batches, receipts, issues) -
-- the fixed ink colour list per machine (Cyan/Magenta/etc, seeded by
-- the system, not entered by a user) is left untouched.
CREATE OR REPLACE FUNCTION clear_ink_records() RETURNS VOID AS $$
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'Only the Owner can clear ink records.'; END IF;
  DELETE FROM ink_issues;
  DELETE FROM on_machine_status;
  DELETE FROM ink_receipts;
  DELETE FROM ink_batches;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Consumables (unlike inks) are themselves free-typed/entered by
-- users, so the master rows are cleared too, along with their
-- transaction history.
CREATE OR REPLACE FUNCTION clear_consumable_records() RETURNS VOID AS $$
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'Only the Owner can clear consumable records.'; END IF;
  DELETE FROM consumable_issues;
  DELETE FROM consumable_receipts;
  DELETE FROM consumables;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION clear_print_records() TO authenticated;
GRANT EXECUTE ON FUNCTION clear_ink_records() TO authenticated;
GRANT EXECUTE ON FUNCTION clear_consumable_records() TO authenticated;
