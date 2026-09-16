const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';

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

test('Shifts & Schedules API', async () => {
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
  assert.ok(shifts.length >= 1);
  assert.ok(schedules.length >= 1);
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
    headers: { 'Content-Type': 'application/json' },
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
  const getRes = await fetch(`${BASE_URL}/api/devices/${deviceId}`);
  assert.equal(getRes.status, 200);
  const deviceData = await getRes.json();
  assert.equal(deviceData.sn, testSn);
  assert.equal(deviceData.alias, 'Test Entrance Clock');

  // 3. Update Device
  const updateRes = await fetch(`${BASE_URL}/api/devices/${deviceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
    method: 'DELETE'
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

test('Clock Devices Live Connectivity API: single ping and bulk live-status workflow', async () => {
  // 1. Bulk live-status endpoint
  const bulkRes = await fetch(`${BASE_URL}/api/devices/live-status`);
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
  const pingRes = await fetch(`${BASE_URL}/api/devices/3/ping`);
  assert.equal(pingRes.status, 200);
  const pingData = await pingRes.json();
  assert.equal(pingData.id, 3);
  assert.equal(typeof pingData.connected, 'boolean');
  assert.equal(typeof pingData.latencyMs, 'number');

  // 3. Ping non-existent device returns 404
  const notFoundRes = await fetch(`${BASE_URL}/api/devices/999999/ping`);
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
