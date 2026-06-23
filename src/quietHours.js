const KL_TIMEZONE = 'Asia/Kuala_Lumpur';

/**
 * Check if the current KL time is within quiet hours (10 PM to 8 AM).
 * During quiet hours, report transmissions should be suppressed
 * to avoid disturbing people.
 * @returns {{ isQuiet: boolean, klHour: number }}
 */
function isQuietHours() {
  const klHour = parseInt(new Date().toLocaleString('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: KL_TIMEZONE,
  }), 10);
  return { isQuiet: klHour < 8 || klHour >= 22, klHour };
}

module.exports = { isQuietHours };
