-- ============================================================
-- The Art Source Printing Department System
-- Supabase (Postgres) schema foundation - Phase Foundation 1
--
-- Mirrors server/db/schema.sql (SQLite) 1:1. NOT wired to the app.
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- machines
CREATE TABLE machines (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    code        TEXT NOT NULL UNIQUE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- inks (one row per machine + colour)
CREATE TABLE inks (
    id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id        BIGINT NOT NULL REFERENCES machines(id),
    color_name        TEXT NOT NULL,
    color_code        TEXT,
    unit_of_measure   TEXT NOT NULL DEFAULT 'L',
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (machine_id, color_name)
);

-- ink_batches
CREATE TABLE ink_batches (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ink_id              BIGINT NOT NULL REFERENCES inks(id),
    batch_number        TEXT NOT NULL,
    manufacture_date    DATE,
    expiry_date         DATE,
    received_date       DATE NOT NULL,
    initial_quantity    NUMERIC NOT NULL,
    unit                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ink_id, batch_number)
);

-- ink_receipts
CREATE TABLE ink_receipts (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ink_id              BIGINT NOT NULL REFERENCES inks(id),
    batch_id            BIGINT NOT NULL REFERENCES ink_batches(id),
    quantity_received   NUMERIC NOT NULL,
    unit                TEXT NOT NULL,
    receipt_date        DATE NOT NULL,
    supplier            TEXT,
    invoice_reference   TEXT,
    received_by         TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ink_issues
CREATE TABLE ink_issues (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ink_id              BIGINT NOT NULL REFERENCES inks(id),
    batch_id            BIGINT NOT NULL REFERENCES ink_batches(id),
    machine_id          BIGINT NOT NULL REFERENCES machines(id),
    quantity_issued     NUMERIC NOT NULL,
    unit                TEXT NOT NULL,
    issue_date          DATE NOT NULL,
    issued_to           TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- on_machine_status (present in current schema; app doesn't write to it yet)
CREATE TABLE on_machine_status (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id          BIGINT NOT NULL REFERENCES machines(id),
    ink_id              BIGINT NOT NULL REFERENCES inks(id),
    current_batch_id    BIGINT REFERENCES ink_batches(id),
    loaded_date         DATE,
    last_issued_date    DATE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (machine_id, ink_id)
);

-- consumables (machine-specific, per Phase 2H)
CREATE TABLE consumables (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id        BIGINT NOT NULL REFERENCES machines(id),
    name              TEXT NOT NULL,
    category          TEXT,
    sku               TEXT,
    unit_of_measure   TEXT NOT NULL DEFAULT 'pcs',
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (machine_id, name)
);

-- consumable_receipts
CREATE TABLE consumable_receipts (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    consumable_id       BIGINT NOT NULL REFERENCES consumables(id),
    quantity_received   NUMERIC NOT NULL,
    unit                TEXT NOT NULL,
    receipt_date        DATE NOT NULL,
    supplier            TEXT,
    invoice_reference   TEXT,
    received_by         TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- consumable_issues
CREATE TABLE consumable_issues (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    consumable_id       BIGINT NOT NULL REFERENCES consumables(id),
    machine_id          BIGINT REFERENCES machines(id),
    quantity_issued     NUMERIC NOT NULL,
    unit                TEXT NOT NULL,
    issue_date          DATE NOT NULL,
    issued_to           TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- projects (client_name lives here - no separate clients table today)
CREATE TABLE projects (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL,
    client_name   TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- print_records (media + roll-calculation fields live here - no separate tables today)
CREATE TABLE print_records (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id                BIGINT NOT NULL REFERENCES projects(id),
    machine_id                BIGINT NOT NULL REFERENCES machines(id),
    image_name                TEXT NOT NULL,
    media                     TEXT,
    image_width               NUMERIC,   -- cm
    image_height               NUMERIC,   -- cm
    quantity                  INTEGER,
    roll_width                NUMERIC,   -- m
    roll_length                NUMERIC,   -- m
    gap_mm                    NUMERIC,
    effective_width_mm        NUMERIC,
    effective_height_mm       NUMERIC,
    orientation                TEXT,       -- 'normal' | 'rotated'
    images_per_row             INTEGER,
    rows_required               INTEGER,
    calculated_print_length    NUMERIC,   -- m
    calculated_rolls           NUMERIC,
    printing_date               DATE,
    printing_time               TIME,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- settings (key/value)
CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- system_log (server-start log; parity with local app)
CREATE TABLE system_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes (mirroring the SQLite ones)
CREATE INDEX idx_inks_machine ON inks (machine_id);
CREATE INDEX idx_ink_batches_ink ON ink_batches (ink_id);
CREATE INDEX idx_ink_batches_expiry ON ink_batches (expiry_date);
CREATE INDEX idx_ink_receipts_ink ON ink_receipts (ink_id);
CREATE INDEX idx_ink_receipts_batch ON ink_receipts (batch_id);
CREATE INDEX idx_ink_issues_ink ON ink_issues (ink_id);
CREATE INDEX idx_ink_issues_batch ON ink_issues (batch_id);
CREATE INDEX idx_ink_issues_machine ON ink_issues (machine_id);
CREATE INDEX idx_on_machine_status_machine ON on_machine_status (machine_id);
CREATE INDEX idx_consumable_receipts_consumable ON consumable_receipts (consumable_id);
CREATE INDEX idx_consumable_issues_consumable ON consumable_issues (consumable_id);
CREATE INDEX idx_consumables_machine ON consumables (machine_id);
CREATE INDEX idx_print_records_project ON print_records (project_id);
CREATE INDEX idx_print_records_machine ON print_records (machine_id);

-- Seed data (matches what the local app auto-seeds on first run)
INSERT INTO machines (name, code) VALUES
    ('Canon Colorado M5W', 'COLORADO'),
    ('Mimaki UCJV 330-160', 'MIMAKI');

INSERT INTO inks (machine_id, color_name, color_code)
SELECT id, c.color_name, c.color_code
FROM machines, (VALUES
    ('Cyan','C'), ('Magenta','M'), ('Yellow','Y'), ('Black','K'), ('White','W')
) AS c(color_name, color_code)
WHERE machines.code = 'COLORADO';

INSERT INTO inks (machine_id, color_name, color_code)
SELECT id, c.color_name, c.color_code
FROM machines, (VALUES
    ('Cyan','C'), ('Magenta','M'), ('Yellow','Y'), ('Black','K'),
    ('Light Cyan','LC'), ('Light Magenta','LM'), ('White','W')
) AS c(color_name, color_code)
WHERE machines.code = 'MIMAKI';

INSERT INTO settings (key, value) VALUES
    ('company_name', 'The Art Source - Printing Department'),
    ('app_version', '0.1.0-phase1');

-- NOTE: Row Level Security is off by default in this script. The current
-- app has no authentication, so RLS policies need to be decided when the
-- backend is actually migrated (out of scope for this phase).
