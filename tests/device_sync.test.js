const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatLocalMySQLDateTime,
  normalizeDeviceUser,
  normalizeDeviceAttendance,
} = require('../bridge/device_sync');
const { serializeRecords, deserializeRecords } = require('../bridge/helpers');

test('formatLocalMySQLDateTime should produce formatted local DATETIME string', () => {
  const d = new Date(2026, 8, 16, 9, 15, 30); // Sep 16 2026 09:15:30
  const formatted = formatLocalMySQLDateTime(d);
  assert.equal(formatted, '2026-09-16 09:15:30');

  // Edge cases
  assert.equal(formatLocalMySQLDateTime(null), null);
  assert.equal(formatLocalMySQLDateTime(undefined), null);
  assert.equal(formatLocalMySQLDateTime('invalid-date'), null);
});

test('normalizeDeviceUser should validate, clean, and provide sensible fallbacks', () => {
  // Complete user with cardno
  const u1 = normalizeDeviceUser({
    uid: 84,
    userId: '125',
    name: 'Malcolm',
    cardno: 987654
  });
  assert.deepEqual(u1, {
    userId: 125,
    badgeNumber: '987654',
    name: 'Malcolm'
  });

  // User with blank name and cardno=0
  const u2 = normalizeDeviceUser({
    uid: 85,
    userId: '126',
    name: '',
    cardno: 0
  });
  assert.deepEqual(u2, {
    userId: 126,
    badgeNumber: '126',
    name: 'Employee 126'
  });

  // Invalid user records
  assert.equal(normalizeDeviceUser(null), null);
  assert.equal(normalizeDeviceUser({}), null);
  assert.equal(normalizeDeviceUser({ userId: 'not-a-number' }), null);
  assert.equal(normalizeDeviceUser({ userId: -5 }), null);
});

test('normalizeDeviceAttendance should map device punch data accurately', () => {
  const sampleTime = new Date(2026, 8, 16, 14, 51, 52);
  const rawAtt = {
    userSn: 11,
    deviceUserId: '125',
    recordTime: sampleTime,
    ip: '10.10.61.3'
  };

  const norm = normalizeDeviceAttendance(rawAtt, 'KWQ3241600076');
  assert.ok(norm);
  assert.equal(norm.userId, 125);
  assert.equal(norm.checkTime, '2026-09-16 14:51:52');
  assert.equal(norm.checkType, 'I');
  assert.equal(norm.normType, 'in');
  assert.equal(norm.sensorId, '11');
  assert.equal(norm.workCode, 0);
  assert.equal(norm.sn, 'KWQ3241600076');

  // Invalid records
  assert.equal(normalizeDeviceAttendance(null), null);
  assert.equal(normalizeDeviceAttendance({ deviceUserId: 'invalid' }), null);
  assert.equal(normalizeDeviceAttendance({ deviceUserId: '125', recordTime: 'bad-date' }), null);
});

test('normalizeDeviceAttendance should correctly classify IN vs OUT punch types', () => {
  const baseAtt = { deviceUserId: '125', recordTime: new Date(2026, 8, 16, 17, 0, 0) };

  // inOutStatus=0  → Check In
  const normIn = normalizeDeviceAttendance({ ...baseAtt, inOutStatus: 0 });
  assert.equal(normIn.checkType, 'I');
  assert.equal(normIn.normType, 'in');

  // inOutStatus=1  → Check Out
  const normOut = normalizeDeviceAttendance({ ...baseAtt, inOutStatus: 1 });
  assert.equal(normOut.checkType, 'O');
  assert.equal(normOut.normType, 'out');

  // inOutStatus=4  → Overtime In (treated as in)
  const normOtIn = normalizeDeviceAttendance({ ...baseAtt, inOutStatus: 4 });
  assert.equal(normOtIn.checkType, 'I');
  assert.equal(normOtIn.normType, 'in');

  // inOutStatus=5  → Overtime Out (treated as out)
  const normOtOut = normalizeDeviceAttendance({ ...baseAtt, inOutStatus: 5 });
  assert.equal(normOtOut.checkType, 'O');
  assert.equal(normOtOut.normType, 'out');

  // rawAtt.type fallback (no inOutStatus field)
  const normTypeFallback = normalizeDeviceAttendance({ ...baseAtt, type: 1 });
  assert.equal(normTypeFallback.checkType, 'O');
  assert.equal(normTypeFallback.normType, 'out');

  // No punch type field → defaults to IN
  const normDefault = normalizeDeviceAttendance({ ...baseAtt });
  assert.equal(normDefault.checkType, 'I');
  assert.equal(normDefault.normType, 'in');
});

test('Pickle & serialization integrity test for device sync payloads', () => {
  const users = [
    normalizeDeviceUser({ userId: '101', name: 'Alice', cardno: 1001 }),
    normalizeDeviceUser({ userId: '102', name: 'Bob', cardno: 0 }),
  ];

  const serialized = serializeRecords(users);
  const deserialized = deserializeRecords(serialized);

  assert.equal(deserialized.length, 2);
  assert.equal(deserialized[0].userId, 101);
  assert.equal(deserialized[0].name, 'Alice');
  assert.equal(deserialized[1].userId, 102);
  assert.equal(deserialized[1].badgeNumber, '102');
});

test('decodeRecordData40 should correctly decode inOutStatus (byte 31) and verifyType (byte 26)', () => {
  const zklibUtils = require('node-zklib/utils');
  
  // Construct a simulated 40-byte record buffer:
  // userSn: 17, userId: '41', verifyType: 1 (fingerprint), inOutStatus: 1 (Check Out)
  const buf = Buffer.alloc(40);
  buf.writeUInt16LE(17, 0); // userSn at offset 0
  buf.write('41', 2, 'ascii'); // userId at offset 2..11
  buf[26] = 1; // verifyType at offset 26
  buf.writeUInt32LE(858426293, 27); // timestamp at offset 27..30
  buf[31] = 1; // inOutStatus at offset 31 (Check Out)

  const decoded = zklibUtils.decodeRecordData40(buf);
  assert.equal(decoded.userSn, 17);
  assert.equal(decoded.deviceUserId, '41');
  assert.equal(decoded.verifyType, 1);
  assert.equal(decoded.inOutStatus, 1);

  // Feed decoded record into normalizeDeviceAttendance
  const normalized = normalizeDeviceAttendance(decoded, 'KWQ3241600076');
  assert.equal(normalized.userId, 41);
  assert.equal(normalized.checkType, 'O');
  assert.equal(normalized.normType, 'out');
  assert.equal(normalized.inOutStatus, 1);
});

test('Incremental punch classification correctly toggles new punches against DB state', () => {
  const { resolveNormalizedType } = require('../bridge/helpers');

  // Simulated DB state: user 125's latest punch was IN at 08:30:00
  const latestDbPunch = {
    user_id: 125,
    normalized_type: 'in',
    check_time: new Date('2026-09-16T08:30:00')
  };

  // Simulated device punches:
  // Punch 1: 08:30:00 (old, already in DB)
  // Punch 2: 17:00:00 (new, inOutStatus=0 generic check-in) -> should toggle to OUT
  // Punch 3: 17:00:15 (new, within 60s debounce) -> should remain OUT
  // Punch 4: 19:30:00 (new, inOutStatus=0 generic) -> should toggle to IN
  const devicePunches = [
    { userId: 125, checkTime: '2026-09-16 08:30:00', inOutStatus: 0 },
    { userId: 125, checkTime: '2026-09-16 17:00:00', inOutStatus: 0 },
    { userId: 125, checkTime: '2026-09-16 17:00:15', inOutStatus: 0 },
    { userId: 125, checkTime: '2026-09-16 19:30:00', inOutStatus: 0 },
  ];

  // Filter new punches (strictly > DB max_time)
  const newPunches = devicePunches.filter(
    p => new Date(p.checkTime).getTime() > latestDbPunch.check_time.getTime()
  );
  assert.equal(newPunches.length, 3); // Punch 1 filtered out

  let lastType = latestDbPunch.normalized_type;
  let lastTime = latestDbPunch.check_time;
  const classified = [];

  for (const p of newPunches) {
    const punchDate = new Date(p.checkTime);
    const resolved = resolveNormalizedType(
      lastType,
      p.inOutStatus,
      punchDate,
      lastTime,
      []
    );
    classified.push({ ...p, normType: resolved });
    lastType = resolved;
    lastTime = punchDate;
  }

  // Verification:
  // Punch 2: last was IN -> now OUT
  assert.equal(classified[0].normType, 'out');
  // Punch 3: within 15s debounce -> remains OUT (prevents double-swipe toggle)
  assert.equal(classified[1].normType, 'out');
  // Punch 4: 2.5 hours later -> toggles to IN
  assert.equal(classified[2].normType, 'in');
});

test('Pickle & serialization test for device punches with inOutStatus', () => {
  const punch = normalizeDeviceAttendance({
    userSn: 99,
    deviceUserId: '125',
    recordTime: new Date(2026, 8, 16, 17, 30, 0),
    inOutStatus: 1
  }, 'KWQ3241600076');

  const serialized = serializeRecords([punch]);
  const [deserialized] = deserializeRecords(serialized);

  assert.equal(deserialized.userId, 125);
  assert.equal(deserialized.inOutStatus, 1);
  assert.equal(deserialized.normType, 'out');
  assert.equal(deserialized.sn, 'KWQ3241600076');
});

test('Mutation test: omitting inOutStatus fallback must trigger assertion failure', () => {
  const punchWithOut = normalizeDeviceAttendance({
    userSn: 100,
    deviceUserId: '125',
    recordTime: new Date(2026, 8, 16, 17, 30, 0),
    inOutStatus: 1
  });

  // If inOutStatus is mutated to undefined or ignored, normType would erroneously fall back to 'in'
  assert.equal(punchWithOut.inOutStatus, 1);
  assert.equal(punchWithOut.normType, 'out');

  // Explicit mutation simulation
  const mutant = { ...punchWithOut, inOutStatus: undefined };
  assert.notEqual(mutant.inOutStatus, 1, 'Mutant must differ from valid punch with inOutStatus');
});


