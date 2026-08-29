// api.js
// Phase 1 API surface: just enough to prove the server + database are alive
// and to feed the basic dashboard. New route files will be added per module
// in later phases (print-records.js, inventory.js, reports.js, settings.js).

const express = require('express');
const { db } = require('../db/database');

const router = express.Router();

// Simple health check - used by the browser on load and useful for debugging.
router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Dashboard summary data: company name + recent server-start history.
// The recent-start history is a deliberate Phase 1 proof that data written
// to SQLite on one run is still there on the next run.
router.get('/dashboard-summary', (req, res) => {
  try {
    const companyName = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('company_name')?.value || 'The Art Source - Printing Department';

    const recentStarts = db
      .prepare('SELECT created_at FROM system_log WHERE event = ? ORDER BY id DESC LIMIT 5')
      .all('server_start');

    const totalStarts = db
      .prepare('SELECT COUNT(*) AS count FROM system_log WHERE event = ?')
      .get('server_start').count;

    res.json({
      companyName,
      totalStarts,
      recentStarts: recentStarts.map((r) => r.created_at),
    });
  } catch (err) {
    console.error('dashboard-summary error:', err);
    res.status(500).json({ error: 'Failed to load dashboard summary' });
  }
});

module.exports = router;
