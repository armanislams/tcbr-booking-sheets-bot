const { JWT } = require('google-auth-library');
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

  let credentials;

  // ── Auth: prefer JSON env var (Render), fall back to file (local) ──────────
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

  const client = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

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

module.exports = { fetchSheetData };
