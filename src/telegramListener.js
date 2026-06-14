const { acknowledgeEvent, loadHistory, loadSnapshot, getDbStatus } = require('./snapshot');

let lastUpdateId = 0;
let runCheckCallback = null;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Sends a message back to a specific Telegram chat.
 */
async function sendDirectMessage(chatId, text) {
  if (!BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('   ❌ Failed to send direct Telegram reply:', err.message);
  }
}

/**
 * Parses and routes Telegram updates (bot commands & button clicks).
 */
async function handleTelegramUpdate(update) {
  if (!BOT_TOKEN) return;

  // ── 1. Handle Bot Commands ────────────────────────────────────────────────
  const message = update.message || update.channel_post;
  if (message && message.text) {
    const text = message.text.trim();
    const chatId = message.chat.id;

    if (text.startsWith('/')) {
      const command = text.split(' ')[0].split('@')[0].toLowerCase();
      console.log(`💬 Received Telegram command: "${command}" from chat ${chatId}`);

      if (command === '/help') {
        const helpMsg = `🤖 <b>Sheets Bot Help Menu</b>\n\n` +
          `• <b>/status</b> - Get database, uptime, and check status.\n` +
          `• <b>/summary</b> - List current month bookings.\n` +
          `• <b>/check</b> - Trigger a manual sheet check right now.\n` +
          `• <b>/remind</b> - Trigger manual check and send 30-day reminders.\n` +
          `• <b>/help</b> - View this menu.`;
        await sendDirectMessage(chatId, helpMsg);
      }

      else if (command === '/status') {
        const history = await loadHistory();
        const lastCheck = history[0]?.checkedAt
          ? new Date(history[0].checkedAt).toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })
          : 'Never';
        const dbStat = getDbStatus();

        const statusMsg = `ℹ️ <b>Sheets Bot Status</b>\n\n` +
          `• <b>Status:</b> Running 🟢\n` +
          `• <b>Database:</b> ${dbStat.connected ? 'Connected 🟢' : 'Disconnected 🔴'} (${dbStat.type})\n` +
          `• <b>Last Check:</b> <code>${lastCheck}</code>\n` +
          `• <b>Logs Count:</b> ${history.length} event(s)`;

        await sendDirectMessage(chatId, statusMsg);
      }

      else if (command === '/check') {
        await sendDirectMessage(chatId, '⏱ <b>Triggering manual check...</b>');
        if (runCheckCallback) {
          try {
            await runCheckCallback(false);
            await sendDirectMessage(chatId, '✅ <b>Check completed successfully!</b> Check dashboard or notifications for changes.');
          } catch (err) {
            await sendDirectMessage(chatId, `❌ <b>Error during check:</b> ${err.message}`);
          }
        } else {
          await sendDirectMessage(chatId, '❌ <b>Error:</b> Manual check trigger is not registered on the server.');
        }
      }

      else if (command === '/remind') {
        await sendDirectMessage(chatId, '⏱ <b>Triggering manual reminders check...</b>');
        if (runCheckCallback) {
          try {
            await runCheckCallback(true);
            await sendDirectMessage(chatId, '✅ <b>Reminders check completed successfully!</b> Check reminder channel for alerts.');
          } catch (err) {
            await sendDirectMessage(chatId, `❌ <b>Error during reminder check:</b> ${err.message}`);
          }
        } else {
          await sendDirectMessage(chatId, '❌ <b>Error:</b> Manual check trigger is not registered on the server.');
        }
      }

      else if (command === '/summary') {
        const snapshot = await loadSnapshot();
        if (!snapshot || !snapshot.monthMap || Object.keys(snapshot.monthMap).length === 0) {
          await sendDirectMessage(chatId, '📅 <b>No active bookings found for this month in snapshot.</b>');
          return;
        }

        const now = new Date();
        const monthName = now.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
        const bookings = Object.values(snapshot.monthMap);

        let msg = `📅 <b>Current Month Bookings (${monthName})</b>\n`;
        // Sort bookings by check-in date row index or checkin date representation
        bookings.forEach((b, i) => {
          if (i < 15) { // cap at 15 to fit in message
            const code = b.row[1] || '—';
            const name = b.row[3] || '—';
            const checkIn = b.row[7] || '—';
            msg += `\n${i+1}. <code>${code}</code>: <b>${name}</b> (In: ${checkIn})`;
          }
        });

        if (bookings.length > 15) {
          msg += `\n\n... and ${bookings.length - 15} more. View the dashboard for full details.`;
        }

        await sendDirectMessage(chatId, msg);
      }
    }
  }

  // ── 2. Handle Inline Button Clicks (Acknowledge) ──────────────────────────
  if (update.callback_query) {
    const callbackQuery = update.callback_query;
    const data = callbackQuery.data;
    const message = callbackQuery.message;
    const callbackQueryId = callbackQuery.id;

    if (data === 'noop_rec' || data === 'noop_div') {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: 'This alert has already been acknowledged.'
          })
        });
      } catch (err) {}
      return;
    }

    if (data.startsWith('ack_rec:') || data.startsWith('ack_div:')) {
      const isRec = data.startsWith('ack_rec:');
      const category = isRec ? 'reception' : 'dive_center';
      const catLabel = isRec ? 'Reception' : 'Dive Center';
      const eventId = data.substring(8);
      
      const username = callbackQuery.from.username
        ? `@${callbackQuery.from.username}`
        : `${callbackQuery.from.first_name} ${callbackQuery.from.last_name || ''}`.trim();

      console.log(`💬 Received Acknowledge ${category} click from Telegram user ${username} for event ${eventId}`);
      const success = await acknowledgeEvent(eventId, username, category);

      // Answer Callback Query so the Telegram UI stops loading
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callback_query_id: callbackQueryId,
            text: success ? `${catLabel} Acknowledged! ✅` : 'Already Acknowledged or Event Not Found'
          })
        });
      } catch (err) {}

      if (success && message) {
        // Fetch the updated event to see both fields
        const history = await loadHistory();
        const eventObj = history.find(item => item.id === eventId) || {};

        // Build the new reply markup
        const row = [];
        if (eventObj.acknowledgedReception) {
          row.push({
            text: `✅ Reception (${eventObj.acknowledgedReceptionBy})`,
            callback_data: 'noop_rec'
          });
        } else {
          row.push({
            text: '🛎 Reception',
            callback_data: `ack_rec:${eventId}`
          });
        }

        if (eventObj.acknowledgedDiveCenter) {
          row.push({
            text: `✅ Dive Center (${eventObj.acknowledgedDiveCenterBy})`,
            callback_data: 'noop_div'
          });
        } else {
          row.push({
            text: '🤿 Dive Center',
            callback_data: `ack_div:${eventId}`
          });
        }

        const replyMarkup = { inline_keyboard: [row] };

        // Edit the message reply markup (retains original HTML text format!)
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: message.chat.id,
              message_id: message.message_id,
              reply_markup: replyMarkup
            })
          });
        } catch (err) {
          console.error('   ❌ Failed to edit Telegram message reply markup:', err.message);
        }
      }
    }
  }
}

/**
 * Initializes and starts the long-polling loop for Telegram updates.
 */
async function startTelegramListener(runCheckFn) {
  if (!BOT_TOKEN) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN not set. Telegram updates listener disabled.');
    return;
  }

  runCheckCallback = runCheckFn;
  console.log('🤖 Starting Telegram Updates Listener...');

  // Initialize offset by fetching the last pending update (so we don't replay old history)
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=1&offset=-1`);
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        lastUpdateId = data.result[0].update_id + 1;
      }
    }
  } catch (err) {
    console.error('⚠️ Failed to initialize Telegram update ID offset:', err.message);
  }

  // Poll Telegram every 5 seconds for new updates
  setInterval(async () => {
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId}&timeout=3`;
      const res = await fetch(url);
      if (!res.ok) return;

      const data = await res.json();
      if (!data.ok || !data.result) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    } catch (err) {
      // Catch and ignore network connectivity fluctuations
    }
  }, 5000);
}

module.exports = { startTelegramListener };
