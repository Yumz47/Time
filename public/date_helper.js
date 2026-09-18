/**
 * TimePulse Date Management Helper (UMD Pattern)
 * Standardizes UI date representation to Day-Month-Year (DD/MM/YYYY).
 * Provides timezone-safe date parsing, formatting, and serialization integrity.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DateHelper = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SEPARATOR = '/';
  const DEFAULT_FALLBACK = '--';

  /**
   * Left-pads a numeric value with leading zeros.
   * @param {number|string} val 
   * @param {number} len 
   * @returns {string}
   */
  function padZero(val, len = 2) {
    const s = String(val !== undefined && val !== null ? val : '0');
    return s.padStart(len, '0');
  }

  /**
   * Safely parses date inputs without UTC day-boundary shift.
   * Handles Date objects, timestamps, ISO 8601 strings, and SQL DATETIME / DATE strings.
   * @param {any} input 
   * @returns {{ year: number, month: number, day: number, hours: number, minutes: number, seconds: number }|null}
   */
  function parseDateParts(input) {
    if (!input && input !== 0) return null;

    if (input instanceof Date) {
      if (isNaN(input.getTime())) return null;
      return {
        year: input.getFullYear(),
        month: input.getMonth() + 1,
        day: input.getDate(),
        hours: input.getHours(),
        minutes: input.getMinutes(),
        seconds: input.getSeconds()
      };
    }

    if (typeof input === 'number') {
      const d = new Date(input);
      if (isNaN(d.getTime())) return null;
      return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        hours: d.getHours(),
        minutes: d.getMinutes(),
        seconds: d.getSeconds()
      };
    }

    if (typeof input !== 'string') return null;

    const trimmed = input.trim();
    if (!trimmed) return null;

    // Pattern 1: ISO or SQL format: YYYY-MM-DD or YYYY/MM/DD with optional time
    const isoMatch = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(trimmed);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10);
      const day = parseInt(isoMatch[3], 10);
      const hours = isoMatch[4] !== undefined ? parseInt(isoMatch[4], 10) : 0;
      const minutes = isoMatch[5] !== undefined ? parseInt(isoMatch[5], 10) : 0;
      const seconds = isoMatch[6] !== undefined ? parseInt(isoMatch[6], 10) : 0;

      // Validate month and day ranges
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;

      // Check for explicit timezone indicator (e.g. Z or +HH:mm)
      if (trimmed.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed)) {
        const d = new Date(trimmed);
        if (!isNaN(d.getTime())) {
          return {
            year: d.getFullYear(),
            month: d.getMonth() + 1,
            day: d.getDate(),
            hours: d.getHours(),
            minutes: d.getMinutes(),
            seconds: d.getSeconds()
          };
        }
      }

      return { year, month, day, hours, minutes, seconds };
    }

    // Pattern 2: Day-Month-Year format: DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(trimmed);
    if (dmyMatch) {
      const day = parseInt(dmyMatch[1], 10);
      const month = parseInt(dmyMatch[2], 10);
      const year = parseInt(dmyMatch[3], 10);
      const hours = dmyMatch[4] !== undefined ? parseInt(dmyMatch[4], 10) : 0;
      const minutes = dmyMatch[5] !== undefined ? parseInt(dmyMatch[5], 10) : 0;
      const seconds = dmyMatch[6] !== undefined ? parseInt(dmyMatch[6], 10) : 0;

      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return { year, month, day, hours, minutes, seconds };
    }

    // Fallback: Date constructor
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        hours: d.getHours(),
        minutes: d.getMinutes(),
        seconds: d.getSeconds()
      };
    }

    return null;
  }

  /**
   * Formats date input into Day-Month-Year: DD/MM/YYYY.
   * @param {any} dateInput 
   * @param {string} separator 
   * @param {string} fallback 
   * @returns {string} e.g. "18/09/2026"
   */
  function formatDate(dateInput, separator = DEFAULT_SEPARATOR, fallback = DEFAULT_FALLBACK) {
    const parts = parseDateParts(dateInput);
    if (!parts) return fallback;
    const sep = typeof separator === 'string' ? separator : DEFAULT_SEPARATOR;
    return `${padZero(parts.day)}${sep}${padZero(parts.month)}${sep}${padZero(parts.year, 4)}`;
  }

  /**
   * Formats date and time into Day-Month-Year + 24-hour time: DD/MM/YYYY HH:mm:ss.
   * @param {any} dateInput 
   * @param {object} options 
   * @param {string} fallback 
   * @returns {string} e.g. "18/09/2026 08:30:00"
   */
  function formatDateTime(dateInput, options = {}, fallback = DEFAULT_FALLBACK) {
    const parts = parseDateParts(dateInput);
    if (!parts) return fallback;

    const sep = (options && typeof options.separator === 'string') ? options.separator : DEFAULT_SEPARATOR;
    const datePart = `${padZero(parts.day)}${sep}${padZero(parts.month)}${sep}${padZero(parts.year, 4)}`;
    
    if (options && options.includeTime === false) {
      return datePart;
    }

    const includeSeconds = options && options.includeSeconds !== false;
    const timePart = includeSeconds
      ? `${padZero(parts.hours)}:${padZero(parts.minutes)}:${padZero(parts.seconds)}`
      : `${padZero(parts.hours)}:${padZero(parts.minutes)}`;

    return `${datePart} ${timePart}`;
  }

  /**
   * Convenience alias maintaining backwards compatibility with existing UI formatTime calls.
   * Formats punch timestamps and check times as Day-Month-Year + 24-hour time.
   * @param {any} isoStr 
   * @param {string} fallback 
   * @returns {string}
   */
  function formatTime(isoStr, fallback = DEFAULT_FALLBACK) {
    if (!isoStr) return fallback;
    
    // If string is already a pure time like "08:30" or "08:30:00", preserve it
    if (typeof isoStr === 'string' && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(isoStr.trim())) {
      return isoStr.trim();
    }

    const formatted = formatDateTime(isoStr, { includeSeconds: true }, fallback);
    return formatted !== fallback ? formatted : String(isoStr);
  }

  /**
   * Serializes a date filter or date range payload ensuring integrity guarantees (Pickle standard).
   * @param {object} payload 
   * @returns {string} JSON payload
   */
  function serializeDatePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new TypeError('serializeDatePayload requires an object input');
    }
    const safePayload = {
      from: payload.from ? formatDate(payload.from) : null,
      to: payload.to ? formatDate(payload.to) : null,
      targetDate: payload.targetDate ? formatDate(payload.targetDate) : null,
      timestamp: payload.timestamp ? formatDateTime(payload.timestamp) : null,
      format: 'DD/MM/YYYY'
    };
    return JSON.stringify(safePayload);
  }

  /**
   * Deserializes and validates a serialized date payload.
   * @param {string} serialized 
   * @returns {{ from: string|null, to: string|null, targetDate: string|null, timestamp: string|null, format: string }}
   */
  function deserializeDatePayload(serialized) {
    if (typeof serialized !== 'string') {
      throw new TypeError('deserializeDatePayload requires a string input');
    }
    try {
      const parsed = JSON.parse(serialized);
      if (!parsed || typeof parsed !== 'object') {
        return { from: null, to: null, targetDate: null, timestamp: null, format: 'DD/MM/YYYY' };
      }
      return {
        from: parsed.from ? String(parsed.from) : null,
        to: parsed.to ? String(parsed.to) : null,
        targetDate: parsed.targetDate ? String(parsed.targetDate) : null,
        timestamp: parsed.timestamp ? String(parsed.timestamp) : null,
        format: parsed.format || 'DD/MM/YYYY'
      };
    } catch (err) {
      return { from: null, to: null, targetDate: null, timestamp: null, format: 'DD/MM/YYYY' };
    }
  }

  return {
    padZero,
    parseDateParts,
    formatDate,
    formatDateTime,
    formatTime,
    serializeDatePayload,
    deserializeDatePayload
  };
});
