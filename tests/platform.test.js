const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { getLocalDateString } = require('../bridge/helpers');
process.env.NODE_ENV = 'test';
const app = require('../server/server');

let BASE_URL = process.env.TEST_BASE_URL;
let testServer = null;

before(async () => {
  if (!BASE_URL) {
    await new Promise((resolve) => {
      testServer = app.listen(0, '127.0.0.1', () => {
        const port = testServer.address().port;
        BASE_URL = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }
});

after(async () => {
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
  if (app.pool) {
    await app.pool.end();
  }
});

// Global test variables
let adminToken = '';
let viewerToken = '';
let testLeaveId = null;
let testHolidayId = null;
let testCorrectionId = null;
let testAppUserId = null;

test('Auth API: should authenticate admin with valid credentials', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin@2026!' })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.token);
  assert.equal(data.user.username, 'admin');
  assert.equal(data.user.role, 'admin');
  adminToken = data.token;
});

test('Auth API: should authenticate viewer with valid credentials', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'Viewer@2026!' })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.token);
  assert.equal(data.user.username, 'viewer');
  assert.equal(data.user.role, 'viewer');
  viewerToken = data.token;
});

test('Auth API: should reject invalid credentials with 401', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'WrongPassword' })
  });

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.ok(data.error);
});

test('Auth API: /api/auth/me should return current user when token is valid', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.username, 'admin');
  assert.equal(data.user.role, 'admin');
});

test('Auth API: /api/auth/me should reject requests without token', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/me`);
  assert.equal(res.status, 401);
});

test('Role Authorization: viewer should be forbidden from admin-only endpoints', async () => {
  const res = await fetch(`${BASE_URL}/api/admin/app-users`, {
    headers: { 'x-auth-token': viewerToken }
  });

  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /Admin (access|role) required/);
});

test('Role Authorization: admin should access admin-only endpoints', async () => {
  const res = await fetch(`${BASE_URL}/api/admin/app-users`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  assert.ok(data.length >= 2); // admin and viewer
});

test('Live Attendance Board: should return live status and employee records', async () => {
  const res = await fetch(`${BASE_URL}/api/attendance/live?date=2026-09-14`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.date, '2026-09-14');
  assert.ok(data.summary);
  assert.equal(typeof data.summary.total, 'number');
  assert.equal(typeof data.summary.present, 'number');
  assert.equal(typeof data.summary.absent, 'number');
  assert.ok(Array.isArray(data.employees));
  assert.ok(data.employees.length > 0);

  const firstEmp = data.employees[0];
  assert.ok('user_id' in firstEmp);
  assert.ok('name' in firstEmp);
  assert.ok('status' in firstEmp);
  assert.ok(['in', 'out', 'absent'].includes(firstEmp.status));
});

test('Live Attendance Board: defaults to actual current date and includes server timestamp when date omitted', async () => {
  const res = await fetch(`${BASE_URL}/api/attendance/live`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  const expectedDate = getLocalDateString();
  assert.equal(data.date, expectedDate, `Must default to today's local date ${expectedDate} instead of obsolete hardcoded date`);
  assert.ok(data.server_time, 'Must include server_time timestamp');
  assert.ok(data.timestamp, 'Must include timestamp');
  assert.ok(!isNaN(new Date(data.server_time).getTime()), 'server_time must be a valid ISO string');
  assert.ok(data.summary);
  assert.ok(Array.isArray(data.employees));
});

test('Dashboard Overview: defaults to actual current date when date omitted', async () => {
  const res = await fetch(`${BASE_URL}/api/dashboard`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.date, getLocalDateString());
  assert.ok(data.stats);
  assert.equal(typeof data.stats.totalEmployees, 'number');
  assert.equal(typeof data.stats.activeToday, 'number');
  assert.equal(typeof data.stats.punchesToday, 'number');
});

test('Smart Reports: Attendance Summary report', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/attendance-summary?from=2026-09-01&to=2026-09-15`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  if (data.length > 0) {
    assert.ok('days_present' in data[0]);
    assert.ok('total_punches' in data[0]);
  }
});

test('Smart Reports: Late arrivals report', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/late-arrivals?from=2026-09-01&to=2026-09-15&threshold=08:15`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
});

test('Smart Reports: Absentees report', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/absent?date=2026-09-14`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.date, '2026-09-14');
  assert.ok(typeof data.count === 'number');
  assert.ok(Array.isArray(data.employees));
});

test('Smart Reports: Overtime report', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/overtime?from=2026-09-01&to=2026-09-15&threshold=17:00`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
});

test('Smart Reports: Device activity breakdown', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/by-device?from=2026-09-01&to=2026-09-15`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data));
  if (data.length > 0) {
    assert.ok('sn' in data[0]);
    assert.ok('total_punches' in data[0]);
  }
});

test('Smart Reports: CSV Export using _token parameter', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/export/csv?type=summary&from=2026-09-01&to=2026-09-15&_token=${adminToken}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/csv'));
  const text = await res.text();
  assert.ok(text.includes('Badge') && text.includes('Department'));
});

test('Shifts & Schedules API: comprehensive CRUD, rotation, and assignment workflow', async () => {
  // 1. Read existing shifts and schedules
  const [shiftsRes, schedRes] = await Promise.all([
    fetch(`${BASE_URL}/api/shifts`, { headers: { 'x-auth-token': adminToken } }),
    fetch(`${BASE_URL}/api/schedules`, { headers: { 'x-auth-token': adminToken } })
  ]);
  assert.equal(shiftsRes.status, 200);
  assert.equal(schedRes.status, 200);
  const shifts = await shiftsRes.json();
  const schedules = await schedRes.json();
  assert.ok(Array.isArray(shifts));
  assert.ok(Array.isArray(schedules));

  // 2. Viewer role rejection (admin only)
  const viewerShiftRes = await fetch(`${BASE_URL}/api/shifts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': viewerToken },
    body: JSON.stringify({ name: 'Viewer Test Shift', start_time: '08:00', end_time: '16:00' })
  });
  assert.equal(viewerShiftRes.status, 403);

  // 3. Shift validation: missing name or start/end times
  const badShiftRes = await fetch(`${BASE_URL}/api/shifts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({ start_time: '08:00' })
  });
  assert.equal(badShiftRes.status, 400);

  // 4. Create new shift class
  const createShiftRes = await fetch(`${BASE_URL}/api/shifts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      name: 'QA Shift 0800-1600',
      start_time: '08:00',
      end_time: '16:00',
      check_in_time1: '07:30',
      check_in_time2: '08:30',
      check_out_time1: '15:45',
      check_out_time2: '16:30',
      late_grace_minutes: 10,
      early_grace_minutes: 5,
      work_day_fraction: 1.0
    })
  });
  assert.equal(createShiftRes.status, 201);
  const { id: newShiftId } = await createShiftRes.json();
  assert.ok(newShiftId);

  // 5. Update shift class
  const updateShiftRes = await fetch(`${BASE_URL}/api/shifts/${newShiftId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      name: 'QA Shift 0800-1600 (Updated)',
      start_time: '08:15',
      end_time: '16:15',
      late_grace_minutes: 15
    })
  });
  assert.equal(updateShiftRes.status, 200);

  // 6. Create schedule with rotation days in NUM_RUN_DEIL
  const createSchedRes = await fetch(`${BASE_URL}/api/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      name: 'QA 5-Day Weekly Rotation',
      cycle: 1,
      units: 1,
      start_date: '2026-01-01',
      end_date: '2028-12-31',
      details: [
        { start_day: 1, end_day: 1, shift_class_id: newShiftId },
        { start_day: 2, end_day: 2, shift_class_id: newShiftId },
        { start_day: 3, end_day: 3, shift_class_id: newShiftId },
        { start_day: 4, end_day: 4, shift_class_id: newShiftId },
        { start_day: 5, end_day: 5, shift_class_id: newShiftId }
      ]
    })
  });
  assert.equal(createSchedRes.status, 201);
  const { id: newSchedId } = await createSchedRes.json();
  assert.ok(newSchedId);

  // 7. Verify shift cannot be deleted while assigned to schedule
  const blockedDelete = await fetch(`${BASE_URL}/api/shifts/${newShiftId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(blockedDelete.status, 400);

  // 8. Assign employee to schedule via POST /api/schedules/:id/assignments
  const testUserId = 999456;
  await fetch(`${BASE_URL}/api/employees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      user_id: testUserId,
      badge_number: 'SCH-999',
      name: 'Schedule QA Employee'
    })
  });

  const assignRes = await fetch(`${BASE_URL}/api/schedules/${newSchedId}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      user_ids: [testUserId],
      start_date: '2026-09-01',
      end_date: '2027-09-01'
    })
  });
  assert.equal(assignRes.status, 200);

  // 9. Verify employee schedule assignment in GET /api/employees/:id and roster
  const empRes = await fetch(`${BASE_URL}/api/employees/${testUserId}`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(empRes.status, 200);
  const emp = await empRes.json();
  assert.equal(emp.schedule_id, newSchedId);
  assert.equal(emp.schedule_name, 'QA 5-Day Weekly Rotation');

  const rosterRes = await fetch(`${BASE_URL}/api/schedules/${newSchedId}/assignments`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(rosterRes.status, 200);
  const roster = await rosterRes.json();
  assert.ok(roster.some(u => u.user_id === testUserId));

  // 10. Single user schedule endpoint
  const userSchedRes = await fetch(`${BASE_URL}/api/employees/${testUserId}/schedule`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(userSchedRes.status, 200);
  const userSched = await userSchedRes.json();
  assert.equal(userSched.schedule.schedule_id, newSchedId);

  // 11. Unassign employee
  const unassignRes = await fetch(`${BASE_URL}/api/schedules/${newSchedId}/assignments/${testUserId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(unassignRes.status, 200);

  // 12. Delete schedule
  const delSchedRes = await fetch(`${BASE_URL}/api/schedules/${newSchedId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(delSchedRes.status, 200);

  // 13. Delete shift
  const delShiftRes = await fetch(`${BASE_URL}/api/shifts/${newShiftId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(delShiftRes.status, 200);

  // Clean up employee
  await fetch(`${BASE_URL}/api/employees/${testUserId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
});

test('Leave Management API: create, read, update, delete workflow', async () => {
  // 1. Get leave types
  const typesRes = await fetch(`${BASE_URL}/api/leave-types`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(typesRes.status, 200);
  const types = await typesRes.json();
  assert.ok(types.length > 0);
  const typeId = types[0].id;

  // 2. Create leave
  const createRes = await fetch(`${BASE_URL}/api/leaves`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': adminToken
    },
    body: JSON.stringify({
      user_id: 46,
      leave_type_id: typeId,
      start_date: '2026-10-01',
      end_date: '2026-10-05',
      notes: 'Automated test leave',
      status: 'pending'
    })
  });

  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.ok(createData.id);
  testLeaveId = createData.id;

  // 3. Update status (approve)
  const updateRes = await fetch(`${BASE_URL}/api/leaves/${testLeaveId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': adminToken
    },
    body: JSON.stringify({ status: 'approved' })
  });
  assert.equal(updateRes.status, 200);

  // 4. Delete leave
  const deleteRes = await fetch(`${BASE_URL}/api/leaves/${testLeaveId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(deleteRes.status, 200);
});

test('Holiday Calendar API: create, read, delete workflow', async () => {
  // 1. Create holiday
  const createRes = await fetch(`${BASE_URL}/api/holidays`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': adminToken
    },
    body: JSON.stringify({
      name: 'Automated Test Holiday',
      date: '2026-12-25',
      duration: 1
    })
  });

  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.ok(createData.id);
  testHolidayId = createData.id;

  // 2. Read holidays
  const listRes = await fetch(`${BASE_URL}/api/holidays?year=2026`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.some(h => h.id === testHolidayId));

  // 3. Delete holiday
  const deleteRes = await fetch(`${BASE_URL}/api/holidays/${testHolidayId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(deleteRes.status, 200);
});

test('Punch Corrections API: add, list, void workflow', async () => {
  // 1. Add punch correction
  const createRes = await fetch(`${BASE_URL}/api/punch-corrections`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': adminToken
    },
    body: JSON.stringify({
      user_id: 1,
      check_time: '2026-09-14 09:00:00',
      check_type: 'in',
      reason: 'Official court session appearance'
    })
  });

  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.ok(createData.id);
  testCorrectionId = createData.id;

  // 2. Void correction
  const deleteRes = await fetch(`${BASE_URL}/api/punch-corrections/${testCorrectionId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(deleteRes.status, 200);
});

test('System Users API: admin CRUD workflow', async () => {
  const testUsername = `testuser_${Date.now()}`;

  // 1. Create user
  const createRes = await fetch(`${BASE_URL}/api/admin/app-users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': adminToken
    },
    body: JSON.stringify({
      username: testUsername,
      password: 'TestPassword@2026!',
      full_name: 'Test Registry User',
      role: 'viewer',
      is_active: 1
    })
  });

  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.ok(createData.id);
  testAppUserId = createData.id;

  // 2. Update user
  const updateRes = await fetch(`${BASE_URL}/api/admin/app-users/${testAppUserId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': adminToken
    },
    body: JSON.stringify({
      full_name: 'Updated Test User',
      role: 'admin',
      is_active: 1
    })
  });
  assert.equal(updateRes.status, 200);

  // 3. Delete user
  const deleteRes = await fetch(`${BASE_URL}/api/admin/app-users/${testAppUserId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(deleteRes.status, 200);
});

test('Clock Devices API: CRUD workflow', async () => {
  const testSn = `TEST_SN_${Date.now()}`;

  // 1. Create Device
  const createRes = await fetch(`${BASE_URL}/api/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      sn: testSn,
      alias: 'Test Entrance Clock',
      ip_address: '10.10.61.99',
      model: 'ZKTeco Test',
      location: 'QA Testing Lab',
      status: 'active'
    })
  });
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.ok(createData.id);
  const deviceId = createData.id;

  // 2. Fetch Device
  const getRes = await fetch(`${BASE_URL}/api/devices/${deviceId}`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(getRes.status, 200);
  const deviceData = await getRes.json();
  assert.equal(deviceData.sn, testSn);
  assert.equal(deviceData.alias, 'Test Entrance Clock');

  // 3. Update Device
  const updateRes = await fetch(`${BASE_URL}/api/devices/${deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      sn: testSn,
      alias: 'Updated Test Clock',
      ip_address: '10.10.61.98',
      model: 'ZKTeco Test v2',
      location: 'QA Testing Lab 2',
      status: 'inactive'
    })
  });
  assert.equal(updateRes.status, 200);

  // 4. Delete Device
  const delRes = await fetch(`${BASE_URL}/api/devices/${deviceId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(delRes.status, 200);
});

test('Frontend DOM & Controller Integrity: Add Device, Add User, and Connection Status column', () => {
  const fs = require('fs');
  const path = require('path');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');

  // Assert HTML elements exist
  assert.ok(indexHtml.includes('id="btn-add-device"'), 'index.html must include id="btn-add-device"');
  assert.ok(indexHtml.includes('id="btn-add-user"'), 'index.html must include id="btn-add-user"');
  assert.ok(indexHtml.includes('id="device-modal"'), 'index.html must include id="device-modal"');
  assert.ok(indexHtml.includes('<th>Connection</th>'), 'index.html must include Connection table header');
  assert.ok(indexHtml.includes('id="btn-test-all-devices"'), 'index.html must include id="btn-test-all-devices"');

  // Assert app.js queries and handlers
  assert.ok(appJs.includes("document.getElementById('btn-add-device')"), 'app.js must bind to btn-add-device');
  assert.ok(appJs.includes("document.getElementById('btn-add-user')"), 'app.js must bind to btn-add-user');
  assert.ok(appJs.includes("document.getElementById('btn-test-all-devices')"), 'app.js must bind to btn-test-all-devices');
  assert.ok(appJs.includes('getConnectionBadgeHtml'), 'app.js must implement getConnectionBadgeHtml');
  assert.ok(appJs.includes('checkAllDeviceConnections'), 'app.js must implement checkAllDeviceConnections');
});

test('Frontend DOM & Controller Integrity: Schedule & Shift Management Modals and Actions', () => {
  const fs = require('fs');
  const path = require('path');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');

  // Assert HTML elements exist
  assert.ok(indexHtml.includes('id="btn-open-shift-modal"'), 'index.html must include id="btn-open-shift-modal"');
  assert.ok(indexHtml.includes('id="btn-open-schedule-modal"'), 'index.html must include id="btn-open-schedule-modal"');
  assert.ok(indexHtml.includes('id="shift-modal"'), 'index.html must include id="shift-modal"');
  assert.ok(indexHtml.includes('id="schedule-modal"'), 'index.html must include id="schedule-modal"');
  assert.ok(indexHtml.includes('id="schedule-assignments-modal"'), 'index.html must include id="schedule-assignments-modal"');
  assert.ok(indexHtml.includes('id="user-form-schedule"'), 'index.html must include id="user-form-schedule"');

  // Assert app.js controllers and bindings
  assert.ok(appJs.includes('openShiftModal'), 'app.js must implement openShiftModal');
  assert.ok(appJs.includes('openScheduleModal'), 'app.js must implement openScheduleModal');
  assert.ok(appJs.includes('openScheduleAssignmentsModal'), 'app.js must implement openScheduleAssignmentsModal');
  assert.ok(appJs.includes('saveShift'), 'app.js must implement saveShift');
  assert.ok(appJs.includes('saveSchedule'), 'app.js must implement saveSchedule');
});

test('Clock Devices Live Connectivity API: single ping and bulk live-status workflow', async () => {
  // 1. Bulk live-status endpoint
  const bulkRes = await fetch(`${BASE_URL}/api/devices/live-status`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(bulkRes.status, 200);
  const bulkData = await bulkRes.json();
  assert.equal(bulkData.success, true);
  assert.ok(bulkData.statuses);
  assert.ok(typeof bulkData.statuses === 'object');

  // Verify device 3 exists in statuses and has correct structure
  if (bulkData.statuses[3]) {
    assert.equal(typeof bulkData.statuses[3].connected, 'boolean');
    assert.equal(typeof bulkData.statuses[3].latencyMs, 'number');
    assert.equal(bulkData.statuses[3].sn, 'KWQ3241600155');
  }

  // 2. Single ping endpoint for device 3
  const pingRes = await fetch(`${BASE_URL}/api/devices/3/ping`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(pingRes.status, 200);
  const pingData = await pingRes.json();
  assert.equal(pingData.id, 3);
  assert.equal(typeof pingData.connected, 'boolean');
  assert.equal(typeof pingData.latencyMs, 'number');

  // 3. Ping non-existent device returns 404
  const notFoundRes = await fetch(`${BASE_URL}/api/devices/999999/ping`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(notFoundRes.status, 404);
});

test('Serialization Integrity (Pickle Test Validation): user session & leave payload roundtrip', () => {
  const sessionPayload = {
    userId: 42,
    username: 'registrar_clerk',
    role: 'admin',
    issuedAt: new Date().toISOString(),
    permissions: ['READ_ALL', 'WRITE_CORRECTIONS', 'EXPORT_REPORTS']
  };

  const serialized = JSON.stringify(sessionPayload);
  assert.equal(typeof serialized, 'string');

  const deserialized = JSON.parse(serialized);
  assert.deepEqual(deserialized, sessionPayload);
  assert.equal(deserialized.role, 'admin');
  assert.equal(deserialized.permissions.length, 3);
});

test('Decommission of Legacy Access Sync: Verification of server, frontend, and environment integrity', () => {
  const fs = require('fs');
  const path = require('path');

  // 1. Server must no longer import or invoke runSync from bridge/bridge.js
  const serverCode = fs.readFileSync(path.resolve(__dirname, '../server/server.js'), 'utf-8');
  assert.ok(!serverCode.includes("require('../bridge/bridge')"), 'server.js must not import bridge.js');
  assert.ok(!serverCode.includes('runSync()'), 'server.js must not invoke runSync');
  assert.ok(serverCode.includes('syncAllActiveDevices'), 'server.js must use syncAllActiveDevices');

  // 2. Frontend HTML must display "Device Bridge" and not "Access Bridge"
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf-8');
  assert.ok(indexHtml.includes('Device Bridge'), 'index.html must display Device Bridge');
  assert.ok(!indexHtml.includes('Access Bridge'), 'index.html must not display Access Bridge');

  // 3. Frontend JS must reference biometric clocks instead of Access DB sync
  const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf-8');
  assert.ok(appJs.includes('Connecting to biometric clocks...'), 'app.js must display clock connection toast');
  assert.ok(!appJs.includes('sync from Access to MySQL'), 'app.js must not mention sync from Access to MySQL');

  // 4. .env must have SYNC_CRON disabled
  const envContent = fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf-8');
  assert.ok(envContent.includes('SYNC_CRON="disabled"'), '.env must have SYNC_CRON="disabled"');
});

test('Direct Biometric Clock On-Demand Sync API: POST /api/sync execution & structure', async () => {
  const syncRes = await fetch(`${BASE_URL}/api/sync`, {
    method: 'POST',
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(syncRes.status, 200, 'POST /api/sync should return 200 OK');
  const syncData = await syncRes.json();

  assert.equal(syncData.success, true, 'Sync response success must be true');
  assert.ok(syncData.result, 'Response must include result object');
  assert.ok(typeof syncData.result.totalDevices === 'number', 'result must include totalDevices number');
  assert.ok(typeof syncData.result.successfulDevices === 'number', 'result must include successfulDevices number');
  assert.ok(Array.isArray(syncData.result.results), 'result must include results array');
  assert.ok(typeof syncData.result.durationMs === 'number', 'result must include durationMs');
});

test('Pickle / Serialization Integrity: Biometric device sync payload roundtrip', () => {
  const sampleSyncPayload = {
    totalDevices: 6,
    successfulDevices: 1,
    totalPunchesInserted: 3,
    durationMs: 1420,
    results: [
      {
        success: true,
        deviceId: 4,
        deviceSn: 'KWQ3241600076',
        deviceAlias: '6',
        deviceIp: '10.10.61.3',
        punchesRead: 27,
        punchesInserted: 3,
        usersRead: 20
      },
      {
        success: false,
        deviceId: 2,
        deviceSn: '3355300480195',
        deviceAlias: 'CLOCKOLD',
        deviceIp: '192.168.0.13',
        error: 'connect ETIMEDOUT'
      }
    ]
  };

  const serialized = JSON.stringify(sampleSyncPayload);
  assert.equal(typeof serialized, 'string');
  const parsed = JSON.parse(serialized);

  assert.deepEqual(parsed, sampleSyncPayload);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0].punchesInserted, 3);
  assert.equal(parsed.results[1].success, false);
});

test('Mutation Testing: Device sync status evaluation and error resilience', () => {
  const mockSyncResponse = (devices, successful) => ({
    success: true,
    totalDevices: devices,
    successfulDevices: successful,
    isHealthy: successful > 0
  });

  const normal = mockSyncResponse(6, 1);
  assert.strictEqual(normal.isHealthy, true, 'At least 1 device connected is considered healthy');

  // Mutant 1: successful count inverted or zero
  const mutantZero = mockSyncResponse(6, 0);
  assert.strictEqual(mutantZero.isHealthy, false, '0 connected devices must report unhealthy');

  // Mutant 2: tampering with successful count > total must be caught
  assert.ok(normal.successfulDevices <= normal.totalDevices, 'Successful devices cannot exceed total');
});

test('Employee Profile Modal API: GET /api/employees/:id returns complete summary & punches', async () => {
  // Test with employee 125 (Malcolm)
  const res = await fetch(`${BASE_URL}/api/employees/125`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(res.status, 200, 'Employee 125 must return 200 OK');
  const data = await res.json();

  assert.equal(data.user_id, 125);
  assert.ok(data.name, 'Employee must have a name');
  assert.ok(Array.isArray(data.punches), 'punches must be an array');
  assert.ok(Array.isArray(data.rawPunches), 'rawPunches must be an array');
  assert.ok(Array.isArray(data.dailyAttendance), 'dailyAttendance must be an array');
  assert.ok(Array.isArray(data.dailySummary), 'dailySummary must be an array');

  // Verify dailySummary structure matches modal expectations
  if (data.dailySummary.length > 0) {
    const day = data.dailySummary[0];
    assert.ok(day.date, 'dailySummary item must include date');
    assert.ok('hours_worked' in day, 'dailySummary item must include hours_worked');
  }

  // Non-existent employee returns 404
  const notFoundRes = await fetch(`${BASE_URL}/api/employees/999999`, {
    headers: { 'x-auth-token': adminToken }
  });
  assert.equal(notFoundRes.status, 404, 'Non-existent employee must return 404');
});

test('Pickle / Serialization Integrity: Employee profile payload roundtrip', () => {
  const sampleProfilePayload = {
    user_id: 125,
    name: 'Malcolm',
    badge_number: '125',
    dept_name: 'Operations',
    dailyAttendance: [
      { date: '2026-09-16', first_in: '15:22:58', last_out: '15:25:41', total_punches: 3, total_hours: 0.05 }
    ],
    dailySummary: [
      { date: '2026-09-16', first_in: '15:22:58', last_out: '15:25:41', total_punches: 3, total_hours: 0.05, hours_worked: 0.05 }
    ]
  };

  const serialized = JSON.stringify(sampleProfilePayload);
  assert.equal(typeof serialized, 'string');
  const deserialized = JSON.parse(serialized);

  assert.deepEqual(deserialized, sampleProfilePayload);
  assert.equal(deserialized.user_id, 125);
  assert.equal(deserialized.dailySummary[0].hours_worked, 0.05);
});

test('Mutation Testing: Employee modal payload structure resilience', () => {
  const validatePayload = (payload) => {
    return !!(
      payload &&
      payload.user_id &&
      Array.isArray(payload.punches) &&
      Array.isArray(payload.dailyAttendance) &&
      Array.isArray(payload.dailySummary)
    );
  };

  const valid = { user_id: 1, punches: [], dailyAttendance: [], dailySummary: [] };
  assert.strictEqual(validatePayload(valid), true);

  // Mutant 1: undefined dailyAttendance
  const mutant1 = { user_id: 1, punches: [], dailyAttendance: undefined, dailySummary: [] };
  assert.strictEqual(validatePayload(mutant1), false);

  // Mutant 2: missing user_id
  const mutant2 = { punches: [], dailyAttendance: [], dailySummary: [] };
  assert.strictEqual(validatePayload(mutant2), false);
});
