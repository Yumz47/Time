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
 * Determines day of week (0=Sun, 1=Mon, ..., 5=Fri, 6=Sat) from a YYYY-MM-DD date string.
 * Uses noon local time to avoid any timezone day shifts.
 * @param {string} dateStr
 * @returns {number}
 */
function getDayOfWeek(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return 1;
  const parts = dateStr.split(/[-/]/);
  if (parts.length < 3) return 1;
  const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
  return isNaN(d.getDay()) ? 1 : d.getDay();
}

/**
 * Returns scheduled shift boundaries for a given date based on official Supreme Court / Registry rules.
 * Mon-Thu: 08:00 - 17:00 (1h lunch 12:00 - 13:00) = 8.00h
 * Friday:  08:00 - 16:30 (1h lunch 12:00 - 13:00) = 7.50h
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {{dayOfWeek: number, isFriday: boolean, isWeekend: boolean, startTimeStr: string, endTimeStr: string, lunchHours: number, scheduledHours: number}}
 */
function getShiftScheduleForDate(dateStr) {
  const dayOfWeek = getDayOfWeek(dateStr);
  const isFriday = (dayOfWeek === 5);
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  const startTimeStr = '08:00:00';
  const endTimeStr = isFriday ? '16:30:00' : '17:00:00';
  const lunchHours = 1.0;
  const scheduledHours = isFriday ? 7.5 : 8.0;

  return {
    dayOfWeek,
    isFriday,
    isWeekend,
    startTimeStr,
    endTimeStr,
    lunchHours,
    scheduledHours,
  };
}

/**
 * Computes audited working hours deducting standard unpaid lunch break (12:00 - 13:00)
 * and applying the 'No Extra Time' rule when punch-out is auto-completed.
 *
 * @param {string|Date} firstInTime
 * @param {string|Date} lastOutTime
 * @param {Object} shift
 * @param {boolean} [isAutoOut=false]
 * @returns {number|null}
 */
function calculateAuditedWorkingHours(firstInTime, lastOutTime, shift, isAutoOut = false) {
  if (!firstInTime || !lastOutTime) return null;
  const dIn = new Date(firstInTime);
  const dOut = new Date(lastOutTime);
  if (isNaN(dIn.getTime()) || isNaN(dOut.getTime())) return null;

  const isUTC = (typeof firstInTime === 'string' && firstInTime.endsWith('Z')) ||
                (typeof lastOutTime === 'string' && lastOutTime.endsWith('Z'));

  const inHourVal = isUTC
    ? (dIn.getUTCHours() + dIn.getUTCMinutes() / 60 + dIn.getUTCSeconds() / 3600)
    : (dIn.getHours() + dIn.getMinutes() / 60 + dIn.getSeconds() / 3600);

  const outHourVal = isUTC
    ? (dOut.getUTCHours() + dOut.getUTCMinutes() / 60 + dOut.getUTCSeconds() / 3600)
    : (dOut.getHours() + dOut.getMinutes() / 60 + dOut.getSeconds() / 3600);

  let effIn = inHourVal;
  let effOut = outHourVal;

  // 'No Extra Time' rule:
  // When punch-out is auto-completed, cap arrival at shift start (08:00)
  // and departure at shift end (17:00 or 16:30 on Friday), granting zero unapproved overtime.
  if (isAutoOut) {
    if (effIn < 8.0) effIn = 8.0;
    const maxEnd = shift.isFriday ? 16.5 : 17.0;
    if (effOut > maxEnd) effOut = maxEnd;
  }

  let spanHours = effOut - effIn;
  if (spanHours <= 0) return 0;

  // Deduct 1-hour unpaid lunch break (12:00 to 13:00) when workday covers lunch
  let lunchDeduction = 0;
  const lunchStart = 12.0;
  const lunchEnd = 13.0;

  if (effIn <= lunchStart && effOut >= lunchEnd) {
    lunchDeduction = 1.0;
  } else if (effIn < lunchEnd && effOut > lunchStart) {
    const overlapStart = Math.max(effIn, lunchStart);
    const overlapEnd = Math.min(effOut, lunchEnd);
    lunchDeduction = Math.max(0, overlapEnd - overlapStart);
  }

  const workedHours = Math.max(0, spanHours - lunchDeduction);
  return Number(workedHours.toFixed(2));
}

/**
 * Pairs daily punches for an employee into shift sessions (First In, Last Out, total hours)
 * Handles cases where employees only punch In (standard biometric single-mode) by auto-completing
 * missed punch-outs to the scheduled shift end with no extra time.
 *
 * @param {Array<{check_time: string|Date, normalized_type: string}>} punches - Sorted chronologically
 * @param {Object} [options]
 * @param {boolean} [options.autoCompleteMissedOut=true] - Auto-complete missing punch-out to shift end
 * @param {Date} [options.referenceNow=new Date()] - Reference time for checking whether shift has ended today
 * @returns {Array<{date: string, first_in: string, last_out: string|null, punch_count: number, raw_hours: number|null, total_hours: number|null, hours_worked: number|null, is_auto_out: boolean}>}
 */
function computeDailyAttendance(punches, optionsOrShift = {}, maybeOptions = {}) {
  if (!Array.isArray(punches) || punches.length === 0) {
    return [];
  }

  const options = (maybeOptions && typeof maybeOptions === 'object' && Object.keys(maybeOptions).length > 0)
    ? maybeOptions
    : (optionsOrShift && typeof optionsOrShift === 'object' ? optionsOrShift : {});

  const autoCompleteMissedOut = options.autoCompleteMissedOut !== undefined
    ? Boolean(options.autoCompleteMissedOut)
    : true;
  const referenceNow = options.referenceNow ? new Date(options.referenceNow) : new Date();
  const todayKey = referenceNow.toISOString().split('T')[0];

  const byDate = new Map();

  for (const punch of punches) {
    const d = new Date(punch.check_time);
    if (isNaN(d.getTime())) continue;

    const dateKey = (typeof punch.check_time === 'string' && punch.check_time.includes('-'))
      ? punch.check_time.split(/T|\s/)[0]
      : d.toISOString().split('T')[0];

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

    const shift = getShiftScheduleForDate(date);
    const firstIn = dayPunches[0].rawTime;
    let lastOut = null;
    let rawHours = null;
    let totalHours = null;
    let isAutoOut = false;

    // Check if there is a distinct departure punch (> 5 minutes after arrival)
    if (dayPunches.length > 1) {
      const lastPunch = dayPunches[dayPunches.length - 1];
      const diffMs = lastPunch.time.getTime() - dayPunches[0].time.getTime();
      if (diffMs > 5 * 60 * 1000) {
        lastOut = lastPunch.rawTime;
        rawHours = Number((diffMs / (1000 * 60 * 60)).toFixed(2));
        totalHours = calculateAuditedWorkingHours(firstIn, lastOut, shift, false);
      }
    }

    // Auto-complete missed punch-out if employee only punched IN (or duplicate morning tap)
    if (!lastOut && autoCompleteMissedOut) {
      const isPastDate = (date < todayKey);
      let isTodayShiftEnded = false;

      if (date === todayKey) {
        const currentHour = referenceNow.getHours() + referenceNow.getMinutes() / 60;
        const shiftEndHour = shift.isFriday ? 16.5 : 17.0;
        isTodayShiftEnded = (currentHour >= shiftEndHour);
      }

      if (isPastDate || isTodayShiftEnded) {
        // Format auto-out timestamp matching input format
        const isISO = (typeof firstIn === 'string' && firstIn.includes('T') && firstIn.endsWith('Z'));
        if (isISO) {
          lastOut = `${date}T${shift.endTimeStr}.000Z`;
        } else {
          lastOut = `${date} ${shift.endTimeStr}`;
        }

        isAutoOut = true;
        totalHours = calculateAuditedWorkingHours(firstIn, lastOut, shift, true);
        const autoOutDate = new Date(lastOut);
        const autoDiffMs = autoOutDate.getTime() - dayPunches[0].time.getTime();
        rawHours = (autoDiffMs > 0) ? Number((autoDiffMs / (1000 * 60 * 60)).toFixed(2)) : totalHours;
      }
    }

    results.push({
      date,
      first_in: firstIn,
      last_out: lastOut,
      punch_count: dayPunches.length,
      raw_hours: rawHours,
      total_hours: totalHours,
      hours_worked: totalHours,
      is_auto_out: isAutoOut,
    });
  }

  return results.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Infers normalized punch type using alternating toggle logic.
 *
 * Priority order:
 *   1. Explicit hardware inOutStatus (1 or 5 → 'out'; 4 → 'in') — always wins
 *   2. Alternating toggle off the last known type for this user
 *   3. Defaults to 'in' when no prior punch exists (first punch of the day/ever)
 *
 * A 1-minute debounce is applied: if the new punch is within 60 seconds of the
 * reference time (lastPunchTime), the type is NOT toggled — it repeats the last
 * known type to prevent accidental double-swipe reclassification.
 *
 * @param {string|null}   lastKnownType   - 'in', 'out', or null (no prior punch)
 * @param {number}        rawInOutStatus  - Hardware inOutStatus byte (0,1,4,5)
 * @param {Date|null}     newPunchTime    - Timestamp of the punch being classified
 * @param {Date|null}     lastPunchTime   - Timestamp of the previous punch for debounce check
 * @returns {'in'|'out'}
 */
/**
 * Checks if two date inputs fall on the same calendar day.
 * @param {Date|string|number} d1
 * @param {Date|string|number} d2
 * @returns {boolean}
 */
function isSameDay(d1, d2) {
  if (!d1 || !d2) return false;
  const a = new Date(d1);
  const b = new Date(d2);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return false;
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

/**
 * Infers normalized punch type using alternating toggle logic.
 *
 * Priority order:
 *   1. Explicit hardware inOutStatus (1 or 5 → 'out'; 4 → 'in') — always wins
 *   2. Daily Reset: If there are no registered checkins on the day, the first check is ALWAYS 'in'
 *   3. 1-minute debounce: duplicate punches within 60s on the same day absorb without toggling
 *   4. Alternating toggle within the same day off the last known type for this user
 *   5. Defaults to 'in' when no prior punch exists
 *
 * @param {string|null}   lastKnownType   - 'in', 'out', or null (no prior punch)
 * @param {number}        rawInOutStatus  - Hardware inOutStatus byte (0,1,4,5)
 * @param {Date|null}     newPunchTime    - Timestamp of the punch being classified
 * @param {Date|null}     lastPunchTime   - Timestamp of the previous punch for debounce check
 * @returns {'in'|'out'}
 */
function inferNormalizedType(lastKnownType, rawInOutStatus, newPunchTime = null, lastPunchTime = null) {
  const punchDate = newPunchTime ? new Date(newPunchTime) : null;
  const prevDate = lastPunchTime ? new Date(lastPunchTime) : null;

  // Daily Reset: If the previous punch was on a different day, reset state for the new day
  let isNewDay = false;
  let effectiveLastType = lastKnownType;
  if (punchDate && prevDate && !isSameDay(punchDate, prevDate)) {
    effectiveLastType = null;
    isNewDay = true;
  }

  const localHour = (punchDate && !isNaN(punchDate.getTime())) ? punchDate.getHours() : null;
  const isFirstPunchOfDay = isNewDay || effectiveLastType === null;

  // Morning Arrival Override:
  // If this is the first punch of the day during morning arrival hours (< 12:00 PM),
  // it is ALWAYS an 'in' punch. Arriving employees cannot clock OUT before clocking IN;
  // physical clock terminals are frequently left on "Clock OUT" state by previous users.
  if (isFirstPunchOfDay && localHour !== null && localHour < 12) {
    return 'in';
  }

  // Debounce: if this punch is within 5 minutes (300s) of the previous one ON THE SAME DAY, do NOT toggle —
  // treat it as the same event type to absorb accidental double-swipes or immediate re-verifications.
  if (punchDate && prevDate && isSameDay(punchDate, prevDate)) {
    const gapMs = punchDate.getTime() - prevDate.getTime();
    if (gapMs >= 0 && gapMs < 5 * 60 * 1000) {
      return effectiveLastType || 'in';
    }
  }

  // Priority 1: explicit hardware checkout signal (status 1 = Out, status 5 = OT Out)
  if (rawInOutStatus === 1 || rawInOutStatus === 5) return 'out';

  // Priority 2: alternating toggle within the same day
  if (effectiveLastType === 'in')  return 'out';
  if (effectiveLastType === 'out') return 'in';

  // Priority 3: default — first punch of the day is always IN
  return 'in';
}

/**
/**
 * Helper to check if a punch in seconds falls within a start-to-end time window,
 * correctly handling shifts that span across midnight (e.g. 22:00 -> 04:00).
 * @param {number} punchSecs
 * @param {number|null} w1
 * @param {number|null} w2
 * @returns {boolean}
 */
function isWithinWindow(punchSecs, w1, w2) {
  if (w1 === null || w2 === null || punchSecs === null) return false;
  if (w1 <= w2) {
    return punchSecs >= w1 && punchSecs <= w2;
  }
  return punchSecs >= w1 || punchSecs <= w2;
}

/**
 * Converts a DB time value (Date, ISO string, or HH:MM:SS) into seconds since midnight.
 * @param {Date|string|number} val
 * @param {'local'|'utc'} [mode='local']
 * @returns {number|null}
 */
function extractSecs(val, mode = 'local') {
  if (!val) return null;
  if (typeof val === 'string') {
    const m = val.match(/(?:T|\s|^)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
    }
  }
  const d = (val instanceof Date) ? val : new Date(val);
  if (isNaN(d.getTime())) return null;
  return mode === 'utc'
    ? d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
    : d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

/**
 * Classifies a punch against an employee's shift check-in / check-out time windows.
 *
 * Each window object must have Date or parseable time values for:
 *   { checkIn1, checkIn2, checkOut1, checkOut2 }
 *
 * The time comparison uses only HH:MM:SS, date portion is ignored.
 * Returns null when no window matches (caller should fall back to toggle).
 *
 * @param {Date}   punchTime    - The actual punch datetime
 * @param {Array}  shiftWindows - Array of SchClass-derived window objects
 * @returns {'in'|'out'|null}
 */
function classifyByShiftWindow(punchTime, shiftWindows) {
  if (!punchTime || !Array.isArray(shiftWindows) || shiftWindows.length === 0) {
    return null;
  }

  const punch = (punchTime instanceof Date) ? punchTime : new Date(punchTime);
  if (isNaN(punch.getTime())) return null;

  const punchSecsLocal = extractSecs(punch, 'local');
  const punchSecsUTC = extractSecs(punch, 'utc');

  for (const w of shiftWindows) {
    const ci1 = w.checkIn1  ?? w.CheckInTime1  ?? w.check_in_time1;
    const ci2 = w.checkIn2  ?? w.CheckInTime2  ?? w.check_in_time2;
    const co1 = w.checkOut1 ?? w.CheckOutTime1 ?? w.check_out_time1;
    const co2 = w.checkOut2 ?? w.CheckOutTime2 ?? w.check_out_time2;

    // 1. Check check-in window (local, UTC, and cross-format)
    if (ci1 && ci2) {
      const ci1Local = extractSecs(ci1, 'local');
      const ci2Local = extractSecs(ci2, 'local');
      const ci1UTC = extractSecs(ci1, 'utc');
      const ci2UTC = extractSecs(ci2, 'utc');

      if (isWithinWindow(punchSecsLocal, ci1Local, ci2Local) ||
          isWithinWindow(punchSecsUTC, ci1UTC, ci2UTC) ||
          isWithinWindow(punchSecsLocal, ci1UTC, ci2UTC)) {
        return 'in';
      }
    }

    // 2. Check check-out window (local, UTC, and cross-format)
    if (co1 && co2) {
      const co1Local = extractSecs(co1, 'local');
      const co2Local = extractSecs(co2, 'local');
      const co1UTC = extractSecs(co1, 'utc');
      const co2UTC = extractSecs(co2, 'utc');

      if (isWithinWindow(punchSecsLocal, co1Local, co2Local) ||
          isWithinWindow(punchSecsUTC, co1UTC, co2UTC) ||
          isWithinWindow(punchSecsLocal, co1UTC, co2UTC)) {
        return 'out';
      }
    }
  }

  return null; // no window matched — caller falls back to toggle
}

/**
 * Orchestrates the full priority chain to resolve a punch's normalized type:
 *   1. Hardware inOutStatus (explicit 1/5 = out, 4 = in)
 *   2. Daily Reset: first check of the day is always IN
 *   3. 1-minute debounce: absorb double-swipes within 60s
 *   4. Shift/schedule window matching (Strategy A secondary)
 *   5. Afternoon departure / shift completion heuristic
 *   6. Alternating toggle within the same day
 *
 * @param {string|null}   lastKnownType   - 'in', 'out', or null
 * @param {number}        rawInOutStatus  - Hardware inOutStatus byte (0,1,4,5)
 * @param {Date|null}     newPunchTime    - Timestamp of this punch
 * @param {Date|null}     lastPunchTime   - Timestamp of previous punch (for debounce)
 * @param {Array}         shiftWindows    - Optional array of SchClass windows for this employee
 * @param {Date|null}     firstInTime     - Timestamp of first check-in today (for departure heuristic)
 * @returns {'in'|'out'}
 */
function resolveNormalizedType(lastKnownType, rawInOutStatus, newPunchTime = null, lastPunchTime = null, shiftWindows = [], firstInTime = null) {
  const punchDate = newPunchTime ? new Date(newPunchTime) : null;
  const prevDate = lastPunchTime ? new Date(lastPunchTime) : null;

  // Daily Reset: If previous punch was on a different day, reset state for the new day
  let isNewDay = false;
  let effectiveLastType = lastKnownType;
  if (punchDate && prevDate && !isSameDay(punchDate, prevDate)) {
    effectiveLastType = null;
    isNewDay = true;
  }

  // Priority 1: Shift / Schedule window check
  // An explicit check-in window match ALWAYS wins over sticky hardware keypad state
  let windowResult = null;
  if (punchDate && Array.isArray(shiftWindows) && shiftWindows.length > 0) {
    windowResult = classifyByShiftWindow(punchDate, shiftWindows);
    if (windowResult === 'in') {
      return 'in';
    }
  }

  const localHour = (punchDate && !isNaN(punchDate.getTime())) ? punchDate.getHours() : null;
  const isFirstPunchOfDay = isNewDay || effectiveLastType === null;

  // Priority 2: Morning Arrival Override
  // If this is the first punch of the day during morning arrival hours (< 12:00 PM),
  // it is ALWAYS an 'in' punch. Arriving employees cannot clock OUT before clocking IN;
  // physical clock terminals are frequently left on "Clock OUT" state by previous users.
  if (isFirstPunchOfDay && localHour !== null && localHour < 12) {
    return 'in';
  }

  // Debounce: absorb duplicate punches within 5 minutes (300s) on the same day.
  // A second swipe within 5 minutes is a duplicate verification/re-tap, not an immediate departure.
  if (punchDate && prevDate && isSameDay(punchDate, prevDate)) {
    const gapMs = punchDate.getTime() - prevDate.getTime();
    if (gapMs >= 0 && gapMs < 5 * 60 * 1000) {
      return effectiveLastType || 'in';
    }
  }

  // Priority 3: explicit hardware checkout signal (status 1 = Out, status 5 = OT Out)
  if (rawInOutStatus === 1 || rawInOutStatus === 5) return 'out';

  // Priority 4: Shift/schedule window checkout
  if (windowResult !== null) return windowResult;

  // Priority 5: Afternoon departure / shift completion heuristic
  // If an employee clocked IN in the morning and punches in the afternoon/departure hours (> 4h elapsed or >= 15:00):
  // Leaving work at the end of the shift is always an OUT punch, preventing anomalous morning toggles from inverting departure.
  if (punchDate && firstInTime && isSameDay(punchDate, firstInTime)) {
    const firstDate = new Date(firstInTime);
    const gapHours = (punchDate.getTime() - firstDate.getTime()) / (1000 * 3600);

    if (gapHours >= 4 || (gapHours >= 1 && localHour !== null && localHour >= 15)) {
      return 'out';
    }
  }

  // Priority 6: alternating toggle within the same day
  if (effectiveLastType === 'in')  return 'out';
  if (effectiveLastType === 'out') return 'in';

  // Default: first punch of the day is always IN
  return 'in';
}

/**
 * Formats a time string (HH:mm or HH:mm:ss) into standard ZKTeco legacy base datetime: 1899-12-30 HH:mm:ss
 * @param {string} timeStr
 * @returns {string|null}
 */
function timeToDateTime(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
  const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hours = match[1].padStart(2, '0');
  const minutes = match[2].padStart(2, '0');
  const seconds = (match[3] || '00').padStart(2, '0');
  const hNum = parseInt(hours, 10);
  const mNum = parseInt(minutes, 10);
  const sNum = parseInt(seconds, 10);
  if (hNum < 0 || hNum > 23 || mNum < 0 || mNum > 59 || sNum < 0 || sNum > 59) {
    return null;
  }
  return `1899-12-30 ${hours}:${minutes}:${seconds}`;
}

/**
 * Calculates work minutes between two HH:mm strings, handling overnight rollover.
 * @param {string} startTimeStr
 * @param {string} endTimeStr
 * @returns {number}
 */
function calcWorkMinutes(startTimeStr, endTimeStr) {
  if (!startTimeStr || !endTimeStr) return 0;
  const matchS = String(startTimeStr).match(/(\d{1,2}):(\d{2})/);
  const matchE = String(endTimeStr).match(/(\d{1,2}):(\d{2})/);
  if (!matchS || !matchE) return 0;
  let sMins = parseInt(matchS[1], 10) * 60 + parseInt(matchS[2], 10);
  let eMins = parseInt(matchE[1], 10) * 60 + parseInt(matchE[2], 10);
  if (eMins < sMins) eMins += 24 * 60;
  return eMins - sMins;
}

/**
 * Validates shift class input parameters
 * @param {Object} data
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateShiftData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Shift data must be a valid object'] };
  }
  if (!data.schName || String(data.schName).trim() === '') {
    errors.push('Shift name (schName) is required');
  }
  if (!data.StartTime || !timeToDateTime(data.StartTime)) {
    errors.push('StartTime must be a valid HH:mm or HH:mm:ss format');
  }
  if (!data.EndTime || !timeToDateTime(data.EndTime)) {
    errors.push('EndTime must be a valid HH:mm or HH:mm:ss format');
  }
  if (data.WorkDay !== undefined && data.WorkDay !== null) {
    const wd = Number(data.WorkDay);
    if (isNaN(wd) || wd < 0 || wd > 2) {
      errors.push('WorkDay fraction must be a number between 0 and 2');
    }
  }
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates schedule input parameters
 * @param {Object} data
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateScheduleData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Schedule data must be a valid object'] };
  }
  if (!data.name || String(data.name).trim() === '') {
    errors.push('Schedule name is required');
  }
  if (data.cycle !== undefined && data.cycle !== null) {
    const c = Number(data.cycle);
    if (isNaN(c) || c <= 0) {
      errors.push('Cycle must be a positive number');
    }
  }
  if (data.days && Array.isArray(data.days)) {
    for (const d of data.days) {
      if (d.day_index !== undefined) {
        const idx = Number(d.day_index);
        if (isNaN(idx) || idx < 0 || idx > 366) {
          errors.push(`Invalid day_index: ${d.day_index}`);
        }
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Serializes schedule or shift payloads for pickle & caching tests
 * @param {Object} payload
 * @returns {string}
 */
function serializeSchedulePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('Payload must be a non-null object');
  }
  return JSON.stringify(payload, (key, value) => {
    if (value instanceof Date) {
      return value.toISOString();
    }
    return value;
  });
}

/**
 * Deserializes schedule payload ensuring roundtrip integrity
 * @param {string} jsonStr
 * @returns {Object}
 */
function deserializeSchedulePayload(jsonStr) {
  if (typeof jsonStr !== 'string') {
    throw new TypeError('Input must be a JSON string');
  }
  const parsed = JSON.parse(jsonStr);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Deserialized payload must be an object');
  }
  return parsed;
}

module.exports = {
  normalizeCheckType,
  formatMySQLDateTime,
  serializeRecords,
  deserializeRecords,
  computeDailyAttendance,
  getDayOfWeek,
  getShiftScheduleForDate,
  calculateAuditedWorkingHours,
  isSameDay,
  inferNormalizedType,
  classifyByShiftWindow,
  resolveNormalizedType,
  timeToDateTime,
  calcWorkMinutes,
  validateShiftData,
  validateScheduleData,
  serializeSchedulePayload,
  deserializeSchedulePayload
};


