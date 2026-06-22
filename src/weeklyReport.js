const crypto = require('crypto');
const { sendMessage, deleteMessage, editMessageText } = require('./telegram');
const { findHeaderRowIndex, parseDate, getMonthNameFromText } = require('./detector');

const KL_TIMEZONE = 'Asia/Kuala_Lumpur';

/**
 * PAX CALCULATION POLICY:
 * - Total pax = Snorkel + Diving + Course (all three columns).
 * - Snorkel (Column E): Count all pax entries (A=adults, C=children, B=babies).
 * - Diving (Column F): Count all diving pax, including dive-only customers.
 * - Course (Column G): Each course entry's leading number is the pax count.
 *   Multiple entries in one string are summed (e.g., "2 owc 1 aowc" = 3 pax).
 */

/**
 * Get the KL timezone date components for a given Date object.
 */
function getKLDate(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: KL_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = formatter.formatToParts(date);
  return {
    year:  parseInt(parts.find(p => p.type === 'year').value, 10),
    month: parseInt(parts.find(p => p.type === 'month').value, 10) - 1,
    day:   parseInt(parts.find(p => p.type === 'day').value, 10),
  };
}

/**
 * Parse pax string from Column E (SNORKELLING).
 * Handles formats like:
 *   "12A 2C"            → { a:12, c:2, b:0 }
 *   "1A 1C 1Baby"       → { a:1,  c:1, b:1 }
 *   "5A + 2 Instructor" → { a:7,  c:0, b:0 }  (instructors count as adults)
 *   "2 Instructor"      → { a:2,  c:0, b:0 }
 *   "7A"                → { a:7,  c:0, b:0 }
 *   "8A2C1bABY"         → { a:8,  c:2, b:1 }  (case insensitive, no spaces)
 */
function parsePax(str) {
  if (!str || typeof str !== 'string') return { a: 0, c: 0, b: 0 };

  // 1. Remove the first set of parentheses (if any) to ignore its numeric data (e.g. dive counts)
  let s = str.replace(/\([^)]*\)/, '').trim();
  if (!s) return { a: 0, c: 0, b: 0 };

  let adults = 0;
  let children = 0;
  let babies = 0;

  // 2. Identify "instructor" entries and categorize them as Adult (A)
  const instructorRegex = /\+?\s*(\d*)\s*instructor/i;
  let instructorMatch = s.match(instructorRegex);
  while (instructorMatch) {
    const countStr = instructorMatch[1];
    const count = countStr ? parseInt(countStr, 10) : 1;
    adults += count;
    // Remove this instructor match to avoid double-processing
    s = s.replace(instructorMatch[0], '').trim();
    instructorMatch = s.match(instructorRegex);
  }

  // 3. Regular parsing logic
  const numA = s.match(/(\d+)\s*A(?=\s|$|[^A-Za-z])/i);
  const numC = s.match(/(\d+)\s*C(?=\s|$|[^A-Za-z])/i);
  const numB = s.match(/(\d+)\s*Baby\b/i);

  if (numA) adults += parseInt(numA[1], 10);
  if (numC) children += parseInt(numC[1], 10);
  if (numB) babies += parseInt(numB[1], 10);

  return { a: adults, c: children, b: babies };
}

/**
 * Parse pax string from Column F (DIVING).
 * Handles all common variations:
 *   "2A (5 Dives)"   → { a:2, c:0, b:0 }   — standard format
 *   "2 A (5 Dives)"  → { a:2, c:0, b:0 }   — space before A
 *   "2A(5 Dives)"    → { a:2, c:0, b:0 }   — no space before parenthetical
 *   "A (5 Dives)"    → { a:1, c:0, b:0 }   — no number, defaults to 1
 *   "2a"              → { a:2, c:0, b:0 }   — lowercase, no parenthetical
 *   "5 dives"         → { a:5, c:0, b:0 }   — just a number + text
 *   "2"               → { a:2, c:0, b:0 }   — bare number
 *   ""                → { a:0, c:0, b:0 }   — empty
 */
function parseDivingPax(str) {
  if (!str || typeof str !== 'string') return { a: 0, c: 0, b: 0 };

  // 1. Remove the first set of parentheses (if any) to ignore its numeric data (e.g. dive counts)
  let s = str.replace(/\([^)]*\)/, '').trim();
  if (!s) return { a: 0, c: 0, b: 0 };

  let adults = 0;
  let children = 0;
  let babies = 0;

  // 2. Identify "instructor" entries and categorize them as Adult (A)
  const instructorRegex = /\+?\s*(\d*)\s*instructor/i;
  let instructorMatch = s.match(instructorRegex);
  while (instructorMatch) {
    const countStr = instructorMatch[1];
    const count = countStr ? parseInt(countStr, 10) : 1;
    adults += count;
    // Remove this instructor match to avoid double-processing
    s = s.replace(instructorMatch[0], '').trim();
    instructorMatch = s.match(instructorRegex);
  }

  // 3. Regular parsing logic
  // Try "NUMBER A" or just "A" pattern (with optional space, case insensitive)
  const numA = s.match(/(\d+)\s*A(?=\s|$|[^A-Za-z])/i);
  if (numA) {
    adults += parseInt(numA[1], 10);
  } else if (/\bA\b/i.test(s)) {
    // Just "A" with no leading number → default to 1
    adults += 1;
  } else {
    // No "A" found — try bare number at start: "5 dives", "2", etc.
    const bareNum = s.match(/^(\d+)/);
    if (bareNum) {
      adults += parseInt(bareNum[1], 10);
    }
  }

  // Also check for C/B patterns in case diving has children/babies
  const numC = s.match(/(\d+)\s*C\b/i);
  const numB = s.match(/(\d+)\s*Baby\b/i);
  if (numC) children += parseInt(numC[1], 10);
  if (numB) babies += parseInt(numB[1], 10);

  return { a: adults, c: children, b: babies };
}

/**
 * Parse pax string from Column G (COURSE).
 * Each course entry's leading number is the pax count.
 * Multiple entries in one string are summed.
 *
 * Handles all common variations:
 *   "1 OWC"              → { a:1 }  (single entry)
 *   "2 owc 1 aowc"       → { a:3 }  (2+1=3, multiple entries)
 *   "2 owc 2 aowc 2efr-res" → { a:6 }  (2+2+2=6)
 *   "5"                  → { a:5 }  (bare number)
 *   "OWC"                → { a:1 }  (no number, defaults to 1)
 *   ""                   → { a:0 }
 */
function parseCoursePax(str) {
  if (!str || typeof str !== 'string') return { a: 0, c: 0, b: 0 };
  
  // Clean up any extra dive count or free boat dive text
  // e.g. "+ 4 Dives", "Free 1 boat dive each", "free 1 boat dives"
  let s = str.replace(/\+?\s*(?:free\s*)?\d+\s*(?:boat\s*)?dives?(?:\s*each)?/gi, '').trim();
  if (!s) return { a: 0, c: 0, b: 0 };

  let total = 0;

  // Match all "X COURSE_TYPE" patterns (e.g., "2 owc", "1aowc", "3efr-res")
  const matches = s.match(/\d+\s*[A-Za-z][A-Za-z-]*/g);
  if (matches) {
    for (const m of matches) {
      const numMatch = m.match(/^(\d+)/);
      if (numMatch) {
        total += parseInt(numMatch[1], 10);
      }
    }
    return { a: total, c: 0, b: 0 };
  }

  // No course-type pattern found — check if it's just a bare number
  const bareNum = s.match(/^(\d+)$/);
  if (bareNum) {
    return { a: parseInt(bareNum[1], 10), c: 0, b: 0 };
  }

  // It's a course type name without a number — default to 1
  if (/[A-Z]/i.test(s)) {
    return { a: 1, c: 0, b: 0 };
  }

  return { a: 0, c: 0, b: 0 };
}

/**
 * Sum two pax objects.
 */
function addPax(p1, p2) {
  const a = p1 || { a: 0, c: 0, b: 0 };
  const b = p2 || { a: 0, c: 0, b: 0 };
  return { a: a.a + b.a, c: a.c + b.c, b: a.b + b.b };
}

/**
 * Format pax object into readable string.
 * e.g. { a:16, c:2, b:0 } → "16A 2C"
 * All zeros → "0"
 */
function formatPax(p) {
  if (!p) return '0';
  const parts = [];
  if (p.a > 0) parts.push(`${p.a}A`);
  if (p.c > 0) parts.push(`${p.c}C`);
  if (p.b > 0) parts.push(`${p.b}B`);
  return parts.length > 0 ? parts.join(' ') : '0';
}

/**
 * Format a customer's pax breakdown for display.
 * Shows total + per-activity if there are multiple activities.
 * e.g. "5A 2C (🤿3A 🏊2A 2C 📚1)"
 */
function formatCustomerPax(customer) {
  const total = formatPax(customer.pax);
  const parts = [];

  // Snorkelling
  const sPax = formatPax(customer.snorkel);
  if (sPax !== '0') parts.push(`🤿${sPax}`);

  // Diving
  const dPax = formatPax(customer.diving);
  if (dPax !== '0') parts.push(`🏊${dPax}`);

  // Course — now { a, c, b }, course students are adults
  if (customer.course) {
    const cTotal = customer.course.a + customer.course.c + customer.course.b;
    if (cTotal > 0) parts.push(`📚${cTotal}`);
  }

  if (parts.length === 0) return total;
  return `${total} (${parts.join(' ')})`;
}

/**
 * Check if a date is within the next 10 days from today (inclusive) in KL timezone.
 */
function isWithinNextTenDays(date) {
  if (!date) return false;
  const now = new Date();
  const todayKL = getKLDate(now);
  const targetKL = getKLDate(date);

  const todayUTC = Date.UTC(todayKL.year, todayKL.month, todayKL.day);
  const targetUTC = Date.UTC(targetKL.year, targetKL.month, targetKL.day);

  const diffDays = (targetUTC - todayUTC) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays < 10;
}

/**
 * Get KL date as a YYYY-MM-DD string for grouping.
 */
function toKLDateString(date) {
  const d = getKLDate(date);
  return `${d.year}-${String(d.month + 1).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/**
 * Format a KL date as "Sun, 21 Jun".
 */
function formatDayLabel(date) {
  const d = getKLDate(date);
  const jsDate = new Date(d.year, d.month, d.day);
  const dayName = jsDate.toLocaleString('en-US', { weekday: 'short', timeZone: KL_TIMEZONE });
  const monthName = jsDate.toLocaleString('en-US', { month: 'short', timeZone: KL_TIMEZONE });
  return `${dayName}, ${d.day} ${monthName}`;
}

/**
 * Build the 10-day report from sheet rows.
 * Returns { dateRange, generatedAt, days: [{ label, dateStr, checkIns: [{code, name, pax, snorkel, diving, course}], checkOuts: [...] }] }
 */
function buildReport(rows) {
  const headerIndex = findHeaderRowIndex(rows);
  const headers = rows[headerIndex] || [];

  // Find column indices by header name (case-insensitive, flexible matching)
  const codeIdx      = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'CODE');
  const nameIdx      = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'NAME');
  const checkInIdx   = headers.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN', 'CHECK IN DATE', 'CHECK-IN DATE'].includes(h.toString().trim().toUpperCase()));
  const checkOutIdx  = headers.findIndex(h => h && ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT', 'CHECK OUT DATE', 'CHECK-OUT DATE'].includes(h.toString().trim().toUpperCase()));

  // Activity columns: SNORKELLING (E), DIVING (F), COURSE (G)
  // Use includes() for flexible matching (handles "Snorkelling", "SNORKELLING", "Snorkel", etc.)
  let snorkelIdx = headers.findIndex(h => {
    if (!h) return false;
    const u = h.toString().trim().toUpperCase();
    return u === 'SNORKELLING' || u === 'SNORKEL' || u.includes('SNORKEL');
  });
  if (snorkelIdx === -1) snorkelIdx = 4; // Fallback to Column E

  let divingIdx = headers.findIndex(h => {
    if (!h) return false;
    const u = h.toString().trim().toUpperCase();
    return u === 'DIVING' || u === 'DIVE' || u.includes('DIVE');
  });
  if (divingIdx === -1) divingIdx = 5; // Fallback to Column F

  let courseIdx = headers.findIndex(h => {
    if (!h) return false;
    const u = h.toString().trim().toUpperCase();
    return u === 'COURSE' || u.includes('COURSE');
  });
  if (courseIdx === -1) courseIdx = 6; // Fallback to Column G

  // Build 10 day buckets
  const now = new Date();
  const todayKL = getKLDate(now);
  const days = [];

  for (let i = 0; i < 10; i++) {
    const d = new Date(todayKL.year, todayKL.month, todayKL.day + i);
    days.push({
      label: formatDayLabel(d),
      dateStr: toKLDateString(d),
      checkIns: [],
      checkOuts: [],
    });
  }

  // Scan data rows
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.slice(0, -1).every(cell => !cell || cell.toString().trim() === '')) {
      continue;
    }

    // Exclude cancelled, postponed, changed, or duplicate bookings
    const colorIdx = headers.findIndex(h => h && h.toString().trim().toUpperCase() === 'ROW_COLOR');
    const rowColor = colorIdx !== -1 ? (row[colorIdx] || 'WHITE') : 'WHITE';

    const remarkIdx = headers.findIndex(h => h && ['REMARK', 'REMARKS'].includes(h.toString().trim().toUpperCase()));
    const remarkVal = remarkIdx !== -1 ? (row[remarkIdx] || '') : '';

    if (rowColor === 'WHITE') {
      const lowerRemark = remarkVal.toLowerCase();
      const isSpecialRemark = lowerRemark.includes('cancel') || lowerRemark.includes('cancle') || lowerRemark.includes('cancled') || lowerRemark.includes('cancelled') ||
                             lowerRemark.includes('postpone') || lowerRemark.includes('postponed') ||
                             lowerRemark.includes('change') || lowerRemark.includes('changed') || lowerRemark.includes('chage') || lowerRemark.includes('chaged') ||
                             lowerRemark.includes('double') || lowerRemark.includes('dup');
      const isHistorical = lowerRemark.includes('previously') || lowerRemark.includes('prev');
      if (isSpecialRemark && !isHistorical) {
        continue;
      }
    }

    try {
      const code  = codeIdx !== -1   ? (row[codeIdx]  || '').toString().trim() : '';
      const name  = nameIdx !== -1   ? (row[nameIdx]  || '').toString().trim() : '';

      // Skip rows with no code AND no name (likely empty or metadata rows)
      if (!code && !name) continue;

      // Parse pax from all three activity columns
      const snorkelStr = snorkelIdx !== -1 ? (row[snorkelIdx] || '').toString().trim() : '';
      const divingStr  = divingIdx  !== -1 ? (row[divingIdx]  || '').toString().trim() : '';
      const courseStr  = courseIdx  !== -1 ? (row[courseIdx]  || '').toString().trim() : '';

      const snorkel = parsePax(snorkelStr);        // Column E: { a, c, b }
      const diving  = parseDivingPax(divingStr);    // Column F: { a, c, b }
      const course  = parseCoursePax(courseStr);    // Column G: { a, c, b }

      // Combine pax into total — Snorkel + Diving + Course.
      // All three activity columns contribute to the passenger count.
      const pax = {
        a: snorkel.a + diving.a + course.a,
        c: snorkel.c + diving.c + course.c,
        b: snorkel.b + diving.b + course.b,
      };

      const checkInRaw  = checkInIdx  !== -1 ? (row[checkInIdx]  || '').toString().trim() : '';
      const checkOutRaw = checkOutIdx !== -1 ? (row[checkOutIdx] || '').toString().trim() : '';

      const checkInDate  = parseDate(checkInRaw);
      const checkOutDate = parseDate(checkOutRaw);

      const customer = { code, name, pax, snorkel, diving, course, snorkelStr, divingStr, courseStr };

      // Check-in within next 10 days
      if (checkInDate && isWithinNextTenDays(checkInDate)) {
        const key = toKLDateString(checkInDate);
        const bucket = days.find(d => d.dateStr === key);
        if (bucket) {
          bucket.checkIns.push(customer);
        }
      }

      // Check-out within next 10 days
      if (checkOutDate && isWithinNextTenDays(checkOutDate)) {
        const key = toKLDateString(checkOutDate);
        const bucket = days.find(d => d.dateStr === key);
        if (bucket) {
          bucket.checkOuts.push(customer);
        }
      }
    } catch (err) {
      // Skip malformed rows gracefully — log but don't crash
      console.warn(`   ⚠️  Skipping malformed row ${i}: ${err.message}`);
      continue;
    }
  }

  // Build date range string
  const firstDay = new Date(todayKL.year, todayKL.month, todayKL.day);
  const lastDay  = new Date(todayKL.year, todayKL.month, todayKL.day + 9);
  const rangeStart = `${firstDay.toLocaleString('en-US', { month: 'short', timeZone: KL_TIMEZONE })} ${firstDay.getDate()}`;
  const rangeEnd   = `${lastDay.toLocaleString('en-US', { month: 'short', timeZone: KL_TIMEZONE })} ${lastDay.getDate()}, ${lastDay.getFullYear()}`;

  const generatedAt = now.toLocaleString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: KL_TIMEZONE,
  });

  return {
    dateRange: `${rangeStart} - ${rangeEnd}`,
    generatedAt,
    days,
  };
}

/**
 * Format a single day into a Telegram HTML message.
 */
function formatDayMessage(report, day, isUpdated) {
  const lines = [];

  // Header only on first usage (we'll pass it from caller)
  lines.push(`━━━ 📅 ${day.label} ━━━`);

  // Check-outs
  // Note: c.pax = snorkel + diving + course (all activities included).
  if (day.checkOuts.length > 0) {
    lines.push(` <b>Check-out 08:30am (${day.checkOuts.length}):</b>`);
    let dayPax = { a: 0, c: 0, b: 0 };
    for (const c of day.checkOuts) {
      const codeStr = c.code ? `<code>${escapeHtml(c.code)}</code>` : '—';
      lines.push(` ${codeStr} - ${escapeHtml(c.name || '—')} - ${formatPax(c.pax)}`);
      dayPax = addPax(dayPax, c.pax);
    }
    lines.push(`  total: ${formatPax(dayPax)}`);
  } else {
    lines.push(` <b>Check-out 08:30am (0):</b> —`);
  }

  lines.push('');

  // Check-ins
  // Note: c.pax = snorkel + diving + course (all activities included).
  if (day.checkIns.length > 0) {
    lines.push(` <b>Check-in 10:30am (${day.checkIns.length}):</b>`);
    let dayPax = { a: 0, c: 0, b: 0 };
    for (const c of day.checkIns) {
      const codeStr = c.code ? `<code>${escapeHtml(c.code)}</code>` : '—';
      lines.push(`${codeStr} - ${escapeHtml(c.name || '—')} - ${formatPax(c.pax)}`);
      dayPax = addPax(dayPax, c.pax);
    }
    lines.push(`  total: ${formatPax(dayPax)}`);
  } else {
    lines.push(` <b>Check-in 10:30am (0):</b> —`);
  }

  return lines.join('\n').trim();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build and send the weekly report via Telegram — one message per date.
 * @param {Array[]} rows - Full sheet data rows
 * @param {string}  chatId - Target Telegram chat ID
 * @param {string}  reason - 'scheduled', 'updated', or 'manual'
 * @param {object}  prevMessages - Previous report messages { headerId, dateMessages: { "YYYY-MM-DD": msgId }, dateHashes: { "YYYY-MM-DD": hash } }
 * @param {string[]} changedDates - Which specific dates changed (for targeted update)
 * @returns {{ report, eventId, messages: { headerId, dateMessages, dateHashes } }}
 */
async function sendWeeklyReport(rows, chatId, reason = 'scheduled', prevMessages = null, changedDates = []) {
  const report = buildReport(rows);
  const eventId = crypto.randomUUID();

  // Accumulate previous messages and hashes to preserve history (even for dates outside the 10-day window)
  const dateMessages = { ...(prevMessages?.dateMessages || {}) };
  const dateHashes = { ...(prevMessages?.dateHashes || {}) };
  let headerId = prevMessages?.headerId || null;

  // Process each day in the current 10-day report window
  for (const day of report.days) {
    const dateStr = day.dateStr;
    const dayText = formatDayMessage(report, day, false);
    const hash = crypto.createHash('md5').update(dayText).digest('hex');

    const prevMsgId = prevMessages?.dateMessages?.[dateStr];
    const prevHash = prevMessages?.dateHashes?.[dateStr];

    const hasChanged = (prevHash !== hash) || changedDates.includes(dateStr);
    const needsSending = !prevMsgId || hasChanged;

    if (needsSending) {
      // Delete old message if it exists in channel
      if (prevMsgId) {
        console.log(`   🗑️  Deleting outdated message for ${dateStr}: ${prevMsgId}`);
        try {
          await deleteMessage(chatId, prevMsgId);
        } catch (err) {
          console.warn(`   ⚠️  Failed to delete message for date ${dateStr}:`, err.message);
        }
      }

      console.log(`   📨 Sending message for ${dateStr}`);
      const replyMarkup = {
        inline_keyboard: [
          [{ text: '✅ Verify', callback_data: `verify_report:${eventId}:${dateStr}` }]
        ]
      };
      const newMsgId = await sendMessage(dayText, replyMarkup, chatId);
      if (newMsgId) {
        dateMessages[dateStr] = newMsgId;
        dateHashes[dateStr] = hash;
      }
    } else {
      // Keep old message ID and hash
      dateMessages[dateStr] = prevMsgId;
      dateHashes[dateStr] = prevHash;
    }
  }

  // Update or send header message
  const headerText = `📋 <b>Customer Report: ${report.dateRange}</b>\n🕐 Generated: ${report.generatedAt}`;
  if (headerId) {
    console.log(`   ✏️  Editing report header message: ${headerId}`);
    try {
      await editMessageText(chatId, headerId, headerText);
    } catch (err) {
      if (err.message && err.message.includes('message is not modified')) {
        console.log('   ℹ️  Header message is unmodified.');
      } else {
        console.warn('   ⚠️  Failed to edit header message, sending a new one:', err.message);
        headerId = await sendMessage(headerText, null, chatId);
      }
    }
  } else {
    console.log('   📨 Sending new report header message');
    headerId = await sendMessage(headerText, null, chatId);
  }

  return {
    report,
    eventId,
    messages: { headerId, dateMessages, dateHashes }
  };
}

/**
 * Determine which specific dates are affected by new/modified rows.
 * Returns array of YYYY-MM-DD date strings.
 */
function getChangedDates(newRows, modifiedRows) {
  const dates = new Set();
  const allEntries = [...(newRows || []), ...(modifiedRows || [])];

  for (const entry of allEntries) {
    const row = entry.row || [];
    const headers = entry.headers || [];
    const checkInIdx = headers.findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
    const checkOutIdx = headers.findIndex(h => h && ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'].includes(h.toString().trim().toUpperCase()));

    if (checkInIdx !== -1) {
      const d = parseDate(row[checkInIdx]);
      if (d && isWithinNextTenDays(d)) dates.add(toKLDateString(d));
    }
    if (checkOutIdx !== -1) {
      const d = parseDate(row[checkOutIdx]);
      if (d && isWithinNextTenDays(d)) dates.add(toKLDateString(d));
    }
  }

  return Array.from(dates);
}

/**
 * Check if any new or modified rows affect the 10-day forward window.
 */
function affectsReportWindow(newRows, modifiedRows) {
  const allEntries = [...(newRows || []), ...(modifiedRows || [])];
  for (const entry of allEntries) {
    const row = entry.row || [];
    const checkInIdx  = (entry.headers || []).findIndex(h => h && ['CHECK IN', 'CHECK-IN', 'CHECKIN'].includes(h.toString().trim().toUpperCase()));
    const checkOutIdx = (entry.headers || []).findIndex(h => h && ['CHECK OUT', 'CHECK-OUT', 'CHECKOUT'].includes(h.toString().trim().toUpperCase()));

    if (checkInIdx !== -1) {
      const checkInDate = parseDate(row[checkInIdx]);
      if (checkInDate && isWithinNextTenDays(checkInDate)) return true;
    }
    if (checkOutIdx !== -1) {
      const checkOutDate = parseDate(row[checkOutIdx]);
      if (checkOutDate && isWithinNextTenDays(checkOutDate)) return true;
    }
  }
  return false;
}

module.exports = {
  parsePax,
  parseDivingPax,
  parseCoursePax,
  formatPax,
  formatCustomerPax,
  addPax,
  isWithinNextTenDays,
  buildReport,
  formatDayMessage,
  sendWeeklyReport,
  affectsReportWindow,
  getChangedDates,
  escapeHtml,
};
