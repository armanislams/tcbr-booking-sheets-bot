const fs   = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const { rowKey, findHeaderRowIndex } = require('./detector');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshot.json');
const HISTORY_FILE  = path.join(DATA_DIR, 'change_history.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let mongoClient = null;
let db = null;
let dbStatus = { connected: false, type: 'local', error: 'Database not initialized' };

// In-memory cache variables
let cachedSnapshot = null;
let lastSnapshotLoadTime = 0;
let cachedHistory = null;
let lastHistoryLoadTime = 0;
const CACHE_TTL = 300000; // Cache for 5 minutes (5 * 60 * 1000 ms)

/**
 * Get the current database connection status.
 */
function getDbStatus() {
  return dbStatus;
}

/**
 * Connect to MongoDB if the MONGODB_URI is provided.
 */
async function getDb() {
  if (!process.env.MONGODB_URI) {
    dbStatus = {
      connected: false,
      type: 'local',
      error: 'MONGODB_URI environment variable is not set.'
    };
    return null;
  }
  if (db) {
    dbStatus = { connected: true, type: 'mongodb', error: null };
    return db;
  }

  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db();
    console.log('   ✅ Connected to MongoDB successfully');
    dbStatus = { connected: true, type: 'mongodb', error: null };
    return db;
  } catch (err) {
    console.error('   ❌ Failed to connect to MongoDB:', err.message);
    dbStatus = { connected: false, type: 'local', error: err.message };
    db = null;
    return null;
  }
}

/**
 * Load the previous snapshot from MongoDB or fallback to disk.
 * Returns null if no snapshot exists yet.
 */
async function loadSnapshot() {
  const now = Date.now();
  // Serve from cache if still valid
  if (cachedSnapshot && (now - lastSnapshotLoadTime < CACHE_TTL)) {
    return cachedSnapshot;
  }

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('snapshots');
      const doc = await collection.findOne({ type: 'current_baseline' });
      
      cachedSnapshot = doc ? doc.data : null;
      lastSnapshotLoadTime = now;
      return cachedSnapshot;
    } catch (err) {
      console.error('   ❌ MongoDB loadSnapshot error:', err.message);
      return null;
    }
  }

  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    cachedSnapshot = data;
    lastSnapshotLoadTime = now;
    return data;
  } catch {
    return null;
  }
}

/**
 * Save the current snapshot to MongoDB or fallback to disk.
 * @param {Array[]} allRows        - Full sheet data
 * @param {Array}   currentMonthRows - Rows matching this month
 */
async function saveSnapshot(allRows, currentMonthRows, sentReminders = {}) {
  const headerIndex = findHeaderRowIndex(allRows);
  const headers = allRows[headerIndex] || [];

  // Format all data rows (excluding headers and empty rows)
  const allRowsData = [];
  for (let i = headerIndex + 1; i < allRows.length; i++) {
    const row = allRows[i];
    // Skip empty/blank rows
    if (!row || row.every(cell => !cell || cell.toString().trim() === '')) {
      continue;
    }
    allRowsData.push({
      row,
      rowIndex: i
    });
  }

  const snapshot = {
    savedAt: new Date().toISOString(),
    totalRows: allRows.length,
    headers, // Keep the headers saved in snapshot for current bookings endpoint
    monthMap: {},
    allRows: allRowsData, // Save all rows data for the "All Bookings" tab
    sentReminders,
  };

  for (const entry of currentMonthRows) {
    const key = rowKey(entry.row, entry.rowIndex);
    snapshot.monthMap[key] = {
      row: entry.row,
      rowIndex: entry.rowIndex,
    };
  }

  // Update in-memory cache immediately
  cachedSnapshot = snapshot;
  lastSnapshotLoadTime = Date.now();

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('snapshots');
      await collection.updateOne(
        { type: 'current_baseline' },
        { $set: { type: 'current_baseline', data: snapshot, updatedAt: new Date() } },
        { upsert: true }
      );
      return;
    } catch (err) {
      console.error('   ❌ MongoDB saveSnapshot error:', err.message);
    }
  }

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf-8');
}

/**
 * Append a change event to the history log (used by the dashboard).
 */
async function appendHistory(event) {
  // Invalidate history cache to fetch fresh data on next reload
  cachedHistory = null;
  lastHistoryLoadTime = 0;

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      await collection.insertOne({ ...event, createdAt: new Date() });
      return;
    } catch (err) {
      console.error('   ❌ MongoDB appendHistory error:', err.message);
    }
  }

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
async function loadHistory() {
  const now = Date.now();
  // Serve from cache if still valid
  if (cachedHistory && (now - lastHistoryLoadTime < CACHE_TTL)) {
    return cachedHistory;
  }

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      const docs = await collection.find({}).sort({ checkedAt: -1 }).limit(500).toArray();
      
      const mapped = docs.map(doc => {
        const { _id, ...rest } = doc;
        return rest;
      });
      cachedHistory = mapped;
      lastHistoryLoadTime = now;
      return mapped;
    } catch (err) {
      console.error('   ❌ MongoDB loadHistory error:', err.message);
      return [];
    }
  }

  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    cachedHistory = data;
    lastHistoryLoadTime = now;
    return data;
  } catch {
    return [];
  }
}

/**
 * Acknowledge a change event by its ID.
 */
async function acknowledgeEvent(eventId, username, category = 'reception') {
  // Clear cache to reflect updates
  cachedHistory = null;
  lastHistoryLoadTime = 0;

  const prefix = category === 'dive_center' ? 'acknowledgedDiveCenter' : 'acknowledgedReception';

  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      const result = await collection.updateOne(
        { id: eventId },
        { 
          $set: { 
            [`${prefix}`]: true, 
            [`${prefix}By`]: username, 
            [`${prefix}At`]: new Date().toISOString() 
          } 
        }
      );
      return result.modifiedCount > 0;
    } catch (err) {
      console.error('   ❌ MongoDB acknowledgeEvent error:', err.message);
      return false;
    }
  }

  if (!fs.existsSync(HISTORY_FILE)) return false;
  try {
    let history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    const idx = history.findIndex(item => item.id === eventId);
    if (idx !== -1) {
      history[idx][`${prefix}`] = true;
      history[idx][`${prefix}By`] = username;
      history[idx][`${prefix}At`] = new Date().toISOString();
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
      return true;
    }
    return false;
  } catch (err) {
    console.error('   ❌ Local file acknowledgeEvent error:', err.message);
    return false;
  }
}

/**
 * Clear all change history and snapshot baseline (monthly reset).
 */
async function clearMonthData() {
  // Clear in-memory caches
  cachedSnapshot = null;
  lastSnapshotLoadTime = 0;
  cachedHistory = null;
  lastHistoryLoadTime = 0;

  const db = await getDb();
  if (db) {
    try {
      await db.collection('history').deleteMany({});
      await db.collection('snapshots').deleteMany({ type: 'current_baseline' });
      console.log('   🗑️  MongoDB history and snapshot cleared.');
      return;
    } catch (err) {
      console.error('   ❌ MongoDB clearMonthData error:', err.message);
    }
  }

  // Local fallback
  if (fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, '[]', 'utf-8');
  }
  if (fs.existsSync(SNAPSHOT_FILE)) {
    fs.unlinkSync(SNAPSHOT_FILE);
  }
  console.log('   🗑️  Local history and snapshot cleared.');
}

module.exports = { loadSnapshot, saveSnapshot, appendHistory, loadHistory, getDbStatus, acknowledgeEvent, clearMonthData };
