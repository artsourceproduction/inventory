// server.js
// Entry point for The Art Source Printing Department System.
// Starts a local-only Express server, initializes SQLite, serves the
// static dashboard shell, and opens the default browser automatically.

const express = require('express');
const path = require('path');
const { initializeSchema, logSystemStart, getDbPath } = require('./db/database');
const apiRoutes = require('./routes/api');
const inventoryRoutes = require('./routes/inventory');
const printRecordsRoutes = require('./routes/print-records');

const PORT = 4173;
const HOST = '127.0.0.1'; // local machine only - never exposed on the network
const URL = `http://${HOST}:${PORT}`;

// 1. Prepare the database before anything else can touch it.
initializeSchema();
logSystemStart();

// 2. Set up the app.
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/print-records', printRecordsRoutes);
app.use(express.static(path.join(__dirname, '..', 'public')));

// Fallback: any non-API route serves the dashboard shell (simple SPA-style nav).
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 3. Start listening, then open the browser.
app.listen(PORT, HOST, () => {
  console.log('========================================');
  console.log(' The Art Source - Printing Department System');
  console.log('========================================');
  console.log(` Server running at: ${URL}`);
  console.log(` Database file:     ${getDbPath()}`);
  console.log(' Press CTRL+C in this window to stop the server.');
  console.log('========================================');

  // Lazy-require so a missing/failed 'open' package never prevents the
  // server itself from running - worst case, user opens the URL manually.
  try {
    const open = require('open');
    open(URL);
  } catch (err) {
    console.warn('Could not auto-open browser. Please open this URL manually:', URL);
  }
});
