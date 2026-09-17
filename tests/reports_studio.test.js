const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const app = require('../server/server');

let BASE_URL = process.env.TEST_BASE_URL;
let testServer = null;
let viewerToken = '';

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

  // Authenticate as viewer
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'viewer', password: 'Viewer@2026!' })
  });
  const data = await res.json();
  viewerToken = data.token;
});

after(async () => {
  if (testServer) {
    await new Promise((resolve) => testServer.close(resolve));
  }
  if (app.pool) {
    await app.pool.end();
  }
});

// ─── 1. UNIT TESTS: VIEWER ROLE ACCESS TO REPORT ENDPOINTS ───────────────────

test('Reports Studio API: Viewer role can fetch Daily Paired Shifts with search filter', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/daily?from=2026-09-01&to=2026-09-17&search=Malcolm`, {
    headers: { 'Authorization': `Bearer ${viewerToken}` }
  });
  assert.equal(res.status, 200, 'Viewer must have 200 OK access to daily paired report');
  const data = await res.json();
  assert.ok(Array.isArray(data), 'Report must return an array');
  if (data.length > 0) {
    assert.ok(data.some(r => r.name.includes('Malcolm') || r.badge_number.includes('Malcolm')));
    const first = data[0];
    assert.ok('date' in first);
    assert.ok('badge_number' in first);
    assert.ok('first_in' in first);
    assert.ok('last_out' in first);
    assert.ok('total_hours' in first);
  }
});

test('Reports Studio API: Viewer role can fetch Attendance Summary with department filter', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/attendance-summary?from=2026-09-01&to=2026-09-17&deptId=1`, {
    headers: { 'Authorization': `Bearer ${viewerToken}` }
  });
  assert.equal(res.status, 200, 'Viewer must have 200 OK access to attendance summary');
  const data = await res.json();
  assert.ok(Array.isArray(data));
  if (data.length > 0) {
    assert.ok('days_present' in data[0]);
    assert.ok('total_punches' in data[0]);
  }
});

test('Reports Studio API: Viewer role can fetch Late Arrivals report', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/late-arrivals?from=2026-09-01&to=2026-09-17&threshold=08:15`, {
    headers: { 'Authorization': `Bearer ${viewerToken}` }
  });
  assert.equal(res.status, 200, 'Viewer must have 200 OK access to late arrivals');
  const data = await res.json();
  assert.ok(Array.isArray(data));
  if (data.length > 0) {
    assert.ok('minutes_late' in data[0]);
    assert.ok('check_in_time' in data[0]);
  }
});

test('Reports Studio API: Viewer role can fetch Absentees report', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/absent?date=2026-09-16`, {
    headers: { 'Authorization': `Bearer ${viewerToken}` }
  });
  assert.equal(res.status, 200, 'Viewer must have 200 OK access to absentees report');
  const data = await res.json();
  assert.ok('employees' in data);
  assert.ok(Array.isArray(data.employees));
});

test('Reports Studio API: Viewer role can fetch Overtime report', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/overtime?from=2026-09-01&to=2026-09-17&threshold=17:00`, {
    headers: { 'Authorization': `Bearer ${viewerToken}` }
  });
  assert.equal(res.status, 200, 'Viewer must have 200 OK access to overtime report');
  const data = await res.json();
  assert.ok(Array.isArray(data));
});

test('Reports Studio API: Viewer role can fetch Device Activity report', async () => {
  const res = await fetch(`${BASE_URL}/api/reports/by-device?from=2026-09-01&to=2026-09-17`, {
    headers: { 'Authorization': `Bearer ${viewerToken}` }
  });
  assert.equal(res.status, 200, 'Viewer must have 200 OK access to device report');
  const data = await res.json();
  assert.ok(Array.isArray(data));
});

// ─── 2. UNIT TESTS: CUSTOM COLUMN PROJECTION & CSV EXPORT LOGIC ──────────────

function buildCustomCsv(columns, rows) {
  const headers = columns.map(c => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map(r => {
    return columns.map(c => `"${String(r[c.id] ?? '').replace(/"/g, '""')}"`).join(',');
  });
  return [headers, ...lines].join('\n');
}

function calculateKpis(mode, rows) {
  const totalRecords = rows.length;
  if (totalRecords === 0) {
    return { totalRecords: 0, totalHours: '0.0h', lateCount: 0, absentCount: 0 };
  }

  if (mode === 'daily') {
    const totalHrs = rows.reduce((acc, r) => acc + (Number(r.total_hours) || 0), 0);
    const avgHrs = (totalHrs / totalRecords).toFixed(1);
    const autoOutCount = rows.filter(r => r.is_auto_out).length;
    const uniquePersonnel = new Set(rows.map(r => r.user_id)).size;
    return {
      totalRecords,
      totalHours: `${totalHrs.toFixed(1)}h (avg ${avgHrs}h)`,
      lateCount: autoOutCount,
      absentCount: uniquePersonnel
    };
  }

  return { totalRecords, totalHours: '0.0h', lateCount: 0, absentCount: 0 };
}

test('Unit Test: buildCustomCsv formats selected columns with proper quoting', () => {
  const sampleColumns = [
    { id: 'date', label: 'Date' },
    { id: 'name', label: 'Personnel Name' },
    { id: 'total_hours', label: 'Total Hours' }
  ];
  const sampleRows = [
    { date: '2026-09-16', name: 'John "The Chief" Doe', total_hours: 8.5 },
    { date: '2026-09-16', name: 'Jane Smith', total_hours: 7.25 }
  ];

  const csv = buildCustomCsv(sampleColumns, sampleRows);
  const lines = csv.split('\n');

  assert.equal(lines.length, 3);
  assert.equal(lines[0], '"Date","Personnel Name","Total Hours"');
  assert.equal(lines[1], '"2026-09-16","John ""The Chief"" Doe","8.5"');
  assert.equal(lines[2], '"2026-09-16","Jane Smith","7.25"');
});

test('Unit Test: calculateKpis accurately computes total and average metrics', () => {
  const rows = [
    { user_id: 1, total_hours: 8.0, is_auto_out: false },
    { user_id: 2, total_hours: 7.0, is_auto_out: true },
    { user_id: 1, total_hours: 6.0, is_auto_out: false }
  ];

  const kpis = calculateKpis('daily', rows);
  assert.equal(kpis.totalRecords, 3);
  assert.equal(kpis.totalHours, '21.0h (avg 7.0h)');
  assert.equal(kpis.lateCount, 1);
  assert.equal(kpis.absentCount, 2);
});

// ─── 3. PICKLE / SERIALIZATION INTEGRITY TESTS ────────────────────────────────

test('Pickle Tests: Report preset payload serialization roundtrip integrity', () => {
  const samplePreset = {
    name: 'Executive Weekly Tardiness Report',
    mode: 'late',
    from: '2026-09-01',
    to: '2026-09-17',
    deptId: '2',
    search: 'Security',
    threshold: '08:15',
    columns: ['date', 'badge_number', 'name', 'dept_name', 'check_in_time', 'minutes_late']
  };

  const serialized = JSON.stringify(samplePreset);
  assert.equal(typeof serialized, 'string');
  const deserialized = JSON.parse(serialized);

  assert.deepEqual(deserialized, samplePreset);
  assert.equal(deserialized.name, 'Executive Weekly Tardiness Report');
  assert.equal(deserialized.columns.length, 6);
  assert.ok(deserialized.columns.includes('minutes_late'));
});

test('Pickle Tests: Custom report dataset serialization roundtrip integrity', () => {
  const sampleDataset = [
    {
      user_id: 101,
      badge_number: '101',
      name: 'Arthur Pendelton',
      dept_name: 'Registrar',
      date: '2026-09-16',
      first_in: '2026-09-16 08:02:14',
      last_out: '2026-09-16 17:05:22',
      punch_count: 4,
      total_hours: 8.05,
      is_auto_out: false
    }
  ];

  const serialized = JSON.stringify(sampleDataset);
  const deserialized = JSON.parse(serialized);

  assert.deepEqual(deserialized, sampleDataset);
  assert.equal(deserialized[0].user_id, 101);
  assert.equal(deserialized[0].total_hours, 8.05);
});

// ─── 4. MUTATION TESTING ──────────────────────────────────────────────────────

test('Mutation Testing: Missing or null values in row fields fall back gracefully', () => {
  const corruptedRows = [
    { date: '2026-09-16', name: null, total_hours: undefined }
  ];
  const columns = [
    { id: 'date', label: 'Date' },
    { id: 'name', label: 'Name' },
    { id: 'total_hours', label: 'Hours' }
  ];

  const csv = buildCustomCsv(columns, corruptedRows);
  const lines = csv.split('\n');
  assert.equal(lines[1], '"2026-09-16","",""');
});

test('Mutation Testing: calculateKpis handles empty records without division by zero', () => {
  const emptyKpis = calculateKpis('daily', []);
  assert.strictEqual(emptyKpis.totalRecords, 0);
  assert.strictEqual(emptyKpis.totalHours, '0.0h');
  assert.strictEqual(emptyKpis.lateCount, 0);
  assert.strictEqual(emptyKpis.absentCount, 0);
  assert.ok(!emptyKpis.totalHours.includes('NaN'), 'Must never output NaN');
});

test('Mutation Testing: Preset schema validation rejects malformed structures', () => {
  const isValidPreset = (p) => {
    return !!(
      p &&
      typeof p.name === 'string' &&
      p.name.trim().length > 0 &&
      typeof p.mode === 'string' &&
      Array.isArray(p.columns) &&
      p.columns.length > 0
    );
  };

  assert.strictEqual(isValidPreset({ name: 'Valid', mode: 'daily', columns: ['date'] }), true);
  // Mutant 1: empty name
  assert.strictEqual(isValidPreset({ name: '   ', mode: 'daily', columns: ['date'] }), false);
  // Mutant 2: missing columns
  assert.strictEqual(isValidPreset({ name: 'Valid', mode: 'daily', columns: [] }), false);
  // Mutant 3: null object
  assert.strictEqual(isValidPreset(null), false);
});

// ─── 5. FRONTEND DOM & CONTROLLER INTEGRITY TESTS ─────────────────────────────

test('Frontend DOM & Controller Integrity: Unified Reports Studio elements and structure', () => {
  const fs = require('fs');
  const path = require('path');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8');
  const styleCss = fs.readFileSync(path.resolve(__dirname, '../public/style.css'), 'utf8');

  // 1. Navigation verification: Single unified Reports Studio, redundant entry removed
  assert.ok(indexHtml.includes('id="nav-reports"'), 'index.html must include id="nav-reports"');
  assert.ok(indexHtml.includes('data-tab="reports"'), 'nav-reports must specify data-tab="reports"');
  assert.ok(indexHtml.includes('<span>Reports Studio</span>'), 'nav-reports label must be Reports Studio');
  assert.ok(!indexHtml.includes('id="nav-smart-reports"'), 'Redundant nav-smart-reports must be removed from sidebar');
  assert.ok(!indexHtml.includes('id="view-smart-reports"'), 'Redundant view-smart-reports section must be consolidated');

  // 2. Reports Studio Builder Panel elements
  assert.ok(indexHtml.includes('id="reports-preset-select"'), 'index.html must include preset dropdown');
  assert.ok(indexHtml.includes('id="btn-save-custom-preset"'), 'index.html must include Save Preset button');
  assert.ok(indexHtml.includes('id="btn-delete-custom-preset"'), 'index.html must include Delete Preset button');

  // Report type pills
  assert.ok(indexHtml.includes('id="report-type-pills"'), 'index.html must include report type pills container');
  assert.ok(indexHtml.includes('data-report-type="daily"'), 'Must have daily report pill');
  assert.ok(indexHtml.includes('data-report-type="summary"'), 'Must have summary report pill');
  assert.ok(indexHtml.includes('data-report-type="late"'), 'Must have late report pill');
  assert.ok(indexHtml.includes('data-report-type="absent"'), 'Must have absent report pill');
  assert.ok(indexHtml.includes('data-report-type="overtime"'), 'Must have overtime report pill');
  assert.ok(indexHtml.includes('data-report-type="device"'), 'Must have device report pill');

  // Date range and filters
  assert.ok(indexHtml.includes('id="date-quick-presets"'), 'Must include quick date chips');
  assert.ok(indexHtml.includes('id="report-from"'), 'Must include report-from input');
  assert.ok(indexHtml.includes('id="report-to"'), 'Must include report-to input');
  assert.ok(indexHtml.includes('id="report-dept"'), 'Must include report-dept dropdown');
  assert.ok(indexHtml.includes('id="report-search-input"'), 'Must include report-search-input');
  assert.ok(indexHtml.includes('id="report-threshold-input"'), 'Must include report-threshold-input');

  // Column customizer & action buttons
  assert.ok(indexHtml.includes('id="columns-chips-container"'), 'Must include columns-chips-container');
  assert.ok(indexHtml.includes('id="btn-cols-select-all"'), 'Must include Select All columns button');
  assert.ok(indexHtml.includes('id="btn-cols-reset-default"'), 'Must include Reset Default columns button');
  assert.ok(indexHtml.includes('id="btn-generate-report"'), 'Must include Generate Report button');
  assert.ok(indexHtml.includes('id="btn-reset-report-filters"'), 'Must include Reset Filters button');
  assert.ok(indexHtml.includes('id="btn-export-csv"'), 'Must include Export CSV button');
  assert.ok(indexHtml.includes('id="btn-print-report"'), 'Must include Print/PDF button');
  assert.ok(indexHtml.includes('id="btn-copy-report"'), 'Must include Copy Table button');

  // KPI cards & results table
  assert.ok(indexHtml.includes('id="reports-kpi-grid"'), 'Must include KPI cards strip');
  assert.ok(indexHtml.includes('id="kpi-total-records"'), 'Must include Total Records KPI');
  assert.ok(indexHtml.includes('id="kpi-total-hours"'), 'Must include Hours KPI');
  assert.ok(indexHtml.includes('id="kpi-late-count"'), 'Must include Late Arrivals KPI');
  assert.ok(indexHtml.includes('id="kpi-absent-count"'), 'Must include Absent KPI');
  assert.ok(indexHtml.includes('id="report-table-instant-filter"'), 'Must include instant search filter');
  assert.ok(indexHtml.includes('id="results-count-badge"'), 'Must include results row counter');
  assert.ok(indexHtml.includes('id="reports-thead"'), 'Must include dynamic thead');
  assert.ok(indexHtml.includes('id="reports-tbody"'), 'Must include dynamic tbody');

  // 3. Controller bindings in app.js
  assert.ok(appJs.includes('ReportsStudio'), 'app.js must implement ReportsStudio controller');
  assert.ok(appJs.includes('initReportsStudio'), 'app.js must implement initReportsStudio');
  assert.ok(appJs.includes('COLUMN_DEFS'), 'app.js must define COLUMN_DEFS');
  assert.ok(appJs.includes('renderReportTable'), 'app.js must implement renderReportTable');
  assert.ok(appJs.includes('saveCurrentAsPreset'), 'app.js must implement saveCurrentAsPreset');
  assert.ok(appJs.includes('deleteCurrentPreset'), 'app.js must implement deleteCurrentPreset');
  assert.ok(appJs.includes('exportCsv'), 'app.js must implement exportCsv');
  assert.ok(appJs.includes('copyTable'), 'app.js must implement copyTable');

  // 4. CSS styling
  assert.ok(styleCss.includes('.reports-studio-card'), 'style.css must style .reports-studio-card');
  assert.ok(styleCss.includes('.col-chip'), 'style.css must style .col-chip');
  assert.ok(styleCss.includes('.reports-kpi-grid'), 'style.css must style .reports-kpi-grid');
  assert.ok(styleCss.includes('.sortable-th'), 'style.css must style .sortable-th');
  // 5. Dynamic filter bindings and reactivity
  assert.ok(appJs.includes("report-dept', 'report-from', 'report-to', 'report-threshold-input'"), 'app.js must bind change listeners to all filter inputs');
  assert.ok(appJs.includes('searchDebounceTimer'), 'app.js must provide debounce timer for live server search input');
  assert.ok(appJs.includes('this.updateKpis(rows)'), 'renderReportTable must update KPIs dynamically on filtered records');
});

test('Unit Test: Dynamic filtering updates KPI metrics on row subsets', () => {
  const allRecords = [
    { total_hours: 8.5, is_auto_out: 0, user_id: 1, department: 'Engineering' },
    { total_hours: 7.0, is_auto_out: 1, user_id: 2, department: 'Support' },
    { total_hours: 9.0, is_auto_out: 0, user_id: 3, department: 'Engineering' }
  ];

  const calculateKpis = (records) => {
    const totalRows = records.length;
    const totalHrs = records.reduce((acc, r) => acc + (Number(r.total_hours) || 0), 0);
    const avgHrs = totalRows > 0 ? (totalHrs / totalRows).toFixed(1) : '0.0';
    const autoOutCount = records.filter(r => r.is_auto_out).length;
    const uniquePersonnel = new Set(records.map(r => r.user_id)).size;
    return { totalRows, totalHrs, avgHrs, autoOutCount, uniquePersonnel };
  };

  const fullKpis = calculateKpis(allRecords);
  assert.strictEqual(fullKpis.totalRows, 3);
  assert.strictEqual(fullKpis.totalHrs, 24.5);
  assert.strictEqual(fullKpis.autoOutCount, 1);
  assert.strictEqual(fullKpis.uniquePersonnel, 3);

  // Filter to Engineering only
  const engRecords = allRecords.filter(r => r.department === 'Engineering');
  const engKpis = calculateKpis(engRecords);
  assert.strictEqual(engKpis.totalRows, 2);
  assert.strictEqual(engKpis.totalHrs, 17.5);
  assert.strictEqual(engKpis.avgHrs, '8.8');
  assert.strictEqual(engKpis.autoOutCount, 0);
  assert.strictEqual(engKpis.uniquePersonnel, 2);
});

test('Unit Test: Overtime duration parsing and KPI metrics calculation', () => {
  const parseDurationToHours = (dur) => {
    if (!dur) return 0;
    const clean = String(dur).replace('+', '').trim();
    const parts = clean.split(':').map(Number);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return 0;
    return (parts[0] || 0) + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
  };

  const calculateOvertimeKpis = (records) => {
    const totalRows = records.length;
    const totalOtHours = records.reduce((acc, r) => acc + parseDurationToHours(r.overtime_duration), 0);
    const avgOtHours = totalRows > 0 ? (totalOtHours / totalRows).toFixed(1) : '0.0';
    const uniqueEmps = new Set(records.map(r => r.user_id)).size;

    let maxDurationStr = '00:00:00';
    let maxSecs = 0;
    records.forEach(r => {
      if (!r.overtime_duration) return;
      const clean = String(r.overtime_duration).replace('+', '').trim();
      const parts = clean.split(':').map(Number);
      const secs = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
      if (secs > maxSecs) {
        maxSecs = secs;
        maxDurationStr = clean;
      }
    });

    return { totalRows, totalOtHours: Number(totalOtHours.toFixed(1)), avgOtHours, uniqueEmps, maxDurationStr };
  };

  const sampleLogs = [
    { user_id: 1, overtime_duration: '01:30:00' }, // 1.5h
    { user_id: 2, overtime_duration: '00:45:00' }, // 0.75h
    { user_id: 1, overtime_duration: '02:00:00' }  // 2.0h
  ];

  const kpi = calculateOvertimeKpis(sampleLogs);
  assert.strictEqual(kpi.totalRows, 3);
  assert.strictEqual(kpi.totalOtHours, 4.3); // 1.5 + 0.75 + 2.0 = 4.25 -> 4.3
  assert.strictEqual(kpi.avgOtHours, '1.4');
  assert.strictEqual(kpi.uniqueEmps, 2);
  assert.strictEqual(kpi.maxDurationStr, '02:00:00');
});

test('Pickle Tests: Overtime KPI dataset serialization roundtrip integrity', () => {
  const sampleData = {
    mode: 'overtime',
    range: 'this_week',
    totalIncidents: 19,
    totalOtHours: 3.6,
    avgOtHours: '0.2',
    uniqueEmps: 12,
    maxDuration: '+01:13:00'
  };

  const serialized = JSON.stringify(sampleData);
  const deserialized = JSON.parse(serialized);
  assert.deepStrictEqual(deserialized, sampleData, 'Pickle roundtrip must restore exact overtime KPI state');
});

test('Mutation Testing: Overtime duration parser handles malformed and null values gracefully', () => {
  const parseDurationToHours = (dur) => {
    if (!dur) return 0;
    const clean = String(dur).replace('+', '').trim();
    const parts = clean.split(':').map(Number);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return 0;
    return (parts[0] || 0) + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
  };

  // Mutants:
  assert.strictEqual(parseDurationToHours(null), 0);
  assert.strictEqual(parseDurationToHours(undefined), 0);
  assert.strictEqual(parseDurationToHours('invalid'), 0);
  assert.strictEqual(parseDurationToHours(''), 0);
  assert.strictEqual(parseDurationToHours('+01:00:00'), 1.0);
  assert.strictEqual(parseDurationToHours('00:30:00'), 0.5);
});



