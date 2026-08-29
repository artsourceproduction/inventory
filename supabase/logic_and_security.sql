-- ============================================================
-- The Art Source Printing Department System
-- Supabase logic & security - Phase Foundation 2
-- Run AFTER supabase/schema.sql. Not wired to the app yet.
-- ============================================================

-- ---- Constraints (mirrors app-level validation) ----
ALTER TABLE ink_batches       ADD CONSTRAINT chk_ink_batches_qty       CHECK (initial_quantity > 0);
ALTER TABLE ink_receipts      ADD CONSTRAINT chk_ink_receipts_qty      CHECK (quantity_received > 0);
ALTER TABLE ink_issues        ADD CONSTRAINT chk_ink_issues_qty        CHECK (quantity_issued > 0);
ALTER TABLE consumable_receipts ADD CONSTRAINT chk_consumable_receipts_qty CHECK (quantity_received > 0);
ALTER TABLE consumable_issues   ADD CONSTRAINT chk_consumable_issues_qty   CHECK (quantity_issued > 0);
ALTER TABLE print_records ADD CONSTRAINT chk_print_records_qty    CHECK (quantity > 0);
ALTER TABLE print_records ADD CONSTRAINT chk_print_records_dims   CHECK (image_width > 0 AND image_height > 0 AND roll_width > 0 AND roll_length > 0);
ALTER TABLE print_records ADD CONSTRAINT chk_print_records_gap    CHECK (gap_mm >= 0);

-- Extra index for date-range filtering (Print Record List, Phase 3C/3D)
CREATE INDEX idx_print_records_printing_date ON print_records (printing_date);

-- ---- Views (read-side calculations) ----

-- Per-batch remaining stock + expiry status. expiry_status is NULL once
-- a batch is depleted, matching the app (Phase 2E/2C behaviour).
CREATE VIEW ink_batch_stock AS
SELECT
  b.id AS batch_id, b.ink_id, b.batch_number, b.received_date, b.expiry_date, b.unit,
  COALESCE(r.total,0) AS total_received,
  COALESCE(i.total,0) AS total_issued,
  COALESCE(r.total,0) - COALESCE(i.total,0) AS remaining,
  CASE
    WHEN COALESCE(r.total,0) - COALESCE(i.total,0) <= 0 THEN NULL
    WHEN b.expiry_date IS NULL THEN NULL
    WHEN b.expiry_date <= CURRENT_DATE THEN 'critical'
    WHEN b.expiry_date <= CURRENT_DATE + INTERVAL '1 month' THEN 'red'
    WHEN b.expiry_date <= CURRENT_DATE + INTERVAL '2 months' THEN 'yellow'
    ELSE 'normal'
  END AS expiry_status
FROM ink_batches b
LEFT JOIN (SELECT batch_id, SUM(quantity_received) total FROM ink_receipts GROUP BY batch_id) r ON r.batch_id = b.id
LEFT JOIN (SELECT batch_id, SUM(quantity_issued) total FROM ink_issues GROUP BY batch_id) i ON i.batch_id = b.id;

-- Per-ink totals + low-stock flag (< 2, Phase 2F rule)
CREATE VIEW ink_stock AS
SELECT ink_id, SUM(remaining) AS total_stock, (SUM(remaining) < 2) AS is_low_stock
FROM ink_batch_stock GROUP BY ink_id;

-- Last-issued date per ink (Phase 2G), never a stored/duplicable row
CREATE VIEW on_machine_ink_status AS
SELECT i.id AS ink_id, i.machine_id, i.color_name, MAX(ii.issue_date) AS last_issued_date
FROM inks i LEFT JOIN ink_issues ii ON ii.ink_id = i.id
WHERE i.is_active
GROUP BY i.id, i.machine_id, i.color_name;

-- Per-consumable stock + low-stock flag
CREATE VIEW consumable_stock AS
SELECT
  c.id AS consumable_id, c.machine_id, c.name, c.unit_of_measure,
  COALESCE(r.total,0) AS total_received,
  COALESCE(i.total,0) AS total_issued,
  COALESCE(r.total,0) - COALESCE(i.total,0) AS current_stock,
  (COALESCE(r.total,0) - COALESCE(i.total,0) < 2) AS is_low_stock
FROM consumables c
LEFT JOIN (SELECT consumable_id, SUM(quantity_received) total FROM consumable_receipts GROUP BY consumable_id) r ON r.consumable_id = c.id
LEFT JOIN (SELECT consumable_id, SUM(quantity_issued) total FROM consumable_issues GROUP BY consumable_id) i ON i.consumable_id = c.id
WHERE c.is_active;

-- ---- Functions (write-side logic) ----

-- FIFO ink issuing: allocates oldest batch(es) first, one ink_issues row
-- per batch touched, rejects (raises, nothing written) if requested
-- quantity exceeds total available. Atomic - a plpgsql function body is
-- one transaction, so a rejection mid-loop leaves nothing inserted.
CREATE OR REPLACE FUNCTION issue_ink(p_ink_id BIGINT, p_quantity NUMERIC, p_issue_date DATE)
RETURNS TABLE(batch_id BIGINT, quantity_allocated NUMERIC) AS $$
DECLARE
  v_machine_id BIGINT; v_unit TEXT; v_available NUMERIC;
  v_remaining NUMERIC := p_quantity; v_batch RECORD; v_take NUMERIC;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero.';
  END IF;

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

-- Consumable issuing: no batches, same reject-if-insufficient rule.
CREATE OR REPLACE FUNCTION issue_consumable(p_consumable_id BIGINT, p_quantity NUMERIC, p_issue_date DATE)
RETURNS VOID AS $$
DECLARE v_machine_id BIGINT; v_unit TEXT; v_available NUMERIC;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero.';
  END IF;

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

-- Roll layout calculation (Phase 4B rule, ported as-is: compares FULL
-- print length for normal vs rotated, picks the shorter one - not
-- simply whichever orientation fits more per row).
CREATE OR REPLACE FUNCTION calculate_print_layout(
  p_image_width_cm NUMERIC, p_image_height_cm NUMERIC, p_gap_mm NUMERIC,
  p_quantity INTEGER, p_roll_width_m NUMERIC, p_roll_length_m NUMERIC
) RETURNS TABLE(
  effective_width_mm NUMERIC, effective_height_mm NUMERIC, orientation TEXT,
  images_per_row INTEGER, rows_required INTEGER,
  calculated_print_length NUMERIC, calculated_rolls NUMERIC
) AS $$
DECLARE
  v_eff_w NUMERIC := (p_image_width_cm * 10) + 2*p_gap_mm;
  v_eff_h NUMERIC := (p_image_height_cm * 10) + 2*p_gap_mm;
  v_roll_w_mm NUMERIC := p_roll_width_m * 1000;
  v_per_row_normal INTEGER := FLOOR(v_roll_w_mm / v_eff_w);
  v_per_row_rotated INTEGER := FLOOR(v_roll_w_mm / v_eff_h);
  v_rows_normal INTEGER; v_rows_rotated INTEGER;
  v_len_normal NUMERIC; v_len_rotated NUMERIC;
BEGIN
  IF v_per_row_normal <= 0 AND v_per_row_rotated <= 0 THEN
    RAISE EXCEPTION 'This image does not fit within the roll width, even rotated.';
  END IF;

  IF v_per_row_normal > 0 THEN
    v_rows_normal := CEIL(p_quantity::NUMERIC / v_per_row_normal);
    v_len_normal := v_rows_normal * v_eff_h;
  END IF;
  IF v_per_row_rotated > 0 THEN
    v_rows_rotated := CEIL(p_quantity::NUMERIC / v_per_row_rotated);
    v_len_rotated := v_rows_rotated * v_eff_w;
  END IF;

  IF v_per_row_normal > 0 AND (v_per_row_rotated <= 0 OR v_len_normal <= v_len_rotated) THEN
    orientation := 'normal'; images_per_row := v_per_row_normal;
    rows_required := v_rows_normal; calculated_print_length := v_len_normal / 1000;
  ELSE
    orientation := 'rotated'; images_per_row := v_per_row_rotated;
    rows_required := v_rows_rotated; calculated_print_length := v_len_rotated / 1000;
  END IF;

  effective_width_mm := v_eff_w; effective_height_mm := v_eff_h;
  calculated_rolls := CEIL(calculated_print_length / p_roll_length_m);
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- Auto-fills the calculation columns on every print_records insert -
-- aborts the insert (nothing saved) if the image can't fit, matching
-- the app's POST /print-records behaviour.
CREATE OR REPLACE FUNCTION trg_print_records_calculate() RETURNS TRIGGER AS $$
DECLARE v_calc RECORD;
BEGIN
  SELECT * INTO v_calc FROM calculate_print_layout(
    NEW.image_width, NEW.image_height, NEW.gap_mm, NEW.quantity, NEW.roll_width, NEW.roll_length
  );
  NEW.effective_width_mm := v_calc.effective_width_mm;
  NEW.effective_height_mm := v_calc.effective_height_mm;
  NEW.orientation := v_calc.orientation;
  NEW.images_per_row := v_calc.images_per_row;
  NEW.rows_required := v_calc.rows_required;
  NEW.calculated_print_length := v_calc.calculated_print_length;
  NEW.calculated_rolls := v_calc.calculated_rolls;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER print_records_before_insert
BEFORE INSERT ON print_records
FOR EACH ROW EXECUTE FUNCTION trg_print_records_calculate();

-- ---- Row Level Security ----
-- No user accounts exist or are being added. The eventual backend will
-- connect using the service_role key (kept server-side only, never
-- exposed to any frontend/browser/git) - service_role always bypasses
-- RLS regardless of policy. Enabling RLS with NO policies means the
-- public anon key (the only key ever safe to expose) gets zero access
-- to every table by default. This is the correct, secure state for an
-- authless internal tool: nothing is reachable except server-side.
ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ink_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ink_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ink_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE on_machine_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumables ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumable_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumable_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_log ENABLE ROW LEVEL SECURITY;
