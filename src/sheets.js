const { google } = require('googleapis');
const path = require('path');

/**
 * Fetches all rows from the first sheet tab in the configured Google Sheet.
 * Returns an array of arrays (raw row data).
 */
async function fetchSheetData() {
  const keyFilePath = path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || './service-account.json');
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!sheetId) {
    throw new Error('GOOGLE_SHEET_ID is not set in your .env file');
  }

  // Authenticate with service account
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Get spreadsheet metadata to find the first sheet's name
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const firstSheetName = meta.data.sheets[0].properties.title;
  console.log(`   📋 Reading tab: "${firstSheetName}"`);

  // Fetch all data from the first sheet (no fixed range — expands automatically)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: firstSheetName,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const rows = response.data.values || [];

  // Return all rows (including header row at index 0)
  return rows;
}

module.exports = { fetchSheetData };
