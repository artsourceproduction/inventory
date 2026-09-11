-- ============================================================
-- Owner-only "Clear" functions. Each deletes only entered transaction
-- data, never touching machines/inks (fixed system reference data,
-- never user-entered). Consumables ARE cleared entirely since their
-- master rows are free-text, user-entered (unlike ink colours).
-- ============================================================

CREATE OR REPLACE FUNCTION clear_print_records() RETURNS VOID AS $$
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'Only the Owner can do this.'; END IF;
  DELETE FROM print_records WHERE true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION clear_ink_records() RETURNS VOID AS $$
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'Only the Owner can do this.'; END IF;
  DELETE FROM ink_issues WHERE true;
  DELETE FROM on_machine_status WHERE true;
  DELETE FROM ink_receipts WHERE true;
  DELETE FROM ink_batches WHERE true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION clear_consumable_records() RETURNS VOID AS $$
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'Only the Owner can do this.'; END IF;
  DELETE FROM consumable_issues WHERE true;
  DELETE FROM consumable_receipts WHERE true;
  DELETE FROM consumables WHERE true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION clear_print_records() TO authenticated;
GRANT EXECUTE ON FUNCTION clear_ink_records() TO authenticated;
GRANT EXECUTE ON FUNCTION clear_consumable_records() TO authenticated;

CREATE OR REPLACE FUNCTION clear_projects_history() RETURNS VOID AS $$
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'Only the Owner can do this.'; END IF;
  DELETE FROM print_records WHERE true;
  DELETE FROM projects WHERE true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Scoped to one machine, matching how the Machine Service History page
-- itself is always scoped to whichever machine is open.
CREATE OR REPLACE FUNCTION clear_machine_service_history(p_machine_id BIGINT) RETURNS VOID AS $$
BEGIN
  IF NOT is_owner() THEN RAISE EXCEPTION 'Only the Owner can do this.'; END IF;
  DELETE FROM machine_service_records WHERE machine_id = p_machine_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION clear_projects_history() TO authenticated;
GRANT EXECUTE ON FUNCTION clear_machine_service_history(BIGINT) TO authenticated;
