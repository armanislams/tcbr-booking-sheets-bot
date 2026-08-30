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
 * Supports search by key, ROW_rowIndex, or legacy keys.
 */
async function deleteOverride(bookingKey, rowIndex) {
  const overrides = await loadOverrides();
  if (!overrides || Object.keys(overrides).length === 0) return false;

  let targetKey = null;

  // Extract numeric row index if passed as ROW_X or string
  let parsedRowIndex = rowIndex;
  if ((parsedRowIndex === undefined || parsedRowIndex === null || isNaN(parsedRowIndex)) && bookingKey && typeof bookingKey === 'string') {
    if (bookingKey.startsWith('ROW_')) {
      const idx = parseInt(bookingKey.replace('ROW_', ''), 10);
      if (!isNaN(idx)) parsedRowIndex = idx;
    } else if (bookingKey.includes('_ROW_')) {
      const parts = bookingKey.split('_ROW_');
      const idx = parseInt(parts[1], 10);
      if (!isNaN(idx)) parsedRowIndex = idx;
    }
  }

  // 1. Direct match by bookingKey
  if (bookingKey && overrides[bookingKey]) {
    targetKey = bookingKey;
  }
  // 2. Direct match by ROW_rowIndex
  else if (parsedRowIndex !== undefined && parsedRowIndex !== null && !isNaN(parsedRowIndex) && overrides[`ROW_${parsedRowIndex}`]) {
    targetKey = `ROW_${parsedRowIndex}`;
  }
  // 3. Fallback search across overrides map
  else {
    for (const k in overrides) {
      if (
        k === bookingKey ||
        (parsedRowIndex !== undefined && !isNaN(parsedRowIndex) && (k === `ROW_${parsedRowIndex}` || k.endsWith(`_ROW_${parsedRowIndex}`))) ||
        (bookingKey && overrides[k]?.fields?.CODE === bookingKey)
      ) {
        targetKey = k;
        break;
      }
    }
  }

  // 4. Fallback if single override exists
  if (!targetKey && bookingKey) {
    const keys = Object.keys(overrides);
    if (keys.length === 1) {
      targetKey = keys[0];
    }
  }

  if (!targetKey) return false;

  delete overrides[targetKey];
  cachedOverrides = overrides;
  lastOverridesLoadTime = Date.now();

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('booking_overrides');
      const deleteConditions = [{ bookingKey: targetKey }];
      if (bookingKey) deleteConditions.push({ bookingKey });
      if (parsedRowIndex !== undefined && !isNaN(parsedRowIndex)) {
        deleteConditions.push({ bookingKey: `ROW_${parsedRowIndex}` });
      }
      await collection.deleteMany({
        $or: deleteConditions
      });
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

    if (rowIndex === undefined || rowIndex === null) {
      return entry;
    }

    const bookingKey = `ROW_${rowIndex}`;
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
