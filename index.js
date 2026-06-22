require('dotenv').config();
const cron = require('node-cron');
const crypto = require('crypto');
const { startDashboard } = require('./src/dashboard');
const { startTelegramListener } = require('./src/telegramListener');
const { fetchSheetData, fetchRoomMap } = require('./src/sheets');
const { detectChanges, findHeaderRowIndex, parseDate, getMonthNameFromText, getStayDays } = require('./src/detector');
const { sendTelegramAlert } = require('./src/telegram');
const { loadSnapshot, saveSnapshot, appendHistory, clearMonthData } = require('./src/snapshot');
const { checkAndSend30DayReminders } = require('./src/reminders');
const { sendWeeklyReport, affectsReportWindow, getChangedDates, buildReport } = require('./src/weeklyReport');

console.log('🤖 Sheets Monitor Bot starting...');

let isBoot = true;

// Error alert snoozing state
let lastErrorAlertTime = 0;
let lastErrorMessage = '';

// Weekly report state
const REPORT_CHAT_ID = process.env.TELEGRAM_REPORT_CHAT_ID;
const REPORT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown between change-triggered reports
let lastWeeklyReportTime = 0;
let lastReportMessages = null; // { headerId, dateMessages: { "YYYY-MM-DD": msgId } }

// ─── Channel configuration logging ──────────────────────────────────────────
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const REMINDER_CHANNEL_ID = process.env.TELEGRAM_REMINDER_CHANNEL_ID;

console.log('\n📡 Channel Configuration:');
console.log(`   TELEGRAM_CHAT_ID:             ${CHAT_ID ? `${CHAT_ID.slice(0, 6)}...${CHAT_ID.slice(-4)}` : '❌ NOT SET'}`);
console.log(`   TELEGRAM_REPORT_CHAT_ID:      ${REPORT_CHAT_ID ? `${REPORT_CHAT_ID.slice(0, 6)}...${REPORT_CHAT_ID.slice(-4)}` : '❌ NOT SET'}`);
console.log(`   TELEGRAM_REMINDER_CHANNEL_ID: ${REMINDER_CHANNEL_ID ? `${REMINDER_CHANNEL_ID.slice(0, 6)}...${REMINDER_CHANNEL_ID.slice(-4)}` : '❌ NOT SET'}`);

if (!REPORT_CHAT_ID) {
  console.warn('⚠️  WARNING: TELEGRAM_REPORT_CHAT_ID is not set! Reports will fall back to TELEGRAM_CHAT_ID.');
} else if (REPORT_CHAT_ID === CHAT_ID) {
  console.warn('⚠️  WARNING: TELEGRAM_REPORT_CHAT_ID is the same as TELEGRAM_CHAT_ID. They should be different channels.');
} else if (REPORT_CHAT_ID === REMINDER_CHANNEL_ID) {
  console.warn('⚠️  WARNING: TELEGRAM_REPORT_CHAT_ID is the same as TELEGRAM_REMINDER_CHANNEL_ID! Reports will go to the reminder channel!');
}

// ─── Run check job ──────────────────────────────────────────────────────────
async function runCheck(forceReminders = false) {
  const now = new Date();
  console.log(`\n[${now.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })}] ⏱  Running check...`);
  
  const eventId = crypto.randomUUID();

  try {
    // 1. Fetch latest data from Google Sheet
    const rows = await fetchSheetData();
    console.log(`   📄 Fetched ${rows.length} total rows from sheet`);

    // 2. Identify check-in and check-out months in the booking rows to fetch room allocations dynamically
    const monthsToFetch = new Set();
    
    // Add current month name as fallback
    const currentMonthName = getMonthNameFromText(new Date().toLocaleString('en-US', { month: 'long' })) || 'June';
    monthsToFetch.add(currentMonthName);

    const headerIndex = findHeaderRowIndex(rows);
    if (headerIndex !== -1) {
      const headers = rows[headerIndex] || [];
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
    }

    // 3. Fetch room allocations map for these months
    const monthNamesList = Array.from(monthsToFetch);
    console.log(`   🔍 Fetching room maps for: ${monthNamesList.join(', ')}`);
    const roomMap = await fetchRoomMap(monthNamesList);

    // 4. Enrich rows with ROOM and ROOM_PAX columns
    if (headerIndex !== -1) {
      const headers = rows[headerIndex];
      if (headers && headers.length > 0) {
        headers[headers.length - 1] = 'ROW_COLOR';
      }

      const codeIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
      const nameIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NAME');
      const checkInIndex = headers.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
      const checkOutIndex = headers.findIndex(h => h && ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'].includes(h.toString().trim().toUpperCase()));
      
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
          
          const stayDays = getStayDays(checkInVal, checkOutVal);
          const checkInDate = parseDate(checkInVal);

          // 1. Gather rooms occupied on the day before check-in (to identify checkout room changes)
          let prevDay = null;
          let prevMonth = null;
          if (checkInDate) {
            const prevDate = new Date(checkInDate);
            prevDate.setDate(prevDate.getDate() - 1);
            prevDay = prevDate.getDate();
            prevMonth = (getMonthNameFromText(prevDate.toLocaleString('en-US', { month: 'long' })) || 'June').toUpperCase();
          }

          const prevDayRooms = new Set();
          if (prevDay && prevMonth && roomMap[prevMonth] && roomMap[prevMonth][code]) {
            const prevAlloc = roomMap[prevMonth][code][prevDay] || {};
            for (const room in prevAlloc) {
              prevDayRooms.add(room);
            }
          }

          // 2. Gather rooms occupied on subsequent stay days
          const subsequentRooms = new Set();
          for (let idx = 1; idx < stayDays.length; idx++) {
            const stay = stayDays[idx];
            const monthMap = roomMap[stay.month] || {};
            const codeAllocations = monthMap[code] || null;
            if (codeAllocations) {
              const dayRooms = codeAllocations[stay.day] || {};
              for (const room in dayRooms) {
                subsequentRooms.add(room);
              }
            }
          }
          
          const roomEntries = {}; // { [room]: maxPax }
          for (let idx = 0; idx < stayDays.length; idx++) {
            const stay = stayDays[idx];
            const monthMap = roomMap[stay.month] || {};
            const codeAllocations = monthMap[code] || null;
            if (codeAllocations) {
              const dayRooms = codeAllocations[stay.day] || {};
              for (const room in dayRooms) {
                // If this is the check-in day, the room was occupied the day before, and is NOT occupied on subsequent days,
                // it is a vacated/checkout room from a room change. Exclude it from this stay's room listing.
                if (idx === 0 && prevDayRooms.has(room) && subsequentRooms.size > 0 && !subsequentRooms.has(room)) {
                  continue;
                }
                roomEntries[room] = Math.max(roomEntries[room] || 0, dayRooms[room]);
              }
            }
          }

          const roomStrings = [];
          let totalPax = 0;
          for (const room in roomEntries) {
            const pax = roomEntries[room];
            roomStrings.push(`${room} (${pax} Pax)`);
            totalPax += pax;
          }

          if (roomStrings.length > 0) {
            roomsStr = roomStrings.join(', ');
            totalPaxVal = totalPax;
          }
        }

        while (row.length < headers.length - 2) {
          row.push('');
        }
        row.push(roomsStr);
        row.push(totalPaxVal);
      }
    }

    // 5. Load previous snapshot
    const previousSnapshot = await loadSnapshot();
    const isInitialRun = !previousSnapshot;

    let sentReminders = previousSnapshot?.sentReminders || {};
    if (previousSnapshot?.lastWeeklyReportTime) {
      lastWeeklyReportTime = previousSnapshot.lastWeeklyReportTime;
    }
    if (previousSnapshot?.lastReportMessages) {
      lastReportMessages = previousSnapshot.lastReportMessages;
    }
    if (forceReminders) {
      try {
        const remindersResult = await checkAndSend30DayReminders(rows, previousSnapshot);
        sentReminders = remindersResult.sentReminders;
      } catch (reminderErr) {
        throw new Error(`Reminder check failed: ${reminderErr.message}`);
      }
    }

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
      await sendTelegramAlert({ newRows, modifiedRows, checkedAt: now, offlineInfo, eventId, chatId: CHAT_ID });
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

    // 6. Check if report needs to be updated (sheet changes or date window shifted)
    if (REPORT_CHAT_ID && !isInitialRun) {
      const hasChanges = (newRows.length > 0 || modifiedRows.length > 0);
      const reportData = buildReport(rows);
      const currentDates = reportData.days.map(d => d.dateStr);
      const lastDates = Object.keys(lastReportMessages?.dateMessages || {});
      // Only check forward: are there new dates in the current window not in lastReportMessages?
      // The backward check (old dates not in current window) is removed because dateMessages
      // accumulates entries from previous days, so lastDates always contains stale dates
      // that are no longer in the current 10-day window, causing false positives.
      const datesShifted = lastDates.length === 0 || 
                           currentDates.some(d => !lastDates.includes(d));

      // Restrict report updates during quiet hours (10:00 PM to 8:00 AM KL time) to avoid disturbing people
      const klHour = parseInt(new Date().toLocaleString('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone: 'Asia/Kuala_Lumpur'
      }), 10);
      const isQuietHours = klHour < 8 || klHour >= 22;

      if (isQuietHours) {
        console.log(`   ℹ️ Skipping report update check during quiet hours (${klHour}:00 KL time).`);
      } else if (datesShifted || (hasChanges && affectsReportWindow(newRows, modifiedRows))) {
        const nowMs = Date.now();
        const cooldownPassed = (nowMs - lastWeeklyReportTime > REPORT_COOLDOWN_MS);

        if (datesShifted || cooldownPassed) {
          try {
            const changedDates = getChangedDates(newRows, modifiedRows);
            console.log(`   📅 Updating report. Dates shifted: ${datesShifted}, Changed dates: ${changedDates.join(', ')}`);

            const { messages } = await sendWeeklyReport(rows, REPORT_CHAT_ID, 'updated', lastReportMessages, changedDates);
            lastWeeklyReportTime = nowMs;
            lastReportMessages = messages;
            console.log('   ✅ Weekly/daily report updated successfully.');
          } catch (reportErr) {
            console.error('   ❌ Failed to update weekly/daily report:', reportErr.message);
          }
        }
      }
    }

    // 7. Save new snapshot
    await saveSnapshot(rows, currentMonthRows, sentReminders, lastWeeklyReportTime, lastReportMessages);

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
        await sendTelegramAlert({ error: errorMsg, checkedAt: now, eventId, chatId: CHAT_ID });
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
cron.schedule(cronExpression, () => runCheck(false));

// Daily 30-day reminders at 10:00 AM Kuala Lumpur time
console.log('📆 Daily 10:00 AM KL reminder job scheduled');
cron.schedule('0 10 * * *', async () => {
  console.log('\n⏰ [10:00 AM KL] Running daily 30-day reminders job...');
  await runCheck(true);
}, {
  timezone: 'Asia/Kuala_Lumpur'
});

// Monthly reset: clear history and snapshot on the 1st of each month at midnight KL time
console.log('📆 Monthly reset job scheduled (1st of each month at 12:00 AM KL)');
cron.schedule('0 0 1 * *', async () => {
  console.log('\n🗑️  [Monthly Reset] Clearing history and snapshot...');
  await clearMonthData();
  console.log('   ✅ Monthly reset complete. Next check will establish a new baseline.');
}, {
  timezone: 'Asia/Kuala_Lumpur'
});

// Weekly 10-day customer report: every Saturday at 11:00 AM KL time
if (REPORT_CHAT_ID) {
  console.log('📆 Weekly 10-day report job scheduled (Saturday 11:00 AM KL)');
  cron.schedule('0 11 * * 6', async () => {
    console.log('\n📋 [Saturday Report] Generating 10-day customer report...');
    try {
      const rows = await fetchSheetData();
      const snapshot = await loadSnapshot();
      const prevMessages = snapshot?.lastReportMessages || lastReportMessages;

      const { messages } = await sendWeeklyReport(rows, REPORT_CHAT_ID, 'scheduled', prevMessages);
      lastWeeklyReportTime = Date.now();
      lastReportMessages = messages;
      // Persist the updated time and message IDs while keeping the current month rows intact
      const currentMonthRows = Object.values(snapshot?.monthMap || {});
      await saveSnapshot(rows, currentMonthRows, snapshot?.sentReminders || {}, lastWeeklyReportTime, lastReportMessages);
      console.log('   ✅ Saturday report sent successfully.');
    } catch (err) {
      console.error('   ❌ Saturday report failed:', err.message);
    }
  }, {
    timezone: 'Asia/Kuala_Lumpur'
  });
} else {
  console.log('⚠️  TELEGRAM_REPORT_CHAT_ID not set. Weekly report job disabled.');
}

console.log('🌐 Dashboard: http://localhost:' + (process.env.DASHBOARD_PORT || 3000));
console.log('👋 Bot is running. Press Ctrl+C to stop.\n');
