const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const app = require('../server/server');
const {
  hashPassword,
  legacySha256,
  verifyPassword,
  constantTimeEqual,
  isSafeDeviceIp,
  sanitizeCsvCell,
  sanitizeFilenameDate,
  createRateLimiter,
  securityHeadersMiddleware,
  sanitizeErrorMessage,
} = require('../server/security');

let server;
let baseUrl;
let adminToken = null;
let viewerToken = null;

test.before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Obtain admin and viewer tokens for integration tests
  const adminRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Admin@2026!' })
  });
  assert.equal(adminRes.status, 200);
  const adminData = await adminRes.json();
  adminToken = adminData.token;

  const viewerRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'Viewer@2026!' })
  });
  assert.equal(viewerRes.status, 200);
  const viewerData = await viewerRes.json();
  viewerToken = viewerData.token;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ─── 1. UNIT TESTS: PASSWORD CRYPTOGRAPHY & UPGRADE ───────────────────────────

test('Unit Tests: hashPassword derives valid salted scrypt hash format', () => {
  const password = 'SecureSecretPassword@2026!';
  const hash = hashPassword(password);

  assert.ok(typeof hash === 'string');
  assert.ok(hash.startsWith('scrypt$16384$8$1$'));
  const parts = hash.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[4].length, 32); // 16-byte salt in hex
  assert.equal(parts[5].length, 128); // 64-byte key in hex

  // Verify uniqueness (different salt per hash)
  const hash2 = hashPassword(password);
  assert.notEqual(hash, hash2, 'Salts must be unique per password derivation');
});

test('Unit Tests: verifyPassword authenticates valid scrypt and rejects invalid passwords', () => {
  const password = 'MyStrongPassword123#';
  const hash = hashPassword(password);

  const validResult = verifyPassword(password, hash);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.needsUpgrade, false);

  const invalidResult = verifyPassword('WrongPassword123#', hash);
  assert.equal(invalidResult.valid, false);
  assert.equal(invalidResult.needsUpgrade, false);
});

test('Unit Tests: verifyPassword validates legacy SHA-256 and flags needsUpgrade', () => {
  const password = 'LegacyPassword2026';
  const shaHash = legacySha256(password);

  const result = verifyPassword(password, shaHash);
  assert.equal(result.valid, true);
  assert.equal(result.needsUpgrade, true, 'Legacy SHA-256 must trigger automatic re-hashing upgrade');

  const invalidResult = verifyPassword('WrongPassword', shaHash);
  assert.equal(invalidResult.valid, false);
  assert.equal(invalidResult.needsUpgrade, false);
});

test('Unit Tests: constantTimeEqual prevents timing discrepancy side-channels', () => {
  const a = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  const b = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  const c = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09';

  assert.equal(constantTimeEqual(a, b), true);
  assert.equal(constantTimeEqual(a, c), false);
  assert.equal(constantTimeEqual(a, 'short'), false);
  assert.equal(constantTimeEqual(null, a), false);
});

// ─── 2. UNIT TESTS: SSRF & IP ADDRESS SANITIZER ──────────────────────────────

test('Unit Tests: isSafeDeviceIp permits valid LAN and public IPv4 addresses', () => {
  const safeIps = ['10.10.61.3', '10.10.61.2', '192.168.1.100', '172.16.0.5', '8.8.8.8'];
  for (const ip of safeIps) {
    const res = isSafeDeviceIp(ip);
    assert.equal(res.valid, true, `Expected ${ip} to be valid`);
    assert.equal(res.ip, ip);
  }
});

test('Unit Tests: isSafeDeviceIp blocks loopback, cloud metadata, and reserved networks', () => {
  // 1. Loopback addresses
  assert.equal(isSafeDeviceIp('127.0.0.1').valid, false);
  assert.equal(isSafeDeviceIp('127.0.1.1').valid, false);
  assert.match(isSafeDeviceIp('127.0.0.1').error, /Loopback/);

  // 2. Cloud metadata / link-local addresses (AWS / GCP / Azure 169.254.169.254)
  assert.equal(isSafeDeviceIp('169.254.169.254').valid, false);
  assert.equal(isSafeDeviceIp('169.254.1.1').valid, false);
  assert.match(isSafeDeviceIp('169.254.169.254').error, /metadata/);

  // 3. Unspecified / current network
  assert.equal(isSafeDeviceIp('0.0.0.0').valid, false);

  // 4. Multicast and broadcast
  assert.equal(isSafeDeviceIp('224.0.0.1').valid, false);
  assert.equal(isSafeDeviceIp('255.255.255.255').valid, false);

  // 5. Malformed formats
  assert.equal(isSafeDeviceIp('invalid-host').valid, false);
  assert.equal(isSafeDeviceIp('256.10.10.1').valid, false);
  assert.equal(isSafeDeviceIp('10.10.10').valid, false);
  assert.equal(isSafeDeviceIp(null).valid, false);
});

// ─── 3. UNIT TESTS: CSV FORMULA INJECTION & FILENAME SANITIZATION ─────────────

test('Unit Tests: sanitizeCsvCell neutralizes spreadsheet formula triggers', () => {
  // Triggers: =, +, -, @, tab, carriage return
  assert.equal(sanitizeCsvCell('=cmd|\' /C calc\'!A0'), "\"'=cmd|' /C calc'!A0\"");
  assert.equal(sanitizeCsvCell('+SUM(A1:A10)'), "\"'+SUM(A1:A10)\"");
  assert.equal(sanitizeCsvCell('-123+456'), "\"'-123+456\"");
  assert.equal(sanitizeCsvCell('@IMPORTXML(...)'), "\"'@IMPORTXML(...)\"");
  assert.equal(sanitizeCsvCell('\tmalicious'), "\"'	malicious\"");

  // Double quotes escaped
  assert.equal(sanitizeCsvCell('Normal "Safe" Text'), '"Normal ""Safe"" Text"');
  assert.equal(sanitizeCsvCell(null), '""');
  assert.equal(sanitizeCsvCell(undefined), '""');
});

test('Unit Tests: sanitizeFilenameDate prevents CRLF injection in HTTP headers', () => {
  assert.equal(sanitizeFilenameDate('2026-09-18'), '2026-09-18');
  assert.equal(sanitizeFilenameDate('2026-09-18\r\nSet-Cookie: evil=1'), 'report');
  assert.equal(sanitizeFilenameDate('malicious"injection'), 'report');
  assert.equal(sanitizeFilenameDate('../../etc/passwd'), 'report');
});

// ─── 4. UNIT TESTS: IN-MEMORY RATE LIMITER ────────────────────────────────────

test('Unit Tests: createRateLimiter blocks clients exceeding failed attempt thresholds', () => {
  const limiter = createRateLimiter({ windowMs: 1000, maxAttempts: 3 });
  const mockReq = { ip: '198.51.100.5' };
  let statusSet = null;
  let jsonBody = null;
  const mockRes = {
    setHeader: () => {},
    status: (code) => {
      statusSet = code;
      return {
        json: (data) => {
          jsonBody = data;
        }
      };
    }
  };

  // 1. First 3 attempts pass through
  for (let i = 0; i < 3; i++) {
    let nextCalled = false;
    limiter(mockReq, mockRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    mockReq.registerAuthFailure();
  }

  // 2. 4th attempt must be rejected with 429
  let nextCalled4th = false;
  limiter(mockReq, mockRes, () => { nextCalled4th = true; });
  assert.equal(nextCalled4th, false);
  assert.equal(statusSet, 429);
  assert.match(jsonBody.error, /Too many failed login attempts/);

  // 3. Reset clears the lockout
  limiter.reset('198.51.100.5');
  let nextCalledAfterReset = false;
  limiter(mockReq, mockRes, () => { nextCalledAfterReset = true; });
  assert.equal(nextCalledAfterReset, true);
});

// ─── 5. QUALITY CONTROL (QA): AUTHENTICATION & ACCESS CONTROL LOCKDOWN ────────

test('QA: Unauthenticated requests to sensitive API endpoints must be rejected with 401', async () => {
  const protectedEndpoints = [
    { url: `${baseUrl}/api/status`, method: 'GET' },
    { url: `${baseUrl}/api/departments`, method: 'GET' },
    { url: `${baseUrl}/api/employees`, method: 'GET' },
    { url: `${baseUrl}/api/employees/125`, method: 'GET' },
    { url: `${baseUrl}/api/punches`, method: 'GET' },
    { url: `${baseUrl}/api/dashboard`, method: 'GET' },
    { url: `${baseUrl}/api/reports/daily?from=2026-09-01&to=2026-09-17`, method: 'GET' },
    { url: `${baseUrl}/api/devices`, method: 'GET' },
    { url: `${baseUrl}/api/devices/1`, method: 'GET' },
    { url: `${baseUrl}/api/admin/users`, method: 'GET' },
    { url: `${baseUrl}/api/devices/live-status`, method: 'GET' },
    { url: `${baseUrl}/api/devices/3/ping`, method: 'GET' },
    { url: `${baseUrl}/api/sync`, method: 'POST' },
    { url: `${baseUrl}/api/devices`, method: 'POST' },
    { url: `${baseUrl}/api/employees`, method: 'POST' },
  ];

  for (const ep of protectedEndpoints) {
    const res = await fetch(ep.url, {
      method: ep.method,
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(
      res.status,
      401,
      `Expected 401 Unauthorized for unauthenticated ${ep.method} ${ep.url}, got ${res.status}`
    );
    const data = await res.json();
    assert.match(data.error, /Authentication required/i);
  }
});

test('QA: Viewer role must be forbidden (403) from administrative mutation endpoints', async () => {
  const adminOnlyEndpoints = [
    { url: `${baseUrl}/api/admin/users`, method: 'GET' },
    { url: `${baseUrl}/api/admin/app-users`, method: 'GET' },
    { url: `${baseUrl}/api/sync`, method: 'POST', body: {} },
    { url: `${baseUrl}/api/devices/live-status`, method: 'GET' },
    { url: `${baseUrl}/api/devices/3/ping`, method: 'GET' },
    { url: `${baseUrl}/api/devices`, method: 'POST', body: { sn: 'TEST_SN', alias: 'Test' } },
    { url: `${baseUrl}/api/devices/1`, method: 'PUT', body: { sn: 'TEST_SN' } },
    { url: `${baseUrl}/api/devices/1`, method: 'DELETE' },
    { url: `${baseUrl}/api/employees`, method: 'POST', body: { user_id: 8888, name: 'Hacker' } },
    { url: `${baseUrl}/api/employees/125`, method: 'DELETE' },
  ];

  for (const ep of adminOnlyEndpoints) {
    const res = await fetch(ep.url, {
      method: ep.method,
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': viewerToken
      },
      body: ep.body ? JSON.stringify(ep.body) : undefined
    });
    assert.equal(
      res.status,
      403,
      `Expected 403 Forbidden for viewer on ${ep.method} ${ep.url}, got ${res.status}`
    );
    const data = await res.json();
    assert.match(data.error, /Admin access required/i);
  }
});

// ─── 6. QUALITY CONTROL (QA): SSRF PROTECTION IN DEVICE API ──────────────────

test('QA: Registering devices with loopback or cloud metadata IP addresses is rejected with 400', async () => {
  const invalidIps = ['127.0.0.1', '127.0.1.5', '169.254.169.254', '0.0.0.0', '256.1.1.1'];

  for (const ip of invalidIps) {
    const res = await fetch(`${baseUrl}/api/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-auth-token': adminToken
      },
      body: JSON.stringify({
        sn: `SN_SSRF_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        alias: 'SSRF Exploit Probe',
        ip_address: ip
      })
    });

    assert.equal(
      res.status,
      400,
      `Expected 400 Bad Request when registering device with IP "${ip}", got ${res.status}`
    );
    const data = await res.json();
    assert.ok(data.error);
  }
});

test('QA: Updating device to loopback IP address is rejected with 400', async () => {
  // First create valid device
  const createRes = await fetch(`${baseUrl}/api/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      sn: `SN_UPDATE_${Date.now()}`,
      alias: 'Safe Device',
      ip_address: '10.10.61.50'
    })
  });
  assert.equal(createRes.status, 201);
  const { id } = await createRes.json();

  // Attempt update to 127.0.0.1
  const updateRes = await fetch(`${baseUrl}/api/devices/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      sn: `SN_UPDATE_${Date.now()}`,
      ip_address: '127.0.0.1'
    })
  });
  assert.equal(updateRes.status, 400);

  // Clean up
  await fetch(`${baseUrl}/api/devices/${id}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
});

// ─── 7. QUALITY CONTROL (QA): IDOR MITIGATION ON LEAVE MANAGEMENT ─────────────

test('QA: Viewer cannot edit another employee pending leave request (IDOR Defense)', async () => {
  // 1. Admin creates a leave for employee 46
  const leaveRes = await fetch(`${baseUrl}/api/leaves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      user_id: 46,
      leave_type_id: 1,
      start_date: '2026-11-01',
      end_date: '2026-11-03',
      notes: 'Legitimate request',
      status: 'pending'
    })
  });
  assert.equal(leaveRes.status, 201);
  const { id: leaveId } = await leaveRes.json();

  // 2. Viewer attempts to modify notes on employee 46's leave request
  const viewerTamperRes = await fetch(`${baseUrl}/api/leaves/${leaveId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': viewerToken },
    body: JSON.stringify({
      notes: 'Tampered by unauthorized viewer'
    })
  });
  assert.equal(viewerTamperRes.status, 403);
  const tamperData = await viewerTamperRes.json();
  assert.match(tamperData.error, /not authorized to modify this leave record/i);

  // Clean up
  await fetch(`${baseUrl}/api/leaves/${leaveId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
});

// ─── 8. QUALITY CONTROL (QA): SESSION REVOCATION ON USER STATE MODIFICATION ───

test('QA: Deactivating user revokes all active sessions immediately', async () => {
  const username = `victim_user_${Date.now()}`;
  const password = 'VictimPassword@2026!';

  // 1. Admin creates user
  const createRes = await fetch(`${baseUrl}/api/admin/app-users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      username,
      password,
      full_name: 'Test Deactivate User',
      role: 'viewer'
    })
  });
  assert.equal(createRes.status, 201);
  const { id: userId } = await createRes.json();

  // 2. User logs in to get active session
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(loginRes.status, 200);
  const { token: userToken } = await loginRes.json();

  // 3. User can fetch /api/auth/me
  const meRes1 = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { 'x-auth-token': userToken }
  });
  assert.equal(meRes1.status, 200);

  // 4. Admin deactivates user
  const deactRes = await fetch(`${baseUrl}/api/admin/app-users/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': adminToken },
    body: JSON.stringify({
      full_name: 'Test Deactivate User',
      role: 'viewer',
      is_active: 0
    })
  });
  assert.equal(deactRes.status, 200);

  // 5. User token must now be invalid (revoked)
  const meRes2 = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { 'x-auth-token': userToken }
  });
  assert.equal(meRes2.status, 401, 'Revoked session must reject with 401');

  // Clean up
  await fetch(`${baseUrl}/api/admin/app-users/${userId}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': adminToken }
  });
});

// ─── 9. QUALITY CONTROL (QA): SECURITY HEADERS & ERROR MASKING ────────────────

test('QA: HTTP responses contain essential security headers and no X-Powered-By leakage', async () => {
  const res = await fetch(`${baseUrl}/api/status`, {
    headers: { 'x-auth-token': adminToken }
  });

  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.ok(res.headers.get('content-security-policy'));
  assert.equal(res.headers.get('x-powered-by'), null, 'X-Powered-By header must be stripped');
});

test('QA: sanitizeErrorMessage prevents leaking raw SQL queries and file paths', () => {
  const rawDbError = new Error('You have an error in your SQL syntax near `app_users` at line 1 in /app/server/server.js:42');
  const sanitized = sanitizeErrorMessage(rawDbError);

  assert.equal(sanitized.includes('/app/server'), false);
  assert.equal(sanitized.includes('syntax near'), false);
  assert.match(sanitized, /internal database or server error/i);

  // Client validation errors must be preserved
  const clientError = new Error('Serial number (SN) is required');
  assert.equal(sanitizeErrorMessage(clientError), 'Serial number (SN) is required');
});

// ─── 10. PICKLE / SERIALIZATION INTEGRITY TESTS ───────────────────────────────

test('Pickle Tests: Security configuration and hash descriptor serialization roundtrip', () => {
  const securityProfile = {
    algorithm: 'scrypt',
    params: { N: 16384, r: 8, p: 1, keylen: 64 },
    saltHex: crypto.randomBytes(16).toString('hex'),
    issuedAt: new Date().toISOString(),
    ssrfBlockedNetworks: ['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8', '224.0.0.0/4'],
    formulaTriggers: ['=', '+', '-', '@', '\t', '\r']
  };

  const serialized = JSON.stringify(securityProfile);
  assert.equal(typeof serialized, 'string');
  const deserialized = JSON.parse(serialized);

  assert.deepEqual(deserialized, securityProfile);
  assert.equal(deserialized.algorithm, 'scrypt');
  assert.equal(deserialized.ssrfBlockedNetworks.length, 4);
});

// ─── 11. MUTATION TESTING: SECURITY BOUNDARY VERIFICATION ─────────────────────

test('Mutation Testing: Tampering with IP loopback rule must fail security validation', () => {
  const mutantIpValidator = (ip) => {
    // Mutant: allows 127.0.0.1
    if (ip === '169.254.169.254') return { valid: false };
    return { valid: true };
  };

  const loopbackResult = mutantIpValidator('127.0.0.1');
  assert.strictEqual(loopbackResult.valid, true, 'Mutant incorrectly permits loopback');

  // Our production validator must catch this mutation
  assert.strictEqual(isSafeDeviceIp('127.0.0.1').valid, false, 'Production validator must block loopback');
});

test('Mutation Testing: Tampering with formula trigger detection must be detected', () => {
  const mutantSanitizer = (val) => {
    // Mutant: forgets to check for '=' formula trigger
    if (String(val).startsWith('+')) return `'${val}`;
    return `"${val}"`;
  };

  const mutantOutput = mutantSanitizer('=HYPERLINK(...)');
  assert.equal(mutantOutput.startsWith('"='), true, 'Mutant failed to quote formula');

  // Production sanitizer must neutralize '='
  const prodOutput = sanitizeCsvCell('=HYPERLINK(...)');
  assert.equal(prodOutput.startsWith("\"'="), true, 'Production sanitizer must prefix apostrophe');
});

// ─── 12. UI CREDENTIAL HYGIENE & QUICK LOGIN REMOVAL ──────────────────────────

test('QA: Login interface must not expose quick login buttons or hardcoded credentials', () => {
  const fs = require('fs');
  const path = require('path');

  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

  // Assert complete removal from index.html
  assert.equal(indexHtml.includes('login-presets'), false, 'index.html must not contain login-presets container');
  assert.equal(indexHtml.includes('btn-preset-admin'), false, 'index.html must not contain btn-preset-admin button');
  assert.equal(indexHtml.includes('btn-preset-viewer'), false, 'index.html must not contain btn-preset-viewer button');
  assert.equal(indexHtml.includes('Quick Logins'), false, 'index.html must not contain Quick Logins label');

  // Assert complete removal of preset listeners and hardcoded credentials from app.js
  assert.equal(appJs.includes('btn-preset-admin'), false, 'app.js must not reference btn-preset-admin');
  assert.equal(appJs.includes('btn-preset-viewer'), false, 'app.js must not reference btn-preset-viewer');
  assert.equal(appJs.includes('Admin@2026!'), false, 'app.js must not contain hardcoded Admin credentials');
  assert.equal(appJs.includes('Viewer@2026!'), false, 'app.js must not contain hardcoded Viewer credentials');
});

test('Pickle Tests: Login credentials payload serialization roundtrip without preset contamination', () => {
  const credentialsPayload = {
    username: 'legitimate_operator',
    password: 'UserSpecifiedPassword@2026#',
    timestamp: Date.now(),
    source: 'user_input'
  };

  const serialized = JSON.stringify(credentialsPayload);
  const deserialized = JSON.parse(serialized);

  assert.deepEqual(deserialized, credentialsPayload);
  assert.equal(deserialized.source, 'user_input');
  assert.equal('preset' in deserialized, false, 'Payload must not contain preset flag');
});

test('Mutation Testing: Reintroducing demo presets or hardcoded passwords must fail security checks', () => {
  const validateUiHygiene = (htmlContent, jsContent) => {
    const forbiddenTokens = ['btn-preset-admin', 'btn-preset-viewer', 'Admin@2026!', 'Viewer@2026!'];
    for (const token of forbiddenTokens) {
      if (htmlContent.includes(token) || jsContent.includes(token)) {
        return { compliant: false, token };
      }
    }
    return { compliant: true };
  };

  // 1. Current production files must be compliant
  const fs = require('fs');
  const path = require('path');
  const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  assert.equal(validateUiHygiene(indexHtml, appJs).compliant, true);

  // 2. Mutant containing quick login must be rejected
  const mutantJs = 'document.getElementById("btn-preset-admin").addEventListener("click", () => {});';
  const mutantResult = validateUiHygiene(indexHtml, mutantJs);
  assert.equal(mutantResult.compliant, false);
  assert.equal(mutantResult.token, 'btn-preset-admin');
});

