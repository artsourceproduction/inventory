# The Art Source — Printing Department System

Phase 1: foundation only (application shell, local server, SQLite database,
basic dashboard, navigation). Print Records, Inventory, and Reports are
placeholders until later phases.

## Requirements

- Windows 11
- [Node.js](https://nodejs.org) LTS installed (includes npm)

## Run it

1. Unzip this folder anywhere on the computer, e.g. `C:\ArtSourcePrinting`.
2. Double-click **start.bat**.
   - First run installs dependencies automatically (needs internet once).
   - It then starts the local server and opens your browser to the dashboard.
3. To stop the app, close the black command window (or press `CTRL+C` in it).
4. To run it again later, just double-click **start.bat** — no reinstall needed.

The app runs entirely on this machine at `http://127.0.0.1:4173`. It is not
reachable from other computers or the internet.

## Where the data lives

`data\printing_system.db` — a single SQLite file created automatically on
first run. Back it up by copying that file.

## Verifying the database works

1. Start the app, note the "Total sessions" number on the dashboard.
2. Close the app completely.
3. Start it again with `start.bat`.
4. "Total sessions" should have increased by 1, and the "Recent activity"
   table should show a new "Server started" row with the new timestamp.

This confirms the app is writing to and reading from `printing_system.db`
correctly across restarts.

## Project structure

```
art-source-printing-system/
├── start.bat                 # double-click to run on Windows
├── package.json
├── server/
│   ├── server.js             # Express app entry point
│   ├── db/
│   │   ├── database.js       # SQLite connection + init
│   │   └── schema.sql        # table definitions (Phase 1: settings, system_log)
│   └── routes/
│       └── api.js            # /api endpoints
├── public/                   # dashboard front end (static HTML/CSS/JS)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
└── data/
    └── printing_system.db    # created automatically on first run
```
