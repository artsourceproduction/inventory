-- schema.sql
-- Phase 1: foundation tables only.
-- Print Records, Inventory, and Reports tables will be added in later phases.

-- Key/value store for app configuration (used by Settings module later).
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Records every time the local server starts.
-- This exists in Phase 1 specifically so we can prove the database
-- persists data across restarts (see the "Last started" list on the dashboard).
CREATE TABLE IF NOT EXISTS system_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);


-- ============================================================
-- Phase 2A — Inventory module: database structure only.
-- No UI, no stock-calculation logic, no reports yet.
--
-- Design notes:
--   - Master data (machines, inks, consumables) uses is_active flags
--     instead of deletes, so historical transactions always stay
--     linked to something meaningful.
--   - Receipts, issues, and batches are never updated in place or
--     deleted by the app - they are a permanent transaction log.
--     Foreign keys default to NO ACTION in SQLite, which blocks
--     deleting a parent row (e.g. an ink) while history references it.
--   - FIFO issuing and stock-on-hand are computed from this history
--     in a later phase; this phase only stores the raw facts.
-- ============================================================

-- Physical machines that consume ink and consumables.
CREATE TABLE IF NOT EXISTS machines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,      -- e.g. 'Canon Colorado M5W'
    code        TEXT NOT NULL UNIQUE,      -- short code, e.g. 'COLORADO'
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- One row per ink colour available on a given machine.
-- (Different machines can both have e.g. "Cyan" - each gets its own row,
-- since they are physically different ink products.)
CREATE TABLE IF NOT EXISTS inks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id        INTEGER NOT NULL REFERENCES machines(id),
    color_name        TEXT NOT NULL,       -- e.g. 'Cyan', 'Light Magenta'
    color_code        TEXT,                -- short code, e.g. 'C', 'LM'
    unit_of_measure   TEXT NOT NULL DEFAULT 'L',
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (machine_id, color_name)
);

-- A physical batch/lot of a given ink, as received from the supplier.
-- Enables batch tracking, expiry dates, and FIFO issuing (issues always
-- reference the specific batch they were drawn from).
CREATE TABLE IF NOT EXISTS ink_batches (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ink_id              INTEGER NOT NULL REFERENCES inks(id),
    batch_number        TEXT NOT NULL,          -- supplier batch/lot code
    manufacture_date    TEXT,
    expiry_date         TEXT,
    received_date       TEXT NOT NULL,
    initial_quantity    REAL NOT NULL,           -- quantity at receipt, this batch
    unit                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',  -- active / depleted / expired
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (ink_id, batch_number)
);

-- Every time ink stock is received (permanent log).
-- Normally one receipt creates one batch, but the tables are kept
-- separate so a batch can also be topped up by a later receipt.
CREATE TABLE IF NOT EXISTS ink_receipts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ink_id              INTEGER NOT NULL REFERENCES inks(id),
    batch_id            INTEGER NOT NULL REFERENCES ink_batches(id),
    quantity_received   REAL NOT NULL,
    unit                TEXT NOT NULL,
    receipt_date        TEXT NOT NULL,
    supplier            TEXT,
    invoice_reference   TEXT,
    received_by         TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Every time ink stock is issued out of a batch (permanent log).
-- batch_id is what makes FIFO possible - each issue is tied to the
-- exact batch it was drawn from.
CREATE TABLE IF NOT EXISTS ink_issues (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ink_id              INTEGER NOT NULL REFERENCES inks(id),
    batch_id            INTEGER NOT NULL REFERENCES ink_batches(id),
    machine_id          INTEGER NOT NULL REFERENCES machines(id),
    quantity_issued     REAL NOT NULL,
    unit                TEXT NOT NULL,
    issue_date          TEXT NOT NULL,
    issued_to           TEXT,               -- operator/technician name
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Current state of what's loaded on each machine, per ink colour.
-- One row per (machine, ink) pair - this is what "last issued /
-- on-machine date" reporting will read from.
CREATE TABLE IF NOT EXISTS on_machine_status (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id          INTEGER NOT NULL REFERENCES machines(id),
    ink_id              INTEGER NOT NULL REFERENCES inks(id),
    current_batch_id    INTEGER REFERENCES ink_batches(id),
    loaded_date         TEXT,               -- date current_batch_id was loaded
    last_issued_date    TEXT,               -- most recent issue date for this slot
    updated_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (machine_id, ink_id)
);

-- Non-ink consumables (media, laminate, blades, cleaning supplies, etc.).
-- Consumables are machine-specific: the same name can exist independently
-- for Canon and Mimaki (they are different physical stock).
CREATE TABLE IF NOT EXISTS consumables (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id        INTEGER NOT NULL REFERENCES machines(id),
    name              TEXT NOT NULL,
    category          TEXT,               -- e.g. 'Media', 'Laminate', 'Cleaning'
    sku               TEXT,
    unit_of_measure   TEXT NOT NULL DEFAULT 'pcs',
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (machine_id, name)
);

-- Every time consumable stock is received (permanent log).
CREATE TABLE IF NOT EXISTS consumable_receipts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    consumable_id       INTEGER NOT NULL REFERENCES consumables(id),
    quantity_received   REAL NOT NULL,
    unit                TEXT NOT NULL,
    receipt_date        TEXT NOT NULL,
    supplier            TEXT,
    invoice_reference   TEXT,
    received_by         TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Every time consumable stock is issued (permanent log).
-- machine_id is nullable since not every consumable is tied to one machine.
CREATE TABLE IF NOT EXISTS consumable_issues (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    consumable_id       INTEGER NOT NULL REFERENCES consumables(id),
    machine_id          INTEGER REFERENCES machines(id),
    quantity_issued     REAL NOT NULL,
    unit                TEXT NOT NULL,
    issue_date          TEXT NOT NULL,
    issued_to           TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Indexes to keep batch/history lookups fast as transaction tables grow.
CREATE INDEX IF NOT EXISTS idx_inks_machine ON inks (machine_id);
CREATE INDEX IF NOT EXISTS idx_ink_batches_ink ON ink_batches (ink_id);
CREATE INDEX IF NOT EXISTS idx_ink_batches_expiry ON ink_batches (expiry_date);
CREATE INDEX IF NOT EXISTS idx_ink_receipts_ink ON ink_receipts (ink_id);
CREATE INDEX IF NOT EXISTS idx_ink_receipts_batch ON ink_receipts (batch_id);
CREATE INDEX IF NOT EXISTS idx_ink_issues_ink ON ink_issues (ink_id);
CREATE INDEX IF NOT EXISTS idx_ink_issues_batch ON ink_issues (batch_id);
CREATE INDEX IF NOT EXISTS idx_ink_issues_machine ON ink_issues (machine_id);
CREATE INDEX IF NOT EXISTS idx_on_machine_status_machine ON on_machine_status (machine_id);
CREATE INDEX IF NOT EXISTS idx_consumable_receipts_consumable ON consumable_receipts (consumable_id);
CREATE INDEX IF NOT EXISTS idx_consumable_issues_consumable ON consumable_issues (consumable_id);
CREATE INDEX IF NOT EXISTS idx_consumables_machine ON consumables (machine_id);


-- ============================================================
-- Phase 3A — Print Records: database structure only.
-- No UI, no calculations, no reports yet.
--
-- A project can span multiple machines - each print job records its
-- own machine_id, so a project is never permanently tied to one
-- machine (see print_records.machine_id below).
-- ============================================================

-- A client project. Print jobs belong to a project; the project itself
-- is not tied to a machine - individual jobs are.
CREATE TABLE IF NOT EXISTS projects (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,       -- Project Name
    client_name   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- One row per print job. machine_id is set per job (not inherited from
-- the project), so the same project can have jobs on Canon and Mimaki.
CREATE TABLE IF NOT EXISTS print_records (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id            INTEGER NOT NULL REFERENCES projects(id),
    machine_id            INTEGER NOT NULL REFERENCES machines(id),
    image_name            TEXT NOT NULL,
    media                 TEXT,
    image_width           REAL,
    image_height          REAL,
    quantity              INTEGER,
    roll_width            REAL,
    roll_length           REAL,
    gap_mm                REAL,             -- user-entered spacing (Phase 4B)
    effective_width_mm    REAL,             -- image_width + 2*gap, in mm
    effective_height_mm   REAL,             -- image_height + 2*gap, in mm
    orientation           TEXT,             -- 'normal' or 'rotated' - whichever produced the shorter print length
    images_per_row        INTEGER,
    rows_required         INTEGER,
    calculated_print_length REAL,           -- metres
    calculated_rolls      REAL,
    printing_date     TEXT,             -- production date (user-entered)
    printing_time     TEXT,             -- production time (user-entered)
    created_at        TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))  -- actual record-creation timestamp, automatic
);

CREATE INDEX IF NOT EXISTS idx_print_records_project ON print_records (project_id);
CREATE INDEX IF NOT EXISTS idx_print_records_machine ON print_records (machine_id);
