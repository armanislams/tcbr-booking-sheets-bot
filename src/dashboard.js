const express = require('express');
const path    = require('path');
const { loadHistory, loadSnapshot, getDbStatus, acknowledgeEvent } = require('./snapshot');

const app = express();

// Middleware to parse JSON bodies (needed for acknowledgement requests)
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

let runCheckCallback = null;

// API endpoint for the dashboard to fetch change history
app.get('/api/history', async (req, res) => {
  const history = await loadHistory();
  res.json(history);
});

// API endpoint for health check / last check info
app.get('/api/status', async (req, res) => {
  const history = await loadHistory();
  res.json({
    status: 'running',
    lastCheck: history[0]?.checkedAt || null,
    totalEventsLogged: history.length,
    dbStatus: getDbStatus(),
  });
});

// API endpoint for the dashboard to fetch current month's active bookings
app.get('/api/current-bookings', async (req, res) => {
  try {
    const snapshot = await loadSnapshot();
    if (!snapshot) {
      return res.json({ headers: [], bookings: [] });
    }

    // Convert monthMap into a flat list of booking rows
    const bookings = Object.values(snapshot.monthMap || {}).map(entry => ({
      row: entry.row,
      rowIndex: entry.rowIndex,
    }));

    res.json({
      headers: snapshot.headers || [],
      bookings,
    });
  } catch (err) {
    console.error('   ❌ Failed to load current bookings:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint for the dashboard to fetch all bookings from Google Sheet snapshot
app.get('/api/all-bookings', async (req, res) => {
  try {
    const snapshot = await loadSnapshot();
    if (!snapshot) {
      return res.json({ headers: [], bookings: [] });
    }

    res.json({
      headers: snapshot.headers || [],
      bookings: snapshot.allRows || [],
    });
  } catch (err) {
    console.error('   ❌ Failed to load all bookings:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to trigger a manual check on demand from the dashboard
app.post('/api/check', async (req, res) => {
  try {
    if (runCheckCallback) {
      await runCheckCallback();
      res.json({ success: true, message: 'Sheet check completed successfully.' });
    } else {
      res.status(500).json({ error: 'Check trigger callback not registered on the server.' });
    }
  } catch (err) {
    console.error('   ❌ Manual check trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API endpoint to acknowledge an event from the dashboard
app.post('/api/history/acknowledge', async (req, res) => {
  try {
    const { id, user } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing event ID' });
    }

    const success = await acknowledgeEvent(id, user || 'Dashboard User');
    if (success) {
      res.json({ success: true, message: 'Event acknowledged.' });
    } else {
      res.status(404).json({ error: 'Event not found or already acknowledged.' });
    }
  } catch (err) {
    console.error('   ❌ Event acknowledgement API error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function startDashboard(runCheckFn) {
  runCheckCallback = runCheckFn;
  const port = parseInt(process.env.DASHBOARD_PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`🌐 Dashboard running at http://localhost:${port}`);
  });
}

module.exports = { startDashboard };
