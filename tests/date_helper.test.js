const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DateHelper = require('../public/date_helper');

// ─── 1. UNIT TESTS ────────────────────────────────────────────────────────────

test('Unit Tests: padZero pads numeric and string inputs properly', () => {
  assert.equal(DateHelper.padZero(5), '05');
  assert.equal(DateHelper.padZero(12), '12');
  assert.equal(DateHelper.padZero('7'), '07');
  assert.equal(DateHelper.padZero(2026, 4), '2026');
  assert.equal(DateHelper.padZero(99, 4), '0099');
  assert.equal(DateHelper.padZero(null), '00');
  assert.equal(DateHelper.padZero(undefined), '00');
});

test('Unit Tests: parseDateParts parses SQL and ISO date strings without timezone day shift', () => {
  // Pure date string (YYYY-MM-DD)
  const p1 = DateHelper.parseDateParts('2026-09-18');
  assert.ok(p1, 'Must parse valid date string');
  assert.equal(p1.year, 2026);
  assert.equal(p1.month, 9);
  assert.equal(p1.day, 18);
  assert.equal(p1.hours, 0);
  assert.equal(p1.minutes, 0);

  // Leap day date string
  const p2 = DateHelper.parseDateParts('2024-02-29');
  assert.equal(p2.year, 2024);
  assert.equal(p2.month, 2);
  assert.equal(p2.day, 29);

  // SQL DATETIME string
  const p3 = DateHelper.parseDateParts('2026-09-18 14:45:30');
  assert.equal(p3.year, 2026);
  assert.equal(p3.month, 9);
  assert.equal(p3.day, 18);
  assert.equal(p3.hours, 14);
  assert.equal(p3.minutes, 45);
  assert.equal(p3.seconds, 30);

  // Day-Month-Year input string (DD/MM/YYYY)
  const p4 = DateHelper.parseDateParts('18/09/2026');
  assert.equal(p4.year, 2026);
  assert.equal(p4.month, 9);
  assert.equal(p4.day, 18);

  // Day-Month-Year with dash (DD-MM-YYYY)
  const p5 = DateHelper.parseDateParts('15-09-2026 08:30:00');
  assert.equal(p5.year, 2026);
  assert.equal(p5.month, 9);
  assert.equal(p5.day, 15);
  assert.equal(p5.hours, 8);
  assert.equal(p5.minutes, 30);
});

test('Unit Tests: formatDate formats dates as Day-Month-Year (DD/MM/YYYY)', () => {
  // ISO string
  assert.equal(DateHelper.formatDate('2026-09-18'), '18/09/2026');
  assert.equal(DateHelper.formatDate('2026-01-05'), '05/01/2026');
  assert.equal(DateHelper.formatDate('2026-12-31'), '31/12/2026');
  assert.equal(DateHelper.formatDate('2024-02-29'), '29/02/2024');

  // Custom separator
  assert.equal(DateHelper.formatDate('2026-09-18', '-'), '18-09-2026');

  // Date instance
  const d = new Date(2026, 8, 18, 10, 0, 0); // Month index 8 = September
  assert.equal(DateHelper.formatDate(d), '18/09/2026');

  // Fallback on invalid inputs
  assert.equal(DateHelper.formatDate(null), '--');
  assert.equal(DateHelper.formatDate(undefined), '--');
  assert.equal(DateHelper.formatDate(''), '--');
  assert.equal(DateHelper.formatDate('not-a-date'), '--');
  assert.equal(DateHelper.formatDate('not-a-date', '/', 'N/A'), 'N/A');
});

test('Unit Tests: formatDateTime formats date and 24-hour time as DD/MM/YYYY HH:mm:ss', () => {
  const dtStr = '2026-09-18 08:30:15';
  assert.equal(DateHelper.formatDateTime(dtStr), '18/09/2026 08:30:15');

  // Without seconds
  assert.equal(DateHelper.formatDateTime(dtStr, { includeSeconds: false }), '18/09/2026 08:30');

  // Date only option
  assert.equal(DateHelper.formatDateTime(dtStr, { includeTime: false }), '18/09/2026');

  // Date instance
  const d = new Date(2026, 8, 18, 17, 5, 9);
  assert.equal(DateHelper.formatDateTime(d), '18/09/2026 17:05:09');

  // Fallback
  assert.equal(DateHelper.formatDateTime(null), '--');
  assert.equal(DateHelper.formatDateTime('invalid'), '--');
});

test('Unit Tests: formatTime backwards compatibility preserves pure time and formats timestamps', () => {
  // Full timestamp becomes Day-Month-Year + Time
  assert.equal(DateHelper.formatTime('2026-09-18 09:15:00'), '18/09/2026 09:15:00');

  // Pure time string is preserved
  assert.equal(DateHelper.formatTime('08:30'), '08:30');
  assert.equal(DateHelper.formatTime('17:00:00'), '17:00:00');

  // Empty / null
  assert.equal(DateHelper.formatTime(null), '--');
  assert.equal(DateHelper.formatTime(''), '--');
});

// ─── 2. PICKLE / SERIALIZATION INTEGRITY TESTS ────────────────────────────────

test('Pickle Tests: Date Payload Serialization & Deserialization roundtrip integrity', () => {
  const originalPayload = {
    from: '2026-09-01',
    to: '2026-09-18',
    targetDate: '2026-09-18',
    timestamp: '2026-09-18 10:30:00'
  };

  const serialized = DateHelper.serializeDatePayload(originalPayload);
  assert.equal(typeof serialized, 'string');

  const deserialized = DateHelper.deserializeDatePayload(serialized);
  assert.equal(deserialized.from, '01/09/2026');
  assert.equal(deserialized.to, '18/09/2026');
  assert.equal(deserialized.targetDate, '18/09/2026');
  assert.equal(deserialized.timestamp, '18/09/2026 10:30:00');
  assert.equal(deserialized.format, 'DD/MM/YYYY');

  // Validation: non-object throws TypeError
  assert.throws(() => DateHelper.serializeDatePayload(null), TypeError);
  assert.throws(() => DateHelper.serializeDatePayload('invalid'), TypeError);
  assert.throws(() => DateHelper.deserializeDatePayload(123), TypeError);
  assert.throws(() => DateHelper.deserializeDatePayload(null), TypeError);
});

// ─── 3. MUTATION TESTING ──────────────────────────────────────────────────────

test('Mutation Testing: Parser and deserializer handle mutant and corrupt inputs gracefully', () => {
  // Mutant 1: Corrupt JSON
  const corruptedJson = '{"from": "18/09/2026", "to": corrupt';
  const recoveredFromCorrupt = DateHelper.deserializeDatePayload(corruptedJson);
  assert.equal(recoveredFromCorrupt.from, null);
  assert.equal(recoveredFromCorrupt.format, 'DD/MM/YYYY');

  // Mutant 2: Out of range month
  assert.equal(DateHelper.parseDateParts('2026-13-18'), null);
  assert.equal(DateHelper.formatDate('2026-13-18'), '--');

  // Mutant 3: Out of range day
  assert.equal(DateHelper.parseDateParts('2026-02-35'), null);
  assert.equal(DateHelper.formatDate('2026-02-35'), '--');

  // Mutant 4: Random strings
  assert.equal(DateHelper.parseDateParts('not a valid date at all'), null);
  assert.equal(DateHelper.formatDate('not a valid date at all'), '--');
});

// ─── 4. QUALITY CONTROL (QA) ──────────────────────────────────────────────────

test('Quality Control (QA): Frontend index.html and app.js integration integrity', () => {
  const htmlPath = path.resolve(__dirname, '../public/index.html');
  const appJsPath = path.resolve(__dirname, '../public/app.js');
  const dateHelperPath = path.resolve(__dirname, '../public/date_helper.js');

  assert.ok(fs.existsSync(dateHelperPath), 'public/date_helper.js must exist');
  assert.ok(fs.existsSync(htmlPath), 'public/index.html must exist');
  assert.ok(fs.existsSync(appJsPath), 'public/app.js must exist');

  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const appJsContent = fs.readFileSync(appJsPath, 'utf8');

  // Script include check
  assert.ok(htmlContent.includes('date_helper.js'), 'index.html must include date_helper.js script tag');

  // Ensure app.js references DateHelper or formatDate
  assert.ok(appJsContent.includes('formatDate'), 'app.js must use formatDate');
  assert.ok(appJsContent.includes('formatDateTime'), 'app.js must define or use formatDateTime');

  // Ensure no unformatted raw date slices in schedule roster or leave table
  assert.ok(!appJsContent.includes("${sc.start_date ? String(sc.start_date).slice(0, 10) : '2013-01-01'}"), 'Schedule card must not use raw YYYY-MM-DD slice');
  assert.ok(!appJsContent.includes("${u.created_at ? u.created_at.substring(0, 10) : '—'}"), 'System users table must not use raw YYYY-MM-DD substring');
});
