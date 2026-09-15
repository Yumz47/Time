const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { runSync } = require('../bridge/bridge');
const { computeDailyAttendance } = require('../bridge/helpers');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../public')));

// Database pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'timeclock_user',
  password: process.env.DB_PASSWORD || 'TimeClock@2026!',
  database: process.env.DB_NAME || 'timeclock_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

let isSyncInProgress = false;

// ─── AUTH UTILITIES ────────────────────────────────────────────────────────────

/**
 * Hash password using SHA-256
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Generate a secure random session token
 * @returns {string}
 */
function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

/**
 * Middleware: require any authenticated user (admin or viewer)
 */
async function requireAuth(req, res, next) {
  let token = req.headers['x-auth-token'] || req.query._token;
  if (!token && req.headers['authorization']) {
    const parts = req.headers['authorization'].split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const [rows] = await pool.query(
      `SELECT s.user_id, u.username, u.full_name, u.role, u.is_active
       FROM sessions s
       JOIN app_users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > NOW()`,
      [token]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid or expired session' });
    if (!rows[0].is_active) return res.status(403).json({ error: 'Account disabled' });
    req.user = rows[0];
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Middleware: require admin role
 */
async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

// ─── AUTH ENDPOINTS ────────────────────────────────────────────────────────────

// A1. Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const hash = hashPassword(String(password));
    const [rows] = await pool.query(
      'SELECT * FROM app_users WHERE username = ? AND password_hash = ? AND is_active = 1',
      [String(username).trim().toLowerCase(), hash]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = rows[0];
    const token = generateToken();
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 12 HOUR))`,
      [token, user.id]
    );
    res.json({
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A2. Logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers['x-auth-token'] || req.query._token;
  try {
    await pool.query('DELETE FROM sessions WHERE token = ?', [token]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A3. Current user info
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ─── APP USER MANAGEMENT (Admin only) ─────────────────────────────────────────

// AU1. List app users
app.get('/api/admin/app-users', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, username, full_name, role, is_active, created_at FROM app_users ORDER BY role ASC, username ASC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AU2. Create app user
app.post('/api/admin/app-users', requireAdmin, async (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Username, password, and full name are required' });
  }
  const validRoles = ['admin', 'viewer'];
  const userRole = validRoles.includes(role) ? role : 'viewer';
  try {
    const hash = hashPassword(String(password));
    const [result] = await pool.query(
      'INSERT INTO app_users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
      [String(username).trim().toLowerCase(), hash, String(full_name).trim(), userRole]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// AU3. Update app user
app.put('/api/admin/app-users/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { full_name, role, is_active, password } = req.body;
  const validRoles = ['admin', 'viewer'];
  try {
    if (password && String(password).trim()) {
      const hash = hashPassword(String(password));
      await pool.query(
        'UPDATE app_users SET full_name=?, role=?, is_active=?, password_hash=? WHERE id=?',
        [String(full_name).trim(), validRoles.includes(role) ? role : 'viewer', is_active ? 1 : 0, hash, id]
      );
    } else {
      await pool.query(
        'UPDATE app_users SET full_name=?, role=?, is_active=? WHERE id=?',
        [String(full_name).trim(), validRoles.includes(role) ? role : 'viewer', is_active ? 1 : 0, id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AU4. Delete app user
app.delete('/api/admin/app-users/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user.user_id === id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    const [result] = await pool.query('DELETE FROM app_users WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LIVE ATTENDANCE BOARD ─────────────────────────────────────────────────────

// L1. Live attendance: IN / OUT / ABSENT per employee
app.get('/api/attendance/live', requireAuth, async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];
    const deptId = req.query.dept_id ? parseInt(req.query.dept_id, 10) : null;
    const startOfDay = `${targetDate} 00:00:00`;
    const endOfDay = `${targetDate} 23:59:59`;

    let whereClause = '';
    const params = [startOfDay, endOfDay];
    if (deptId) {
      whereClause = 'AND e.dept_id = ?';
      params.push(deptId);
    }

    const [rows] = await pool.query(`
      SELECT
        e.user_id,
        e.name,
        e.badge_number,
        d.dept_name,
        agg.last_punch_time,
        agg.first_in_time,
        last_c.normalized_type AS last_punch_type,
        dev.alias AS device_alias
      FROM employees e
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      LEFT JOIN (
        SELECT user_id, MIN(check_time) AS first_in_time, MAX(check_time) AS last_punch_time
        FROM checkinout
        WHERE check_time >= ? AND check_time <= ?
        GROUP BY user_id
      ) agg ON agg.user_id = e.user_id
      LEFT JOIN checkinout last_c ON last_c.user_id = e.user_id AND last_c.check_time = agg.last_punch_time
      LEFT JOIN devices dev ON dev.sn = last_c.sn
      WHERE 1=1 ${whereClause}
      ORDER BY agg.last_punch_time DESC, e.name ASC
    `, params);

    const data = rows.map(r => ({
      ...r,
      status: !r.last_punch_time ? 'absent'
        : r.last_punch_type === 'out' ? 'out'
        : 'in'
    }));

    const summary = {
      total: data.length,
      present: data.filter(r => r.status !== 'absent').length,
      absent: data.filter(r => r.status === 'absent').length,
      currently_in: data.filter(r => r.status === 'in').length,
      currently_out: data.filter(r => r.status === 'out').length,
    };

    res.json({ date: targetDate, summary, employees: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SMART REPORTS ─────────────────────────────────────────────────────────────

// R1. Attendance summary (per employee, date range)
app.get('/api/reports/attendance-summary', requireAuth, async (req, res) => {
  try {
    const { from, to, deptId } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    let deptFilter = '';
    const params = [`${from} 00:00:00`, `${to} 23:59:59`];
    if (deptId) { deptFilter = 'AND e.dept_id = ?'; params.push(parseInt(deptId, 10)); }

    const [rows] = await pool.query(`
      SELECT
        e.user_id, e.name, e.badge_number, d.dept_name,
        COUNT(DISTINCT DATE(c.check_time)) AS days_present,
        COUNT(c.id) AS total_punches,
        SUM(CASE WHEN TIME(c.check_time) > '08:15:00' AND c.normalized_type = 'in' THEN 1 ELSE 0 END) AS late_count,
        MIN(CASE WHEN c.normalized_type = 'in' THEN TIME(c.check_time) END) AS earliest_in,
        MAX(CASE WHEN c.normalized_type = 'in' THEN TIME(c.check_time) END) AS latest_in,
        MAX(c.check_time) AS last_seen
      FROM employees e
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      LEFT JOIN checkinout c ON c.user_id = e.user_id AND c.check_time BETWEEN ? AND ?
      WHERE 1=1 ${deptFilter}
      GROUP BY e.user_id, e.name, e.badge_number, d.dept_name
      ORDER BY days_present DESC, e.name ASC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// R2. Late arrivals
app.get('/api/reports/late-arrivals', requireAuth, async (req, res) => {
  try {
    const { from, to, threshold = '08:15', deptId } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    let deptFilter = '';
    const params = [`${from} 00:00:00`, `${to} 23:59:59`, threshold];
    if (deptId) { deptFilter = 'AND e.dept_id = ?'; params.push(parseInt(deptId, 10)); }

    const [rows] = await pool.query(`
      SELECT
        e.user_id, e.name, e.badge_number, d.dept_name,
        DATE(c.check_time) AS date,
        MIN(TIME(c.check_time)) AS check_in_time,
        TIMEDIFF(MIN(TIME(c.check_time)), ?) AS minutes_late
      FROM checkinout c
      JOIN employees e ON c.user_id = e.user_id
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      WHERE c.check_time BETWEEN ? AND ?
        AND c.normalized_type = 'in'
        AND TIME(c.check_time) > ?
        AND DAYOFWEEK(c.check_time) BETWEEN 2 AND 6
        ${deptFilter}
      GROUP BY e.user_id, e.name, e.badge_number, d.dept_name, DATE(c.check_time)
      ORDER BY date DESC, minutes_late DESC
    `, [threshold, `${from} 00:00:00`, `${to} 23:59:59`, threshold, ...params.slice(3)]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// R3. Absent employees for a given date
app.get('/api/reports/absent', requireAuth, async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];
    const deptId = req.query.dept_id ? parseInt(req.query.dept_id, 10) : null;
    const startOfDay = `${targetDate} 00:00:00`;
    const endOfDay = `${targetDate} 23:59:59`;

    let deptFilter = '';
    const params = [startOfDay, endOfDay];
    if (deptId) { deptFilter = 'AND e.dept_id = ?'; params.push(deptId); }

    const [rows] = await pool.query(`
      SELECT e.user_id, e.name, e.badge_number, d.dept_name,
             MAX(c2.check_time) AS last_known_punch
      FROM employees e
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      LEFT JOIN checkinout c2 ON c2.user_id = e.user_id
      WHERE NOT EXISTS (
        SELECT 1 FROM checkinout c WHERE c.user_id = e.user_id AND c.check_time >= ? AND c.check_time <= ?
      )
      ${deptFilter}
      GROUP BY e.user_id, e.name, e.badge_number, d.dept_name
      ORDER BY d.dept_name ASC, e.name ASC
    `, params);
    res.json({ date: targetDate, count: rows.length, employees: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// R4. Overtime — employees who punched after threshold
app.get('/api/reports/overtime', requireAuth, async (req, res) => {
  try {
    const { from, to, threshold = '17:00', deptId } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    let deptFilter = '';
    const params = [`${from} 00:00:00`, `${to} 23:59:59`, threshold];
    if (deptId) { deptFilter = 'AND e.dept_id = ?'; params.push(parseInt(deptId, 10)); }

    const [rows] = await pool.query(`
      SELECT
        e.user_id, e.name, e.badge_number, d.dept_name,
        DATE(c.check_time) AS date,
        MAX(TIME(c.check_time)) AS last_punch_time,
        TIMEDIFF(MAX(TIME(c.check_time)), ?) AS overtime_duration
      FROM checkinout c
      JOIN employees e ON c.user_id = e.user_id
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      WHERE c.check_time BETWEEN ? AND ?
        AND TIME(c.check_time) > ?
        AND DAYOFWEEK(c.check_time) BETWEEN 2 AND 6
        ${deptFilter}
      GROUP BY e.user_id, e.name, e.badge_number, d.dept_name, DATE(c.check_time)
      ORDER BY date DESC, overtime_duration DESC
    `, [threshold, `${from} 00:00:00`, `${to} 23:59:59`, threshold, ...params.slice(3)]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// R5. Punch count by device
app.get('/api/reports/by-device', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let dateFilter = '';
    if (from && to) { dateFilter = 'WHERE c.check_time BETWEEN ? AND ?'; params.push(`${from} 00:00:00`, `${to} 23:59:59`); }

    const [rows] = await pool.query(`
      SELECT
        c.sn,
        COALESCE(d.alias, c.sn) AS device_alias,
        d.ip_address,
        d.location,
        d.status AS device_status,
        COUNT(*) AS total_punches,
        COUNT(DISTINCT c.user_id) AS unique_employees,
        MAX(c.check_time) AS last_punch
      FROM checkinout c
      LEFT JOIN devices d ON d.sn = c.sn
      ${dateFilter}
      GROUP BY c.sn, d.alias, d.ip_address, d.location, d.status
      ORDER BY total_punches DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// R6. CSV export of daily attendance
app.get('/api/reports/export/csv', requireAuth, async (req, res) => {
  try {
    const { from, to, deptId } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    let deptFilter = '';
    const params = [`${from} 00:00:00`, `${to} 23:59:59`];
    if (deptId) { deptFilter = 'AND e.dept_id = ?'; params.push(parseInt(deptId, 10)); }

    const [rows] = await pool.query(`
      SELECT
        e.badge_number, e.name, d.dept_name,
        DATE(c.check_time) AS date,
        MIN(c.check_time) AS first_punch,
        MAX(c.check_time) AS last_punch,
        COUNT(*) AS punch_count,
        ROUND(TIMESTAMPDIFF(MINUTE, MIN(c.check_time), MAX(c.check_time))/60.0, 2) AS hours_span
      FROM checkinout c
      JOIN employees e ON c.user_id = e.user_id
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      WHERE c.check_time BETWEEN ? AND ?
      ${deptFilter}
      GROUP BY e.user_id, e.badge_number, e.name, d.dept_name, DATE(c.check_time)
      ORDER BY date DESC, e.name ASC
    `, params);

    // Build CSV
    const headers = ['Badge', 'Employee Name', 'Department', 'Date', 'First Punch', 'Last Punch', 'Punches', 'Hours Span'];
    const csvRows = rows.map(r => [
      r.badge_number, r.name, r.dept_name || '', r.date,
      r.first_punch ? String(r.first_punch).replace('T', ' ').substring(0, 19) : '',
      r.last_punch ? String(r.last_punch).replace('T', ' ').substring(0, 19) : '',
      r.punch_count, r.hours_span
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${from}_to_${to}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SHIFTS & SCHEDULES ────────────────────────────────────────────────────────

// S1. Shift classes
app.get('/api/shifts', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT schClassid AS id, schClassid, schName AS name, schName AS SchName,
             TIME(\`StartTime\`) AS start_time, \`StartTime\`,
             TIME(\`EndTime\`) AS end_time, \`EndTime\`,
             TIME(\`CheckInTime1\`) AS check_in_time1, \`CheckInTime1\`,
             TIME(\`CheckInTime2\`) AS check_in_time2, \`CheckInTime2\`,
             TIME(\`CheckOutTime1\`) AS check_out_time1, \`CheckOutTime1\`,
             TIME(\`CheckOutTime2\`) AS check_out_time2, \`CheckOutTime2\`,
             LateMinutes AS late_grace_minutes, LateMinutes,
             EarlyMinutes AS early_grace_minutes, EarlyMinutes,
             WorkDay AS work_day_fraction, WorkDay,
             WorkMins AS work_minutes, WorkMins
      FROM SchClass ORDER BY schClassid ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S2. Timetable / Schedule rotations
app.get('/api/schedules', requireAuth, async (req, res) => {
  try {
    const [schedules] = await pool.query(`
      SELECT n.NUM_RUNID AS id, n.NAME AS name,
             DATE(n.STARTDATE) AS start_date, DATE(n.ENDDATE) AS end_date,
             n.CYLE AS cycle, n.UNITS AS units,
             COALESCE(u_cnt.cnt, 0) AS active_user_count,
             COALESCE(n.CYLE, 1) * COALESCE(n.UNITS, 1) AS cycle_days,
             CONCAT(COALESCE(n.CYLE, 1), ' ', CASE WHEN n.UNITS = 1 THEN 'Week(s)' WHEN n.UNITS = 2 THEN 'Month(s)' ELSE 'Day(s)' END) AS cycle_units
      FROM NUM_RUN n
      LEFT JOIN (
        SELECT NUM_OF_RUN_ID, COUNT(*) AS cnt
        FROM USER_OF_RUN
        GROUP BY NUM_OF_RUN_ID
      ) u_cnt ON u_cnt.NUM_OF_RUN_ID = n.NUM_RUNID
      ORDER BY n.NUM_RUNID ASC
    `);
    const [details] = await pool.query(`
      SELECT nd.NUM_RUNID AS schedule_id,
             TIME(nd.STARTTIME) AS start_time, TIME(nd.ENDTIME) AS end_time,
             nd.SDAYS AS start_day, nd.EDAYS AS end_day,
             nd.SCHCLASSID AS shift_class_id,
             sc.schName AS shift_name
      FROM NUM_RUN_DEIL nd
      LEFT JOIN SchClass sc ON sc.schClassid = nd.SCHCLASSID
      ORDER BY nd.NUM_RUNID, nd.SDAYS
    `);
    const detailsBySchedule = {};
    for (const d of details) {
      if (!detailsBySchedule[d.schedule_id]) detailsBySchedule[d.schedule_id] = [];
      detailsBySchedule[d.schedule_id].push(d);
    }
    res.json(schedules.map(s => ({ ...s, details: detailsBySchedule[s.id] || [] })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S3. Employee assignments per schedule
app.get('/api/schedules/:id/assignments', requireAuth, async (req, res) => {
  try {
    const scheduleId = parseInt(req.params.id, 10);
    const [rows] = await pool.query(`
      SELECT u.USERID AS user_id, e.name, e.badge_number, d.dept_name,
             DATE(u.STARTDATE) AS start_date, DATE(u.ENDDATE) AS end_date
      FROM USER_OF_RUN u
      JOIN employees e ON e.user_id = u.USERID
      LEFT JOIN departments d ON d.dept_id = e.dept_id
      WHERE u.NUM_OF_RUN_ID = ?
      ORDER BY e.name ASC
    `, [scheduleId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LEAVE TYPES ────────────────────────────────────────────────────────────────

app.get('/api/leave-types', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT LeaveId AS id, LeaveName AS name, ReportSymbol AS symbol, Code AS code FROM LeaveClass ORDER BY LeaveId ASC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LEAVE MANAGEMENT ──────────────────────────────────────────────────────────

// LV1. List leaves
app.get('/api/leaves', requireAuth, async (req, res) => {
  try {
    const { userId, deptId, status, from, to } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (userId) { where += ' AND l.user_id = ?'; params.push(parseInt(userId, 10)); }
    if (deptId) { where += ' AND e.dept_id = ?'; params.push(parseInt(deptId, 10)); }
    if (status) { where += ' AND l.status = ?'; params.push(status); }
    if (from) { where += ' AND l.start_date >= ?'; params.push(from); }
    if (to) { where += ' AND l.end_date <= ?'; params.push(to); }

    const [rows] = await pool.query(`
      SELECT l.id, l.user_id, e.name AS employee_name, e.badge_number, d.dept_name,
             l.leave_type_id, lc.LeaveName AS leave_type_name, lc.ReportSymbol AS leave_symbol,
             l.start_date, l.end_date,
             DATEDIFF(l.end_date, l.start_date) + 1 AS duration_days,
             l.notes, l.status, l.submitted_by_self, l.created_at
      FROM leaves l
      JOIN employees e ON l.user_id = e.user_id
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      LEFT JOIN LeaveClass lc ON l.leave_type_id = lc.LeaveId
      ${where}
      ORDER BY l.start_date DESC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LV2. Create leave
app.post('/api/leaves', requireAuth, async (req, res) => {
  const { user_id, leave_type_id, start_date, end_date, notes, submitted_by_self } = req.body;
  if (!user_id || !leave_type_id || !start_date || !end_date) {
    return res.status(400).json({ error: 'user_id, leave_type_id, start_date, end_date are required' });
  }
  const status = req.user.role === 'admin' ? 'approved' : 'pending';
  try {
    const [result] = await pool.query(
      `INSERT INTO leaves (user_id, leave_type_id, start_date, end_date, notes, status, submitted_by_self)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [parseInt(user_id, 10), parseInt(leave_type_id, 10), start_date, end_date,
       notes || null, status, submitted_by_self ? 1 : 0]
    );
    res.status(201).json({ success: true, id: result.insertId, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LV3. Update leave (admin can change status; anyone can edit notes if pending)
app.put('/api/leaves/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { leave_type_id, start_date, end_date, notes, status } = req.body;
  try {
    const [existing] = await pool.query('SELECT * FROM leaves WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Leave record not found' });
    const cur = existing[0];

    if (req.user.role !== 'admin' && cur.status !== 'pending') {
      return res.status(403).json({ error: 'Cannot edit processed leave request' });
    }

    const newTypeId = leave_type_id !== undefined ? parseInt(leave_type_id, 10) : cur.leave_type_id;
    const newStart = start_date !== undefined ? start_date : cur.start_date;
    const newEnd = end_date !== undefined ? end_date : cur.end_date;
    const newNotes = notes !== undefined ? notes : cur.notes;
    const newStatus = (req.user.role === 'admin' && status !== undefined) ? status : cur.status;

    await pool.query(
      'UPDATE leaves SET leave_type_id=?, start_date=?, end_date=?, notes=?, status=? WHERE id=?',
      [newTypeId, newStart, newEnd, newNotes, newStatus, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LV4. Delete leave
app.delete('/api/leaves/:id', requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM leaves WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Leave record not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HOLIDAY MANAGEMENT ────────────────────────────────────────────────────────

// H1. List holidays
app.get('/api/holidays', requireAuth, async (req, res) => {
  try {
    const { year } = req.query;
    let sql = `
      SELECT HOLIDAYID AS id, HOLIDAYNAME AS name, STARTTIME AS date,
             DURATION AS duration_days, DURATION AS duration,
             HOLIDAYTYPE AS type, DeptID AS dept_id
      FROM HOLIDAYS
    `;
    const params = [];
    if (year && year !== 'all') {
      sql += ' WHERE YEAR(STARTTIME) = ?';
      params.push(parseInt(year, 10));
    }
    sql += ' ORDER BY STARTTIME ASC';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// H2. Create holiday
app.post('/api/holidays', requireAdmin, async (req, res) => {
  const { name, date, duration_days, type, dept_id } = req.body;
  if (!name || !date) return res.status(400).json({ error: 'name and date are required' });
  try {
    const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(HOLIDAYID), 0) + 1 AS nextId FROM HOLIDAYS');
    const newId = maxRow.nextId;
    await pool.query(
      'INSERT INTO HOLIDAYS (HOLIDAYID, HOLIDAYNAME, STARTTIME, DURATION, HOLIDAYTYPE, DeptID) VALUES (?, ?, ?, ?, ?, ?)',
      [newId, String(name).trim(), date, duration_days || 1, type || 0, dept_id || null]
    );
    res.status(201).json({ success: true, id: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// H3. Update holiday
app.put('/api/holidays/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, date, duration_days, type } = req.body;
  if (!name || !date) return res.status(400).json({ error: 'name and date are required' });
  try {
    const [result] = await pool.query(
      'UPDATE HOLIDAYS SET HOLIDAYNAME=?, STARTTIME=?, DURATION=?, HOLIDAYTYPE=? WHERE HOLIDAYID=?',
      [String(name).trim(), date, duration_days || 1, type || 0, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Holiday not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// H4. Delete holiday
app.delete('/api/holidays/:id', requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM HOLIDAYS WHERE HOLIDAYID = ?', [parseInt(req.params.id, 10)]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Holiday not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUNCH CORRECTIONS (CHECKEXACT) ───────────────────────────────────────────

// PC1. List corrections
app.get('/api/punch-corrections', requireAuth, async (req, res) => {
  try {
    const { userId, from, to } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (userId) { where += ' AND cx.USERID = ?'; params.push(parseInt(userId, 10)); }
    if (from) { where += ' AND cx.CHECKTIME >= ?'; params.push(`${from} 00:00:00`); }
    if (to) { where += ' AND cx.CHECKTIME <= ?'; params.push(`${to} 23:59:59`); }

    const [rows] = await pool.query(`
      SELECT cx.EXACTID AS id, cx.USERID AS user_id, e.name AS employee_name, e.badge_number,
             cx.CHECKTIME AS check_time, cx.CHECKTYPE AS check_type,
             cx.ISADD AS is_added, cx.ISMODIFY AS is_modified, cx.ISDELETE AS is_deleted,
             COALESCE(cx.MODIFYBY, 'System Admin') AS operator,
             cx.MODIFYBY AS modified_by, cx.YUYIN AS reason
      FROM CHECKEXACT cx
      JOIN employees e ON e.user_id = cx.USERID
      ${where}
      ORDER BY cx.CHECKTIME DESC
      LIMIT 500
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PC2. Add a punch correction
app.post('/api/punch-corrections', requireAdmin, async (req, res) => {
  const { user_id, check_time, check_type, reason } = req.body;
  if (!user_id || !check_time || !check_type) {
    return res.status(400).json({ error: 'user_id, check_time, and check_type are required' });
  }
  const normalizedType = ['O', 'o', '0', 'out'].includes(String(check_type)) ? 'out' : 'in';
  const rawCheckType = normalizedType === 'out' ? 'O' : 'I';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[maxRow]] = await conn.query('SELECT COALESCE(MAX(EXACTID), 0) + 1 AS nextId FROM CHECKEXACT');
    const newId = maxRow.nextId;
    await conn.query(
      `INSERT INTO CHECKEXACT (EXACTID, USERID, CHECKTIME, CHECKTYPE, ISADD, YUYIN, ISMODIFY, ISDELETE, INCOUNT, ISCOUNT, MODIFYBY, DATE)
       VALUES (?, ?, ?, ?, 1, ?, 0, 0, 1, 1, 'TimePulse', NOW())`,
      [newId, parseInt(user_id, 10), check_time, rawCheckType, reason || 'Manual correction via TimePulse']
    );
    await conn.query(
      `INSERT IGNORE INTO checkinout (user_id, check_time, check_type, normalized_type, sensor_id, work_code, sn)
       VALUES (?, ?, ?, ?, 'MANUAL', 0, NULL)`,
      [parseInt(user_id, 10), check_time, rawCheckType, normalizedType]
    );
    await conn.commit();
    res.status(201).json({ success: true, id: newId, correction_id: newId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// PC3. Void a correction
app.delete('/api/punch-corrections/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const [cx] = await pool.query('SELECT * FROM CHECKEXACT WHERE EXACTID = ?', [id]);
    if (cx.length === 0) return res.status(404).json({ error: 'Correction not found' });
    await pool.query('UPDATE CHECKEXACT SET ISDELETE = 1 WHERE EXACTID = ?', [id]);
    await pool.query(
      `DELETE FROM checkinout WHERE user_id = ? AND check_time = ? AND sensor_id = 'MANUAL' LIMIT 1`,
      [cx[0].USERID, cx[0].CHECKTIME]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1. Health & Sync Status
app.get('/api/status', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM sync_log ORDER BY id DESC LIMIT 1'
    );
    const [counts] = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM employees) AS employeeCount,
        (SELECT COUNT(*) FROM departments) AS departmentCount,
        (SELECT COUNT(*) FROM checkinout) AS punchCount
    `);
    res.json({
      status: 'online',
      syncInProgress: isSyncInProgress,
      lastSync: rows[0] || null,
      stats: counts[0] || { employeeCount: 0, departmentCount: 0, punchCount: 0 }
    });
  } catch (err) {
    res.json({
      status: 'db_offline',
      syncInProgress: false,
      message: 'Database connection failed. Please run ./setup_database.sh to initialize MySQL.',
      error: err.message,
      stats: { employeeCount: 0, departmentCount: 0, punchCount: 0 }
    });
  }
});

// 2. Trigger On-Demand Sync
app.post('/api/sync', async (req, res) => {
  if (isSyncInProgress) {
    return res.status(409).json({ error: 'A sync is already in progress' });
  }
  isSyncInProgress = true;
  try {
    const result = await runSync();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    isSyncInProgress = false;
  }
});

// 3. Departments
app.get('/api/departments', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT d.dept_id, d.dept_name, COUNT(e.user_id) AS employee_count
      FROM departments d
      LEFT JOIN employees e ON d.dept_id = e.dept_id
      GROUP BY d.dept_id, d.dept_name
      ORDER BY d.dept_name ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Employees with latest punch status
app.get('/api/employees', async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const deptId = req.query.dept_id ? parseInt(req.query.dept_id, 10) : null;

    let query = `
      SELECT 
        e.user_id,
        e.badge_number,
        e.name,
        e.gender,
        e.dept_id,
        d.dept_name,
        latest.check_time AS last_punch_time,
        latest.normalized_type AS last_punch_type
      FROM employees e
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      LEFT JOIN (
        SELECT c1.user_id, c1.check_time, c1.normalized_type
        FROM checkinout c1
        INNER JOIN (
          SELECT user_id, MAX(check_time) AS max_time
          FROM checkinout
          GROUP BY user_id
        ) c2 ON c1.user_id = c2.user_id AND c1.check_time = c2.max_time
      ) latest ON e.user_id = latest.user_id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (e.name LIKE ? OR e.badge_number LIKE ?)`;
      params.push(search, search);
    }

    if (deptId) {
      query += ` AND e.dept_id = ?`;
      params.push(deptId);
    }

    query += ` ORDER BY e.name ASC`;

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Single Employee Details + Attendance
app.get('/api/employees/:id', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const [empRows] = await pool.query(`
      SELECT e.*, d.dept_name 
      FROM employees e 
      LEFT JOIN departments d ON e.dept_id = d.dept_id 
      WHERE e.user_id = ?
    `, [userId]);

    if (empRows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Recent punches
    const [punches] = await pool.query(`
      SELECT * FROM checkinout 
      WHERE user_id = ? 
      ORDER BY check_time DESC 
      LIMIT 100
    `, [userId]);

    const dailyAttendance = computeDailyAttendance(punches);

    res.json({
      employee: empRows[0],
      punches,
      dailyAttendance,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Filterable Punch Log (Pagination & Range)
app.get('/api/punches', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const { userId, deptId, from, to, type } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (userId) {
      whereClause += ' AND c.user_id = ?';
      params.push(parseInt(userId, 10));
    }
    if (deptId) {
      whereClause += ' AND e.dept_id = ?';
      params.push(parseInt(deptId, 10));
    }
    if (from) {
      whereClause += ' AND c.check_time >= ?';
      params.push(`${from} 00:00:00`);
    }
    if (to) {
      whereClause += ' AND c.check_time <= ?';
      params.push(`${to} 23:59:59`);
    }
    if (type && (type === 'in' || type === 'out')) {
      whereClause += ' AND c.normalized_type = ?';
      params.push(type);
    }

    const countSql = `
      SELECT COUNT(*) AS total
      FROM checkinout c
      JOIN employees e ON c.user_id = e.user_id
      ${whereClause}
    `;
    const [totalRows] = await pool.query(countSql, params);
    const total = totalRows[0].total;

    const dataSql = `
      SELECT 
        c.id,
        c.user_id,
        c.check_time,
        c.check_type,
        c.normalized_type,
        c.sensor_id,
        e.name,
        e.name AS employee_name,
        e.badge_number,
        d.dept_name
      FROM checkinout c
      JOIN employees e ON c.user_id = e.user_id
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      ${whereClause}
      ORDER BY c.check_time DESC
      LIMIT ? OFFSET ?
    `;
    const [rows] = await pool.query(dataSql, [...params, limit, offset]);

    const totalPages = Math.ceil(total / limit);
    res.json({
      page,
      limit,
      total,
      totalPages,
      data: rows,
      punches: rows,
      pagination: {
        page,
        limit,
        total,
        pages: totalPages
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Dashboard Overview
app.get('/api/dashboard', async (req, res) => {
  try {
    const targetDate = req.query.date || '2026-09-14';
    const startOfDay = `${targetDate} 00:00:00`;
    const endOfDay = `${targetDate} 23:59:59`;

    const [[totals]] = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM employees) AS totalEmployees,
        (SELECT COUNT(DISTINCT user_id) FROM checkinout WHERE check_time >= ? AND check_time <= ?) AS activeToday,
        (SELECT COUNT(*) FROM checkinout WHERE check_time >= ? AND check_time <= ?) AS punchesToday,
        (SELECT COUNT(*) FROM checkinout) AS totalPunches
    `, [startOfDay, endOfDay, startOfDay, endOfDay]);

    // Latest 10 punches
    const [recentPunches] = await pool.query(`
      SELECT 
        c.id, c.user_id, c.check_time, c.normalized_type,
        e.name, e.badge_number, d.dept_name
      FROM checkinout c
      JOIN employees e ON c.user_id = e.user_id
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      ORDER BY c.check_time DESC
      LIMIT 10
    `);

    // Department breakdown for target date
    const [deptBreakdown] = await pool.query(`
      SELECT 
        d.dept_name,
        COUNT(DISTINCT c.user_id) AS employee_count
      FROM departments d
      JOIN employees e ON d.dept_id = e.dept_id
      JOIN checkinout c ON e.user_id = c.user_id AND c.check_time >= ? AND c.check_time <= ?
      GROUP BY d.dept_id, d.dept_name
      ORDER BY employee_count DESC
    `, [startOfDay, endOfDay]);

    const stats = {
      totalEmployees: Number(totals.totalEmployees || 0),
      activeToday: Number(totals.activeToday || 0),
      punchesToday: Number(totals.punchesToday || 0),
      totalPunches: Number(totals.totalPunches || 0)
    };

    res.json({
      date: targetDate,
      stats,
      summary: stats,
      recentPunches,
      deptBreakdown: deptBreakdown || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Daily Attendance Reports (Paired First In / Last Out)
app.get('/api/reports/daily', async (req, res) => {
  try {
    const { from, to, deptId } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to date parameters are required (YYYY-MM-DD)' });
    }

    let query = `
      SELECT 
        c.user_id,
        e.name,
        e.badge_number,
        d.dept_name,
        c.check_time,
        c.normalized_type
      FROM checkinout c
      JOIN employees e ON c.user_id = e.user_id
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      WHERE c.check_time >= ? AND c.check_time <= ?
    `;
    const params = [`${from} 00:00:00`, `${to} 23:59:59`];

    if (deptId) {
      query += ` AND e.dept_id = ?`;
      params.push(parseInt(deptId, 10));
    }

    query += ` ORDER BY c.user_id ASC, c.check_time ASC`;

    const [rows] = await pool.query(query, params);

    // Group by user
    const byUser = new Map();
    for (const row of rows) {
      if (!byUser.has(row.user_id)) {
        byUser.set(row.user_id, {
          user_id: row.user_id,
          name: row.name,
          badge_number: row.badge_number,
          dept_name: row.dept_name,
          punches: [],
        });
      }
      byUser.get(row.user_id).punches.push(row);
    }

    const report = [];
    for (const emp of byUser.values()) {
      const daily = computeDailyAttendance(emp.punches);
      for (const day of daily) {
        report.push({
          user_id: emp.user_id,
          name: emp.name,
          badge_number: emp.badge_number,
          dept_name: emp.dept_name,
          date: day.date,
          first_in: day.first_in,
          last_out: day.last_out,
          punch_count: day.punch_count,
          total_hours: day.total_hours,
        });
      }
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DEVICE ADMINISTRATION CRUD ──────────────────────────────────────────────

// 9. List all devices (with punch count from checkinout.sn cross-reference)
app.get('/api/devices', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        d.*,
        COALESCE(pc.punch_count, 0) AS punch_count
      FROM devices d
      LEFT JOIN (
        SELECT sn, COUNT(*) AS punch_count
        FROM checkinout
        WHERE sn IS NOT NULL AND sn != ''
        GROUP BY sn
      ) pc ON d.sn = pc.sn
      ORDER BY d.alias ASC, d.sn ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9b. Discover & import devices from existing punch data (INSERT IGNORE = skip duplicates)
app.post('/api/devices/import-from-punches', async (req, res) => {
  try {
    const [result] = await pool.query(`
      INSERT IGNORE INTO devices (sn, alias, model, status)
      SELECT
        sn,
        CONCAT('Device ', sn) AS alias,
        'ZKTeco' AS model,
        'active' AS status
      FROM (
        SELECT sn
        FROM checkinout
        WHERE sn IS NOT NULL AND sn != ''
        GROUP BY sn
      ) AS discovered
    `);
    res.json({
      success: true,
      imported: result.affectedRows,
      message: result.affectedRows > 0
        ? `${result.affectedRows} new device(s) imported from punch history`
        : 'All devices from punch data are already registered',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Create a device
app.post('/api/devices', async (req, res) => {
  const { sn, alias, ip_address, location, model, status } = req.body;
  if (!sn || !String(sn).trim()) {
    return res.status(400).json({ error: 'Serial number (SN) is required' });
  }
  const validStatuses = ['active', 'inactive'];
  const deviceStatus = validStatuses.includes(status) ? status : 'active';
  try {
    const [result] = await pool.query(
      `INSERT INTO devices (sn, alias, ip_address, location, model, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(sn).trim(),
        alias ? String(alias).trim() : null,
        ip_address ? String(ip_address).trim() : null,
        location ? String(location).trim() : null,
        model ? String(model).trim() : null,
        deviceStatus,
      ]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `A device with SN "${sn}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

// 11. Get single device
app.get('/api/devices/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Update a device
app.put('/api/devices/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { sn, alias, ip_address, location, model, status } = req.body;
  if (!sn || !String(sn).trim()) {
    return res.status(400).json({ error: 'Serial number (SN) is required' });
  }
  const validStatuses = ['active', 'inactive'];
  const deviceStatus = validStatuses.includes(status) ? status : 'active';
  try {
    const [result] = await pool.query(
      `UPDATE devices SET sn=?, alias=?, ip_address=?, location=?, model=?, status=? WHERE id=?`,
      [
        String(sn).trim(),
        alias ? String(alias).trim() : null,
        ip_address ? String(ip_address).trim() : null,
        location ? String(location).trim() : null,
        model ? String(model).trim() : null,
        deviceStatus,
        id,
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `A device with SN "${sn}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

// 13. Delete a device
app.delete('/api/devices/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM devices WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── USER ADMINISTRATION CRUD ─────────────────────────────────────────────────

// 14. Admin user list (employees with total punch count)
app.get('/api/admin/users', async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : null;
    const deptId = req.query.dept_id ? parseInt(req.query.dept_id, 10) : null;

    let query = `
      SELECT
        e.user_id,
        e.badge_number,
        e.name,
        e.gender,
        e.dept_id,
        d.dept_name,
        e.created_at,
        e.updated_at,
        COALESCE(pc.punch_count, 0) AS punch_count
      FROM employees e
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS punch_count FROM checkinout GROUP BY user_id
      ) pc ON e.user_id = pc.user_id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (e.name LIKE ? OR e.badge_number LIKE ?)`;
      params.push(search, search);
    }
    if (deptId) {
      query += ` AND e.dept_id = ?`;
      params.push(deptId);
    }

    query += ` ORDER BY e.name ASC`;

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 15. Create a user/employee
app.post('/api/employees', async (req, res) => {
  const { user_id, badge_number, name, gender, dept_id } = req.body;
  if (!user_id || !name || !String(name).trim()) {
    return res.status(400).json({ error: 'User ID and full name are required' });
  }
  const uid = parseInt(user_id, 10);
  if (isNaN(uid) || uid <= 0) {
    return res.status(400).json({ error: 'User ID must be a positive integer' });
  }
  try {
    await pool.query(
      `INSERT INTO employees (user_id, badge_number, name, gender, dept_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        uid,
        badge_number ? String(badge_number).trim() : null,
        String(name).trim(),
        gender ? String(gender).trim() : null,
        dept_id ? parseInt(dept_id, 10) : null,
      ]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `A user with ID ${user_id} already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

// 16. Update a user/employee
app.put('/api/employees/:id', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { badge_number, name, gender, dept_id } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  try {
    const [result] = await pool.query(
      `UPDATE employees SET badge_number=?, name=?, gender=?, dept_id=? WHERE user_id=?`,
      [
        badge_number ? String(badge_number).trim() : null,
        String(name).trim(),
        gender ? String(gender).trim() : null,
        dept_id ? parseInt(dept_id, 10) : null,
        userId,
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 17. Delete a user/employee (cascades to checkinout via FK)
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM employees WHERE user_id = ?', [parseInt(req.params.id, 10)]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Setup scheduled cron if enabled
const cronPattern = process.env.SYNC_CRON;
if (cronPattern && cronPattern.trim().toLowerCase() !== 'disabled') {
  console.log(`[Server] Scheduling automated sync with cron: "${cronPattern}"`);
  cron.schedule(cronPattern, async () => {
    console.log('[Cron] Executing scheduled Access -> MySQL sync...');
    if (isSyncInProgress) {
      console.log('[Cron] Sync already running. Skipping.');
      return;
    }
    isSyncInProgress = true;
    try {
      await runSync();
    } catch (e) {
      console.error('[Cron] Scheduled sync failed:', e.message);
    } finally {
      isSyncInProgress = false;
    }
  });
}

// Fallback to SPA index.html
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// Start Server
if (require.main === module) {
  app.listen(port, () => {
    console.log(`[Server] Personnel Time & Attendance Server running at http://localhost:${port}`);
  });
}

module.exports = app;
