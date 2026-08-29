-- ============================================================
-- Phase Foundation 3: enable anon (browser) access.
-- Foundation 2 deliberately gave anon zero access, assuming a Node
-- backend using service_role. That backend is being removed, so the
-- browser now talks to Supabase directly with the anon key - these
-- policies replace that assumption. Still no user accounts: every
-- policy below is a blanket internal-tool policy, not per-user.
--
-- Design: plain SELECT/INSERT policies for direct reads/writes (used
-- for receiving, creating projects/records, etc). Issuing ink or
-- consumables goes through issue_ink()/issue_consumable() only (kept
-- SECURITY DEFINER, not a raw table grant) so the FIFO/stock-check
-- logic can't be bypassed by inserting into ink_issues/consumable_issues
-- directly - anon gets SELECT on those tables but no INSERT policy.
-- ============================================================

-- Run AFTER schema.sql and logic_and_security.sql.

GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;

-- Direct-write tables (no business rule to protect - simple inserts)
GRANT INSERT ON machines, inks, ink_batches, ink_receipts, consumables,
  consumable_receipts, projects, print_records, settings, system_log TO anon;

-- Table-level RLS policies (SELECT already granted above; add matching
-- policies since RLS is ON for every table from Foundation 2).
CREATE POLICY anon_select ON machines FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON inks FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON ink_batches FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON ink_receipts FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON ink_issues FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON on_machine_status FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON consumables FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON consumable_receipts FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON consumable_issues FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON projects FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON print_records FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON settings FOR SELECT TO anon USING (true);
CREATE POLICY anon_select ON system_log FOR SELECT TO anon USING (true);

CREATE POLICY anon_insert ON machines FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON inks FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON ink_batches FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON ink_receipts FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON consumables FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON consumable_receipts FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON projects FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON print_records FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON settings FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY anon_insert ON system_log FOR INSERT TO anon WITH CHECK (true);

-- Issuing stays function-only: run as SECURITY DEFINER so the FIFO/
-- stock-check logic executes with elevated rights, while anon still
-- has no direct INSERT policy on ink_issues/consumable_issues above.
ALTER FUNCTION issue_ink(BIGINT, NUMERIC, DATE) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION issue_consumable(BIGINT, NUMERIC, DATE) SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION issue_ink(BIGINT, NUMERIC, DATE) TO anon;
GRANT EXECUTE ON FUNCTION issue_consumable(BIGINT, NUMERIC, DATE) TO anon;
GRANT EXECUTE ON FUNCTION calculate_print_layout(NUMERIC, NUMERIC, NUMERIC, INTEGER, NUMERIC, NUMERIC) TO anon;

-- Views: grant SELECT directly (views run with the owner's underlying
-- table access, so no separate RLS policy is needed on the views).
GRANT SELECT ON ink_batch_stock, ink_stock, on_machine_ink_status, consumable_stock TO anon;
