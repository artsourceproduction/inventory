-- ============================================================
-- Machine Service Tickets - per-machine, same permission model as
-- machine_service_records (can_edit_machine_service()). Viewing stays
-- open to anyone logged in; creating/resolving requires that permission.
-- ============================================================

CREATE TABLE machine_service_tickets (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id    BIGINT NOT NULL REFERENCES machines(id),
    token_code    TEXT NOT NULL,
    sent_at       TIMESTAMPTZ NOT NULL,
    problem       TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (machine_id, token_code)
);

CREATE INDEX idx_machine_service_tickets_machine ON machine_service_tickets (machine_id);

ALTER TABLE machine_service_tickets ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON machine_service_tickets TO authenticated;

CREATE POLICY authenticated_select ON machine_service_tickets FOR SELECT TO authenticated USING (true);
CREATE POLICY authenticated_insert ON machine_service_tickets FOR INSERT TO authenticated WITH CHECK (can_edit_machine_service());
CREATE POLICY authenticated_update ON machine_service_tickets FOR UPDATE TO authenticated USING (can_edit_machine_service()) WITH CHECK (can_edit_machine_service());
