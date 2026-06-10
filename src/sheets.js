const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

/**
 * Fetches all rows from the first sheet tab in the configured Google Sheet.
 * Returns an array of arrays (raw row data).
 *
 * Auth supports two modes:
 *  1. GOOGLE_SERVICE_ACCOUNT_JSON env var — full JSON string (used on Render/cloud)
 *  2. GOOGLE_SERVICE_ACCOUNT_KEY file path — local development fallback
 */
async function fetchSheetData() {
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!sheetId) {
    throw new Error('GOOGLE_SHEET_ID is not set in your environment variables');
  }

  // ── Auth: prefer JSON env var (Render), fall back to file (local) ──────────
  let auth;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    // Cloud deployment: parse JSON string from env var
    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Make sure you pasted the entire file contents.');
    }

    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

  } else {
    // Local development: use key file path
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

    auth = new google.auth.GoogleAuth({
      keyFile: keyFilePath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }

  const sheets = google.sheets({ version: 'v4', auth });

  // ── Get first sheet tab name dynamically ───────────────────────────────────
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const firstSheetName = meta.data.sheets[0].properties.title;
  console.log(`   📋 Reading tab: "${firstSheetName}"`);

  // ── Fetch all data (no fixed range — expands with data) ────────────────────
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: firstSheetName,
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });

  const rows = response.data.values || [];
  return rows;
}

module.exports = { fetchSheetData };
