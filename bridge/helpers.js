/**
 * Helpers for data normalization, serialization, and session pairing.
 */

/**
 * Normalizes ZKTeco punch check types into standard 'in' or 'out'
 * @param {string|number} rawType - The raw CHECKTYPE from MDB ('I', 'i', '1', 'O', 'o', '0')
 * @returns {'in'|'out'}
 */
function normalizeCheckType(rawType) {
  if (rawType === undefined || rawType === null) {
    return 'in';
  }
  const clean = String(rawType).trim().toUpperCase();
  if (clean === 'O' || clean === '0') {
    return 'out';
  }
  return 'in';
}

/**
 * Validates and formats a date string or Date object into MySQL DATETIME format (YYYY-MM-DD HH:mm:ss)
 * @param {Date|string} dateInput
 * @returns {string|null}
 */
function formatMySQLDateTime(dateInput) {
  if (!dateInput) return null;
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Serializes records into safe, deterministic JSON payloads for caching or transport
 * @param {Array<Object>} records
 * @returns {string} JSON string
 */
function serializeRecords(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('Records must be an array');
  }
  return JSON.stringify(records, (key, value) => {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  });
}

/**
 * Deserializes JSON string back to records ensuring integrity
 * @param {string} payload
 * @returns {Array<Object>}
 */
function deserializeRecords(payload) {
  if (typeof payload !== 'string') {
    throw new TypeError('Payload must be a string');
  }
  return JSON.parse(payload);
}

/**
 * Pairs daily punches for an employee into shift sessions (First In, Last Out, total hours)
 * Handles cases where employees only punch In (standard biometric single-mode).
 * @param {Array<{check_time: string|Date, normalized_type: string}>} punches - Sorted chronologically
 * @returns {Array<{date: string, first_in: string, last_out: string|null, punch_count: number, total_hours: number|null}>}
 */
function computeDailyAttendance(punches) {
  if (!Array.isArray(punches) || punches.length === 0) {
    return [];
  }

  const byDate = new Map();

  for (const punch of punches) {
    const d = new Date(punch.check_time);
    if (isNaN(d.getTime())) continue;

    const dateKey = d.toISOString().split('T')[0];
    if (!byDate.has(dateKey)) {
      byDate.set(dateKey, []);
    }
    byDate.get(dateKey).push({
      time: d,
      rawTime: punch.check_time,
      type: punch.normalized_type,
    });
  }

  const results = [];

  for (const [date, dayPunches] of byDate.entries()) {
    dayPunches.sort((a, b) => a.time.getTime() - b.time.getTime());

    const firstIn = dayPunches[0].rawTime;
    let lastOut = null;
    let totalHours = null;

    if (dayPunches.length > 1) {
      const lastPunch = dayPunches[dayPunches.length - 1];
      // Only treat as last out if time difference is greater than 1 minute (to avoid accidental double-taps)
      const diffMs = lastPunch.time.getTime() - dayPunches[0].time.getTime();
      if (diffMs > 60 * 1000) {
        lastOut = lastPunch.rawTime;
        totalHours = Number((diffMs / (1000 * 60 * 60)).toFixed(2));
      }
    }

    results.push({
      date,
      first_in: firstIn,
      last_out: lastOut,
      punch_count: dayPunches.length,
      total_hours: totalHours,
    });
  }

  return results.sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = {
  normalizeCheckType,
  formatMySQLDateTime,
  serializeRecords,
  deserializeRecords,
  computeDailyAttendance,
};
