const express = require('express');
const path    = require('path');
const { loadHistory, loadSnapshot, getDbStatus, acknowledgeEvent, getTotalChecksCount } = require('./snapshot');
const { parseDate } = require('./detector');
const { parsePax, parseDivingPax, parseCoursePax } = require('./weeklyReport');

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

function parsePaxString(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.replace(/\([^)]*\)/g, '').trim();
  if (!s) return 0;

  let total = 0;

  // 1. Match DM / Dive Master / Divemaster
  const dmRegex = /\+?\s*(\d*)\s*(?:dm|divemaster|dive\s*master)\b/gi;
  let dmMatch;
  while ((dmMatch = dmRegex.exec(s)) !== null) {
    const num = dmMatch[1] ? parseInt(dmMatch[1], 10) : 1;
    total += num;
  }
  s = s.replace(dmRegex, ' ').trim();

  // 2. Match Ins / Instructor / Instructors
  const insRegex = /\+?\s*(\d*)\s*(?:i[nst]+[ruoc]*t[oers]{0,4}|ins|inst|instructor|instructors)\b/gi;
  let insMatch;
  while ((insMatch = insRegex.exec(s)) !== null) {
    const num = insMatch[1] ? parseInt(insMatch[1], 10) : 1;
    total += num;
  }
  s = s.replace(insRegex, ' ').trim();

  // 3. Match remaining numbers
  const matches = s.matchAll(/(\d+)/g);
  for (const m of matches) {
    const val = parseInt(m[1], 10);
    if (!isNaN(val)) total += val;
  }

  return total;
}

function getRowActivityPax(row) {
  const snork = (row[4] || '').toString();
  const dive = (row[5] || '').toString();
  const course = (row[6] || '').toString();
  
  const s = parsePax(snork);
  const d = parseDivingPax(dive);
  const c = parseCoursePax(course);
  return (s.a + s.c + s.b) + (d.a + d.c + d.b) + (c.a + c.c + c.b);
}

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
    const remarkIdx = headers.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
    const codeIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');

    const bookingsByCode = {};

    for (let i = 0; i < snapshot.allRows.length; i++) {
      const item = snapshot.allRows[i];
      const row = item.row || item;
      
      const remarkVal = (remarkIdx !== -1 ? (row[remarkIdx] || '') : (row[22] || '')).toString().toLowerCase();
      if (remarkVal.includes('cancel') || remarkVal.includes('cancle') || remarkVal.includes('cancelled') || remarkVal.includes('postpone') || remarkVal.includes('postponed')) {
        continue;
      }

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
        const rawCode = (codeIdx !== -1 && row[codeIdx]) ? row[codeIdx].toString().trim().toUpperCase() : '';
        const codeKey = rawCode || `ROW_${i}`;

        if (!bookingsByCode[codeKey]) {
          bookingsByCode[codeKey] = {
            code: rawCode,
            firstRow: row,
            firstRowIndex: i,
            totalActivityPax: 0,
            roomPax: 0
          };
        }

        bookingsByCode[codeKey].totalActivityPax += getRowActivityPax(row);

        if (roomPaxIdx !== -1 && row[roomPaxIdx] && row[roomPaxIdx] !== '—') {
          const parsedRoomPax = parsePaxString(row[roomPaxIdx].toString());
          if (parsedRoomPax > 0 && bookingsByCode[codeKey].roomPax === 0) {
            bookingsByCode[codeKey].roomPax = parsedRoomPax;
          }
        }
      }
    }

    const inHouseBookings = [];
    let totalGuests = 0;

    for (const key in bookingsByCode) {
      const group = bookingsByCode[key];

      // Smart Pax Logic: Activity Pax > Room Pax > Default 1
      let pax = 1;
      if (group.totalActivityPax > 0) {
        pax = group.totalActivityPax;
      } else if (group.roomPax > 0) {
        pax = group.roomPax;
      }

      totalGuests += pax;
      inHouseBookings.push({ row: group.firstRow, rowIndex: group.firstRowIndex, pax });
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
