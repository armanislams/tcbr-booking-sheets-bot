/**
 * Change detection logic.
 *
 * The sheet layout:
 *   Row 0   = Header row  (skipped)
 *   Col H   = Check-in Date  (index 7)
 *   Col I   = Check-out Date (index 8)
 *
 * A row is considered "current month" if the check-in date
 * falls within the current month & year.
 */

const CHECK_IN_COL  = 7; // Column H (0-indexed)
const CHECK_OUT_COL = 8; // Column I (0-indexed)

/**
 * Helper to get English month name from a text string case-insensitively.
 * Supports typos and abbreviations.
 */
function getMonthNameFromText(text) {
  const index = getMonthIndexFromText(text);
  if (index === -1) return null;
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return MONTH_NAMES[index];
}

/**
 * Helper to get 0-indexed month number from a text string case-insensitively.
 */
function getMonthIndexFromText(text) {
  if (!text || typeof text !== 'string') return -1;
  const lower = text.toLowerCase();
  if (lower.includes('jan')) return 0;
  if (lower.includes('feb')) return 1;
  if (lower.includes('mar')) return 2; // matches march, marc, marcj
  if (lower.includes('apr')) return 3;
  if (lower.includes('may')) return 4;
  if (lower.includes('jun')) return 5;
  if (lower.includes('jul')) return 6;
  if (lower.includes('aug')) return 7;
  if (lower.includes('sep')) return 8; // matches sept, september
  if (lower.includes('oct')) return 9;
  if (lower.includes('nov')) return 10;
  if (lower.includes('dec')) return 11;
  return -1;
}

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

  // Handle textual formats with ordinal suffixes and typos (e.g. "20th March", "2nd June", "24thJuly", "17th Marcj")
  const dayMatch = trimmed.match(/^(\d+)/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    const month = getMonthIndexFromText(trimmed);
    if (month !== -1) {
      const now = new Date();
      const year = now.getFullYear();
      const parsed = new Date(year, month, day);
      if (!isNaN(parsed)) return parsed;
    }
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
 * Find the index of the header row in the spreadsheet.
 * Typically the row that contains critical column identifiers like 'CODE'.
 */
function findHeaderRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    if (row && row.some(cell => typeof cell === 'string' && cell.trim() === 'CODE')) {
      return i;
    }
  }
  return 0; // Default to row 0 if not found
}

/**
 * Build a map of { rowKey -> { row, checkIn, checkOut, rowIndex } }
 * for all rows that belong to the current month.
 */
function buildCurrentMonthMap(rows) {
  const map = {};
  const headerIndex = findHeaderRowIndex(rows);

  // Skip header row
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const checkIn  = parseDate(row[CHECK_IN_COL]);
    const checkOut = parseDate(row[CHECK_OUT_COL]);

    if (isCurrentMonth(checkIn)) {
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
  const headerIndex = findHeaderRowIndex(rows);
  const headers = rows[headerIndex] || [];
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
          const colName = headers[col] || `Col ${col + 1}`;
          const colUpper = colName.toString().toUpperCase().trim();
          // Exclude payment details columns from change detection
          if (['TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS'].includes(colUpper)) {
            continue;
          }
          changes.push({
            column: colName,
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

module.exports = { detectChanges, buildCurrentMonthMap, parseDate, isCurrentMonth, rowKey, findHeaderRowIndex, getMonthNameFromText };
