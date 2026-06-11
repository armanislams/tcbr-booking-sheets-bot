const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Sends a Telegram message.
 * @param {string} text - The message text (supports Telegram HTML formatting)
 */
async function sendMessage(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('   ⚠️  Telegram not configured. Skipping notification.');
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/**
 * Format a row's data as a compact HTML list using headers.
 */
function formatRow(row, headers) {
  return headers
    .map((header, i) => {
      const val = (row[i] || '').toString().trim();
      if (!val) return null;
      return `  • <b>${escapeHtml(header)}:</b> ${escapeHtml(val)}`;
    })
    .filter(Boolean)
    .join('\n');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build and send a Telegram alert summarizing detected changes.
 */
async function sendTelegramAlert({ newRows = [], modifiedRows = [], error = null, checkedAt, offlineInfo }) {
  const now = checkedAt || new Date();
  const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' });
  const timestamp = now.toLocaleString();

  // ── Error notification ──────────────────────────────────────────────────
  if (error) {
    await sendMessage(
      `🚨 <b>Sheets Bot Error</b>\n` +
      `🕐 ${timestamp}\n\n` +
      `❌ ${escapeHtml(error)}`
    );
    return;
  }

  const parts = [];

  let offlineHeader = '';
  if (offlineInfo && offlineInfo.wasOffline) {
    offlineHeader = `🔌 <b>Bot Back Online</b> (Offline for: <code>${escapeHtml(offlineInfo.duration)}</code>)\n`;
  }

  parts.push(
    (offlineHeader ? offlineHeader + '\n' : '') +
    `📊 <b>Sheets Monitor — ${escapeHtml(monthName)}</b>\n` +
    `🕐 Checked at: ${timestamp}\n`
  );

  // ── New rows ─────────────────────────────────────────────────────────────
  if (newRows.length > 0) {
    parts.push(`\n🟢 <b>${newRows.length} New Row(s) This Month:</b>`);
    for (const entry of newRows.slice(0, 10)) { // cap at 10 to avoid huge messages
      parts.push(
        `\n━━━━━━━━━━━━━━━\n` +
        formatRow(entry.row, entry.headers)
      );
    }
    if (newRows.length > 10) {
      parts.push(`\n  ... and ${newRows.length - 10} more new rows.`);
    }
  }

  // ── Modified rows ─────────────────────────────────────────────────────────
  if (modifiedRows.length > 0) {
    parts.push(`\n\n🟡 <b>${modifiedRows.length} Modified Row(s) This Month:</b>`);
    for (const entry of modifiedRows.slice(0, 10)) {
      const changesText = entry.changes
        .map(c =>
          `  • <b>${escapeHtml(c.column)}:</b>\n` +
          `    ❌ Was: ${escapeHtml(c.before) || '(empty)'}\n` +
          `    ✅ Now: ${escapeHtml(c.after)  || '(empty)'}`
        )
        .join('\n');
      parts.push(`\n━━━━━━━━━━━━━━━\nRow: <i>${escapeHtml(entry.row[0] || entry.key)}</i>\n${changesText}`);
    }
    if (modifiedRows.length > 10) {
      parts.push(`\n  ... and ${modifiedRows.length - 10} more modified rows.`);
    }
  }

  const fullMessage = parts.join('');

  // Telegram has a 4096 char limit per message — split if needed
  const LIMIT = 4000;
  if (fullMessage.length <= LIMIT) {
    await sendMessage(fullMessage);
  } else {
    // Send in chunks
    let chunk = '';
    const lines = fullMessage.split('\n');
    for (const line of lines) {
      if ((chunk + line + '\n').length > LIMIT) {
        await sendMessage(chunk);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk.trim()) await sendMessage(chunk);
  }
}

module.exports = { sendTelegramAlert };
