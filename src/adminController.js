const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { 
  loadUsers, 
  saveUsers, 
  appendAuditLog, 
  loadAuditLogs, 
  loadBotConfig, 
  saveBotConfig,
  getDbStatus,
  getTotalChecksCount,
  loadSnapshot,
  loadHistory,
  saveSnapshot,
  addNote,
  getNotes
} = require('./snapshot');
const { fetchAndEnrichSheetData } = require('./sheets');
const { sendMessage } = require('./telegram');

// In-memory cache for dynamic bot settings
let activeConfig = null;

async function getOrLoadConfig() {
  if (!activeConfig) {
    activeConfig = await loadBotConfig();
  }
  return activeConfig;
}

/**
 * Get all user accounts (omitting password hashes)
 */
async function getUsers(req, res) {
  try {
    const users = await loadUsers();
    const safeUsers = users.map(u => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName || u.username,
      role: u.role,
      approved: u.approved !== false,
      createdAt: u.createdAt,
      isSeed: !!u.isSeed
    }));
    res.json({ success: true, users: safeUsers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Create a new user account (Admin direct creation)
 */
async function createUser(req, res) {
  try {
    const { username, displayName, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const users = await loadUsers();

    if (users.some(u => u.username && u.username.toLowerCase() === cleanUsername)) {
      return res.status(400).json({ error: `Username "${cleanUsername}" is already taken.` });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: crypto.randomUUID(),
      username: cleanUsername,
      displayName: displayName || cleanUsername,
      role: role === 'admin' ? 'admin' : 'operator',
      approved: true, // Created directly by Admin
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    await saveUsers(users);

    await appendAuditLog({
      action: 'USER_CREATED',
      username: req.user.username,
      role: req.user.role,
      details: `Created new ${newUser.role} user: ${cleanUsername}`,
      ip: req.ip
    });

    res.json({
      success: true,
      message: `User ${cleanUsername} created successfully.`,
      user: {
        id: newUser.id,
        username: newUser.username,
        displayName: newUser.displayName,
        role: newUser.role,
        approved: true,
        createdAt: newUser.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Approve a pending user account
 */
async function approveUser(req, res) {
  try {
    const { userId } = req.params;
    const users = await loadUsers();
    const user = users.find(u => u.id === userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    user.approved = true;
    await saveUsers(users);

    await appendAuditLog({
      action: 'USER_APPROVED',
      username: req.user.username,
      role: req.user.role,
      details: `Approved account for user: ${user.username}`,
      ip: req.ip
    });

    res.json({ success: true, message: `Account for ${user.username} has been approved.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Delete a user account
 */
async function deleteUser(req, res) {
  try {
    const { userId } = req.params;
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own active account.' });
    }

    let users = await loadUsers();
    const targetUser = users.find(u => u.id === userId);

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }

    users = users.filter(u => u.id !== userId);
    await saveUsers(users);

    await appendAuditLog({
      action: 'USER_DELETED',
      username: req.user.username,
      role: req.user.role,
      details: `Deleted user: ${targetUser.username} (${targetUser.role})`,
      ip: req.ip
    });

    res.json({ success: true, message: `User ${targetUser.username} deleted.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Change password for current user or target user
 */
async function changePassword(req, res) {
  try {
    const { userId, oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }

    const users = await loadUsers();
    const targetId = userId || req.user.id;
    const userIndex = users.findIndex(u => u.id === targetId);

    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Non-admin users must provide old password to change their password
    if (req.user.role !== 'admin' || targetId === req.user.id) {
      if (!oldPassword) {
        return res.status(400).json({ error: 'Old password is required.' });
      }
      const isValid = await bcrypt.compare(oldPassword, users[userIndex].password);
      if (!isValid) {
        return res.status(400).json({ error: 'Incorrect old password.' });
      }
    }

    users[userIndex].password = await bcrypt.hash(newPassword, 10);
    delete users[userIndex].isSeed; // Clear seed flag on password update
    await saveUsers(users);

    await appendAuditLog({
      action: 'USER_PASSWORD_CHANGED',
      username: req.user.username,
      role: req.user.role,
      details: `Password changed for user: ${users[userIndex].username}`,
      ip: req.ip
    });

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Get dynamic bot settings
 */
async function getBotSettings(req, res) {
  try {
    const config = await getOrLoadConfig();
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Get public branding configuration (unauthenticated)
 */
async function getPublicBranding(req, res) {
  try {
    const config = await getOrLoadConfig();
    const branding = {
      resortName: config.resortName,
      resortTagline: config.resortTagline,
      logoUrl: config.logoUrl,
      primaryColor: config.primaryColor,
      brandAccent: config.brandAccent,
      jettyName: config.jettyName,
      jettyMapUrl: config.jettyMapUrl,
      assemblyTime: config.assemblyTime,
      departureTime: config.departureTime,
      contactPhone: config.contactPhone
    };
    res.json({ success: true, branding });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Update dynamic bot settings & resort branding
 */
async function updateBotSettings(req, res) {
  try {
    const current = await getOrLoadConfig();
    const { 
      isPaused, quietHoursStart, quietHoursEnd, snoozeHours,
      resortName, resortTagline, logoUrl, primaryColor, brandAccent,
      jettyName, jettyMapUrl, assemblyTime, departureTime, contactPhone
    } = req.body;

    const newConfig = {
      ...current,
      isPaused: typeof isPaused === 'boolean' ? isPaused : current.isPaused,
      quietHoursStart: typeof quietHoursStart === 'number' ? quietHoursStart : current.quietHoursStart,
      quietHoursEnd: typeof quietHoursEnd === 'number' ? quietHoursEnd : current.quietHoursEnd,
      snoozeHours: typeof snoozeHours === 'number' ? snoozeHours : current.snoozeHours,
      resortName: typeof resortName === 'string' && resortName.trim() ? resortName.trim() : current.resortName,
      resortTagline: typeof resortTagline === 'string' ? resortTagline.trim() : current.resortTagline,
      logoUrl: typeof logoUrl === 'string' ? logoUrl.trim() : current.logoUrl,
      primaryColor: typeof primaryColor === 'string' && primaryColor.trim() ? primaryColor.trim() : current.primaryColor,
      brandAccent: typeof brandAccent === 'string' && brandAccent.trim() ? brandAccent.trim() : current.brandAccent,
      jettyName: typeof jettyName === 'string' && jettyName.trim() ? jettyName.trim() : current.jettyName,
      jettyMapUrl: typeof jettyMapUrl === 'string' && jettyMapUrl.trim() ? jettyMapUrl.trim() : current.jettyMapUrl,
      assemblyTime: typeof assemblyTime === 'string' ? assemblyTime.trim() : current.assemblyTime,
      departureTime: typeof departureTime === 'string' ? departureTime.trim() : current.departureTime,
      contactPhone: typeof contactPhone === 'string' ? contactPhone.trim() : current.contactPhone
    };

    activeConfig = newConfig;
    await saveBotConfig(newConfig);

    await appendAuditLog({
      action: 'BOT_SETTINGS_UPDATED',
      username: req.user.username,
      role: req.user.role,
      details: `Bot config updated: Resort="${newConfig.resortName}", Paused=${newConfig.isPaused}, QuietHours=${newConfig.quietHoursStart}:00-${newConfig.quietHoursEnd}:00`,
      ip: req.ip
    });

    res.json({ success: true, message: 'Bot settings updated successfully.', config: newConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Send test ping message to Telegram channel
 */
async function testTelegramPing(req, res) {
  try {
    const { channelType } = req.body; // 'main', 'report', or 'reminder'
    let targetChatId = process.env.TELEGRAM_CHAT_ID;
    let channelLabel = 'Main Alert Channel';

    if (channelType === 'report') {
      targetChatId = process.env.TELEGRAM_REPORT_CHAT_ID || targetChatId;
      channelLabel = 'Report Channel';
    } else if (channelType === 'reminder') {
      targetChatId = process.env.TELEGRAM_REMINDER_CHANNEL_ID || targetChatId;
      channelLabel = 'Reminder Channel';
    }

    if (!targetChatId) {
      return res.status(400).json({ error: `Chat ID for ${channelLabel} is not configured in .env!` });
    }

    const config = await getOrLoadConfig();
    const testText = `🔔 <b>${config.resortName || 'Sheets Monitor Bot'} — Channel Test Ping</b>\n\n` +
      `✅ Sender: Admin Portal\n` +
      `👤 Initiated By: <b>${req.user.username}</b> (${req.user.role})\n` +
      `⏱ Sent At: <code>${new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' })} KL</code>\n` +
      `📡 Channel: <b>${channelLabel}</b>`;

    const msgId = await sendMessage(testText, null, targetChatId);

    await appendAuditLog({
      action: 'TELEGRAM_TEST_PING',
      username: req.user.username,
      role: req.user.role,
      details: `Sent test ping to ${channelLabel} (${targetChatId})`,
      ip: req.ip
    });

    res.json({
      success: true,
      message: `Test ping sent to ${channelLabel}! (Message ID: ${msgId || 'Dev Suppressed'})`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Telemetry & System Diagnostics (Memory, Uptime, DB status, Google Sheets API latency)
 */
async function getTelemetryStats(req, res) {
  try {
    const startTime = Date.now();
    let sheetsStatus = { ok: false, latencyMs: 0, error: null };

    try {
      const rows = await fetchAndEnrichSheetData();
      sheetsStatus = {
        ok: true,
        latencyMs: Date.now() - startTime,
        totalRowsFetched: rows.length
      };
    } catch (err) {
      sheetsStatus = {
        ok: false,
        latencyMs: Date.now() - startTime,
        error: err.message
      };
    }

    const mem = process.memoryUsage();
    const totalChecks = await getTotalChecksCount();
    const snapshot = await loadSnapshot();

    res.json({
      success: true,
      telemetry: {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsage: {
          heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
          heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(2),
          rssMB: (mem.rss / 1024 / 1024).toFixed(2)
        },
        dbStatus: getDbStatus(),
        sheetsApi: sheetsStatus,
        totalChecks,
        snapshotSavedAt: snapshot?.savedAt || null,
        snapshotTotalRows: snapshot?.totalRows || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Reset baseline snapshot from Google Sheets
 */
async function resetSnapshotBaseline(req, res) {
  try {
    const rows = await fetchAndEnrichSheetData();
    await saveSnapshot(rows, rows);

    await appendAuditLog({
      action: 'SNAPSHOT_BASELINE_RESET',
      username: req.user.username,
      role: req.user.role,
      details: `Re-established baseline snapshot with ${rows.length} rows`,
      ip: req.ip
    });

    res.json({ success: true, message: `Baseline snapshot updated with ${rows.length} rows.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Export System Data as JSON or CSV
 */
async function exportData(req, res) {
  try {
    const { type } = req.params; // 'snapshot', 'history', or 'audit'
    const format = req.query.format === 'csv' ? 'csv' : 'json';

    let data = [];
    let filename = `export_${type}_${Date.now()}`;

    if (type === 'snapshot') {
      const snap = await loadSnapshot();
      data = snap ? snap.allRows : [];
      filename = `bookings_snapshot_${Date.now()}`;
    } else if (type === 'history') {
      data = await loadHistory();
      filename = `change_history_${Date.now()}`;
    } else if (type === 'audit') {
      data = await loadAuditLogs();
      filename = `audit_logs_${Date.now()}`;
    } else {
      return res.status(400).json({ error: 'Invalid export type.' });
    }

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);

      if (data.length === 0) return res.send('');
      
      const keys = Object.keys(data[0] || {});
      const csvRows = [keys.join(',')];
      for (const row of data) {
        const values = keys.map(k => {
          const val = row[k];
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
          return `"${str.replace(/"/g, '""')}"`;
        });
        csvRows.push(values.join(','));
      }
      return res.send(csvRows.join('\n'));
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Attach internal staff note to change event or booking row
 */
async function createInternalNote(req, res) {
  try {
    const { targetId, note } = req.body;
    if (!targetId || !note) {
      return res.status(400).json({ error: 'Target ID and note content are required.' });
    }

    const noteDoc = await addNote({
      targetId,
      note,
      createdBy: req.user.username
    });

    await appendAuditLog({
      action: 'INTERNAL_NOTE_ADDED',
      username: req.user.username,
      role: req.user.role,
      details: `Added note to target [${targetId}]: "${note.substring(0, 40)}"`,
      ip: req.ip
    });

    res.json({ success: true, note: noteDoc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Fetch all internal notes
 */
async function fetchInternalNotes(req, res) {
  try {
    const notes = await getNotes();
    res.json({ success: true, notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Fetch audit logs
 */
async function getAuditLogsHandler(req, res) {
  try {
    const logs = await loadAuditLogs();
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Save or update dashboard booking details override (Admin only).
 * Expects { bookingKey, fields } or { rowIndex, fields } in req.body.
 */
async function updateBookingOverride(req, res) {
  try {
    const { saveOverride, getBookingKey } = require('./overrides');
    const { bookingKey: inputKey, rowIndex, fields } = req.body;
    if (!fields || typeof fields !== 'object') {
      return res.status(400).json({ error: 'Fields object is required for booking override.' });
    }

    let finalKey = inputKey;
    if (typeof rowIndex === 'number' && !isNaN(rowIndex)) {
      finalKey = `ROW_${rowIndex}`;
    }

    if (!finalKey) {
      return res.status(400).json({ error: 'Could not determine booking key for override.' });
    }

    const payload = await saveOverride(finalKey, { fields }, req.user.username);

    await appendAuditLog({
      action: 'DASHBOARD_BOOKING_OVERRIDDEN',
      username: req.user.username,
      role: req.user.role,
      details: `Updated dashboard override for [${finalKey}]: ${Object.keys(fields).join(', ')}`,
      ip: req.ip
    });

    res.json({ success: true, message: 'Booking override saved successfully on dashboard.', override: payload, bookingKey: finalKey });
  } catch (err) {
    console.error('   ❌ Error updating booking override:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Delete a dashboard booking override (Revert to original Google Sheet data).
 */
async function revertBookingOverride(req, res) {
  try {
    const { deleteOverride } = require('./overrides');
    const { bookingKey: inputKey, rowIndex } = req.body;

    const parsedRowIndex = (typeof rowIndex === 'number' && !isNaN(rowIndex)) ? rowIndex : (typeof rowIndex === 'string' && !isNaN(parseInt(rowIndex, 10)) ? parseInt(rowIndex, 10) : undefined);

    if (!inputKey && parsedRowIndex === undefined) {
      return res.status(400).json({ error: 'Booking key or row index is required to revert override.' });
    }

    const removed = await deleteOverride(inputKey, parsedRowIndex);

    if (!removed) {
      return res.status(404).json({ error: 'No active override found for this booking.' });
    }

    const logKey = inputKey || `ROW_${parsedRowIndex}`;
    await appendAuditLog({
      action: 'DASHBOARD_BOOKING_OVERRIDE_REVERTED',
      username: req.user.username,
      role: req.user.role,
      details: `Reverted dashboard override for [${logKey}] back to original sheet values.`,
      ip: req.ip
    });

    res.json({ success: true, message: 'Booking override reverted to original sheet data.' });
  } catch (err) {
    console.error('   ❌ Error reverting booking override:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Preview custom date boat transfer report.
 */
async function previewBoatTransferReport(req, res) {
  try {
    const { startDate, endDate, filterType } = req.body;
    const snapshot = await loadSnapshot();

    let rawRows = snapshot?.allRows || [];
    if (rawRows.length === 0) {
      rawRows = await fetchAndEnrichSheetData();
    }

    const { applyOverridesToRows } = require('./overrides');
    const { buildCustomDateReport, formatDayMessage } = require('./weeklyReport');

    const headers = snapshot?.headers || (rawRows.length > 0 ? (rawRows[0].headers || rawRows[0]) : []);
    const enrichedRows = await applyOverridesToRows(rawRows, headers);

    const report = buildCustomDateReport(enrichedRows, {
      startDateStr: startDate,
      endDateStr: endDate,
      filterType: filterType || 'both',
      headers
    });

    const now = new Date();
    const formattedMessages = report.days.map(day => {
      const msgText = formatDayMessage(report, day);
      const timeString = now.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });
      const dateString = now.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });
      const fullText = `${msgText}\n\n<i>Last updated: ${timeString}, ${dateString}</i>`;
      return {
        dateStr: day.dateStr,
        label: day.label,
        messageText: fullText
      };
    });

    res.json({
      success: true,
      report,
      formattedMessages
    });
  } catch (err) {
    console.error('   ❌ Error previewing boat transfer report:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Send custom date boat transfer report to Telegram channel.
 */
async function sendBoatTransferReport(req, res) {
  try {
    const { startDate, endDate, filterType } = req.body;
    const targetChatId = process.env.TELEGRAM_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

    if (!targetChatId) {
      return res.status(400).json({ error: 'TELEGRAM_REPORT_CHAT_ID is not configured in environment!' });
    }

    const snapshot = await loadSnapshot();
    let rawRows = snapshot?.allRows || [];
    if (rawRows.length === 0) {
      rawRows = await fetchAndEnrichSheetData();
    }

    const { applyOverridesToRows } = require('./overrides');
    const { buildCustomDateReport, formatDayMessage } = require('./weeklyReport');

    const headers = snapshot?.headers || (rawRows.length > 0 ? (rawRows[0].headers || rawRows[0]) : []);
    const enrichedRows = await applyOverridesToRows(rawRows, headers);

    const report = buildCustomDateReport(enrichedRows, {
      startDateStr: startDate,
      endDateStr: endDate,
      filterType: filterType || 'both',
      headers
    });

    const now = new Date();
    const eventId = crypto.randomUUID();
    let sentCount = 0;

    for (const day of report.days) {
      const msgText = formatDayMessage(report, day);
      const timeString = now.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });
      const dateString = now.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Kuala_Lumpur' });
      const dayTextWithTimestamp = `${msgText}\n\n<i>Last updated: ${timeString}, ${dateString}</i>`;

      const replyMarkup = {
        inline_keyboard: [
          [{ text: '✅ Verify', callback_data: `verify_report:${eventId}:${day.dateStr}` }]
        ]
      };

      const msgId = await sendMessage(dayTextWithTimestamp, replyMarkup, targetChatId);
      if (msgId) sentCount++;
    }

    await appendAuditLog({
      action: 'BOAT_REPORT_SENT_TELEGRAM',
      username: req.user.username,
      role: req.user.role,
      details: `Sent boat transfer report for ${startDate} to ${endDate} (${sentCount} date message(s) sent)`,
      ip: req.ip
    });

    res.json({
      success: true,
      message: `Boat transfer report sent to Telegram (${sentCount} date message(s) delivered).`,
      sentCount,
      channelId: targetChatId
    });
  } catch (err) {
    console.error('   ❌ Error sending boat transfer report to Telegram:', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getOrLoadConfig,
  getUsers,
  createUser,
  approveUser,
  deleteUser,
  changePassword,
  getBotSettings,
  getPublicBranding,
  updateBotSettings,
  testTelegramPing,
  getTelemetryStats,
  resetSnapshotBaseline,
  exportData,
  createInternalNote,
  fetchInternalNotes,
  getAuditLogsHandler,
  updateBookingOverride,
  revertBookingOverride,
  previewBoatTransferReport,
  sendBoatTransferReport
};


