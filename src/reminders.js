const { sendMessage } = require('./telegram');
const { findHeaderRowIndex, parseDate } = require('./detector');

const REMINDER_CHANNEL_ID = process.env.TELEGRAM_REMINDER_CHANNEL_ID;

/**
 * Returns components of a Date object relative to Asia/Kuala_Lumpur timezone.
 */
function getKualaLumpurDateComponents(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
  const parts = formatter.formatToParts(date);
  const year = parseInt(parts.find(p => p.type === 'year').value, 10);
  const month = parseInt(parts.find(p => p.type === 'month').value, 10) - 1; // 0-indexed
  const day = parseInt(parts.find(p => p.type === 'day').value, 10);
  return { year, month, day };
}

/**
 * Computes calendar day difference between d1 and d2 relative to Asia/Kuala_Lumpur.
 */
function getKualaLumpurDaysDifference(d1, d2) {
  const c1 = getKualaLumpurDateComponents(d1);
  const c2 = getKualaLumpurDateComponents(d2);
  const utc1 = Date.UTC(c1.year, c1.month, c1.day);
  const utc2 = Date.UTC(c2.year, c2.month, c2.day);
  return Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24));
}

/**
 * Normalizes a currency balance string and checks if it represents a non-zero outstanding amount.
 */
function isNonZeroBalance(balanceStr) {
  if (!balanceStr) return false;
  const clean = balanceStr.toString().toUpperCase().replace(/[^\d.-]/g, '').trim();
  if (!clean) return false;
  const val = parseFloat(clean);
  return !isNaN(val) && val !== 0;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Identifies bookings check-in 30 days from now, formats alerts, and posts them to the reminder channel.
 * Returns the updated sentReminders mapping.
 */
async function checkAndSend30DayReminders(rows, previousSnapshot) {
  if (!REMINDER_CHANNEL_ID) {
    console.warn('   ⚠️ TELEGRAM_REMINDER_CHANNEL_ID not set in env. Skipping 30-day reminders.');
    return { sentReminders: previousSnapshot?.sentReminders || {} };
  }

  const headerIndex = findHeaderRowIndex(rows);
  const headers = rows[headerIndex] || [];

  const codeIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
  const nameIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NAME');
  const checkInIndex = headers.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
  const balanceIndex = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'BALANCE');

  if (checkInIndex === -1) {
    console.warn('   ⚠️ Check-In column not found in sheet headers. Skipping reminders.');
    return { sentReminders: previousSnapshot?.sentReminders || {} };
  }

  const today = new Date();
  const sentReminders = { ...(previousSnapshot?.sentReminders || {}) };
  const remindersToSend = [];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.slice(0, -1).every(cell => !cell || cell.toString().trim() === '')) {
      continue;
    }

    const checkInVal = row[checkInIndex];
    const checkInDate = parseDate(checkInVal);
    if (!checkInDate) continue;

    const diffDays = getKualaLumpurDaysDifference(today, checkInDate);
    if (diffDays === 30) {
      const code = codeIndex !== -1 ? (row[codeIndex] || '').toString().trim() : '';
      const name = nameIndex !== -1 ? (row[nameIndex] || '').toString().trim() : '';
      const checkInStr = checkInVal.toString().trim();
      
      // Construct a unique stable key for this reminder
      const reminderKey = `${code}_${name}_${checkInStr}`.replace(/\s+/g, '_');

      if (!sentReminders[reminderKey]) {
        remindersToSend.push({ row, reminderKey });
      }
    }
  }

  if (remindersToSend.length === 0) {
    console.log('   ℹ️ No bookings require a 30-day reminder today.');
    return { sentReminders };
  }

  console.log(`   🔔 Found ${remindersToSend.length} booking(s) for 30-day reminder. Sending to channel...`);

  const parts = [];
  parts.push(`🔔 <b>30-Day Check-in & Payment Reminders</b>\n`);
  parts.push(`🕐 Checked at: ${today.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })}\n`);
  parts.push(`We have <b>${remindersToSend.length}</b> customer(s) checking in 30 days from now:\n`);

  for (const item of remindersToSend) {
    const { row, reminderKey } = item;
    const code = codeIndex !== -1 ? (row[codeIndex] || '—').toString().trim() : '—';
    const name = nameIndex !== -1 ? (row[nameIndex] || '—').toString().trim() : '—';
    const checkIn = checkInIndex !== -1 ? (row[checkInIndex] || '—').toString().trim() : '—';
    const balance = balanceIndex !== -1 ? (row[balanceIndex] || '').toString().trim() : '';
    const balanceText = balance || 'no data in sheet';

    const isOutstanding = isNonZeroBalance(balance);
    const balanceStatusIcon = balance ? (isOutstanding ? '🔴' : '✅') : '⚠️';

    parts.push(
      `\n━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Customer Name:</b> ${escapeHtml(name)}\n` +
      `🔑 <b>Customer Code:</b> <code>${escapeHtml(code)}</code>\n` +
      `• <b>Check-In:</b> ${escapeHtml(checkIn)}\n` +
      `• <b>Balance:</b> ${balanceStatusIcon} ${escapeHtml(balanceText)}\n`
    );

    // Mark as sent
    sentReminders[reminderKey] = { sentAt: today.toISOString() };
  }

  const fullMessage = parts.join('');
  const LIMIT = 4000;
  
  if (fullMessage.length <= LIMIT) {
    await sendMessage(fullMessage, null, REMINDER_CHANNEL_ID);
  } else {
    let chunk = '';
    const lines = fullMessage.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((chunk + line + '\n').length > LIMIT) {
        await sendMessage(chunk, null, REMINDER_CHANNEL_ID);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk.trim()) {
      await sendMessage(chunk, null, REMINDER_CHANNEL_ID);
    }
  }

  console.log(`   ✅ 30-day reminders sent to channel.`);
  return { sentReminders };
}

module.exports = { checkAndSend30DayReminders, getKualaLumpurDaysDifference, isNonZeroBalance };
