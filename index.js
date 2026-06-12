require('dotenv').config();
const cron = require('node-cron');
const crypto = require('crypto');
const { startDashboard } = require('./src/dashboard');
const { startTelegramListener } = require('./src/telegramListener');
const { fetchSheetData } = require('./src/sheets');
const { detectChanges } = require('./src/detector');
const { sendTelegramAlert } = require('./src/telegram');
const { loadSnapshot, saveSnapshot, appendHistory } = require('./src/snapshot');

console.log('🤖 Sheets Monitor Bot starting...');

let isBoot = true;

// Error alert snoozing state
let lastErrorAlertTime = 0;
let lastErrorMessage = '';

// ─── Run check job ──────────────────────────────────────────────────────────
async function runCheck() {
  const now = new Date();
  console.log(`\n[${now.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })}] ⏱  Running check...`);
  
  const eventId = crypto.randomUUID();

  try {
    // 1. Fetch latest data from Google Sheet
    const rows = await fetchSheetData();
    console.log(`   📄 Fetched ${rows.length} total rows from sheet`);

    // 2. Load previous snapshot
    const previousSnapshot = await loadSnapshot();
    const isInitialRun = !previousSnapshot;

    let offlineInfo = null;
    if (isBoot && previousSnapshot && previousSnapshot.savedAt) {
      const lastCheckTime = new Date(previousSnapshot.savedAt);
      const diffMs = now - lastCheckTime;
      const diffMins = Math.floor(diffMs / (1000 * 60));

      // If the bot has been inactive/offline for more than 10 minutes
      if (diffMins >= 10) {
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        const durationText = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

        offlineInfo = {
          wasOffline: true,
          duration: durationText,
          lastActive: lastCheckTime.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })
        };
        console.log(`   ℹ️  Bot is back online! Was offline/inactive for ${durationText} (Last check was at ${offlineInfo.lastActive})`);
      }
    }

    // 3. Detect changes in current month
    const { newRows, modifiedRows, currentMonthRows } = detectChanges(rows, previousSnapshot);

    console.log(`   📅 Current month rows: ${currentMonthRows.length}`);
    console.log(`   🟢 New rows: ${newRows.length}`);
    console.log(`   🟡 Modified rows: ${modifiedRows.length}`);

    // 4. Send notification if there are changes (skip on first boot to prevent spam)
    if (!isInitialRun && (newRows.length > 0 || modifiedRows.length > 0)) {
      await sendTelegramAlert({ newRows, modifiedRows, checkedAt: now, offlineInfo, eventId });
      console.log('   ✅ Telegram notification sent!');
    } else {
      if (isInitialRun) {
        console.log('   ℹ️  Initial run: established baseline snapshot, skipped notifications.');
      } else {
        console.log('   ✅ No changes detected.');
      }
    }

    // 5. Log to history for dashboard
    await appendHistory({
      id: eventId,
      checkedAt: now.toISOString(),
      totalRows: rows.length,
      currentMonthCount: currentMonthRows.length,
      newRows: isInitialRun ? [] : newRows.map(r => ({ row: r.row, headers: r.headers, rowIndex: r.rowIndex })),
      modifiedRows: isInitialRun ? [] : modifiedRows.map(r => ({ row: r.row, headers: r.headers, rowIndex: r.rowIndex, changes: r.changes })),
      offlineInfo,
      note: isInitialRun ? 'Bot initialized. Established baseline snapshot.' : undefined
    });

    // 6. Save new snapshot
    await saveSnapshot(rows, currentMonthRows);

    // Reset error alerts state on success
    lastErrorAlertTime = 0;
    lastErrorMessage = '';

  } catch (err) {
    console.error('   ❌ Error during check:', err.message);
    
    const errorMsg = err.message;
    const nowMs = now.getTime();
    const snoozeHours = parseInt(process.env.ERROR_ALERT_SNOOZE_HOURS || '6', 10);
    const snoozeMs = snoozeHours * 60 * 60 * 1000;

    const isSameError = (errorMsg === lastErrorMessage);
    const hasSnoozePassed = (nowMs - lastErrorAlertTime > snoozeMs);

    if (!isSameError || hasSnoozePassed) {
      try {
        await sendTelegramAlert({ error: errorMsg, checkedAt: now, eventId });
        lastErrorAlertTime = nowMs;
        lastErrorMessage = errorMsg;
        console.log('   ✅ Telegram error alert sent.');
      } catch (tgErr) {
        console.error('   ❌ Failed to send Telegram error alert:', tgErr.message);
      }
    } else {
      console.log(`   ℹ️ Telegram error alert snoozed (Same error within ${snoozeHours}h).`);
    }
  } finally {
    isBoot = false;
  }
}

// ─── Start dashboard server ─────────────────────────────────────────────────
startDashboard(runCheck);

// ─── Start Telegram listener ────────────────────────────────────────────────
startTelegramListener(runCheck);

// ─── Run once immediately on startup ────────────────────────────────────────
runCheck();

// ─── Schedule recurring checks ──────────────────────────────────────────────
const cronExpression = process.env.CHECK_INTERVAL_CRON || '0 * * * *';
console.log(`\n📆 Scheduler set: "${cronExpression}"`);
cron.schedule(cronExpression, runCheck);

console.log('🌐 Dashboard: http://localhost:' + (process.env.DASHBOARD_PORT || 3000));
console.log('👋 Bot is running. Press Ctrl+C to stop.\n');
