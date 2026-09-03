-- ============================================================
-- Machine Service History - table + read/write access.
-- (Supersedes the Part 2 draft shape - table was never deployed with
-- data, so redefined here with the full Part 3 field set.)
-- ============================================================

DROP TABLE IF EXISTS machine_service_records CASCADE;

CREATE TABLE machine_service_records (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id      BIGINT NOT NULL REFERENCES machines(id),
    description     TEXT NOT NULL,          -- service details
    replaced_parts  TEXT,                   -- optional, free text
    engineer_name   TEXT NOT NULL,          -- engineer who visited
    requested_at    TIMESTAMPTZ,            -- optional
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ended_at >= started_at)
);

CREATE INDEX idx_machine_service_records_machine ON machine_service_records (machine_id);

ALTER TABLE machine_service_records ENABLE ROW LEVEL SECURITY;

-- Matches current app-wide access (no login system right now): public
-- read, public write.
GRANT SELECT, INSERT ON machine_service_records TO anon;

CREATE POLICY anon_select ON machine_service_records FOR SELECT TO anon USING (true);
CREATE POLICY anon_insert ON machine_service_records FOR INSERT TO anon WITH CHECK (true);
