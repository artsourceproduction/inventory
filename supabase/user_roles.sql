-- ============================================================
-- User Management — Part 1: Roles & Access Structure
-- Structure only. No login UI yet, no gating of inventory/print
-- records/machine service/exports yet — those stay exactly as they
-- are until a later part explicitly wires enforcement into them.
-- ============================================================

CREATE TABLE profiles (
    id                          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email                       TEXT NOT NULL,
    role                        TEXT NOT NULL CHECK (role IN ('owner','admin','user')) DEFAULT 'user',

    -- Which Admin created/manages this person. NULL for the Owner and
    -- for Admins (Admins are managed directly by the Owner, not by
    -- another Admin). Set for a 'user' row to the Admin who created them.
    managed_by                  UUID REFERENCES profiles(id),

    -- Granular permissions, assignable per person by whoever manages
    -- them (Owner for Admins, Owner or the managing Admin for Users).
    -- The Owner always has full access regardless of these flags -
    -- enforced in the helper functions below, not by setting every
    -- flag true on the Owner's own row.
    can_manage_inventory        BOOLEAN NOT NULL DEFAULT FALSE,
    can_manage_print_records    BOOLEAN NOT NULL DEFAULT FALSE,
    can_manage_machine_service  BOOLEAN NOT NULL DEFAULT FALSE,

    must_change_password        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_managed_by ON profiles (managed_by);

-- ---- Helper functions (SECURITY DEFINER so profiles' own RLS below
-- doesn't recurse into itself when checking the caller's role) ----

CREATE OR REPLACE FUNCTION current_role_name() RETURNS TEXT AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_owner() RETURNS BOOLEAN AS $$
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'owner');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_admin_or_owner() RETURNS BOOLEAN AS $$
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('owner','admin'));
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- True if the caller is the Owner, or is the specific Admin who
-- manages the given user. Used later to scope an Admin's control to
-- only "Users under their management", per the spec.
CREATE OR REPLACE FUNCTION manages_profile(target_id UUID) RETURNS BOOLEAN AS $$
  SELECT is_owner() OR EXISTS(
    SELECT 1 FROM profiles WHERE id = target_id AND managed_by = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---- RLS on profiles itself ----

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Everyone can see their own row; Owner sees everyone; an Admin sees
-- the Users they manage (not other Admins, not the Owner).
CREATE POLICY profiles_select ON profiles
  FOR SELECT USING (auth.uid() = id OR is_owner() OR managed_by = auth.uid());

-- Self-service: a person can update their own row (used for the
-- must-change-password flow later).
CREATE POLICY profiles_update_self ON profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Owner: full control over every row (create/edit/remove Admins and
-- Users, assign permissions). Admin: full control only over rows
-- where managed_by = themselves (their own Users).
CREATE POLICY profiles_owner_manages_all ON profiles
  FOR ALL USING (is_owner()) WITH CHECK (is_owner());

CREATE POLICY profiles_admin_manages_own_users ON profiles
  FOR ALL USING (managed_by = auth.uid()) WITH CHECK (managed_by = auth.uid());

-- ---- Seed the Owner ----
-- Same account used before. Re-run safe: ON CONFLICT just re-affirms
-- the role if this is run again.
INSERT INTO profiles (id, email, role, must_change_password,
                       can_manage_inventory, can_manage_print_records, can_manage_machine_service)
SELECT id, email, 'owner', FALSE, TRUE, TRUE, TRUE
FROM auth.users
WHERE id = '37161e4e-f605-4931-b7d4-7e07e64fd866'
ON CONFLICT (id) DO UPDATE SET role = 'owner', must_change_password = FALSE;
