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
 * Fetches all rows from the first sheet tab in the configured Google Sheet.
 * Returns an array of arrays (raw row data).
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

  // ── Fetch all data (no fixed range — expands with data) ────────────────────
  const range = encodeURIComponent(firstSheetName);
  const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const dataResponse = await client.request({ url: dataUrl });

  if (!dataResponse || !dataResponse.data) {
    throw new Error('Could not retrieve sheet values.');
  }

  const rows = dataResponse.data.values || [];
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

    const monthAllocations = {}; // { [code]: { [room]: pax } }

    // Calendar room assignments start at Row 6 (index 5 in 0-indexed rows)
    for (let rowIndex = 5; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!row || row.length === 0) continue;

      const firstColumn = row[0] || '';
      // Room number matches letters/digits prefix (e.g., "S101", "V101", "D5")
      const roomMatch = firstColumn.match(/^([A-Z0-9]+)/i);
      if (!roomMatch) continue;

      const roomNumber = roomMatch[1];

      // Scan day columns (index 1 onwards)
      for (let colIndex = 1; colIndex < row.length; colIndex++) {
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
          if (!monthAllocations[upperCode]) {
            monthAllocations[upperCode] = {};
          }
          monthAllocations[upperCode][roomNumber] = Math.max(monthAllocations[upperCode][roomNumber] || 0, pax);
        }
      }
    }

    // Format this month's allocations (e.g., "H101 (2 Pax), H105 (3 Pax)")
    const formattedMonthMap = {};
    for (const code in monthAllocations) {
      const roomEntries = monthAllocations[code];
      const roomStrings = [];
      let totalPax = 0;

      for (const roomNumber in roomEntries) {
        const pax = roomEntries[roomNumber];
        roomStrings.push(`${roomNumber} (${pax} Pax)`);
        totalPax += pax;
      }

      formattedMonthMap[code] = {
        rooms: roomStrings.join(', '),
        pax: totalPax
      };
    }

    roomMapByMonth[monthKey] = formattedMonthMap;
  }

  return roomMapByMonth;
}

module.exports = { fetchSheetData, fetchRoomMap };
