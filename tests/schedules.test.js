const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  timeToDateTime,
  calcWorkMinutes,
  validateShiftData,
  validateScheduleData,
  serializeSchedulePayload,
  deserializeSchedulePayload
} = require('../bridge/helpers');

let app;
let server;
let baseUrl;
let adminToken;
let viewerToken;

// Helper to make JSON HTTP requests against our test server
function apiRequest(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const req = http.request(
      url,
      {
        method,
        headers
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            parsed = raw;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed
          });
        });
      }
    );
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('Schedule Suite Setup: boot HTTP server and authenticate roles', async () => {
  const serverModule = require('../server/server');
  app = serverModule.app || serverModule;

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  // Log in as admin
  const adminRes = await apiRequest('POST', '/api/auth/login', {
    username: 'admin',
    password: process.env.ADMIN_DEFAULT_PASSWORD || 'Admin@2026!'
  });
  assert.equal(adminRes.status, 200);
  adminToken = adminRes.body.token;

  // Log in as viewer
  const viewerRes = await apiRequest('POST', '/api/auth/login', {
    username: 'viewer',
    password: process.env.VIEWER_DEFAULT_PASSWORD || 'Viewer@2026!'
  });
  assert.equal(viewerRes.status, 200);
  viewerToken = viewerRes.body.token;
});

// ==========================================
// 1. UNIT TESTS
// ==========================================

test('Unit Tests: timeToDateTime converts HH:mm and HH:mm:ss to 1899-12-30 datetime', () => {
  assert.equal(timeToDateTime('08:00'), '1899-12-30 08:00:00');
  assert.equal(timeToDateTime('17:00:30'), '1899-12-30 17:00:30');
  assert.equal(timeToDateTime('0:00'), '1899-12-30 00:00:00');
  assert.equal(timeToDateTime('23:59:59'), '1899-12-30 23:59:59');

  // Edge cases and invalid inputs
  assert.equal(timeToDateTime(''), null);
  assert.equal(timeToDateTime(null), null);
  assert.equal(timeToDateTime(undefined), null);
  assert.equal(timeToDateTime('25:00'), null);
  assert.equal(timeToDateTime('12:65'), null);
  assert.equal(timeToDateTime('invalid-time'), null);
});

test('Unit Tests: calcWorkMinutes calculates duration and handles overnight shifts', () => {
  // Standard 8am - 5pm shift (9 hours = 540 mins)
  assert.equal(calcWorkMinutes('08:00', '17:00'), 540);

  // Partial shift
  assert.equal(calcWorkMinutes('09:30', '13:45'), 255);

  // Overnight shift: 22:00 to 06:00 (8 hours = 480 mins)
  assert.equal(calcWorkMinutes('22:00', '06:00'), 480);

  // Zero-length shift
  assert.equal(calcWorkMinutes('08:00', '08:00'), 0);

  // Edge cases
  assert.equal(calcWorkMinutes(null, '17:00'), 0);
  assert.equal(calcWorkMinutes('08:00', null), 0);
  assert.equal(calcWorkMinutes('invalid', '17:00'), 0);
});

test('Unit Tests: validateShiftData validates shift models', () => {
  const valid = validateShiftData({
    schName: 'Morning Standard',
    StartTime: '08:00',
    EndTime: '17:00',
    WorkDay: 1.0
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);

  // Missing name
  const noName = validateShiftData({
    schName: '',
    StartTime: '08:00',
    EndTime: '17:00'
  });
  assert.equal(noName.valid, false);

  // Invalid times
  const badTimes = validateShiftData({
    schName: 'Bad Times',
    StartTime: '25:00',
    EndTime: '17:00'
  });
  assert.equal(badTimes.valid, false);

  // Invalid workday fraction
  const badFraction = validateShiftData({
    schName: 'Over Limit',
    StartTime: '08:00',
    EndTime: '17:00',
    WorkDay: 5.0
  });
  assert.equal(badFraction.valid, false);

  // Null input
  assert.equal(validateShiftData(null).valid, false);
});

test('Unit Tests: validateScheduleData validates schedule models and day rules', () => {
  const valid = validateScheduleData({
    name: 'Weekly 5-Day Rotation',
    cycle: 1,
    units: 1,
    days: [
      { day_index: 0, shift_id: 1 },
      { day_index: 1, shift_id: 1 }
    ]
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);

  // Missing name
  assert.equal(validateScheduleData({ name: '' }).valid, false);

  // Invalid cycle
  assert.equal(validateScheduleData({ name: 'Test', cycle: -2 }).valid, false);

  // Invalid day index
  assert.equal(validateScheduleData({
    name: 'Test',
    days: [{ day_index: 999 }]
  }).valid, false);

  // Non-object
  assert.equal(validateScheduleData(undefined).valid, false);
});

// ==========================================
// 2. INTEGRATION API WORKFLOW TESTS
// ==========================================

let createdShiftId = null;
let createdScheduleId = null;
const testEmployeeId = 125; // Known test employee ID in DB

test('API Tests: Shift Class CRUD lifecycle', async () => {
  // 1. Create Shift
  const createRes = await apiRequest(
    'POST',
    '/api/shifts',
    {
      schName: 'Automated Test Shift',
      StartTime: '08:30',
      EndTime: '17:30',
      CheckInTime1: '07:30',
      CheckInTime2: '09:30',
      CheckOutTime1: '16:30',
      CheckOutTime2: '18:30',
      LateMinutes: 10,
      EarlyMinutes: 10,
      WorkDay: 1.0
    },
    adminToken
  );
  assert.equal(createRes.status, 201);
  assert.ok(createRes.body.shift_id);
  createdShiftId = createRes.body.shift_id;

  // 2. Fetch shifts and verify presence
  const listRes = await apiRequest('GET', '/api/shifts', null, adminToken);
  assert.equal(listRes.status, 200);
  const found = listRes.body.find((s) => s.schClassid === createdShiftId);
  assert.ok(found);
  assert.equal(found.schName, 'Automated Test Shift');

  // 3. Update Shift
  const updateRes = await apiRequest(
    'PUT',
    `/api/shifts/${createdShiftId}`,
    {
      schName: 'Automated Test Shift (Updated)',
      StartTime: '09:00',
      EndTime: '18:00',
      LateMinutes: 15
    },
    adminToken
  );
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.success, true);

  // Verify updated fields
  const verifyRes = await apiRequest('GET', '/api/shifts', null, adminToken);
  const updated = verifyRes.body.find((s) => s.schClassid === createdShiftId);
  assert.equal(updated.schName, 'Automated Test Shift (Updated)');
  assert.equal(updated.LateMinutes, 15);
});

test('API Tests: Schedule Rotation CRUD and NUM_RUN_DEIL rules lifecycle', async () => {
  assert.ok(createdShiftId, 'Shift must exist before creating schedule');

  // 1. Create Schedule with day rules
  const createRes = await apiRequest(
    'POST',
    '/api/schedules',
    {
      name: 'Automated Test Schedule',
      cycle: 1,
      units: 1,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      days: [
        { day_index: 0, shift_id: createdShiftId, start_time: '09:00', end_time: '18:00' },
        { day_index: 1, shift_id: createdShiftId, start_time: '09:00', end_time: '18:00' },
        { day_index: 2, shift_id: createdShiftId, start_time: '09:00', end_time: '18:00' }
      ]
    },
    adminToken
  );
  assert.equal(createRes.status, 201);
  assert.ok(createRes.body.schedule_id);
  createdScheduleId = createRes.body.schedule_id;

  // 2. Read Schedule and verify NUM_RUN_DEIL day rules
  const listRes = await apiRequest('GET', '/api/schedules', null, adminToken);
  assert.equal(listRes.status, 200);
  const found = listRes.body.find((s) => s.NUM_RUNID === createdScheduleId);
  assert.ok(found);
  assert.equal(found.NAME, 'Automated Test Schedule');
  assert.equal(found.details.length, 3);

  // 3. Update Schedule
  const updateRes = await apiRequest(
    'PUT',
    `/api/schedules/${createdScheduleId}`,
    {
      name: 'Automated Test Schedule (Updated)',
      cycle: 1,
      units: 1,
      days: [
        { day_index: 0, shift_id: createdShiftId, start_time: '09:00', end_time: '18:00' }
      ]
    },
    adminToken
  );
  assert.equal(updateRes.status, 200);

  const verifyRes = await apiRequest('GET', '/api/schedules', null, adminToken);
  const updated = verifyRes.body.find((s) => s.NUM_RUNID === createdScheduleId);
  assert.equal(updated.NAME, 'Automated Test Schedule (Updated)');
  assert.equal(updated.details.length, 1);
});

test('API Tests: Employee Schedule Assignment and Unassignment lifecycle', async () => {
  assert.ok(createdScheduleId, 'Schedule must exist before assigning employee');

  // 1. Assign employee to schedule
  const assignRes = await apiRequest(
    'POST',
    `/api/schedules/${createdScheduleId}/assignments`,
    {
      userIds: [testEmployeeId],
      startDate: '2026-01-01',
      endDate: '2026-12-31'
    },
    adminToken
  );
  assert.equal(assignRes.status, 200);
  assert.equal(assignRes.body.success, true);

  // 2. Check employee profile schedule assignment
  const empRes = await apiRequest('GET', `/api/employees/${testEmployeeId}/schedule`, null, adminToken);
  assert.equal(empRes.status, 200);
  assert.equal(empRes.body.schedule_id, createdScheduleId);
  assert.equal(empRes.body.schedule_name, 'Automated Test Schedule (Updated)');

  // 3. Verify in schedules listing assigned_users_count >= 1
  const listRes = await apiRequest('GET', '/api/schedules', null, adminToken);
  const sch = listRes.body.find((s) => s.NUM_RUNID === createdScheduleId);
  assert.ok(sch.assigned_users_count >= 1);

  // 4. Unassign employee
  const unassignRes = await apiRequest(
    'DELETE',
    `/api/schedules/${createdScheduleId}/assignments/${testEmployeeId}`,
    null,
    adminToken
  );
  assert.equal(unassignRes.status, 200);
  assert.equal(unassignRes.body.success, true);

  // 5. Verify unassignment
  const empAfterRes = await apiRequest('GET', `/api/employees/${testEmployeeId}/schedule`, null, adminToken);
  assert.equal(empAfterRes.status, 200);
  assert.equal(empAfterRes.body.schedule_id, null);
});

// ==========================================
// 3. QUALITY ASSURANCE (QA) & CONSTRAINTS
// ==========================================

test('QA: Referential integrity protects shift class from deletion while linked to schedule', async () => {
  // Attempt to delete createdShiftId while it is used in createdScheduleId
  const deleteRes = await apiRequest('DELETE', `/api/shifts/${createdShiftId}`, null, adminToken);
  assert.equal(deleteRes.status, 400);
  assert.ok(deleteRes.body.error.includes('referenced in active schedules'));
});

test('QA: Role authorization guarantees non-admins cannot mutate shifts or schedules', async () => {
  // Viewer attempts to create shift -> 403 Forbidden
  const shiftRes = await apiRequest(
    'POST',
    '/api/shifts',
    { schName: 'Unauthorized Shift', StartTime: '08:00', EndTime: '17:00' },
    viewerToken
  );
  assert.equal(shiftRes.status, 403);

  // Viewer attempts to create schedule -> 403 Forbidden
  const schRes = await apiRequest(
    'POST',
    '/api/schedules',
    { name: 'Unauthorized Schedule', cycle: 1, units: 1 },
    viewerToken
  );
  assert.equal(schRes.status, 403);

  // Unauthenticated requests -> 401 Unauthorized
  const unauthRes = await apiRequest('POST', '/api/shifts', { schName: 'No Token' });
  assert.equal(unauthRes.status, 401);
});

test('QA: Schedule deletion cascades and frees referenced shift class for clean deletion', async () => {
  // 1. Delete schedule
  const delSchRes = await apiRequest('DELETE', `/api/schedules/${createdScheduleId}`, null, adminToken);
  assert.equal(delSchRes.status, 200);
  assert.equal(delSchRes.body.success, true);

  // 2. Now shift can be cleanly deleted
  const delShiftRes = await apiRequest('DELETE', `/api/shifts/${createdShiftId}`, null, adminToken);
  assert.equal(delShiftRes.status, 200);
  assert.equal(delShiftRes.body.success, true);

  // Verify shift is gone
  const listRes = await apiRequest('GET', '/api/shifts', null, adminToken);
  assert.equal(listRes.body.some((s) => s.schClassid === createdShiftId), false);
});

// ==========================================
// 4. PICKLE / SERIALIZATION INTEGRITY TESTS
// ==========================================

test('Pickle Tests: serializeSchedulePayload & deserializeSchedulePayload roundtrip integrity', () => {
  const original = {
    scheduleId: 101,
    name: 'Shift Rotation Alpha',
    cycle: 1,
    units: 1,
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-12-31T23:59:59.000Z'),
    details: [
      { day_index: 0, shift_id: 1, start_time: '08:00', end_time: '17:00' },
      { day_index: 1, shift_id: 1, start_time: '08:00', end_time: '17:00' },
      { day_index: 2, shift_id: 2, start_time: '12:00', end_time: '20:00' }
    ],
    assignedUsers: [
      { userId: 125, badge: '125', name: 'Malcolm' },
      { userId: 126, badge: '126', name: 'Hydeia' }
    ]
  };

  const serialized = serializeSchedulePayload(original);
  assert.equal(typeof serialized, 'string');

  const deserialized = deserializeSchedulePayload(serialized);
  assert.equal(deserialized.scheduleId, 101);
  assert.equal(deserialized.name, 'Shift Rotation Alpha');
  assert.equal(deserialized.details.length, 3);
  assert.equal(deserialized.assignedUsers.length, 2);
  assert.equal(deserialized.assignedUsers[0].name, 'Malcolm');

  // Serialization type checks
  assert.throws(() => serializeSchedulePayload(null), TypeError);
  assert.throws(() => serializeSchedulePayload('non-object'), TypeError);
  assert.throws(() => deserializeSchedulePayload(12345), TypeError);
  assert.throws(() => deserializeSchedulePayload('invalid json'), SyntaxError);
});

// ==========================================
// 5. MUTATION TESTING
// ==========================================

test('Mutation Testing: Mutating time strings or day indices must be rejected', () => {
  // 1. Invalid time string mutation: 24:00:00 (hours must be <= 23)
  assert.equal(timeToDateTime('24:00'), null);
  assert.equal(timeToDateTime('12:60'), null);

  // 2. Mutating shift data with invalid time must fail validateShiftData
  const mutantShift = {
    schName: 'Mutant Shift',
    StartTime: '99:99',
    EndTime: '17:00'
  };
  assert.equal(validateShiftData(mutantShift).valid, false);

  // 3. Mutating day index out of bounds must fail validateScheduleData
  const mutantSchedule = {
    name: 'Mutant Schedule',
    days: [{ day_index: -1 }]
  };
  assert.equal(validateScheduleData(mutantSchedule).valid, false);

  // 4. Mutating cycle to 0 or negative must fail validateScheduleData
  const mutantCycle = {
    name: 'Zero Cycle Schedule',
    cycle: 0
  };
  assert.equal(validateScheduleData(mutantCycle).valid, false);
});

test('Schedule Suite Teardown: close HTTP server', async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});
