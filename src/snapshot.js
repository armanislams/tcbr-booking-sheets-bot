const fs   = require('fs');
const path = require('path');
const { rowKey } = require('./detector');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const HISTORY_FILE  = path.join(DATA_DIR, 'change_history.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Load the previous snapshot from disk.
 * Returns null if no snapshot exists yet.
 */
function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save the current snapshot to disk.
 * @param {Array[]} allRows        - Full sheet data
 * @param {Array}   currentMonthRows - Rows matching this month
 */
function saveSnapshot(allRows, currentMonthRows) {
  const snapshot = {
    savedAt: new Date().toISOString(),
    totalRows: allRows.length,
    monthMap: {},
  };

  for (const entry of currentMonthRows) {
    const key = rowKey(entry.row, entry.rowIndex);
    snapshot.monthMap[key] = {
      row: entry.row,
      rowIndex: entry.rowIndex,
    };
  }

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf-8');
}

/**
 * Append a change event to the history log (used by the dashboard).
 */
function appendHistory(event) {
  let history = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch {}
  }

  history.unshift(event); // newest first

  // Keep only last 500 events
  if (history.length > 500) history = history.slice(0, 500);

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Load change history for the dashboard.
 */
function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

module.exports = { loadSnapshot, saveSnapshot, appendHistory, loadHistory };
