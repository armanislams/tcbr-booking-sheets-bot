const fs = require('fs');
const path = require('path');
const { getDbStatus, getDb } = require('./snapshot');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OVERRIDES_FILE = path.join(DATA_DIR, 'booking_overrides.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let cachedOverrides = null;
let lastOverridesLoadTime = 0;
const CACHE_TTL = 300000; // 5 minutes cache

/**
 * Load all active booking overrides.
 * Returns an object map: { [bookingKey]: overrideDataObject }
 */
async function loadOverrides() {
  const now = Date.now();
  if (cachedOverrides && (now - lastOverridesLoadTime < CACHE_TTL)) {
    return cachedOverrides;
  }

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('booking_overrides');
      const docs = await collection.find({}).toArray();
      const map = {};
      docs.forEach(doc => {
        const { _id, bookingKey, ...data } = doc;
        map[bookingKey] = data;
      });
      cachedOverrides = map;
      lastOverridesLoadTime = now;
      return map;
    } catch (err) {
      console.error('   ❌ MongoDB loadOverrides error:', err.message);
    }
  }

  if (!fs.existsSync(OVERRIDES_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
    cachedOverrides = data;
    lastOverridesLoadTime = now;
    return data;
  } catch {
    return {};
  }
}

/**
 * Save an override for a specific booking key.
 * @param {string} bookingKey - Unique identifier (e.g. CODE or row key)
 * @param {object} overrideData - Key-value pair of edited column values
 * @param {string} updatedBy - Username of admin who edited
 */
async function saveOverride(bookingKey, overrideData, updatedBy) {
  if (!bookingKey) throw new Error('Booking key is required');

  const overrides = await loadOverrides();
  const payload = {
    ...overrideData,
    isOverridden: true,
    updatedBy: updatedBy || 'Admin',
    updatedAt: new Date().toISOString()
  };

  overrides[bookingKey] = payload;
  cachedOverrides = overrides;
  lastOverridesLoadTime = Date.now();

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('booking_overrides');
      await collection.updateOne(
        { bookingKey },
        { $set: { bookingKey, ...payload } },
        { upsert: true }
      );
      return payload;
    } catch (err) {
      console.error('   ❌ MongoDB saveOverride error:', err.message);
    }
  }

  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf-8');
  return payload;
}

/**
 * Remove an override for a booking key (revert to original sheet data).
 */
async function deleteOverride(bookingKey) {
  if (!bookingKey) return false;

  const overrides = await loadOverrides();
  if (!overrides[bookingKey]) return false;

  delete overrides[bookingKey];
  cachedOverrides = overrides;
  lastOverridesLoadTime = Date.now();

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('booking_overrides');
      await collection.deleteOne({ bookingKey });
    } catch (err) {
      console.error('   ❌ MongoDB deleteOverride error:', err.message);
    }
  }

  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf-8');
  return true;
}

const HEADER_ALIASES = {
  'SNORKELLING': ['SNORKELING', 'SNORKELLING', 'SNORKEL'],
  'SNORKELING': ['SNORKELING', 'SNORKELLING', 'SNORKEL'],
  'DIVING': ['DIVING', 'DIVE'],
  'COURSE': ['COURSE', 'COURSES'],
  'CHECK IN': ['CHECK IN', 'CHECK-IN', 'CHECKIN'],
  'CHECK OUT': ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'],
  'REMARK': ['REMARK', 'REMARKS'],
  'ROOM_PAX': ['ROOM_PAX', 'ROOM PAX'],
  'TOTAL AMOUNT': ['TOTAL AMOUNT', 'TOTAL'],
};

function getOverriddenValue(overrideFields, headerName) {
  if (!overrideFields || !headerName) return undefined;
  const norm = headerName.toString().trim().toUpperCase();
  if (overrideFields[norm] !== undefined) return overrideFields[norm];

  const aliases = HEADER_ALIASES[norm];
  if (aliases) {
    for (const alias of aliases) {
      if (overrideFields[alias] !== undefined) {
        return overrideFields[alias];
      }
    }
  }
  return undefined;
}

/**
 * Helper to get unique key for a row.
 * Ties override strictly to the row's unique index to prevent duplicate cards.
 */
function getBookingKey(row, headers, rowIndex) {
  if (rowIndex !== undefined && rowIndex !== null) {
    return `ROW_${rowIndex}`;
  }
  if (!headers || !row) return `ROW_0`;
  const codeIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
  if (codeIdx !== -1 && row[codeIdx]) {
    const code = row[codeIdx].toString().trim().toUpperCase();
    if (code && code !== '—' && code !== '-' && code !== 'N/A') {
      return `CODE_${code}`;
    }
  }
  return `ROW_0`;
}

/**
 * Applies active overrides onto a list of row objects or raw row arrays.
 * Returns enriched rows array with override values merged in.
 */
async function applyOverridesToRows(bookingEntries, headers) {
  const overrides = await loadOverrides();
  if (!overrides || Object.keys(overrides).length === 0) {
    return bookingEntries;
  }

  return bookingEntries.map(entry => {
    // Handle both raw row array and object { row, rowIndex } formats
    const isObject = typeof entry === 'object' && entry !== null && Array.isArray(entry.row);
    const row = isObject ? [...entry.row] : (Array.isArray(entry) ? [...entry] : entry);
    const rowIndex = isObject ? entry.rowIndex : undefined;

    const bookingKey = getBookingKey(row, headers, rowIndex);
    const override = overrides[bookingKey];

    if (!override) return entry;

    // Clone row array so we don't mutate original reference directly
    const mergedRow = [...row];

    // Merge overridden fields matching headers and aliases
    if (headers && Array.isArray(headers)) {
      headers.forEach((headerName, colIdx) => {
        if (!headerName) return;
        const val = getOverriddenValue(override.fields, headerName);
        if (val !== undefined) {
          mergedRow[colIdx] = val;
        }
      });
    }

    if (isObject) {
      return {
        ...entry,
        row: mergedRow,
        isOverridden: true,
        overrideMeta: {
          updatedBy: override.updatedBy,
          updatedAt: override.updatedAt,
          bookingKey
        }
      };
    } else if (Array.isArray(entry)) {
      // Attach non-enumerable properties or wrapper metadata if needed
      mergedRow.isOverridden = true;
      mergedRow.overrideMeta = {
        updatedBy: override.updatedBy,
        updatedAt: override.updatedAt,
        bookingKey
      };
      return mergedRow;
    }

    return entry;
  });
}

module.exports = {
  loadOverrides,
  saveOverride,
  deleteOverride,
  getBookingKey,
  applyOverridesToRows
};
