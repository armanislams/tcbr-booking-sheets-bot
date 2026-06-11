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
  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('snapshots');
      const doc = await collection.findOne({ type: 'current_baseline' });
      return doc ? doc.data : null;
    } catch (err) {
      console.error('   ❌ MongoDB loadSnapshot error:', err.message);
      return null;
    }
  }

  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save the current snapshot to MongoDB or fallback to disk.
 * @param {Array[]} allRows        - Full sheet data
 * @param {Array}   currentMonthRows - Rows matching this month
 */
async function saveSnapshot(allRows, currentMonthRows) {
  const headerIndex = findHeaderRowIndex(allRows);
  const headers = allRows[headerIndex] || [];
  const snapshot = {
    savedAt: new Date().toISOString(),
    totalRows: allRows.length,
    headers, // Keep the headers saved in snapshot for current bookings endpoint
    monthMap: {},
  };

  for (const entry of currentMonthRows) {
    const key = rowKey(entry.row, entry.rowIndex);
    snapshot.monthMap[key] = {
      row: entry.row,
      rowIndex: entry.rowIndex,
    };
  }

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
  const db = await getDb();
  if (db) {
    try {
      const collection = db.collection('history');
      const docs = await collection.find({}).sort({ checkedAt: -1 }).limit(500).toArray();
      // Remove mongo _id before sending to frontend if needed
      return docs.map(doc => {
        const { _id, ...rest } = doc;
        return rest;
      });
    } catch (err) {
      console.error('   ❌ MongoDB loadHistory error:', err.message);
      return [];
    }
  }

  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

module.exports = { loadSnapshot, saveSnapshot, appendHistory, loadHistory, getDbStatus };
