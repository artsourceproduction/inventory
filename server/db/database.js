// database.js
// Handles SQLite connection, folder creation, and schema initialization.
// Uses Node's built-in node:sqlite (DatabaseSync) - no native compilation,
// no node-gyp, no Visual Studio Build Tools required. Requires Node 22.5+;
// stable without a flag from Node 23.4+ / all of Node 26.

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'printing_system.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure the data folder exists before SQLite tries to open a file in it.
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Sensible defaults for a single-machine, always-on desktop app.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Phase 2H made consumables machine-specific (added a required machine_id
// column). Older installs may already have an empty consumables table from
// before that; since it's never held real data, it's safe to drop it here
// so schema.sql's CREATE TABLE (below) can recreate it with the new shape.
function migrateConsumablesTable() {
  const cols = db.prepare("PRAGMA table_info(consumables)").all();
  if (cols.length === 0) return; // table doesn't exist yet - nothing to migrate
  if (cols.some((c) => c.name === 'machine_id')) return; // already migrated

  const rowCount = db.prepare('SELECT COUNT(*) AS c FROM consumables').get().c;
  if (rowCount > 0) {
    console.warn('consumables table has existing rows without machine_id - skipped automatic migration.');
    return;
  }
  db.exec('DROP TABLE consumables');
}

// Phase 4B added several calculation columns to print_records. Unlike the
// consumables migration, these are all nullable additions - safe to add
// with ALTER TABLE without touching any existing rows (older records
// simply keep NULL for these, same as calculated_rolls already did).
function migratePrintRecordsTable() {
  const cols = db.prepare("PRAGMA table_info(print_records)").all();
  if (cols.length === 0) return; // table doesn't exist yet - schema.sql will create it fresh
  const existing = new Set(cols.map((c) => c.name));

  const newColumns = [
    ['gap_mm', 'REAL'],
    ['effective_width_mm', 'REAL'],
    ['effective_height_mm', 'REAL'],
    ['orientation', 'TEXT'],
    ['images_per_row', 'INTEGER'],
    ['rows_required', 'INTEGER'],
    ['calculated_print_length', 'REAL'],
  ];

  for (const [name, type] of newColumns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE print_records ADD COLUMN ${name} ${type}`);
    }
  }
}

function initializeSchema() {
  migrateConsumablesTable();

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  migratePrintRecordsTable();

  // Seed default settings once, if not already present.
  const settingsCount = db.prepare('SELECT COUNT(*) AS count FROM settings').get().count;
  if (settingsCount === 0) {
    const insertSetting = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?)'
    );
    const defaults = [
      ['company_name', 'The Art Source - Printing Department'],
      ['app_version', '0.1.0-phase1'],
    ];
    db.exec('BEGIN');
    try {
      for (const [key, value] of defaults) insertSetting.run(key, value);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  seedMachinesAndInks();
}

// Seeds the two known production machines and their ink colours once.
// This is fixed master data (not user-entered inventory), so it's safe
// to seed here the same way default settings are seeded above.
function seedMachinesAndInks() {
  const machineCount = db.prepare('SELECT COUNT(*) AS count FROM machines').get().count;
  if (machineCount > 0) return;

  const insertMachine = db.prepare(
    'INSERT INTO machines (name, code) VALUES (?, ?)'
  );
  const insertInk = db.prepare(
    'INSERT INTO inks (machine_id, color_name, color_code) VALUES (?, ?, ?)'
  );

  const MACHINES = [
    {
      name: 'Canon Colorado M5W',
      code: 'COLORADO',
      colors: [
        ['Cyan', 'C'],
        ['Magenta', 'M'],
        ['Yellow', 'Y'],
        ['Black', 'K'],
        ['White', 'W'],
      ],
    },
    {
      name: 'Mimaki UCJV 330-160',
      code: 'MIMAKI',
      colors: [
        ['Cyan', 'C'],
        ['Magenta', 'M'],
        ['Yellow', 'Y'],
        ['Black', 'K'],
        ['Light Cyan', 'LC'],
        ['Light Magenta', 'LM'],
        ['White', 'W'],
      ],
    },
  ];

  db.exec('BEGIN');
  try {
    for (const machine of MACHINES) {
      const result = insertMachine.run(machine.name, machine.code);
      const machineId = Number(result.lastInsertRowid);
      for (const [colorName, colorCode] of machine.colors) {
        insertInk.run(machineId, colorName, colorCode);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function logSystemStart() {
  db.prepare('INSERT INTO system_log (event, created_at) VALUES (?, datetime(\'now\', \'localtime\'))')
    .run('server_start');
}

function getDbPath() {
  return DB_PATH;
}

module.exports = {
  db,
  initializeSchema,
  logSystemStart,
  getDbPath,
};
