const { JWT } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const { findHeaderRowIndex, parseDate, getMonthNameFromText, getStayDays } = require('./detector');

/**
 * Helper to build JWT auth client using credentials from environment or file.
 */
function getAuthClient() {
  let credentials;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Make sure you pasted the entire file contents.');
    }
  } else {
    const keyFilePath = path.resolve(
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './service-account.json'
    );

    if (!fs.existsSync(keyFilePath)) {
      throw new Error(
        `Service account key file not found at: ${keyFilePath}\n` +
        `Set GOOGLE_SERVICE_ACCOUNT_JSON env var for cloud deployments, ` +
        `or GOOGLE_SERVICE_ACCOUNT_KEY for local development.`
      );
    }

    try {
      credentials = JSON.parse(fs.readFileSync(keyFilePath, 'utf-8'));
    } catch (e) {
      throw new Error(`Failed to parse service account key file at ${keyFilePath}: ${e.message}`);
    }
  }

  return new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

/**
 * Helper to determine standard RGB CSS color of a cell background.
 * Returns 'WHITE' if the color is default or white, otherwise returns standard rgb CSS string.
 */
function getCellColor(color) {
  if (!color) return 'WHITE';
  const r = color.red !== undefined ? color.red : 0;
  const g = color.green !== undefined ? color.green : 0;
  const b = color.blue !== undefined ? color.blue : 0;
  if (r >= 0.99 && g >= 0.99 && b >= 0.99) {
    return 'WHITE';
  }
  const R = Math.round(r * 255);
  const G = Math.round(g * 255);
  const B = Math.round(b * 255);
  return `rgb(${R},${G},${B})`;
}

/**
 * Fetches all rows from the first sheet tab in the configured Google Sheet,
 * including cell background colors to determine highlight status.
 * Returns an array of arrays (raw row data with color status appended as the last element).
 */
async function fetchSheetData() {
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!sheetId) {
    throw new Error('GOOGLE_SHEET_ID is not set in your environment variables');
  }

  const client = getAuthClient();
  await client.authorize();

  // ── Get first sheet tab name dynamically ───────────────────────────────────
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets(properties(title))`;
  const metaResponse = await client.request({ url: metaUrl });

  if (!metaResponse || !metaResponse.data || !metaResponse.data.sheets || metaResponse.data.sheets.length === 0) {
    throw new Error('Could not retrieve sheet metadata. Check your spreadsheet ID and credentials.');
  }

  const firstSheetName = metaResponse.data.sheets[0].properties.title;
  console.log(`   📋 Reading tab: "${firstSheetName}"`);

  // ── Fetch grid data (values and formatting) ────────────────────────────────
  const range = encodeURIComponent(firstSheetName);
  const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?ranges=${range}&includeGridData=true&fields=sheets(data(rowData(values(effectiveFormat(backgroundColor),formattedValue))))`;
  const dataResponse = await client.request({ url: dataUrl });

  if (!dataResponse || !dataResponse.data || !dataResponse.data.sheets || dataResponse.data.sheets.length === 0) {
    throw new Error('Could not retrieve sheet values and formatting.');
  }

  const sheet = dataResponse.data.sheets[0];
  const rowData = (sheet.data && sheet.data[0] && sheet.data[0].rowData) || [];

  // Find max columns across all rows to establish a standard width
  let maxCols = 0;
  for (const row of rowData) {
    if (row && row.values) {
      if (row.values.length > maxCols) {
        maxCols = row.values.length;
      }
    }
  }
  if (maxCols < 4) {
    maxCols = 4; // Ensure we have at least columns up to index 3 (NAME)
  }

  // Map each row, padding empty cells and appending the color state
  const rows = [];
  for (const row of rowData) {
    const rowValues = [];
    let nameColor = null;

    if (row && row.values) {
      for (let c = 0; c < maxCols; c++) {
        const cell = row.values[c];
        const val = cell ? (cell.formattedValue || '') : '';
        rowValues.push(val);

        if (c === 3 && cell) {
          const format = cell.effectiveFormat;
          nameColor = format ? format.backgroundColor : null;
        }
      }
    } else {
      for (let c = 0; c < maxCols; c++) {
        rowValues.push('');
      }
    }

    const cellColor = getCellColor(nameColor);
    rowValues.push(cellColor);
    rows.push(rowValues);
  }

  return rows;
}

/**
 * Fetches calendar tabs matching the requested months and parses room allocations.
 * Returns a map: { [bookingCodeUpper]: { rooms: string, pax: number } }
 */
async function fetchRoomMap(monthsToFetch = []) {
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!sheetId) {
    throw new Error('GOOGLE_SHEET_ID is not set in your environment variables');
  }
  if (monthsToFetch.length === 0) return {};

  const client = getAuthClient();
  await client.authorize();

  // ── Get spreadsheet metadata to see what tabs exist ───────────────────────
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets(properties(title))`;
  const metaResponse = await client.request({ url: metaUrl });
  const sheets = metaResponse.data.sheets || [];

  const roomMapByMonth = {}; // { "JUNE": { "A": { rooms: string, pax: number } } }

  for (const monthName of monthsToFetch) {
    const monthKey = monthName.toUpperCase();
    roomMapByMonth[monthKey] = {};

    // Find tab matching monthName case-insensitively
    const match = sheets.find(s => s.properties.title.toLowerCase().includes(monthName.toLowerCase()));
    if (!match) {
      console.log(`   ⚠️ Calendar tab for month "${monthName}" not found in sheet.`);
      continue;
    }

    const tabTitle = match.properties.title;
    console.log(`   📋 Reading calendar tab: "${tabTitle}" for room lookup`);

    const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabTitle)}?valueRenderOption=FORMATTED_VALUE`;
    const dataResponse = await client.request({ url: dataUrl });
    const rows = dataResponse.data.values || [];

    const monthAllocations = {}; // { [code]: { [day]: { [room]: pax } } }

    // Find ROOM TYPE row index dynamically
    let roomTypeRowIndex = rows.findIndex(r => r && r[0] && r[0].toString().trim().toUpperCase() === 'ROOM TYPE');
    if (roomTypeRowIndex === -1) {
      roomTypeRowIndex = 3; // Fallback to index 3 (June default)
    }

    const dayNumbersRow = rows[roomTypeRowIndex + 1] || [];
    const colIndexToDay = {};
    for (let colIndex = 2; colIndex < dayNumbersRow.length; colIndex++) {
      const dayStr = (dayNumbersRow[colIndex] || '').toString().trim();
      const dayNum = parseInt(dayStr, 10);
      if (!isNaN(dayNum)) {
        colIndexToDay[colIndex] = dayNum;
      }
    }

    // Calendar room assignments start at roomTypeRowIndex + 2
    for (let rowIndex = roomTypeRowIndex + 2; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!row || row.length === 0) continue;

      const firstColumn = row[0] || '';
      // Room number matches letters/digits prefix (e.g., "S101", "V101", "D5")
      const roomMatch = firstColumn.match(/^([A-Z0-9]+)/i);
      if (!roomMatch) continue;

      const roomNumber = roomMatch[1];

      // Scan day columns (index 2 onwards, ignoring Column B which contains data from the previous month)
      for (let colIndex = 2; colIndex < row.length; colIndex++) {
        const cellValue = (row[colIndex] || '').toString().trim();
        if (!cellValue) continue;

        // Split multiple allocations (e.g. check-out/check-in splits, or shared dorm occupants)
        const parts = cellValue.split('/');
        for (const part of parts) {
          const cleanPart = part.trim();
          if (!cleanPart) continue;

          let bookingCode = cleanPart;
          let basePax = 1;
          let addonPax = 0;

          // Parse optional parenthetical addon pax count, e.g. "K6-1(1)" -> addon = 1
          const parenMatch = bookingCode.match(/\((\d+)\)/);
          if (parenMatch) {
            addonPax = parseInt(parenMatch[1], 10);
            bookingCode = bookingCode.replace(/\(\d+\)/, '').trim();
          }

          // Parse base pax suffix or sub-code dash if present, e.g. "K6-1" -> base = 1, code = "K6"
          const lastDashIndex = bookingCode.lastIndexOf('-');
          if (lastDashIndex !== -1) {
            const suffix = bookingCode.substring(lastDashIndex + 1).trim();
            if (/^\d+$/.test(suffix)) {
              basePax = parseInt(suffix, 10);
              bookingCode = bookingCode.substring(0, lastDashIndex).trim();
            }
          }

          const pax = basePax + addonPax;

          const upperCode = bookingCode.toUpperCase();
          const dayNum = colIndexToDay[colIndex];
          if (dayNum !== undefined) {
            if (!monthAllocations[upperCode]) {
              monthAllocations[upperCode] = {};
            }
            if (!monthAllocations[upperCode][dayNum]) {
              monthAllocations[upperCode][dayNum] = {};
            }
            monthAllocations[upperCode][dayNum][roomNumber] = Math.max(
              monthAllocations[upperCode][dayNum][roomNumber] || 0,
              pax
            );
          }
        }
      }
    }

    roomMapByMonth[monthKey] = monthAllocations;
  }

  return roomMapByMonth;
}

function formatRoomDetailsWithDates(code, checkInVal, checkOutVal, roomMap) {
  if (!code || !checkInVal) return { roomsStr: '—', totalPaxVal: '—' };

  const stayDays = getStayDays(checkInVal, checkOutVal);
  if (stayDays.length === 0) return { roomsStr: '—', totalPaxVal: '—' };

  const dailyAllocations = [];
  const allRooms = new Set();

  stayDays.forEach(stay => {
    const monthMap = roomMap[stay.month] || {};
    const codeAlloc = monthMap[code] || {};
    const dayRooms = codeAlloc[stay.day] || {};
    dailyAllocations.push({
      dayStr: `${stay.day} ${stay.month.substring(0, 3)}`,
      day: stay.day,
      month: stay.month,
      rooms: dayRooms
    });
    Object.keys(dayRooms).forEach(r => allRooms.add(r));
  });

  if (allRooms.size === 0) return { roomsStr: '—', totalPaxVal: '—' };

  const roomFirstSeen = {};
  const roomMaxPax = {};

  dailyAllocations.forEach(d => {
    Object.keys(d.rooms).forEach(r => {
      if (!roomFirstSeen[r]) roomFirstSeen[r] = d.dayStr;
      roomMaxPax[r] = Math.max(roomMaxPax[r] || 0, d.rooms[r]);
    });
  });

  // Check if any single day has multiple rooms allocated concurrently
  let hasConcurrentRooms = false;
  dailyAllocations.forEach(d => {
    if (Object.keys(d.rooms).length > 1) {
      hasConcurrentRooms = true;
    }
  });

  if (hasConcurrentRooms || allRooms.size === 1) {
    // Concurrent rooms (e.g. F1 has V104 & B107 on same days) or single room
    const parts = [];
    let totalPax = 0;
    allRooms.forEach(r => {
      const pax = roomMaxPax[r] || 1;
      parts.push(`${r} (${pax} Pax)`);
      totalPax += pax;
    });
    return {
      roomsStr: parts.join(', '),
      totalPaxVal: totalPax
    };
  }

  // True Room Change: rooms occur on separate, non-overlapping days
  const roomSequence = Array.from(allRooms).map(r => ({
    room: r,
    pax: roomMaxPax[r],
    firstSeen: roomFirstSeen[r]
  }));

  const changeDates = [];
  for (let i = 1; i < roomSequence.length; i++) {
    changeDates.push(`on ${roomSequence[i].firstSeen}`);
  }

  const transitionStr = roomSequence.map(r => r.room).join(' ➔ ');
  const changeDateText = changeDates.length > 0 ? ` (Changed ${changeDates.join(', ')})` : '';

  return {
    roomsStr: `${transitionStr}${changeDateText}`,
    totalPaxVal: Math.max(...roomSequence.map(r => r.pax))
  };
}

/**
 * Enriches spreadsheet rows with room allocation details.
 * Pushes ROOM and ROOM_PAX columns onto the header and matching data rows.
 */
async function enrichSheetRows(rows) {
  const headerIndex = findHeaderRowIndex(rows);
  if (headerIndex === -1) return rows;

  const headers = rows[headerIndex] || [];
  
  // 1. Identify check-in and check-out months in the booking rows to fetch room allocations dynamically
  const monthsToFetch = new Set();
  
  // Add current month name as fallback
  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const currentMonthName = MONTH_NAMES[new Date().getMonth()];
  monthsToFetch.add(currentMonthName);

  const checkInIndex = headers.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
  const checkOutIndex = headers.findIndex(h => h && ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'].includes(h.toString().trim().toUpperCase()));
  
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    
    // Add check-in month
    if (checkInIndex !== -1 && row.length > checkInIndex) {
      const checkInVal = row[checkInIndex];
      const monthName = getMonthNameFromText(checkInVal);
      if (monthName) {
        monthsToFetch.add(monthName);
      } else {
        const date = parseDate(checkInVal);
        if (date) {
          const parsedMonthName = getMonthNameFromText(date.toLocaleString('en-US', { month: 'long' }));
          if (parsedMonthName) monthsToFetch.add(parsedMonthName);
        }
      }
    }

    // Add check-out month (for stays spanning month boundaries)
    if (checkOutIndex !== -1 && row.length > checkOutIndex) {
      const checkOutVal = row[checkOutIndex];
      const monthName = getMonthNameFromText(checkOutVal);
      if (monthName) {
        monthsToFetch.add(monthName);
      } else {
        const date = parseDate(checkOutVal);
        if (date) {
          const parsedMonthName = getMonthNameFromText(date.toLocaleString('en-US', { month: 'long' }));
          if (parsedMonthName) monthsToFetch.add(parsedMonthName);
        }
      }
    }
  }

  // 2. Fetch room allocations map for these months
  const monthNamesList = Array.from(monthsToFetch);
  const roomMap = await fetchRoomMap(monthNamesList);

  // 3. Enrich rows with ROOM and ROOM_PAX columns
  if (headers && headers.length > 0) {
    headers[headers.length - 1] = 'ROW_COLOR';
  }

  const codeIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
  const nameIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NAME');
  
  headers.push('ROOM');
  headers.push('ROOM_PAX');

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.slice(0, -1).every(cell => !cell || cell.toString().trim() === '')) {
      continue;
    }

    let code = codeIndex !== -1 ? (row[codeIndex] || '').toString().trim().toUpperCase() : '';
    // If code is empty, try to inherit it from another booking row for the same customer name
    if (!code && nameIndex !== -1) {
      const nameVal = (row[nameIndex] || '').toString().trim();
      if (nameVal) {
        const matchRow = rows.find(r => {
          if (!r) return false;
          const rName = nameIndex !== -1 ? (r[nameIndex] || '').toString().trim() : '';
          const rCode = codeIndex !== -1 ? (r[codeIndex] || '').toString().trim().toUpperCase() : '';
          return rName.toLowerCase() === nameVal.toLowerCase() && rCode;
        });
        if (matchRow) {
          code = matchRow[codeIndex].toString().trim().toUpperCase();
        }
      }
    }

    let roomsStr = '—';
    let totalPaxVal = '—';

    if (code) {
      const checkInVal = checkInIndex !== -1 ? (row[checkInIndex] || '') : '';
      const checkOutVal = checkOutIndex !== -1 ? (row[checkOutIndex] || '') : '';
      
      const res = formatRoomDetailsWithDates(code, checkInVal, checkOutVal, roomMap);
      roomsStr = res.roomsStr;
      totalPaxVal = res.totalPaxVal;
    }

    while (row.length < headers.length - 2) {
      row.push('');
    }
    row.push(roomsStr);
    row.push(totalPaxVal);
  }

  return rows;
}

/**
 * Fetches all rows from the Google Sheet, enriches them with Room details,
 * and applies active dashboard admin overrides.
 */
async function fetchAndEnrichSheetData() {
  const rows = await fetchSheetData();
  await enrichSheetRows(rows);

  try {
    const { applyOverridesToRows } = require('./overrides');
    const headerIndex = findHeaderRowIndex(rows);
    const headers = rows[headerIndex] || [];

    const dataRows = rows.slice(headerIndex + 1);
    const overriddenDataRows = await applyOverridesToRows(dataRows, headers);

    for (let i = 0; i < overriddenDataRows.length; i++) {
      rows[headerIndex + 1 + i] = overriddenDataRows[i];
    }
  } catch (err) {
    console.warn('   ⚠️ Failed to apply admin overrides in fetchAndEnrichSheetData:', err.message);
  }

  return rows;
}

module.exports = { fetchSheetData, fetchRoomMap, enrichSheetRows, fetchAndEnrichSheetData };

