// inventory.js
// Phase 2B: Ink Receiving.
// Phase 2C: Current Stock calculation (Total Received - Total Issued).
// Phase 2D: Ink Issuing, using FIFO batch consumption.
//
// Reports and any UI beyond this module are NOT part of this file.

const express = require('express');
const { db } = require('../db/database');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  // Day 0 of next month = last real day of this month. Built from plain
  // numeric components (no string/ISO round-trip), so this is never
  // affected by the server's timezone offset.
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return false;
  return true;
}

function todayLocalDate() {
  return db.prepare("SELECT date('now', 'localtime') AS d").get().d;
}

// Phase 2E: expiry status for one batch, using today's actual date every
// time this is called (never cached/stored). Only meaningful for batches
// that still have stock - a fully-issued batch isn't "available" expiry
// stock, so it gets no status at all.
//   critical - expiry date has already passed (or is today)
//   red      - expires within 1 month from today
//   yellow   - expires within 2 months from today (but not within 1)
//   normal   - expires more than 2 months from today
function getExpiryStatus(expiryDate, remaining) {
  if (remaining <= 0 || !expiryDate) return null;

  const today = new Date(todayLocalDate() + 'T00:00:00');
  const expiry = new Date(expiryDate + 'T00:00:00');

  const oneMonthOut = new Date(today);
  oneMonthOut.setMonth(oneMonthOut.getMonth() + 1);
  const twoMonthsOut = new Date(today);
  twoMonthsOut.setMonth(twoMonthsOut.getMonth() + 2);

  if (expiry <= today) return 'critical';
  if (expiry <= oneMonthOut) return 'red';
  if (expiry <= twoMonthsOut) return 'yellow';
  return 'normal';
}

// Every batch for one ink, oldest received first (FIFO order), with its
// remaining quantity derived as Total Received - Total Issued for that
// batch. Shared by the stock calculation (2C), the issuing logic (2D),
// and expiry tracking (2E) so all three always agree on what's actually
// available. Prepared lazily (not at module load) since this file is
// required before the schema has been created.
function getBatchesForInk(inkId) {
  const stmt = db.prepare(`
    SELECT
      b.id AS batch_id,
      b.batch_number,
      b.received_date,
      b.expiry_date,
      b.unit,
      COALESCE(recv.total, 0) AS total_received,
      COALESCE(iss.total, 0) AS total_issued,
      COALESCE(recv.total, 0) - COALESCE(iss.total, 0) AS remaining
    FROM ink_batches b
    LEFT JOIN (
      SELECT batch_id, SUM(quantity_received) AS total
      FROM ink_receipts GROUP BY batch_id
    ) recv ON recv.batch_id = b.id
    LEFT JOIN (
      SELECT batch_id, SUM(quantity_issued) AS total
      FROM ink_issues GROUP BY batch_id
    ) iss ON iss.batch_id = b.id
    WHERE b.ink_id = ?
    ORDER BY b.received_date ASC, b.id ASC
  `);
  return stmt.all(inkId).map((b) => ({
    ...b,
    status: b.remaining <= 0 ? 'depleted' : 'active',
    expiry_status: getExpiryStatus(b.expiry_date, b.remaining),
  }));
}

function getInk(inkId) {
  return db
    .prepare('SELECT id, machine_id, color_name, color_code, unit_of_measure FROM inks WHERE id = ? AND is_active = 1')
    .get(inkId);
}

// GET /api/inventory/machines
// Returns each machine with its list of active inks, for the receiving form.
router.get('/machines', (req, res) => {
  try {
    const machines = db
      .prepare('SELECT id, name, code FROM machines WHERE is_active = 1 ORDER BY id')
      .all();

    const inkStmt = db.prepare(
      `SELECT id, color_name, color_code, unit_of_measure
       FROM inks
       WHERE machine_id = ? AND is_active = 1
       ORDER BY id`
    );

    const result = machines.map((m) => ({
      ...m,
      inks: inkStmt.all(m.id),
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /machines error:', err);
    res.status(500).json({ error: 'Failed to load machines' });
  }
});

// GET /api/inventory/batches?machine_id=1
// Recent ink batches (one row per receiving transaction), newest first.
// This is feedback for the receiving screen, not a reporting module.
router.get('/batches', (req, res) => {
  try {
    const machineId = req.query.machine_id ? Number(req.query.machine_id) : null;
    if (req.query.machine_id && (!Number.isInteger(machineId) || machineId <= 0)) {
      return res.status(400).json({ error: 'machine_id must be a positive integer' });
    }

    let query = `
      SELECT
        ink_batches.id AS batch_id,
        ink_batches.batch_number,
        ink_batches.initial_quantity AS quantity,
        ink_batches.unit,
        ink_batches.received_date,
        ink_batches.expiry_date,
        inks.id AS ink_id,
        inks.color_name,
        inks.color_code,
        machines.id AS machine_id,
        machines.name AS machine_name
      FROM ink_batches
      JOIN inks ON inks.id = ink_batches.ink_id
      JOIN machines ON machines.id = inks.machine_id
    `;
    const params = [];
    if (machineId) {
      query += ' WHERE machines.id = ?';
      params.push(machineId);
    }
    query += ' ORDER BY ink_batches.id DESC LIMIT 100';

    const batches = db.prepare(query).all(...params);
    res.json(batches);
  } catch (err) {
    console.error('GET /batches error:', err);
    res.status(500).json({ error: 'Failed to load batches' });
  }
});

// POST /api/inventory/receipts
// Body: { ink_id, quantity, expiry_date }
// Always creates a brand new batch + a matching receipt record.
// Existing batches for the same ink are never touched or merged.
router.post('/receipts', (req, res) => {
  const { ink_id, quantity, expiry_date } = req.body || {};

  // --- Validation -------------------------------------------------
  const errors = [];

  const inkId = Number(ink_id);
  if (!ink_id || !Number.isInteger(inkId) || inkId <= 0) {
    errors.push('Ink is required.');
  }

  const qty = Number(quantity);
  if (quantity === undefined || quantity === null || quantity === '' || Number.isNaN(qty)) {
    errors.push('Quantity is required.');
  } else if (qty <= 0) {
    errors.push('Quantity must be greater than zero.');
  }

  if (!expiry_date) {
    errors.push('Expiry date is required.');
  } else if (!isValidDateString(expiry_date)) {
    errors.push('Expiry date must be a valid date.');
  }

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  // Confirm the ink actually exists and is active.
  const ink = getInk(inkId);

  if (!ink) {
    return res.status(400).json({ errors: ['Selected ink was not found.'] });
  }

  // --- Create the batch + receipt as one transaction ---------------
  try {
    const receivedDate = todayLocalDate();

    const batchCount = db
      .prepare('SELECT COUNT(*) AS count FROM ink_batches WHERE ink_id = ?')
      .get(inkId).count;
    const batchNumber = `${ink.color_code || 'INK'}-${String(batchCount + 1).padStart(3, '0')}`;

    const insertBatch = db.prepare(
      `INSERT INTO ink_batches
        (ink_id, batch_number, received_date, expiry_date, initial_quantity, unit, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    );
    const insertReceipt = db.prepare(
      `INSERT INTO ink_receipts
        (ink_id, batch_id, quantity_received, unit, receipt_date)
       VALUES (?, ?, ?, ?, ?)`
    );

    let batchId;
    db.exec('BEGIN');
    try {
      const batchResult = insertBatch.run(
        inkId, batchNumber, receivedDate, expiry_date, qty, ink.unit_of_measure
      );
      batchId = Number(batchResult.lastInsertRowid);

      insertReceipt.run(inkId, batchId, qty, ink.unit_of_measure, receivedDate);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.status(201).json({
      batch_id: batchId,
      batch_number: batchNumber,
      ink_id: inkId,
      color_name: ink.color_name,
      quantity: qty,
      unit: ink.unit_of_measure,
      received_date: receivedDate,
      expiry_date,
    });
  } catch (err) {
    console.error('POST /receipts error:', err);
    res.status(500).json({ error: 'Failed to save ink receipt' });
  }
});

// GET /api/inventory/stock?machine_id=1
// Current stock, calculated fresh every call as:
//   Current Stock = Total Received - Total Issued
// computed per batch, then summed per ink. Nothing here is stored as
// a "stock" value anywhere - it is always derived from the ink_receipts
// and ink_issues transaction logs, so it can never drift or be edited
// by hand. Batches are never merged or removed; a fully-issued batch
// simply shows remaining = 0 and stays in its ink's batch list.
router.get('/stock', (req, res) => {
  try {
    const machineId = req.query.machine_id ? Number(req.query.machine_id) : null;
    if (req.query.machine_id && (!Number.isInteger(machineId) || machineId <= 0)) {
      return res.status(400).json({ error: 'machine_id must be a positive integer' });
    }

    let inkQuery = `
      SELECT inks.id AS ink_id, inks.color_name, inks.color_code, inks.unit_of_measure,
             machines.id AS machine_id, machines.name AS machine_name
      FROM inks
      JOIN machines ON machines.id = inks.machine_id
      WHERE inks.is_active = 1
    `;
    const inkParams = [];
    if (machineId) {
      inkQuery += ' AND machines.id = ?';
      inkParams.push(machineId);
    }
    inkQuery += ' ORDER BY machines.id, inks.id';

    const inks = db.prepare(inkQuery).all(...inkParams);

    // Per-batch remaining is shared logic with the issuing endpoint below,
    // so stock shown here and stock actually available to issue always match.
    const result = inks.map((ink) => {
      const batches = getBatchesForInk(ink.ink_id);
      const totalStock = batches.reduce((sum, b) => sum + b.remaining, 0);

      return {
        ink_id: ink.ink_id,
        color_name: ink.color_name,
        color_code: ink.color_code,
        unit: ink.unit_of_measure,
        machine_id: ink.machine_id,
        machine_name: ink.machine_name,
        total_stock: totalStock,
        batches,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('GET /stock error:', err);
    res.status(500).json({ error: 'Failed to calculate stock' });
  }
});

// POST /api/inventory/issues
// Body: { ink_id, quantity, issue_date }
// Issues stock using FIFO: the oldest batch with remaining quantity is
// drawn from first. If one batch doesn't cover the full quantity, the
// remainder is drawn from the next-oldest batch, and so on - one
// ink_issues row is written per batch actually touched, so the ledger
// always shows exactly where each unit came from. If total available
// stock is less than the requested quantity, nothing is written at all
// (stock can never go negative) and a clear error is returned.
router.post('/issues', (req, res) => {
  const { ink_id, quantity, issue_date } = req.body || {};

  // --- Validation -------------------------------------------------
  const errors = [];

  const inkId = Number(ink_id);
  if (!ink_id || !Number.isInteger(inkId) || inkId <= 0) {
    errors.push('Ink is required.');
  }

  const qty = Number(quantity);
  if (quantity === undefined || quantity === null || quantity === '' || Number.isNaN(qty)) {
    errors.push('Quantity is required.');
  } else if (qty <= 0) {
    errors.push('Quantity must be greater than zero.');
  }

  if (!issue_date) {
    errors.push('Date issued is required.');
  } else if (!isValidDateString(issue_date)) {
    errors.push('Date issued must be a valid date.');
  }

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  // Confirm the ink actually exists, is active, and belongs to a known
  // machine - the machine is derived from the ink, never taken from the
  // client, so an issue can never be logged against the wrong machine.
  const ink = getInk(inkId);
  if (!ink) {
    return res.status(400).json({ errors: ['Selected ink was not found.'] });
  }

  // --- FIFO allocation across batches -------------------------------
  const batches = getBatchesForInk(inkId).filter((b) => b.remaining > 0);
  const totalAvailable = batches.reduce((sum, b) => sum + b.remaining, 0);

  if (qty > totalAvailable) {
    return res.status(400).json({
      errors: [
        `Not enough ${ink.color_name} in stock. Requested ${qty} ${ink.unit_of_measure}, ` +
        `but only ${totalAvailable} ${ink.unit_of_measure} available.`,
      ],
    });
  }

  const allocations = [];
  let remainingToIssue = qty;
  for (const batch of batches) {
    if (remainingToIssue <= 0) break;
    const take = Math.min(batch.remaining, remainingToIssue);
    if (take > 0) {
      allocations.push({ batch_id: batch.batch_id, batch_number: batch.batch_number, quantity: take });
      remainingToIssue -= take;
    }
  }

  // Should be impossible given the totalAvailable check above, but never
  // silently short-issue - fail loudly instead of allowing bad data in.
  if (remainingToIssue > 0.0000001) {
    console.error('FIFO allocation mismatch for ink', inkId, 'remaining', remainingToIssue);
    return res.status(500).json({ error: 'Could not allocate stock across batches. No changes were made.' });
  }

  // --- Write one issue row per batch touched, as a single transaction --
  const insertIssue = db.prepare(
    `INSERT INTO ink_issues (ink_id, batch_id, machine_id, quantity_issued, unit, issue_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  try {
    db.exec('BEGIN');
    try {
      for (const a of allocations) {
        insertIssue.run(inkId, a.batch_id, ink.machine_id, a.quantity, ink.unit_of_measure, issue_date);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    res.status(201).json({
      ink_id: inkId,
      color_name: ink.color_name,
      quantity: qty,
      unit: ink.unit_of_measure,
      issue_date,
      allocations,
      remaining_stock: totalAvailable - qty,
    });
  } catch (err) {
    console.error('POST /issues error:', err);
    res.status(500).json({ error: 'Failed to save ink issue' });
  }
});

// GET /api/inventory/issue-history?machine_id=1
// Recent issue transactions, newest first - feedback for the issuing
// screen, not a reporting module.
router.get('/issue-history', (req, res) => {
  try {
    const machineId = req.query.machine_id ? Number(req.query.machine_id) : null;
    if (req.query.machine_id && (!Number.isInteger(machineId) || machineId <= 0)) {
      return res.status(400).json({ error: 'machine_id must be a positive integer' });
    }

    let query = `
      SELECT
        ink_issues.id AS issue_id,
        ink_issues.quantity_issued AS quantity,
        ink_issues.unit,
        ink_issues.issue_date,
        ink_batches.batch_number,
        inks.id AS ink_id,
        inks.color_name,
        machines.id AS machine_id,
        machines.name AS machine_name
      FROM ink_issues
      JOIN ink_batches ON ink_batches.id = ink_issues.batch_id
      JOIN inks ON inks.id = ink_issues.ink_id
      JOIN machines ON machines.id = ink_issues.machine_id
    `;
    const params = [];
    if (machineId) {
      query += ' WHERE machines.id = ?';
      params.push(machineId);
    }
    query += ' ORDER BY ink_issues.id DESC LIMIT 100';

    res.json(db.prepare(query).all(...params));
  } catch (err) {
    console.error('GET /issue-history error:', err);
    res.status(500).json({ error: 'Failed to load issue history' });
  }
});

// GET /api/inventory/on-machine-status?machine_id=1
// Last issued date per ink, derived live from ink_issues (MAX(issue_date)
// per ink) - not stored anywhere, so it can never go stale or duplicate.
// A new issue automatically becomes the new "last issued" value on the
// very next read; no write-side bookkeeping needed.
router.get('/on-machine-status', (req, res) => {
  try {
    const machineId = Number(req.query.machine_id);
    if (!req.query.machine_id || !Number.isInteger(machineId) || machineId <= 0) {
      return res.status(400).json({ error: 'machine_id is required and must be a positive integer' });
    }

    const rows = db.prepare(`
      SELECT
        inks.id AS ink_id,
        inks.color_name,
        (SELECT MAX(issue_date) FROM ink_issues WHERE ink_issues.ink_id = inks.id) AS last_issued_date
      FROM inks
      WHERE inks.machine_id = ? AND inks.is_active = 1
      ORDER BY inks.id
    `).all(machineId);

    res.json(rows);
  } catch (err) {
    console.error('GET /on-machine-status error:', err);
    res.status(500).json({ error: 'Failed to load on-machine status' });
  }
});

// GET /api/inventory/on-machine-status?machine_id=1
// Last Issued date per ink. Derived (MAX(issue_date) per ink), never
// stored - so it can never go stale or duplicate; a new issue is
// reflected the moment it's queried again.
router.get('/on-machine-status', (req, res) => {
  try {
    const machineId = req.query.machine_id ? Number(req.query.machine_id) : null;
    if (!machineId || !Number.isInteger(machineId) || machineId <= 0) {
      return res.status(400).json({ error: 'machine_id is required' });
    }

    const rows = db.prepare(`
      SELECT inks.id AS ink_id, inks.color_name,
             MAX(ink_issues.issue_date) AS last_issued_date
      FROM inks
      LEFT JOIN ink_issues ON ink_issues.ink_id = inks.id
      WHERE inks.machine_id = ? AND inks.is_active = 1
      GROUP BY inks.id
      ORDER BY inks.id
    `).all(machineId);

    res.json(rows);
  } catch (err) {
    console.error('GET /on-machine-status error:', err);
    res.status(500).json({ error: 'Failed to load on-machine status' });
  }
});

// POST /api/inventory/consumable-receipts
// Body: { machine_id, name, quantity, received_date }
// Consumables are free-text and machine-specific: if a consumable with
// this name doesn't already exist for this machine, it's created; if it
// does (matched case-insensitively so "Squeegee"/"squeegee" don't fork
// into two rows), the existing one is reused. Either way, this always
// writes a new receipt row - history is never overwritten.
router.post('/consumable-receipts', (req, res) => {
  const { machine_id, name, quantity, received_date } = req.body || {};

  const errors = [];
  const machineId = Number(machine_id);
  if (!machine_id || !Number.isInteger(machineId) || machineId <= 0) {
    errors.push('Machine is required.');
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) errors.push('Consumable name is required.');

  const qty = Number(quantity);
  if (quantity === undefined || quantity === null || quantity === '' || Number.isNaN(qty)) {
    errors.push('Quantity is required.');
  } else if (qty <= 0) {
    errors.push('Quantity must be greater than zero.');
  }

  if (!received_date) {
    errors.push('Date received is required.');
  } else if (!isValidDateString(received_date)) {
    errors.push('Date received must be a valid date.');
  }

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  const machine = db.prepare('SELECT id FROM machines WHERE id = ? AND is_active = 1').get(machineId);
  if (!machine) {
    return res.status(400).json({ errors: ['Selected machine was not found.'] });
  }

  try {
    let consumable = db
      .prepare('SELECT id, unit_of_measure FROM consumables WHERE machine_id = ? AND name = ? COLLATE NOCASE')
      .get(machineId, trimmedName);

    db.exec('BEGIN');
    try {
      if (!consumable) {
        const result = db
          .prepare('INSERT INTO consumables (machine_id, name) VALUES (?, ?)')
          .run(machineId, trimmedName);
        consumable = { id: Number(result.lastInsertRowid), unit_of_measure: 'pcs' };
      }

      const receiptResult = db.prepare(
        `INSERT INTO consumable_receipts (consumable_id, quantity_received, unit, receipt_date)
         VALUES (?, ?, ?, ?)`
      ).run(consumable.id, qty, consumable.unit_of_measure, received_date);

      db.exec('COMMIT');

      res.status(201).json({
        receipt_id: Number(receiptResult.lastInsertRowid),
        consumable_id: consumable.id,
        name: trimmedName,
        quantity: qty,
        unit: consumable.unit_of_measure,
        received_date,
      });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('POST /consumable-receipts error:', err);
    res.status(500).json({ error: 'Failed to save consumable receipt' });
  }
});

// GET /api/inventory/consumable-receipts?machine_id=1
// Recent consumable receiving history for that machine, newest first.
router.get('/consumable-receipts', (req, res) => {
  try {
    const machineId = req.query.machine_id ? Number(req.query.machine_id) : null;
    if (!machineId || !Number.isInteger(machineId) || machineId <= 0) {
      return res.status(400).json({ error: 'machine_id is required' });
    }

    const rows = db.prepare(`
      SELECT
        consumable_receipts.id AS receipt_id,
        consumable_receipts.quantity_received AS quantity,
        consumable_receipts.unit,
        consumable_receipts.receipt_date,
        consumables.name
      FROM consumable_receipts
      JOIN consumables ON consumables.id = consumable_receipts.consumable_id
      WHERE consumables.machine_id = ?
      ORDER BY consumable_receipts.id DESC
      LIMIT 100
    `).all(machineId);

    res.json(rows);
  } catch (err) {
    console.error('GET /consumable-receipts error:', err);
    res.status(500).json({ error: 'Failed to load consumable receipts' });
  }
});

// GET /api/inventory/consumable-stock?machine_id=1
// Current Stock = Total Received - Total Issued, per consumable.
// No batches for consumables (unlike ink) - receipts for the same
// consumable simply accumulate, since they all point at one
// consumables.id row (see POST /consumable-receipts, which reuses an
// existing consumable rather than creating a new one each time).
router.get('/consumable-stock', (req, res) => {
  try {
    const machineId = req.query.machine_id ? Number(req.query.machine_id) : null;
    if (!machineId || !Number.isInteger(machineId) || machineId <= 0) {
      return res.status(400).json({ error: 'machine_id is required' });
    }

    const rows = db.prepare(`
      SELECT
        consumables.id AS consumable_id,
        consumables.name,
        consumables.unit_of_measure AS unit,
        COALESCE(recv.total, 0) AS total_received,
        COALESCE(iss.total, 0) AS total_issued,
        COALESCE(recv.total, 0) - COALESCE(iss.total, 0) AS current_stock
      FROM consumables
      LEFT JOIN (
        SELECT consumable_id, SUM(quantity_received) AS total
        FROM consumable_receipts GROUP BY consumable_id
      ) recv ON recv.consumable_id = consumables.id
      LEFT JOIN (
        SELECT consumable_id, SUM(quantity_issued) AS total
        FROM consumable_issues GROUP BY consumable_id
      ) iss ON iss.consumable_id = consumables.id
      WHERE consumables.machine_id = ? AND consumables.is_active = 1
      ORDER BY consumables.name COLLATE NOCASE
    `).all(machineId);

    res.json(rows);
  } catch (err) {
    console.error('GET /consumable-stock error:', err);
    res.status(500).json({ error: 'Failed to calculate consumable stock' });
  }
});

// POST /api/inventory/consumable-issues
// Body: { consumable_id, quantity, issue_date }
// No batches for consumables - stock is just Total Received - Total
// Issued for that one consumable. If the requested quantity exceeds
// what's available, nothing is written (stock can never go negative).
router.post('/consumable-issues', (req, res) => {
  const { consumable_id, quantity, issue_date } = req.body || {};

  const errors = [];
  const consumableId = Number(consumable_id);
  if (!consumable_id || !Number.isInteger(consumableId) || consumableId <= 0) {
    errors.push('Consumable is required.');
  }

  const qty = Number(quantity);
  if (quantity === undefined || quantity === null || quantity === '' || Number.isNaN(qty)) {
    errors.push('Quantity is required.');
  } else if (qty <= 0) {
    errors.push('Quantity must be greater than zero.');
  }

  if (!issue_date) {
    errors.push('Date issued is required.');
  } else if (!isValidDateString(issue_date)) {
    errors.push('Date issued must be a valid date.');
  }

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  const consumable = db
    .prepare('SELECT id, machine_id, name, unit_of_measure FROM consumables WHERE id = ? AND is_active = 1')
    .get(consumableId);
  if (!consumable) {
    return res.status(400).json({ errors: ['Selected consumable was not found.'] });
  }

  const totalReceived = db
    .prepare('SELECT COALESCE(SUM(quantity_received), 0) AS total FROM consumable_receipts WHERE consumable_id = ?')
    .get(consumableId).total;
  const totalIssued = db
    .prepare('SELECT COALESCE(SUM(quantity_issued), 0) AS total FROM consumable_issues WHERE consumable_id = ?')
    .get(consumableId).total;
  const available = totalReceived - totalIssued;

  if (qty > available) {
    return res.status(400).json({
      errors: [
        `Not enough ${consumable.name} in stock. Requested ${qty} ${consumable.unit_of_measure}, ` +
        `but only ${available} ${consumable.unit_of_measure} available.`,
      ],
    });
  }

  try {
    const result = db.prepare(
      `INSERT INTO consumable_issues (consumable_id, machine_id, quantity_issued, unit, issue_date)
       VALUES (?, ?, ?, ?, ?)`
    ).run(consumableId, consumable.machine_id, qty, consumable.unit_of_measure, issue_date);

    res.status(201).json({
      issue_id: Number(result.lastInsertRowid),
      consumable_id: consumableId,
      name: consumable.name,
      quantity: qty,
      unit: consumable.unit_of_measure,
      issue_date,
      remaining_stock: available - qty,
    });
  } catch (err) {
    console.error('POST /consumable-issues error:', err);
    res.status(500).json({ error: 'Failed to save consumable issue' });
  }
});

// GET /api/inventory/consumable-issues?machine_id=1
router.get('/consumable-issues', (req, res) => {
  try {
    const machineId = req.query.machine_id ? Number(req.query.machine_id) : null;
    if (!machineId || !Number.isInteger(machineId) || machineId <= 0) {
      return res.status(400).json({ error: 'machine_id is required' });
    }

    const rows = db.prepare(`
      SELECT
        consumable_issues.id AS issue_id,
        consumable_issues.quantity_issued AS quantity,
        consumable_issues.unit,
        consumable_issues.issue_date,
        consumables.name
      FROM consumable_issues
      JOIN consumables ON consumables.id = consumable_issues.consumable_id
      WHERE consumable_issues.machine_id = ?
      ORDER BY consumable_issues.id DESC
      LIMIT 100
    `).all(machineId);

    res.json(rows);
  } catch (err) {
    console.error('GET /consumable-issues error:', err);
    res.status(500).json({ error: 'Failed to load consumable issue history' });
  }
});

// GET /api/inventory/transactions?machine_id=&type=&sort=&dir=
// Unified read-only view across all 4 transaction logs - nothing is
// stored here, it's a live union of ink_receipts, ink_issues,
// consumable_receipts, consumable_issues. Never deletes or modifies
// anything, so it can't affect stock calculations elsewhere.
const TRANSACTION_TYPES = ['Ink Receipt', 'Ink Issue', 'Consumable Receipt', 'Consumable Issue'];
const TRANSACTION_SORT_COLUMNS = { date: 'date', type: 'type', machine: 'machine_name', item: 'item', quantity: 'quantity' };

router.get('/transactions', (req, res) => {
  try {
    const machineId = req.query.machine_id ? Number(req.query.machine_id) : null;
    if (req.query.machine_id && (!Number.isInteger(machineId) || machineId <= 0)) {
      return res.status(400).json({ error: 'machine_id must be a positive integer' });
    }

    const type = req.query.type || null;
    if (type && !TRANSACTION_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Invalid type filter' });
    }

    const sortKey = TRANSACTION_SORT_COLUMNS[req.query.sort] || 'date';
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    let query = `
      SELECT * FROM (
        SELECT ir.receipt_date AS date, 'Ink Receipt' AS type, m.name AS machine_name,
               i.color_name AS item, ir.quantity_received AS quantity, ir.unit AS unit,
               b.expiry_date AS expiry_date, ir.id AS row_id
        FROM ink_receipts ir
        JOIN inks i ON i.id = ir.ink_id
        JOIN machines m ON m.id = i.machine_id
        JOIN ink_batches b ON b.id = ir.batch_id

        UNION ALL

        SELECT ii.issue_date AS date, 'Ink Issue' AS type, m.name AS machine_name,
               i.color_name AS item, ii.quantity_issued AS quantity, ii.unit AS unit,
               NULL AS expiry_date, ii.id AS row_id
        FROM ink_issues ii
        JOIN inks i ON i.id = ii.ink_id
        JOIN machines m ON m.id = ii.machine_id

        UNION ALL

        SELECT cr.receipt_date AS date, 'Consumable Receipt' AS type, m.name AS machine_name,
               c.name AS item, cr.quantity_received AS quantity, cr.unit AS unit,
               NULL AS expiry_date, cr.id AS row_id
        FROM consumable_receipts cr
        JOIN consumables c ON c.id = cr.consumable_id
        JOIN machines m ON m.id = c.machine_id

        UNION ALL

        SELECT ci.issue_date AS date, 'Consumable Issue' AS type, m.name AS machine_name,
               c.name AS item, ci.quantity_issued AS quantity, ci.unit AS unit,
               NULL AS expiry_date, ci.id AS row_id
        FROM consumable_issues ci
        JOIN consumables c ON c.id = ci.consumable_id
        JOIN machines m ON m.id = ci.machine_id
      )
      WHERE 1 = 1
    `;
    const params = [];
    if (machineId) {
      query += ' AND machine_name = (SELECT name FROM machines WHERE id = ?)';
      params.push(machineId);
    }
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    query += ` ORDER BY ${sortKey} ${dir}, row_id ${dir} LIMIT 500`;

    res.json(db.prepare(query).all(...params));
  } catch (err) {
    console.error('GET /transactions error:', err);
    res.status(500).json({ error: 'Failed to load transaction history' });
  }
});

module.exports = router;
