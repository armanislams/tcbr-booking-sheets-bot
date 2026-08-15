const KL_TIMEZONE = 'Asia/Kuala_Lumpur';

/**
 * Get current KL hour (0-23).
 */
function getKlHour() {
  return parseInt(new Date().toLocaleString('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: KL_TIMEZONE,
  }), 10);
}

/**
 * Check if the current KL time is within general quiet hours (10 PM to 8 AM).
 * During general quiet hours, change notifications & alerts are suppressed.
 * @returns {{ isQuiet: boolean, klHour: number }}
 */
function isQuietHours() {
  const klHour = getKlHour();
  return { isQuiet: klHour < 8 || klHour >= 22, klHour };
}

/**
 * Check if the current KL time is within report quiet hours (10 PM to 10 AM).
 * Boat transfer report notifications are suppressed until 10 AM.
 * @returns {{ isQuiet: boolean, klHour: number }}
 */
function isReportQuietHours() {
  const klHour = getKlHour();
  return { isQuiet: klHour < 10 || klHour >= 22, klHour };
}

module.exports = { isQuietHours, isReportQuietHours };
