const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * Sends a Telegram message.
 * @param {string} text - The message text (supports Telegram HTML formatting)
 * @param {object} replyMarkup - Optional Telegram reply_markup (e.g. inline keyboard)
 * @param {string} targetChatId - Target chat ID
 * @returns {number|null} The message_id of the sent message, or null on failure
 */
async function sendMessage(text, replyMarkup = null, targetChatId = CHAT_ID) {
  if (!BOT_TOKEN || !targetChatId) {
    console.warn('   ⚠️  Telegram not configured. Skipping notification.');
    return null;
  }

  const target = targetChatId || CHAT_ID;
  if (!targetChatId) {
    console.warn(`   ⚠️  sendMessage called without targetChatId. Falling back to TELEGRAM_CHAT_ID.`);
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const requestBody = {
    chat_id: targetChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (replyMarkup) {
    requestBody.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error: ${response.statusText} (${errorText})`);
  }

  const data = await response.json();
  return data?.result?.message_id || null;
}

/**
 * Deletes a Telegram message by chat_id and message_id.
 * @param {string} chatId
 * @param {number} messageId
 */
async function deleteMessage(chatId, messageId) {
  if (!BOT_TOKEN || !chatId || !messageId) return;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    if (!response.ok) {
      console.warn(`   ⚠️  Failed to delete Telegram message ${messageId}: ${response.statusText}`);
    }
  } catch (err) {
    console.warn(`   ⚠️  Failed to delete Telegram message ${messageId}: ${err.message}`);
  }
}

const EXCLUDED_HEADERS = [
  'ROW_COLOR',
  'TOTAL AMOUNT', 'DEPOSIT', 'BALANCE', 'STATUS',
  'ROOM TYPE', 'STAYING DAYS', 'SHARING', 'ROOM SHARING'
];

/**
 * Format a row's data as a compact HTML list using headers.
 */
function formatRow(row, headers) {
  return headers
    .map((header, i) => {
      const val = (row[i] || '').toString().trim();
      if (!val) return null;
      const headerUpper = header.toUpperCase().trim();
      if (EXCLUDED_HEADERS.includes(headerUpper)) return null;
      return `  • <b>${escapeHtml(header)}:</b> ${escapeHtml(val)}`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Format a modified row's data, appending a 🟡 marker to changed columns.
 */
function formatModifiedRow(row, headers, changes) {
  const changedColumns = new Set(changes.map(c => c.column));
  return headers
    .map((header, i) => {
      const val = (row[i] || '').toString().trim();
      if (!val) return null;
      const headerUpper = header.toUpperCase().trim();
      if (EXCLUDED_HEADERS.includes(headerUpper)) return null;
      const isChanged = changedColumns.has(header);
      const marker = isChanged ? ' 🟡 (changed)' : '';
      return `  • <b>${escapeHtml(header)}${marker}:</b> ${escapeHtml(val)}`;
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
async function sendTelegramAlert({ newRows = [], modifiedRows = [], error = null, checkedAt, offlineInfo, eventId, chatId }) {
  const now = checkedAt || new Date();
  const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
  const timestamp = now.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' });

  const effectiveChatId = chatId || CHAT_ID;
  if (!chatId) {
    console.warn(`   ⚠️  No chatId provided to sendTelegramAlert. Falling back to TELEGRAM_CHAT_ID (${CHAT_ID}).`);
  }
  console.log(`   📨 sendTelegramAlert → target chat: ${effectiveChatId}`);

  // ── Error notification ──────────────────────────────────────────────────
  if (error) {
    await sendMessage(
      `🚨 <b>Sheets Bot Error</b>\n` +
      `🕐 ${timestamp}\n\n` +
      `❌ ${escapeHtml(error)}`,
      null,
      chatId
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
      const filteredChanges = entry.changes.filter(c => !EXCLUDED_HEADERS.includes(c.column.toUpperCase().trim()));
      const fullRowText = formatModifiedRow(entry.row, entry.headers, filteredChanges);
      
      const changesText = filteredChanges
        .map(c =>
          `  • <b>${escapeHtml(c.column)}:</b>\n` +
          `    ❌ Was: ${escapeHtml(c.before) || '(empty)'}\n` +
          `    ✅ Now: ${escapeHtml(c.after)  || '(empty)'}`
        )
        .join('\n');

      const changesSection = changesText
        ? `\n\n<b>⚡ What Changed:</b>\n${changesText}`
        : '';

      parts.push(
        `\n━━━━━━━━━━━━━━━\n` +
        `<b>📋 Full Row Data:</b>\n${fullRowText}${changesSection}`
      );
    }
    if (modifiedRows.length > 10) {
      parts.push(`\n  ... and ${modifiedRows.length - 10} more modified rows.`);
    }
  }

  const fullMessage = parts.join('');

  // Create acknowledgement buttons for Telegram changes (Reception and Dive Center)
  const replyMarkup = eventId ? {
    inline_keyboard: [
      [
        {
          text: '🛎 Reception',
          callback_data: `ack_rec:${eventId}`
        },
        {
          text: '🤿 Dive Center',
          callback_data: `ack_div:${eventId}`
        }
      ]
    ]
  } : null;

  // Telegram has a 4096 char limit per message — split if needed
  const LIMIT = 4000;
  if (fullMessage.length <= LIMIT) {
    await sendMessage(fullMessage, replyMarkup, chatId);
  } else {
    // Send in chunks
    let chunk = '';
    const lines = fullMessage.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((chunk + line + '\n').length > LIMIT) {
        await sendMessage(chunk, null, chatId);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk.trim()) {
      await sendMessage(chunk, replyMarkup, chatId);
    }
  }
}

/**
 * Edits a Telegram message text by chat_id and message_id.
 * @param {string} chatId
 * @param {number} messageId
 * @param {string} text
 * @returns {boolean} True if successful, false otherwise
 */
async function editMessageText(chatId, messageId, text, replyMarkup = null) {
  if (!BOT_TOKEN || !chatId || !messageId) return false;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
  const requestBody = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (replyMarkup) {
    requestBody.reply_markup = replyMarkup;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error: ${response.statusText} (${errorText})`);
  }

  const data = await response.json();
  return data?.ok || false;
}

module.exports = { sendTelegramAlert, sendMessage, deleteMessage, editMessageText };
