// print-records.js
// Phase 3B: Add Print Record only.
// - find-or-create the project (matched by name + client, case-insensitive)
// - insert one print_records row, with Printing Date/Time auto-recorded
// - list recent records, for on-screen feedback (not a reports module)
//
// Roll calculations and reports are NOT part of this file yet.

const express = require('express');
const { db } = require('../db/database');
const { calculateRolls } = require('../services/rollCalculation');

const router = express.Router();

function isPositiveNumber(value) {
  const n = Number(value);
  return value !== undefined && value !== null && value !== '' && !Number.isNaN(n) && n > 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(year, month, 0).getDate();
  return day >= 1 && day <= daysInMonth;
}

// POST /api/print-records
router.post('/', (req, res) => {
  const {
    project_name, client_name, image_name, machine_id, media,
    image_width, image_height, quantity, roll_width, roll_length, printing_date, gap_mm,
  } = req.body || {};

  const errors = [];

  const projectName = typeof project_name === 'string' ? project_name.trim() : '';
  const clientName = typeof client_name === 'string' ? client_name.trim() : '';
  const imageName = typeof image_name === 'string' ? image_name.trim() : '';
  const mediaName = typeof media === 'string' ? media.trim() : '';

  if (!projectName) errors.push('Project name is required.');
  if (!clientName) errors.push('Client name is required.');
  if (!imageName) errors.push('Image name is required.');
  if (!mediaName) errors.push('Media is required.');

  const machineId = Number(machine_id);
  if (!machine_id || !Number.isInteger(machineId) || machineId <= 0) {
    errors.push('Machine is required.');
  }

  if (!isPositiveNumber(image_width)) errors.push('Image width must be greater than zero.');
  if (!isPositiveNumber(image_height)) errors.push('Image height must be greater than zero.');
  if (!isPositiveNumber(roll_width)) errors.push('Roll width must be greater than zero.');
  if (!isPositiveNumber(roll_length)) errors.push('Roll length must be greater than zero.');

  const gap = Number(gap_mm);
  if (gap_mm === undefined || gap_mm === null || gap_mm === '' || Number.isNaN(gap) || gap < 0) {
    errors.push('Gap between images must be zero or greater.');
  }

  const qty = Number(quantity);
  if (quantity === undefined || quantity === null || quantity === '' || Number.isNaN(qty)) {
    errors.push('Quantity is required.');
  } else if (qty <= 0) {
    errors.push('Quantity must be greater than zero.');
  }

  // Printing Date is optional from the client - the "Today" button sends
  // today's date explicitly, and the calendar picker sends whatever was
  // chosen. If it's omitted for any reason, default to today rather than
  // reject the record.
  if (printing_date !== undefined && printing_date !== null && printing_date !== '' && !isValidDateString(printing_date)) {
    errors.push('Printing date must be a valid date.');
  }

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  const machine = db.prepare('SELECT id FROM machines WHERE id = ? AND is_active = 1').get(machineId);
  if (!machine) {
    return res.status(400).json({ errors: ['Selected machine was not found.'] });
  }

  try {
    // Run the real layout calculation before touching the database at all -
    // if the image can't fit on this roll in any orientation, reject the
    // whole submission with a clear reason and save nothing.
    const calc = calculateRolls({
      image_width: Number(image_width),
      image_height: Number(image_height),
      quantity: qty,
      roll_width: Number(roll_width),
      roll_length: Number(roll_length),
      gap_mm: gap,
    });

    if (calc.error) {
      return res.status(400).json({ errors: [calc.error] });
    }

    let project = db
      .prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND client_name = ? COLLATE NOCASE')
      .get(projectName, clientName);

    db.exec('BEGIN');
    try {
      if (!project) {
        const result = db
          .prepare('INSERT INTO projects (name, client_name) VALUES (?, ?)')
          .run(projectName, clientName);
        project = { id: Number(result.lastInsertRowid) };
      }

      const now = db.prepare("SELECT date('now','localtime') AS d, time('now','localtime') AS t").get();
      const finalPrintingDate = (printing_date && isValidDateString(printing_date)) ? printing_date : now.d;

      const recordResult = db.prepare(`
        INSERT INTO print_records (
          project_id, machine_id, image_name, media,
          image_width, image_height, quantity,
          roll_width, roll_length, gap_mm,
          effective_width_mm, effective_height_mm, orientation,
          images_per_row, rows_required, calculated_print_length, calculated_rolls,
          printing_date, printing_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        project.id, machineId, imageName, mediaName,
        Number(image_width), Number(image_height), qty,
        Number(roll_width), Number(roll_length), gap,
        calc.effective_width_mm, calc.effective_height_mm, calc.orientation,
        calc.images_per_row, calc.rows_required, calc.calculated_print_length, calc.calculated_rolls,
        finalPrintingDate, now.t
      );

      db.exec('COMMIT');

      res.status(201).json({
        id: Number(recordResult.lastInsertRowid),
        project_name: projectName,
        client_name: clientName,
        image_name: imageName,
        printing_date: finalPrintingDate,
        printing_time: now.t,
        ...calc,
      });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    console.error('POST /print-records error:', err);
    res.status(500).json({ error: 'Failed to save print record' });
  }
});

// GET /api/print-records?from=YYYY-MM-DD&to=YYYY-MM-DD - filters by
// printing_date (inclusive on both ends). No filter = most recent 200.
// GET /api/print-records/filter-options
// Distinct values to populate the Project/Client/Media filter dropdowns.
// Machine list is already served by GET /api/inventory/machines - reused
// on the client rather than duplicated here.
router.get('/filter-options', (req, res) => {
  try {
    const projects = db.prepare('SELECT DISTINCT name FROM projects ORDER BY name COLLATE NOCASE').all().map((r) => r.name);
    const clients = db.prepare('SELECT DISTINCT client_name FROM projects ORDER BY client_name COLLATE NOCASE').all().map((r) => r.client_name);
    const media = db.prepare('SELECT DISTINCT media FROM print_records WHERE media IS NOT NULL AND media != \'\' ORDER BY media COLLATE NOCASE').all().map((r) => r.media);
    res.json({ projects, clients, media });
  } catch (err) {
    console.error('GET /filter-options error:', err);
    res.status(500).json({ error: 'Failed to load filter options' });
  }
});

router.get('/', (req, res) => {
  try {
    const { from, to, project, client, machine_id, media, search } = req.query;
    let query = `
      SELECT
        print_records.id, print_records.image_name, print_records.media,
        print_records.image_width, print_records.image_height,
        print_records.quantity, print_records.calculated_rolls,
        print_records.roll_width, print_records.roll_length,
        print_records.gap_mm, print_records.effective_width_mm, print_records.effective_height_mm,
        print_records.orientation, print_records.images_per_row, print_records.rows_required,
        print_records.calculated_print_length,
        print_records.printing_date, print_records.printing_time,
        projects.name AS project_name, projects.client_name,
        machines.name AS machine_name
      FROM print_records
      JOIN projects ON projects.id = print_records.project_id
      JOIN machines ON machines.id = print_records.machine_id
    `;
    const conditions = [];
    const params = [];

    if (from && to) {
      conditions.push('print_records.printing_date BETWEEN ? AND ?');
      params.push(from, to);
    }
    if (project) {
      conditions.push('projects.name = ?');
      params.push(project);
    }
    if (client) {
      conditions.push('projects.client_name = ?');
      params.push(client);
    }
    if (machine_id) {
      conditions.push('machines.id = ?');
      params.push(Number(machine_id));
    }
    if (media) {
      conditions.push('print_records.media = ?');
      params.push(media);
    }
    if (search) {
      conditions.push('(projects.name LIKE ? OR projects.client_name LIKE ? OR print_records.image_name LIKE ?)');
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY print_records.printing_date DESC, print_records.id DESC LIMIT 200';

    res.json(db.prepare(query).all(...params));
  } catch (err) {
    console.error('GET /print-records error:', err);
    res.status(500).json({ error: 'Failed to load print records' });
  }
});

module.exports = router;
