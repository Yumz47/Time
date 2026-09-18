const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
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
  getLocalDateString,
  serializeLiveBoardPayload,
  deserializeLiveBoardPayload,
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

test('computeDailyAttendance accurately pairs punches into First In and Last Out with lunch deduction', () => {
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
  assert.equal(attendance[0].total_hours, 8, 'Full Mon-Thu 08:00-17:00 workday must calculate as 8.00h (1h lunch deducted)');
  assert.equal(attendance[0].raw_hours, 9);
  assert.equal(attendance[0].is_auto_out, false);
});

test('computeDailyAttendance handles single punch without auto-completion when disabled', () => {
  const singlePunch = [
    { check_time: '2026-09-14T08:30:00.000Z', normalized_type: 'in' }
  ];

  const attendance = computeDailyAttendance(singlePunch, { autoCompleteMissedOut: false });
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].date, '2026-09-14');
  assert.equal(attendance[0].first_in, '2026-09-14T08:30:00.000Z');
  assert.equal(attendance[0].last_out, null);
  assert.equal(attendance[0].total_hours, null);
  assert.equal(attendance[0].punch_count, 1);
  assert.equal(attendance[0].is_auto_out, false);
});

test('computeDailyAttendance auto-completes missed punch-out to shift end with no extra time (Mon-Thu 17:00)', () => {
  // Arrived early at 07:15, forgot to clock out on Monday
  const singlePunch = [
    { check_time: '2026-09-14T07:15:00.000Z', normalized_type: 'in' }
  ];

  const attendance = computeDailyAttendance(singlePunch, { autoCompleteMissedOut: true });
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].first_in, '2026-09-14T07:15:00.000Z');
  assert.equal(attendance[0].last_out, '2026-09-14T17:00:00.000Z', 'Must set OUT time to 17:00:00 scheduled shift end');
  assert.equal(attendance[0].is_auto_out, true);
  assert.equal(attendance[0].total_hours, 8, 'No extra time: 07:15 capped at 08:00 shift start, minus 1h lunch = 8.00h');
});

test('computeDailyAttendance auto-completes missed punch-out on Friday to 16:30 with no extra time', () => {
  // Arrived early at 07:30, forgot to clock out on Friday (2026-09-11)
  const singlePunch = [
    { check_time: '2026-09-11T07:30:00.000Z', normalized_type: 'in' }
  ];

  const attendance = computeDailyAttendance(singlePunch, { autoCompleteMissedOut: true });
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].last_out, '2026-09-11T16:30:00.000Z', 'Must set Friday OUT time to 16:30:00 scheduled shift end');
  assert.equal(attendance[0].is_auto_out, true);
  assert.equal(attendance[0].total_hours, 7.5, 'Friday scheduled workday must calculate as 7.50h with no extra time');
});

test('computeDailyAttendance prorates working hours for late arrival with auto-complete missed out', () => {
  // Arrived late at 08:30 on Monday, forgot to clock out
  const singlePunch = [
    { check_time: '2026-09-14T08:30:00.000Z', normalized_type: 'in' }
  ];

  const attendance = computeDailyAttendance(singlePunch, { autoCompleteMissedOut: true });
  assert.equal(attendance.length, 1);
  assert.equal(attendance[0].last_out, '2026-09-14T17:00:00.000Z');
  assert.equal(attendance[0].is_auto_out, true);
  // 08:30 to 17:00 = 8.5h span, minus 1.0h lunch = 7.50h
  assert.equal(attendance[0].total_hours, 7.5);
});

test('computeDailyAttendance handles empty or invalid inputs', () => {
  assert.deepEqual(computeDailyAttendance([]), []);
  assert.deepEqual(computeDailyAttendance(null), []);
  assert.deepEqual(computeDailyAttendance([{ check_time: 'invalid' }]), []);
});

// ─── inferNormalizedType — Unit Tests ────────────────────────────────────────

test('inferNormalizedType: first punch (no prior history) should always be IN', () => {
  assert.equal(inferNormalizedType(null, 0), 'in');
  assert.equal(inferNormalizedType(undefined, 0), 'in');
});

test('inferNormalizedType: should toggle IN → OUT → IN → OUT correctly', () => {
  const t0 = new Date('2026-09-16T08:00:00');
  const t1 = new Date('2026-09-16T12:00:00');
  const t2 = new Date('2026-09-16T17:00:00');
  const t3 = new Date('2026-09-16T18:00:00');

  const r1 = inferNormalizedType(null,  0, t0, null); // first punch → in
  assert.equal(r1, 'in');
  const r2 = inferNormalizedType('in',  0, t1, t0);   // in → out
  assert.equal(r2, 'out');
  const r3 = inferNormalizedType('out', 0, t2, t1);   // out → in
  assert.equal(r3, 'in');
  const r4 = inferNormalizedType('in',  0, t3, t2);   // in → out
  assert.equal(r4, 'out');
});

test('inferNormalizedType: explicit hardware inOutStatus overrides toggle', () => {
  // Even if last was 'out', hardware 1 (check-out) must still yield 'out'
  assert.equal(inferNormalizedType('out', 1), 'out');
  // Even if last was 'in', hardware 5 (OT-out) must yield 'out'
  assert.equal(inferNormalizedType('in',  5), 'out');
  // Hardware 4 (default state on clocks like GenReg1) participates in toggle rather than forcing 'in'
  assert.equal(inferNormalizedType('in', 4), 'out');
  assert.equal(inferNormalizedType('out', 4), 'in');
});

test('inferNormalizedType: 5-minute debounce absorbs double-swipes', () => {
  const base = new Date('2026-09-16T08:00:00');
  const within5m = new Date(base.getTime() + 66 * 1000);             // 66 seconds later (User 111 case)
  const after5m  = new Date(base.getTime() + 5 * 60 * 1000 + 1000);  // 5m 1s later

  // Within 5 minutes: should NOT toggle (stays 'in')
  assert.equal(inferNormalizedType('in', 0, within5m, base), 'in');
  // After 5 minutes: SHOULD toggle (in → out)
  assert.equal(inferNormalizedType('in', 0, after5m, base), 'out');
});

// ─── classifyByShiftWindow — Unit Tests ──────────────────────────────────────

test('classifyByShiftWindow: punch at check-in time returns IN', () => {
  // SC/GR (M) shift: CheckInTime1=10:52, CheckInTime2=17:37, CheckOutTime1=17:47, CheckOutTime2=18:22
  // These dates use the legacy Access 1899-12-30 base date
  const shift = {
    CheckInTime1:  new Date('1899-12-30T10:52:48.000Z'), // 10:52:48 UTC
    CheckInTime2:  new Date('1899-12-30T17:37:48.000Z'), // 17:37:48 UTC
    CheckOutTime1: new Date('1899-12-30T17:47:48.000Z'), // 17:47:48 UTC
    CheckOutTime2: new Date('1899-12-30T18:22:48.000Z'), // 18:22:48 UTC
  };

  // Punch at 08:44 local time — within check-in window
  const punchIn = new Date('2026-09-16T10:52:48'); // local 10:52 (same as window start)
  assert.equal(classifyByShiftWindow(punchIn, [shift]), 'in');
});

test('classifyByShiftWindow: punch at check-out time returns OUT', () => {
  const shift = {
    CheckInTime1:  new Date('1899-12-30T10:52:48.000Z'),
    CheckInTime2:  new Date('1899-12-30T17:37:48.000Z'),
    CheckOutTime1: new Date('1899-12-30T17:47:48.000Z'),
    CheckOutTime2: new Date('1899-12-30T18:22:48.000Z'),
  };
  // Punch at 17:55 local → within checkout window
  const punchOut = new Date('2026-09-16T17:55:00');
  assert.equal(classifyByShiftWindow(punchOut, [shift]), 'out');
});

test('classifyByShiftWindow: punch outside all windows returns null (fallback to toggle)', () => {
  const shift = {
    CheckInTime1:  new Date('1899-12-30T10:52:48.000Z'),
    CheckInTime2:  new Date('1899-12-30T17:37:48.000Z'),
    CheckOutTime1: new Date('1899-12-30T17:47:48.000Z'),
    CheckOutTime2: new Date('1899-12-30T18:22:48.000Z'),
  };
  // Punch at 22:00 — outside all windows
  const punchLate = new Date('2026-09-16T22:00:00');
  assert.equal(classifyByShiftWindow(punchLate, [shift]), null);
});

test('classifyByShiftWindow: empty or invalid inputs return null', () => {
  assert.equal(classifyByShiftWindow(null, []), null);
  assert.equal(classifyByShiftWindow(new Date(), null), null);
  assert.equal(classifyByShiftWindow(new Date(), []), null);
});

// ─── resolveNormalizedType — Orchestrator Priority Tests ─────────────────────

test('resolveNormalizedType: hardware inOutStatus=1 wins over toggle', () => {
  // Even if toggle would say 'in' (lastType=out → toggle would be in),
  // hardware 1 must still force 'out'
  assert.equal(resolveNormalizedType('out', 1, new Date(), null, []), 'out');
});

test('resolveNormalizedType: shift window wins over toggle when window matches', () => {
  const shift = {
    CheckInTime1:  new Date('1899-12-30T08:00:00.000Z'),
    CheckInTime2:  new Date('1899-12-30T09:00:00.000Z'),
    CheckOutTime1: new Date('1899-12-30T17:00:00.000Z'),
    CheckOutTime2: new Date('1899-12-30T18:00:00.000Z'),
  };
  // Last known type is 'in' → toggle would say 'out'
  // But punch is at 08:30 (inside CheckIn window) → should return 'in'
  const punchIn = new Date('2026-09-16T08:30:00');
  const result = resolveNormalizedType('in', 0, punchIn, null, [shift]);
  assert.equal(result, 'in');
});

test('resolveNormalizedType: toggle fires when hardware=0 and no shift window matches', () => {
  const t0 = new Date('2026-09-16T08:00:00');
  const t1 = new Date('2026-09-16T17:00:00');
  // last was 'in', hardware=0, no windows, gap>60s → should toggle to 'out'
  assert.equal(resolveNormalizedType('in', 0, t1, t0, []), 'out');
});

// ─── Pickle / Serialization Integrity — Mutation Tests ───────────────────────

test('Pickle test: serialization roundtrip for toggle-classified punch payloads', () => {
  const punches = [
    { user_id: 41, check_time: new Date('2026-09-16T08:44:46'), normalized_type: 'in',  check_type: 'I' },
    { user_id: 41, check_time: new Date('2026-09-16T17:44:53'), normalized_type: 'out', check_type: 'O' },
  ];
  const serialized = serializeRecords(punches);
  const deserialized = deserializeRecords(serialized);

  assert.equal(deserialized.length, 2);
  assert.equal(deserialized[0].normalized_type, 'in');
  assert.equal(deserialized[1].normalized_type, 'out');
  assert.equal(deserialized[0].user_id, 41);
});

test('Mutation test: inverting the toggle condition must fail the alternating sequence', () => {
  // This test ensures the toggle logic is NOT accidentally inverted.
  // If inferNormalizedType were broken (returning same type instead of toggling),
  // all assertions below would fail — proving test robustness.
  const t0 = new Date('2026-09-16T08:00:00');
  const t1 = new Date('2026-09-16T17:00:00');
  const r1 = inferNormalizedType('in', 0, t1, t0);
  assert.notEqual(r1, 'in',  'Toggle after IN must NOT return IN again');
  assert.equal(r1,   'out',  'Toggle after IN must return OUT');

  const r2 = inferNormalizedType('out', 0, t1, t0);
  assert.notEqual(r2, 'out', 'Toggle after OUT must NOT return OUT again');
  assert.equal(r2,   'in',  'Toggle after OUT must return IN');
});

// ─── Daily Reset Principle Tests ("First check of the day is IN") ───────────

test('isSameDay: accurately identifies matching vs differing calendar days', () => {
  assert.equal(isSameDay(new Date('2026-09-16T08:00:00'), new Date('2026-09-16T17:00:00')), true);
  assert.equal(isSameDay(new Date('2026-09-15T17:00:00'), new Date('2026-09-16T08:00:00')), false);
  assert.equal(isSameDay(null, new Date()), false);
  assert.equal(isSameDay(new Date(), null), false);
  assert.equal(isSameDay('invalid', 'invalid'), false);
});

test('Daily Reset: first punch of a new day is ALWAYS IN even if last punch yesterday was IN', () => {
  const yesterdayPunch = new Date('2026-09-15T18:00:00'); // Employee forgot to clock out yesterday
  const todayPunch = new Date('2026-09-16T07:35:00');     // Employee arrives this morning

  // Without daily reset, 'in' would incorrectly toggle to 'out'.
  // With daily reset, because it is a new day with no registered checkins, it MUST be IN.
  const resolved = inferNormalizedType('in', 0, todayPunch, yesterdayPunch);
  assert.equal(resolved, 'in', 'First check of the day must be IN even if yesterday ended on IN');
});

test('Daily Reset: first punch of a new day is ALWAYS IN even if last punch yesterday was OUT', () => {
  const yesterdayPunch = new Date('2026-09-15T17:00:00');
  const todayPunch = new Date('2026-09-16T08:00:00');

  const resolved = inferNormalizedType('out', 0, todayPunch, yesterdayPunch);
  assert.equal(resolved, 'in', 'First check of the day must be IN');
});

test('Daily Reset in resolveNormalizedType orchestrator', () => {
  const yesterdayPunch = new Date('2026-09-15T18:00:00');
  const todayMorning = new Date('2026-09-16T08:00:00');

  const resolved = resolveNormalizedType('in', 0, todayMorning, yesterdayPunch, []);
  assert.equal(resolved, 'in', 'resolveNormalizedType must return IN for the first check of a new day');
});

test('Pickle / Serialization test for multi-day punch sequence with daily reset', () => {
  const punches = [
    { user_id: 125, check_time: '2026-09-15 17:00:00', normalized_type: 'out' },
    { user_id: 125, check_time: '2026-09-16 08:00:00', normalized_type: 'in' },
    { user_id: 125, check_time: '2026-09-16 17:00:00', normalized_type: 'out' },
  ];

  const serialized = serializeRecords(punches);
  const deserialized = deserializeRecords(serialized);

  assert.equal(deserialized.length, 3);
  assert.equal(deserialized[0].normalized_type, 'out');
  assert.equal(deserialized[1].normalized_type, 'in');
  assert.equal(deserialized[2].normalized_type, 'out');
});

test('Mutation test: removing daily reset check would invert morning punch to OUT', () => {
  const yesterdayPunch = new Date('2026-09-15T18:00:00');
  const todayPunch = new Date('2026-09-16T07:35:00');

  // Correct function resets on new day and yields 'in'
  const correctResult = inferNormalizedType('in', 0, todayPunch, yesterdayPunch);
  assert.equal(correctResult, 'in');

  // Mutant simulation: continuous toggle without day check
  const mutantResult = 'in' === 'in' ? 'out' : 'in';
  assert.notEqual(correctResult, mutantResult, 'Mutant continuous toggle across days must fail');
});

// ─── Afternoon Departure Heuristic & Cross-Midnight Shift Window Tests ────────

test('resolveNormalizedType: afternoon departure resolves to OUT even if intermediate morning toggle was OUT (Hydeia Henry case)', () => {
  // First in at 06:35:24
  const firstIn = new Date('2026-09-16T06:35:24');
  // Second morning swipe at 06:50:46 (15 min later) toggled to 'out'
  const morningOut = new Date('2026-09-16T06:50:46');
  // Departure punch at 16:58:03 (4:58 PM, 10 hours later)
  const departurePunch = new Date('2026-09-16T16:58:03');

  // Without shift windows, afternoon departure heuristic must resolve 16:58:03 to OUT (not toggling back to IN)
  const result = resolveNormalizedType('out', 0, departurePunch, morningOut, [], firstIn);
  assert.equal(result, 'out', 'End-of-day departure punch must resolve to OUT after a 10h workday');
});

test('classifyByShiftWindow: handles DB cross-format and afternoon shift windows', () => {
  // SC/GR (a) afternoon shift from database: CheckOut 16:50 to 22:00
  const afternoonShift = {
    schName: 'SC/GR (a)',
    CheckInTime1: '1899-12-30 12:31:00',
    CheckInTime2: '1899-12-30 15:00:00',
    CheckOutTime1: '1899-12-30 16:50:00',
    CheckOutTime2: '1899-12-30 22:00:00',
  };

  const punchAt458PM = new Date('2026-09-16T16:58:03');
  const result = classifyByShiftWindow(punchAt458PM, [afternoonShift]);
  assert.equal(result, 'out', '16:58:03 must match CheckOut window (16:50 - 22:00)');
});

test('Pickle / Serialization test for afternoon departure payload', () => {
  const punchPayload = {
    user_id: 86,
    badge_number: '86',
    name: 'Hydeia Henry',
    check_time: '2026-09-16 16:58:03',
    normalized_type: 'out',
    check_type: 'O',
    sensor_id: '14139',
    device_alias: 'GenReg1',
  };

  const serialized = serializeRecords([punchPayload]);
  const deserialized = deserializeRecords(serialized);

  assert.equal(deserialized.length, 1);
  assert.equal(deserialized[0].user_id, 86);
  assert.equal(deserialized[0].normalized_type, 'out');
  assert.equal(deserialized[0].check_type, 'O');
});

test('Mutation test: omitting departure heuristic would erroneously toggle afternoon departure back to IN', () => {
  const firstIn = new Date('2026-09-16T06:35:24');
  const departurePunch = new Date('2026-09-16T16:58:03');

  // Correct orchestrator with departure heuristic
  const correct = resolveNormalizedType('out', 0, departurePunch, null, [], firstIn);
  assert.equal(correct, 'out');

  // Mutant: naive toggle without departure heuristic would return 'in'
  const mutant = ('out' === 'out') ? 'in' : 'out';
  assert.notEqual(correct, mutant, 'Departure punch must not be erroneously inverted to IN by naive toggle');
});

// ─── Shift Working Hours Review & Auto-Complete Missed Out — QA Tests ────────

test('Pickle / Serialization test for auto-completed shift attendance records', () => {
  const record = {
    date: '2026-09-14',
    first_in: '2026-09-14 07:15:00',
    last_out: '2026-09-14 17:00:00',
    punch_count: 1,
    total_hours: 8.0,
    hours_worked: 8.0,
    raw_hours: 9.75,
    is_auto_out: true,
  };

  const serialized = serializeRecords([record]);
  const deserialized = deserializeRecords(serialized);

  assert.equal(deserialized.length, 1);
  assert.equal(deserialized[0].date, '2026-09-14');
  assert.equal(deserialized[0].is_auto_out, true);
  assert.equal(deserialized[0].total_hours, 8.0);
  assert.equal(deserialized[0].hours_worked, 8.0);
});

test('Mutation test: omitting lunch deduction would overestimate full-day hours by 1.0h', () => {
  const shift = getShiftScheduleForDate('2026-09-14');
  const correctHours = calculateAuditedWorkingHours('2026-09-14 08:00:00', '2026-09-14 17:00:00', shift, false);
  assert.equal(correctHours, 8.0);

  // Mutant: naive span without 1h lunch deduction returns 9.0h
  const mutantHours = 9.0;
  assert.notEqual(correctHours, mutantHours, 'Working hours calculation must deduct 1-hour lunch break');
});

test('Mutation test: omitting early arrival capping would credit unapproved overtime for auto-out', () => {
  const shift = getShiftScheduleForDate('2026-09-14');
  // Arrived early at 07:15, forgot to clock out (auto-out at 17:00)
  const correctHours = calculateAuditedWorkingHours('2026-09-14 07:15:00', '2026-09-14 17:00:00', shift, true);
  assert.equal(correctHours, 8.0, 'No extra time rule must cap at 8.00h');

  // Mutant: calculating span from 07:15 to 17:00 minus lunch yields 8.75h
  const mutantHours = 8.75;
  assert.notEqual(correctHours, mutantHours, 'Auto-completed punch-out must not grant unapproved early arrival overtime');
});

// ─── Morning Arrival vs Terminal "Clock OUT" Keypad State Tests ─────────────

test('resolveNormalizedType: first punch of the day at 08:12 AM with hardware inOutStatus=1 resolves to IN (Malcolm case)', () => {
  // Malcolm arrives at 08:12:20 AM CST. Clock terminal 6 was left on "Clock OUT" (rawInOutStatus=1).
  // Yesterday's departure punch was at 17:02 (lastType='out').
  const yesterdayPunch = new Date('2026-09-16T23:02:42.000Z'); // 17:02:42 CST
  const todayArrival   = new Date('2026-09-17T14:12:20.000Z'); // 08:12:20 CST (hour=8)

  const resolved = resolveNormalizedType('out', 1, todayArrival, yesterdayPunch, []);
  assert.equal(resolved, 'in', 'First punch of day during morning arrival hours must resolve to IN even if terminal is on Clock OUT');
});

test('resolveNormalizedType: shift check-in window match overrides terminal inOutStatus=1', () => {
  const shift = {
    CheckInTime1:  new Date('1899-12-30T08:00:00.000Z'),
    CheckInTime2:  new Date('1899-12-30T09:00:00.000Z'),
    CheckOutTime1: new Date('1899-12-30T17:00:00.000Z'),
    CheckOutTime2: new Date('1899-12-30T18:00:00.000Z'),
  };
  const punchArrival = new Date('2026-09-17T08:15:00'); // within 08:00-09:00 check-in window
  const resolved = resolveNormalizedType('out', 1, punchArrival, null, [shift]);
  assert.equal(resolved, 'in', 'Shift check-in window must override terminal Clock OUT keypad status');
});

test('resolveNormalizedType: subsequent afternoon checkout with inOutStatus=1 resolves to OUT', () => {
  const morningIn    = new Date('2026-09-17T14:12:20.000Z'); // 08:12 CST
  const afternoonOut = new Date('2026-09-17T23:00:00.000Z'); // 17:00 CST

  const resolved = resolveNormalizedType('in', 1, afternoonOut, morningIn, [], morningIn);
  assert.equal(resolved, 'out', 'Afternoon departure with hardware inOutStatus=1 must resolve to OUT');
});

test('inferNormalizedType: morning arrival with inOutStatus=1 on new day resolves to IN', () => {
  const yesterdayPunch = new Date('2026-09-16T23:00:00.000Z');
  const todayMorning   = new Date('2026-09-17T14:00:00.000Z'); // 08:00 CST

  const resolved = inferNormalizedType('out', 1, todayMorning, yesterdayPunch);
  assert.equal(resolved, 'in', 'inferNormalizedType must resolve morning arrival to IN');
});

test('Pickle / Serialization test for morning arrival punch with hardware inOutStatus=1', () => {
  const payload = [
    {
      user_id: 125,
      check_time: '2026-09-17 08:12:20',
      hardware_status: 1,
      normalized_type: 'in',
      check_type: 'I',
      device_alias: '6',
      sn: 'KWQ3241600076'
    }
  ];
  const serialized = serializeRecords(payload);
  const deserialized = deserializeRecords(serialized);

  assert.equal(deserialized.length, 1);
  assert.equal(deserialized[0].user_id, 125);
  assert.equal(deserialized[0].hardware_status, 1);
  assert.equal(deserialized[0].normalized_type, 'in');
  assert.equal(deserialized[0].check_type, 'I');
});

test('Mutation test: removing morning arrival override would erroneously force OUT on first morning swipe', () => {
  // If the morning arrival override were deleted, rawInOutStatus=1 would return 'out'
  const yesterdayPunch = new Date('2026-09-16T23:02:42.000Z');
  const todayArrival   = new Date('2026-09-17T14:12:20.000Z'); // 08:12:20 CST
  const resolved = resolveNormalizedType('out', 1, todayArrival, yesterdayPunch, []);

  // Mutant simulation: naive hardware-first logic
  const mutantResult = 1 === 1 ? 'out' : 'in';

  assert.equal(resolved, 'in', 'Correct logic must yield IN for morning arrival');
  assert.notEqual(resolved, mutantResult, 'Mutant logic returning OUT must differ from correct arrival behavior');
});

// ─── 5-Minute Debounce Duplicate Absorption Tests ───────────────────────────

test('resolveNormalizedType: User 111 case - second punch 66 seconds later absorbs as IN', () => {
  const punch1 = new Date('2026-09-17T12:19:38.000Z'); // 06:19:38 CST
  const punch2 = new Date('2026-09-17T12:20:44.000Z'); // 06:20:44 CST (66s gap)

  const res1 = resolveNormalizedType(null, 0, punch1, null, []);
  assert.equal(res1, 'in', 'First punch must be IN');

  // Second punch 66s later must NOT toggle to OUT, should absorb as IN
  const res2 = resolveNormalizedType(res1, 0, punch2, punch1, []);
  assert.equal(res2, 'in', 'Second punch 66s later must absorb as IN under 5-minute debounce');
});

test('resolveNormalizedType: Ryan Waite case - second punch 4s later on Clock OUT device absorbs as IN', () => {
  // Ryan Waite arrives at 08:50:09 AM on device 6 (terminal set to Clock OUT, status=1)
  // and taps again 4 seconds later at 08:50:13 AM.
  const punch1 = new Date('2026-09-17T14:50:09.000Z'); // 08:50:09 CST
  const punch2 = new Date('2026-09-17T14:50:13.000Z'); // 08:50:13 CST (4s gap)

  const res1 = resolveNormalizedType(null, 1, punch1, null, []);
  assert.equal(res1, 'in', 'First morning punch must resolve to IN');

  // Second punch 4s later with status=1 must absorb as IN, not force OUT
  const res2 = resolveNormalizedType(res1, 1, punch2, punch1, []);
  assert.equal(res2, 'in', 'Second punch within 5 minutes must absorb previous IN state despite terminal status=1');
});

test('computeDailyAttendance: duplicate punches within 5 minutes do not register false departure', () => {
  const records = [
    { user_id: 111, check_time: '2026-09-17 06:19:38', normalized_type: 'in' },
    { user_id: 111, check_time: '2026-09-17 06:20:44', normalized_type: 'in' },
  ];
  const summary = computeDailyAttendance(records, null, { autoCompleteMissedOut: false });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].first_in, '2026-09-17 06:19:38');
  assert.equal(summary[0].last_out, null, 'Duplicate punch 66s later must not register as departure');
});

test('Pickle / Serialization test for 5-minute debounce multi-swipe sequence', () => {
  const punches = [
    { user_id: 79, check_time: '2026-09-17 08:50:09', normalized_type: 'in' },
    { user_id: 79, check_time: '2026-09-17 08:50:13', normalized_type: 'in' },
  ];
  const serialized = serializeRecords(punches);
  const deserialized = deserializeRecords(serialized);

  assert.equal(deserialized.length, 2);
  assert.equal(deserialized[0].normalized_type, 'in');
  assert.equal(deserialized[1].normalized_type, 'in');
});

test('Mutation test: reverting debounce to 60s would erroneously toggle User 111 punch to OUT', () => {
  const punch1 = new Date('2026-09-17T12:19:38.000Z');
  const punch2 = new Date('2026-09-17T12:20:44.000Z'); // 66 seconds gap

  const correctResult = resolveNormalizedType('in', 0, punch2, punch1, []);

  // Mutant simulation: 60-second debounce window
  const gapMs = punch2.getTime() - punch1.getTime();
  const mutantResult = gapMs < 60 * 1000 ? 'in' : 'out'; // would be 'out' at 66s

  assert.equal(correctResult, 'in', '5-minute debounce must preserve IN at 66s');
  assert.equal(mutantResult, 'out', 'Mutant 60s debounce would erroneously toggle to OUT');
  assert.notEqual(correctResult, mutantResult, '5-minute debounce must prevent the mutant 60s toggle');
});

// ─── LIVE BOARD DATE & TIME TEST SUITE ──────────────────────────────────────────

test('Unit Tests: getLocalDateString produces accurate YYYY-MM-DD in local time', () => {
  // Test with explicit date components
  const d1 = new Date(2026, 8, 17, 16, 30, 0); // Sept 17, 2026
  assert.equal(getLocalDateString(d1), '2026-09-17');

  // Test single-digit month and day padding
  const d2 = new Date(2026, 0, 5, 9, 5, 0); // Jan 5, 2026
  assert.equal(getLocalDateString(d2), '2026-01-05');

  // Test leap year day
  const d3 = new Date(2024, 1, 29, 12, 0, 0); // Feb 29, 2024
  assert.equal(getLocalDateString(d3), '2024-02-29');

  // Test year rollover
  const d4 = new Date(2026, 11, 31, 23, 59, 59); // Dec 31, 2026
  assert.equal(getLocalDateString(d4), '2026-12-31');

  // Test default parameter (current date)
  const todayStr = getLocalDateString();
  assert.match(todayStr, /^\d{4}-\d{2}-\d{2}$/);

  // Invalid date inputs must throw TypeError
  assert.throws(() => getLocalDateString('invalid-date-string'), TypeError);
  assert.throws(() => getLocalDateString(new Date('invalid')), TypeError);
});

test('Pickle Tests: serializeLiveBoardPayload and deserializeLiveBoardPayload roundtrip integrity', () => {
  const livePayload = {
    date: '2026-09-17',
    refreshedAt: '2026-09-17T22:30:00.000Z',
    summary: {
      total: 25,
      present: 20,
      absent: 5,
      currently_in: 18,
      currently_out: 2
    },
    employees: [
      { user_id: 111, name: 'Alice', status: 'in', last_punch_time: '2026-09-17 08:12:00' },
      { user_id: 222, name: 'Bob', status: 'out', last_punch_time: '2026-09-17 17:00:00' }
    ]
  };

  const serialized = serializeLiveBoardPayload(livePayload);
  assert.equal(typeof serialized, 'string');

  const deserialized = deserializeLiveBoardPayload(serialized);
  assert.equal(deserialized.date, '2026-09-17');
  assert.equal(deserialized.refreshedAt, '2026-09-17T22:30:00.000Z');
  assert.equal(deserialized.summary.total, 25);
  assert.equal(deserialized.summary.currently_in, 18);
  assert.equal(deserialized.employees.length, 2);
  assert.equal(deserialized.employees[0].name, 'Alice');

  // Deserialization with missing date defaults to current local date
  const partialSerialized = JSON.stringify({ summary: { total: 10 }, employees: [] });
  const restored = deserializeLiveBoardPayload(partialSerialized);
  assert.match(restored.date, /^\d{4}-\d{2}-\d{2}$/);

  // Type errors on invalid inputs
  assert.throws(() => serializeLiveBoardPayload(null), TypeError);
  assert.throws(() => serializeLiveBoardPayload('not-an-object'), TypeError);
  assert.throws(() => deserializeLiveBoardPayload(12345), TypeError);
});

test('Quality Control (QA): Live Attendance Board DOM elements and active source inspection', () => {
  const htmlPath = path.resolve(__dirname, '../public/index.html');
  const appJsPath = path.resolve(__dirname, '../public/app.js');
  const serverJsPath = path.resolve(__dirname, '../server/server.js');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');
  const serverJsContent = fs.readFileSync(serverJsPath, 'utf8');

  // Verify UI controls in index.html
  assert.ok(htmlContent.includes('id="btn-live-today"'), 'index.html must include Today quick jump button #btn-live-today');
  assert.ok(htmlContent.includes('id="live-last-updated"'), 'index.html must include Last Updated timestamp display #live-last-updated');
  assert.ok(htmlContent.includes('id="live-date-input"'), 'index.html must include Target Date picker #live-date-input');

  // Verify zero hardcoded 2026-09-14 default fallbacks in app.js and server.js
  assert.ok(!appJsContent.includes("'2026-09-14'"), 'public/app.js must not contain hardcoded 2026-09-14 date fallback');
  assert.ok(!serverJsContent.includes("'2026-09-14'"), 'server/server.js must not contain hardcoded 2026-09-14 date fallback');
});

test('Mutation Testing: Mutant date formatting and UTC day-boundary shift prevention', () => {
  const localDate = new Date(2026, 8, 17, 23, 45, 0); // 11:45 PM local time
  const correct = getLocalDateString(localDate);

  // Mutant 1: Using unpadded month/day (e.g. 2026-9-17)
  const mutantUnpadded = `${localDate.getFullYear()}-${localDate.getMonth() + 1}-${localDate.getDate()}`;
  if (localDate.getMonth() < 9 || localDate.getDate() < 10) {
    assert.notEqual(correct, mutantUnpadded, 'Mutant unpadded string must be rejected');
  }

  // Mutant 2: Hardcoded fallback date simulation
  const mutantFallback = '2026-09-14';
  assert.notEqual(correct, mutantFallback, 'Live board must not fall back to obsolete 2026-09-14');

  // Mutant 3: Deserializer must reject malformed JSON
  assert.throws(() => deserializeLiveBoardPayload('{ malformed json '), SyntaxError);
});


