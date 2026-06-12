const { JWT } = require('google-auth-library');
const path = require('path');
const fs = require('fs');

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

    const dayNumbersRow = rows[4] || [];
    const colIndexToDay = {};
    for (let colIndex = 2; colIndex < dayNumbersRow.length; colIndex++) {
      const dayStr = (dayNumbersRow[colIndex] || '').toString().trim();
      const dayNum = parseInt(dayStr, 10);
      if (!isNaN(dayNum)) {
        colIndexToDay[colIndex] = dayNum;
      }
    }

    // Calendar room assignments start at Row 6 (index 5 in 0-indexed rows)
    for (let rowIndex = 5; rowIndex < rows.length; rowIndex++) {
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
          let pax = 1;

          // Parse pax suffix if present (e.g. "B4-2" -> code "B4", pax "2")
          const lastDashIndex = cleanPart.lastIndexOf('-');
          if (lastDashIndex !== -1) {
            const suffix = cleanPart.substring(lastDashIndex + 1).trim();
            if (/^\d+$/.test(suffix)) {
              bookingCode = cleanPart.substring(0, lastDashIndex).trim();
              pax = parseInt(suffix, 10);
            }
          }

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

module.exports = { fetchSheetData, fetchRoomMap };
