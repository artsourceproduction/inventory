-- ============================================================
-- Require login to view anything. Previously anon (no login) could
-- SELECT everything; now only authenticated users (any role,
-- including Viewer) can see data at all. Writing rules are unchanged -
-- this only affects reading/viewing.
-- ============================================================

-- Removes anon's blanket read access granted back in Foundation 3.
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM anon;

-- Any logged-in person (Owner, Admin, User, or Viewer) can view.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;

DROP POLICY IF EXISTS anon_select ON machines;
DROP POLICY IF EXISTS anon_select ON inks;
DROP POLICY IF EXISTS anon_select ON ink_batches;
DROP POLICY IF EXISTS anon_select ON ink_receipts;
DROP POLICY IF EXISTS anon_select ON ink_issues;
DROP POLICY IF EXISTS anon_select ON on_machine_status;
DROP POLICY IF EXISTS anon_select ON consumables;
DROP POLICY IF EXISTS anon_select ON consumable_receipts;
DROP POLICY IF EXISTS anon_select ON consumable_issues;
DROP POLICY IF EXISTS anon_select ON projects;
DROP POLICY IF EXISTS anon_select ON print_records;
DROP POLICY IF EXISTS anon_select ON machine_service_records;

CREATE POLICY authenticated_select ON machines FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON inks FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON ink_batches FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON ink_receipts FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON ink_issues FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON on_machine_status FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON consumables FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON consumable_receipts FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON consumable_issues FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON projects FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON print_records FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_select ON machine_service_records FOR SELECT TO authenticated USING (true);
