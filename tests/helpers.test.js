const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCheckType,
  formatMySQLDateTime,
  serializeRecords,
  deserializeRecords,
  computeDailyAttendance,
} = require('../bridge/helpers');

test('normalizeCheckType should accurately categorize In and Out punches', () => {
  assert.equal(normalizeCheckType('I'), 'in');
  assert.equal(normalizeCheckType('i'), 'in');
  assert.equal(normalizeCheckType('1'), 'in');
  assert.equal(normalizeCheckType(1), 'in');

  assert.equal(normalizeCheckType('O'), 'out');
  assert.equal(normalizeCheckType('o'), 'out');
  assert.equal(normalizeCheckType('0'), 'out');
  assert.equal(normalizeCheckType(0), 'out');

  // Edge cases and fallbacks
  assert.equal(normalizeCheckType(null), 'in');
  assert.equal(normalizeCheckType(undefined), 'in');
  assert.equal(normalizeCheckType('UNKNOWN'), 'in');
});

test('formatMySQLDateTime should produce valid MySQL DATETIME strings', () => {
  const d = new Date('2026-09-14T08:30:00.000Z');
  const formatted = formatMySQLDateTime(d);
  assert.equal(formatted, '2026-09-14 08:30:00');

  assert.equal(formatMySQLDateTime(null), null);
  assert.equal(formatMySQLDateTime('invalid-date'), null);
});

test('serializeRecords & deserializeRecords roundtrip validation (Pickle/Serialization integrity)', () => {
  const records = [
    { id: 1, name: 'Alice', timestamp: new Date('2026-09-14T10:00:00.000Z') },
    { id: 2, name: 'Bob', timestamp: new Date('2026-09-14T11:00:00.000Z') }
  ];

  const serialized = serializeRecords(records);
  assert.ok(typeof serialized === 'string');

  const deserialized = deserializeRecords(serialized);
  assert.equal(deserialized.length, 2);
  assert.equal(deserialized[0].id, 1);
  assert.equal(deserialized[0].name, 'Alice');
  assert.equal(deserialized[0].timestamp, '2026-09-14T10:00:00.000Z');

  // TypeError validations
  assert.throws(() => serializeRecords('invalid'), TypeError);
  assert.throws(() => deserializeRecords(123), TypeError);
});

test('computeDailyAttendance accurately pairs punches into First In and Last Out', () => {
  const punches = [
    { check_time: '2026-09-14T08:00:00.000Z', normalized_type: 'in' },
    { check_time: '2026-09-14T08:00:30.000Z', normalized_type: 'in' }, // double tap within 30s
    { check_time: '2026-09-14T12:00:00.000Z', normalized_type: 'out' },
    { check_time: '2026-09-14T17:00:00.000Z', normalized_type: 'out' },
  ];

  const attendance = computeDailyAttendance(punches);
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].date, '2026-09-14');
  assert.equal(attendance[0].first_in, '2026-09-14T08:00:00.000Z');
  assert.equal(attendance[0].last_out, '2026-09-14T17:00:00.000Z');
  assert.equal(attendance[0].punch_count, 4);
  assert.equal(attendance[0].total_hours, 9);
});

test('computeDailyAttendance handles single punch without erroneous last_out', () => {
  const singlePunch = [
    { check_time: '2026-09-14T08:30:00.000Z', normalized_type: 'in' }
  ];

  const attendance = computeDailyAttendance(singlePunch);
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].date, '2026-09-14');
  assert.equal(attendance[0].first_in, '2026-09-14T08:30:00.000Z');
  assert.equal(attendance[0].last_out, null);
  assert.equal(attendance[0].total_hours, null);
  assert.equal(attendance[0].punch_count, 1);
});

test('computeDailyAttendance handles empty or invalid inputs', () => {
  assert.deepEqual(computeDailyAttendance([]), []);
  assert.deepEqual(computeDailyAttendance(null), []);
  assert.deepEqual(computeDailyAttendance([{ check_time: 'invalid' }]), []);
});
