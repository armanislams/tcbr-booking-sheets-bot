const express = require('express');
const path    = require('path');
const { loadHistory, loadSnapshot, getDbStatus, acknowledgeEvent, getTotalChecksCount } = require('./snapshot');
const { parseDate } = require('./detector');

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
  const totalChecks = await getTotalChecksCount();
  res.json({
    status: 'running',
    lastCheck: history[0]?.checkedAt || null,
    totalEventsLogged: history.length,
    totalChecks,
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

// API endpoint to fetch in-house guest stats for a specific date
app.get('/api/in-house', async (req, res) => {
  try {
    const snapshot = await loadSnapshot();
    if (!snapshot || !snapshot.allRows) {
      return res.json({ date: req.query.date || null, totalGuests: 0, totalBookings: 0, bookings: [] });
    }

    const targetDateStr = req.query.date;
    let targetDate = new Date();
    if (targetDateStr) {
      const parsed = parseDate(targetDateStr);
      if (parsed) targetDate = parsed;
      else if (!isNaN(new Date(targetDateStr))) targetDate = new Date(targetDateStr);
    }
    targetDate.setHours(0, 0, 0, 0);

    const headers = snapshot.headers || [];
    const roomPaxIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROOM_PAX');

    const inHouseBookings = [];
    let totalGuests = 0;

    for (let i = 0; i < snapshot.allRows.length; i++) {
      const row = snapshot.allRows[i];
      const checkInStr = row[7];
      const checkOutStr = row[8];
      const checkIn = parseDate(checkInStr);
      const checkOut = parseDate(checkOutStr);

      if (!checkIn) continue;

      const cIn = new Date(checkIn);
      cIn.setHours(0, 0, 0, 0);

      let cOut = checkOut ? new Date(checkOut) : new Date(cIn);
      cOut.setHours(0, 0, 0, 0);

      let isInHouse = false;
      if (cOut > cIn) {
        isInHouse = (targetDate >= cIn && targetDate < cOut);
      } else {
        isInHouse = (targetDate.getTime() === cIn.getTime());
      }

      if (isInHouse) {
        let pax = 1;
        if (roomPaxIdx !== -1 && row[roomPaxIdx]) {
          const parsedPax = parseInt(row[roomPaxIdx].toString().replace(/\D/g, ''), 10);
          if (!isNaN(parsedPax) && parsedPax > 0) pax = parsedPax;
        } else {
          const s = parseInt((row[4] || '').toString().replace(/\D/g, ''), 10) || 0;
          const d = parseInt((row[5] || '').toString().replace(/\D/g, ''), 10) || 0;
          const c = parseInt((row[6] || '').toString().replace(/\D/g, ''), 10) || 0;
          if (s + d + c > 0) pax = s + d + c;
        }

        totalGuests += pax;
        inHouseBookings.push({ row, rowIndex: i, pax });
      }
    }

    res.json({
      date: targetDate.toISOString().split('T')[0],
      totalGuests,
      totalBookings: inHouseBookings.length,
      bookings: inHouseBookings,
    });
  } catch (err) {
    console.error('   ❌ Failed to fetch in-house stats:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to trigger a manual check on demand from the dashboard
app.post('/api/check', async (req, res) => {
  try {
    if (runCheckCallback) {
      await runCheckCallback(false, true);
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
    const { id, user, category } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Missing event ID' });
    }

    const success = await acknowledgeEvent(id, user || 'Dashboard User', category || 'reception');
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
  const port = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`🌐 Dashboard running at http://localhost:${port}`);
  });
}

module.exports = { startDashboard };
