require('dotenv').config();
const cron = require('node-cron');
const { startDashboard } = require('./src/dashboard');
const { fetchSheetData } = require('./src/sheets');
const { detectChanges } = require('./src/detector');
const { sendTelegramAlert } = require('./src/telegram');
const { loadSnapshot, saveSnapshot, appendHistory } = require('./src/snapshot');

console.log('🤖 Sheets Monitor Bot starting...');

// ─── Run check job ──────────────────────────────────────────────────────────
async function runCheck() {
  const now = new Date();
  console.log(`\n[${now.toLocaleString()}] ⏱  Running scheduled check...`);

  try {
    // 1. Fetch latest data from Google Sheet
    const rows = await fetchSheetData();
    console.log(`   📄 Fetched ${rows.length} total rows from sheet`);

    // 2. Load previous snapshot
    const previousSnapshot = loadSnapshot();

    // 3. Detect changes in current month
    const { newRows, modifiedRows, currentMonthRows } = detectChanges(rows, previousSnapshot);

    console.log(`   📅 Current month rows: ${currentMonthRows.length}`);
    console.log(`   🟢 New rows: ${newRows.length}`);
    console.log(`   🟡 Modified rows: ${modifiedRows.length}`);

    // 4. Send notification if there are changes
    if (newRows.length > 0 || modifiedRows.length > 0) {
      await sendTelegramAlert({ newRows, modifiedRows, checkedAt: now });
      console.log('   ✅ Telegram notification sent!');
    } else {
      console.log('   ✅ No changes detected.');
    }

    // 5. Log to history for dashboard
    appendHistory({
      checkedAt: now.toISOString(),
      totalRows: rows.length,
      currentMonthCount: currentMonthRows.length,
      newRows: newRows.map(r => ({ row: r.row, headers: r.headers, rowIndex: r.rowIndex })),
      modifiedRows: modifiedRows.map(r => ({ row: r.row, headers: r.headers, rowIndex: r.rowIndex, changes: r.changes })),
    });

    // 6. Save new snapshot
    saveSnapshot(rows, currentMonthRows);

  } catch (err) {
    console.error('   ❌ Error during check:', err.message);
    // Notify via Telegram about the error too
    try {
      await sendTelegramAlert({ error: err.message, checkedAt: now });
    } catch (_) {}
  }
}

// ─── Start dashboard server ─────────────────────────────────────────────────
startDashboard();

// ─── Run once immediately on startup ────────────────────────────────────────
runCheck();

// ─── Schedule recurring checks ──────────────────────────────────────────────
const cronExpression = process.env.CHECK_INTERVAL_CRON || '0 * * * *';
console.log(`\n📆 Scheduler set: "${cronExpression}"`);
cron.schedule(cronExpression, runCheck);

console.log('🌐 Dashboard: http://localhost:' + (process.env.DASHBOARD_PORT || 3000));
console.log('👋 Bot is running. Press Ctrl+C to stop.\n');
