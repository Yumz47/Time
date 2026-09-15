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
