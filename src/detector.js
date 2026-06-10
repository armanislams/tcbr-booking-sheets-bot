/**
 * Change detection logic.
 *
 * The sheet layout:
 *   Row 0   = Header row  (skipped)
 *   Col H   = Check-in Date  (index 7)
 *   Col I   = Check-out Date (index 8)
 *
 * A row is considered "current month" if EITHER check-in OR check-out
 * falls within the current month & year.
 */

const CHECK_IN_COL  = 7; // Column H (0-indexed)
const CHECK_OUT_COL = 8; // Column I (0-indexed)

/**
 * Parse a date string in common formats like:
 *   "10/06/2026", "2026-06-10", "June 10, 2026", "10-Jun-2026", etc.
 * Returns a Date object or null if unparseable.
 */
function parseDate(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try native parse first (handles ISO and many locale formats)
  const d = new Date(trimmed);
  if (!isNaN(d)) return d;

  // Try dd/mm/yyyy or dd-mm-yyyy
  const dmyMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    const parsed = new Date(`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`);
    if (!isNaN(parsed)) return parsed;
  }

  return null;
}

/**
 * Check if a date falls within the current month & year.
 */
function isCurrentMonth(date) {
  if (!date) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() &&
         date.getMonth()    === now.getMonth();
}

/**
 * Generate a stable unique key for a row.
 * Uses the first non-empty cell (usually an ID or name) + row index as fallback.
 */
function rowKey(row, rowIndex) {
  const firstCell = (row[0] || '').toString().trim();
  return firstCell ? `${firstCell}__row${rowIndex}` : `row${rowIndex}`;
}

/**
 * Build a map of { rowKey -> { row, checkIn, checkOut, rowIndex } }
 * for all rows that belong to the current month.
 */
function buildCurrentMonthMap(rows) {
  const map = {};

  // Skip header row (index 0)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const checkIn  = parseDate(row[CHECK_IN_COL]);
    const checkOut = parseDate(row[CHECK_OUT_COL]);

    if (isCurrentMonth(checkIn) || isCurrentMonth(checkOut)) {
      const key = rowKey(row, i);
      map[key] = { row, checkIn, checkOut, rowIndex: i };
    }
  }

  return map;
}

/**
 * Main change detection function.
 *
 * @param {Array[]} rows          - Current rows from the sheet (with header at [0])
 * @param {Object}  prevSnapshot  - Previous snapshot: { headers, monthMap }
 * @returns {{ newRows, modifiedRows, currentMonthRows }}
 */
function detectChanges(rows, prevSnapshot) {
  const headers = rows[0] || [];
  const currentMap = buildCurrentMonthMap(rows);
  const currentMonthRows = Object.values(currentMap);

  const newRows = [];
  const modifiedRows = [];

  const prevMap = prevSnapshot?.monthMap || {};

  for (const [key, current] of Object.entries(currentMap)) {
    if (!prevMap[key]) {
      // Row is brand new this month
      newRows.push({ key, ...current, headers });
    } else {
      // Row existed before — check if any cell changed
      const prevRow = prevMap[key].row;
      const currRow = current.row;
      const changes = [];

      const maxLen = Math.max(prevRow.length, currRow.length);
      for (let col = 0; col < maxLen; col++) {
        const before = (prevRow[col] || '').toString().trim();
        const after  = (currRow[col] || '').toString().trim();
        if (before !== after) {
          changes.push({
            column: headers[col] || `Col ${col + 1}`,
            before,
            after,
          });
        }
      }

      if (changes.length > 0) {
        modifiedRows.push({ key, ...current, headers, changes });
      }
    }
  }

  return { newRows, modifiedRows, currentMonthRows };
}

module.exports = { detectChanges, buildCurrentMonthMap, parseDate, isCurrentMonth };
