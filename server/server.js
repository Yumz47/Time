const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const net = require('net');
const { computeDailyAttendance, resolveNormalizedType, getLocalDateString } = require('../bridge/helpers');
const {
  syncSingleDevice,
  syncAllActiveDevices,
  propagateUsersFromMaster,
  getDeviceTime,
  setDeviceTime,
  syncDeviceTimeIfDrifted,
} = require('../bridge/device_sync');
const {
  hashPassword,
  verifyPassword,
  isSafeDeviceIp,
  sanitizeCsvCell,
  sanitizeFilenameDate,
  createRateLimiter,
  securityHeadersMiddleware,
  sanitizeErrorMessage,
} = require('./security');

const app = express();
const port = process.env.PORT || 3000;

// Security HTTP headers & middleware
app.use(securityHeadersMiddleware);
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
  dateStrings: true,
});
app.pool = pool;

let isSyncInProgress = false;

// ─── AUTH UTILITIES & RATE LIMITING ──────────────────────────────────────────

const loginLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, maxAttempts: 10 });

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
  let token = req.headers['x-auth-token'];
  if (!token && req.headers['authorization']) {
    const parts = req.headers['authorization'].split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }
  if (!token && req.query && req.query._token) {
    token = req.query._token;
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
    res.status(500).json({ error: sanitizeErrorMessage(err) });
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

// A1. Login (with rate limiting and scrypt/SHA-256 dual verification + auto-upgrade)
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const cleanUsername = String(username).trim().toLowerCase();
    const [rows] = await pool.query(
      'SELECT * FROM app_users WHERE username = ? AND is_active = 1',
      [cleanUsername]
    );
    if (rows.length === 0) {
      if (req.registerAuthFailure) req.registerAuthFailure();
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    const { valid, needsUpgrade } = verifyPassword(String(password), user.password_hash);
    if (!valid) {
      if (req.registerAuthFailure) req.registerAuthFailure();
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (req.registerAuthSuccess) req.registerAuthSuccess();

    // Transparently upgrade legacy SHA-256 hash to scrypt
    if (needsUpgrade) {
      const newHash = hashPassword(String(password));
      await pool.query('UPDATE app_users SET password_hash = ? WHERE id = ?', [newHash, user.id]);
    }

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
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// A2. Logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers['x-auth-token'] || req.query._token;
  try {
    await pool.query('DELETE FROM sessions WHERE token = ?', [token]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
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
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// AU3. Update app user (revokes active sessions if password is changed or account deactivated)
app.put('/api/admin/app-users/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { full_name, role, is_active, password } = req.body;
  const validRoles = ['admin', 'viewer'];
  try {
    const shouldRevokeSessions = (password && String(password).trim()) || is_active === false || is_active === 0;
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
    if (shouldRevokeSessions) {
      await pool.query('DELETE FROM sessions WHERE user_id = ?', [id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// AU4. Delete app user (revokes active sessions)
app.delete('/api/admin/app-users/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user.user_id === id) return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await pool.query('DELETE FROM sessions WHERE user_id = ?', [id]);
    const [result] = await pool.query('DELETE FROM app_users WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// ─── LIVE ATTENDANCE BOARD ─────────────────────────────────────────────────────

// L1. Live attendance: IN / OUT / ABSENT per employee
app.get('/api/attendance/live', requireAuth, async (req, res) => {
  try {
    const targetDate = req.query.date || getLocalDateString();
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

    const data = rows.map(r => {
      const deptName = (!r.dept_name || r.dept_name === 'This Company') ? 'General Registry' : r.dept_name;

      let status = 'absent';
      if (r.last_punch_time) {
        if (r.last_punch_type === 'out') {
          // ── Physically swiped OUT at terminal ──────────────────────────────
          // Leaving before 3:00 PM is an HR flag: early departure.
          const lastOut = new Date(r.last_punch_time);
          const outHour = lastOut.getHours() + lastOut.getMinutes() / 60;
          status = (outHour < 15) ? 'early_out' : 'out';
        } else {
          // ── Last recorded punch was IN — employee has not swiped out yet ───
          // We NEVER silently convert in→out just because 5 PM passed.
          // Instead we use HR-meaningful status labels.
          const now = new Date();
          const todayStr = getLocalDateString(now);
          const targetIsPast = (targetDate < todayStr);
          const currentHour = now.getHours() + now.getMinutes() / 60;

          if (targetIsPast || currentHour >= 22.0) {
            // Past day OR after 10 PM: still showing IN with no swipe-out.
            // HR flag: unconfirmed departure — may indicate a missed punch.
            status = 'unconfirmed_out';
          } else if (currentHour >= 17.0) {
            // After 5 PM standard shift end but before 10 PM: employee may
            // genuinely be working overtime. Mark as overtime — bonus eligible.
            status = 'overtime';
          } else {
            // Within normal working hours and last punch was IN → present.
            status = 'in';
          }
        }
      }

      return {
        ...r,
        dept_name: deptName,
        status,
      };
    });

    const summary = {
      total: data.length,
      // HR-meaningful breakdown — each status is distinct and auditable
      present: data.filter(r => r.status !== 'absent').length,
      absent:          data.filter(r => r.status === 'absent').length,
      currently_in:    data.filter(r => r.status === 'in').length,
      currently_out:   data.filter(r => r.status === 'out').length,
      overtime:        data.filter(r => r.status === 'overtime').length,
      early_out:       data.filter(r => r.status === 'early_out').length,
      unconfirmed_out: data.filter(r => r.status === 'unconfirmed_out').length,
    };

    const now = new Date();
    res.json({
      date: targetDate,
      server_time: now.toISOString(),
      timestamp: now.toISOString(),
      summary,
      employees: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SMART REPORTS ─────────────────────────────────────────────────────────────

// R1. Attendance summary (per employee, date range)
app.get('/api/reports/attendance-summary', requireAuth, async (req, res) => {
  try {
    const { from, to, deptId, search } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    let filterSql = '';
    const params = [`${from} 00:00:00`, `${to} 23:59:59`];
    if (deptId) { filterSql += ' AND e.dept_id = ?'; params.push(parseInt(deptId, 10)); }
    if (search && search.trim()) {
      filterSql += ' AND (e.name LIKE ? OR e.badge_number LIKE ?)';
      params.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }

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
      WHERE 1=1 ${filterSql}
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
    const { from, to, threshold = '08:15', deptId, search } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    let filterSql = '';
    const extraParams = [];
    if (deptId) { filterSql += ' AND e.dept_id = ?'; extraParams.push(parseInt(deptId, 10)); }
    if (search && search.trim()) {
      filterSql += ' AND (e.name LIKE ? OR e.badge_number LIKE ?)';
      extraParams.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }

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
        ${filterSql}
      GROUP BY e.user_id, e.name, e.badge_number, d.dept_name, DATE(c.check_time)
      ORDER BY date DESC, minutes_late DESC
    `, [threshold, `${from} 00:00:00`, `${to} 23:59:59`, threshold, ...extraParams]);
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
    const search = req.query.search;
    const startOfDay = `${targetDate} 00:00:00`;
    const endOfDay = `${targetDate} 23:59:59`;

    let filterSql = '';
    const params = [startOfDay, endOfDay];
    if (deptId) { filterSql += ' AND e.dept_id = ?'; params.push(deptId); }
    if (search && search.trim()) {
      filterSql += ' AND (e.name LIKE ? OR e.badge_number LIKE ?)';
      params.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }

    const [rows] = await pool.query(`
      SELECT e.user_id, e.name, e.badge_number, d.dept_name,
             MAX(c2.check_time) AS last_known_punch
      FROM employees e
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      LEFT JOIN checkinout c2 ON c2.user_id = e.user_id
      WHERE NOT EXISTS (
        SELECT 1 FROM checkinout c WHERE c.user_id = e.user_id AND c.check_time >= ? AND c.check_time <= ?
      )
      ${filterSql}
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
    const { from, to, threshold = '17:00', deptId, search } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

    let filterSql = '';
    const extraParams = [];
    if (deptId) { filterSql += ' AND e.dept_id = ?'; extraParams.push(parseInt(deptId, 10)); }
    if (search && search.trim()) {
      filterSql += ' AND (e.name LIKE ? OR e.badge_number LIKE ?)';
      extraParams.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }

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
        ${filterSql}
      GROUP BY e.user_id, e.name, e.badge_number, d.dept_name, DATE(c.check_time)
      ORDER BY date DESC, overtime_duration DESC
    `, [threshold, `${from} 00:00:00`, `${to} 23:59:59`, threshold, ...extraParams]);
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

    // Build CSV with formula injection defense
    const headers = ['Badge', 'Employee Name', 'Department', 'Date', 'First Punch', 'Last Punch', 'Punches', 'Hours Span'];
    const csvRows = rows.map(r => [
      r.badge_number, r.name, r.dept_name || '', r.date,
      r.first_punch ? String(r.first_punch).replace('T', ' ').substring(0, 19) : '',
      r.last_punch ? String(r.last_punch).replace('T', ' ').substring(0, 19) : '',
      r.punch_count, r.hours_span
    ].map(v => sanitizeCsvCell(v)).join(','));

    const csv = [headers.map(h => `"${h}"`).join(','), ...csvRows].join('\n');
    const safeFrom = sanitizeFilenameDate(from);
    const safeTo = sanitizeFilenameDate(to);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${safeFrom}_to_${safeTo}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// ─── SHIFTS & SCHEDULES ────────────────────────────────────────────────────────

// S1. Shift classes
app.get('/api/shifts', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT schClassid AS id, schClassid, schName, schName AS name, schName AS SchName,
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

function timeToDateTime(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim();
  const match = str.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hours = match[1].padStart(2, '0');
  const minutes = match[2].padStart(2, '0');
  const seconds = (match[3] || '00').padStart(2, '0');
  return `1899-12-30 ${hours}:${minutes}:${seconds}`;
}

function calcWorkMinutes(startTimeStr, endTimeStr) {
  if (!startTimeStr || !endTimeStr) return 0;
  const matchS = String(startTimeStr).match(/(\d{1,2}):(\d{2})/);
  const matchE = String(endTimeStr).match(/(\d{1,2}):(\d{2})/);
  if (!matchS || !matchE) return 0;
  let sMins = parseInt(matchS[1], 10) * 60 + parseInt(matchS[2], 10);
  let eMins = parseInt(matchE[1], 10) * 60 + parseInt(matchE[2], 10);
  if (eMins < sMins) eMins += 24 * 60;
  return eMins - sMins;
}

// S1-B. Create shift class
app.post('/api/shifts', requireAdmin, async (req, res) => {
  const name = req.body.name || req.body.schName;
  const start_time = req.body.start_time || req.body.StartTime;
  const end_time = req.body.end_time || req.body.EndTime;
  const check_in_time1 = req.body.check_in_time1 || req.body.CheckInTime1;
  const check_in_time2 = req.body.check_in_time2 || req.body.CheckInTime2;
  const check_out_time1 = req.body.check_out_time1 || req.body.CheckOutTime1;
  const check_out_time2 = req.body.check_out_time2 || req.body.CheckOutTime2;
  const late_grace_minutes = req.body.late_grace_minutes ?? req.body.LateMinutes ?? 15;
  const early_grace_minutes = req.body.early_grace_minutes ?? req.body.EarlyMinutes ?? 5;
  const work_day_fraction = req.body.work_day_fraction ?? req.body.WorkDay ?? 1.0;
  const work_minutes = req.body.work_minutes ?? req.body.WorkMins;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Shift name is required' });
  }
  if (!start_time || !end_time) {
    return res.status(400).json({ error: 'start_time and end_time are required' });
  }

  try {
    const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(schClassid), 0) + 1 AS nextId FROM SchClass');
    const newId = maxRow.nextId;

    const sTime = timeToDateTime(start_time);
    const eTime = timeToDateTime(end_time);
    const in1 = check_in_time1 ? timeToDateTime(check_in_time1) : sTime;
    const in2 = check_in_time2 ? timeToDateTime(check_in_time2) : sTime;
    const out1 = check_out_time1 ? timeToDateTime(check_out_time1) : eTime;
    const out2 = check_out_time2 ? timeToDateTime(check_out_time2) : eTime;
    const wMins = (work_minutes != null && !isNaN(work_minutes)) ? Number(work_minutes) : calcWorkMinutes(start_time, end_time);

    await pool.query(
      `INSERT INTO SchClass (
        schClassid, schName, StartTime, EndTime, LateMinutes, EarlyMinutes,
        CheckIn, CheckOut, Color, AutoBind, CheckInTime1, CheckInTime2,
        CheckOutTime1, CheckOutTime2, WorkDay, SensorID, WorkMins
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 16715535, 1, ?, ?, ?, ?, ?, null, ?)`,
      [
        newId,
        String(name).trim(),
        sTime,
        eTime,
        late_grace_minutes != null ? parseInt(late_grace_minutes, 10) : 15,
        early_grace_minutes != null ? parseInt(early_grace_minutes, 10) : 5,
        in1,
        in2,
        out1,
        out2,
        work_day_fraction != null ? parseFloat(work_day_fraction) : 1.0,
        wMins
      ]
    );

    res.status(201).json({ success: true, id: newId, shift_id: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S1-C. Update shift class
app.put('/api/shifts/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = req.body.name || req.body.schName;
  const start_time = req.body.start_time || req.body.StartTime;
  const end_time = req.body.end_time || req.body.EndTime;
  const check_in_time1 = req.body.check_in_time1 || req.body.CheckInTime1;
  const check_in_time2 = req.body.check_in_time2 || req.body.CheckInTime2;
  const check_out_time1 = req.body.check_out_time1 || req.body.CheckOutTime1;
  const check_out_time2 = req.body.check_out_time2 || req.body.CheckOutTime2;
  const late_grace_minutes = req.body.late_grace_minutes ?? req.body.LateMinutes;
  const early_grace_minutes = req.body.early_grace_minutes ?? req.body.EarlyMinutes;
  const work_day_fraction = req.body.work_day_fraction ?? req.body.WorkDay;
  const work_minutes = req.body.work_minutes ?? req.body.WorkMins;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Shift name is required' });
  }

  try {
    const [existing] = await pool.query('SELECT * FROM SchClass WHERE schClassid = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Shift class not found' });

    const cur = existing[0];
    const sTime = start_time ? timeToDateTime(start_time) : cur.StartTime;
    const eTime = end_time ? timeToDateTime(end_time) : cur.EndTime;
    const in1 = check_in_time1 ? timeToDateTime(check_in_time1) : cur.CheckInTime1;
    const in2 = check_in_time2 ? timeToDateTime(check_in_time2) : cur.CheckInTime2;
    const out1 = check_out_time1 ? timeToDateTime(check_out_time1) : cur.CheckOutTime1;
    const out2 = check_out_time2 ? timeToDateTime(check_out_time2) : cur.CheckOutTime2;
    const late = late_grace_minutes !== undefined ? parseInt(late_grace_minutes, 10) : cur.LateMinutes;
    const early = early_grace_minutes !== undefined ? parseInt(early_grace_minutes, 10) : cur.EarlyMinutes;
    const wDay = work_day_fraction !== undefined ? parseFloat(work_day_fraction) : cur.WorkDay;
    const wMins = work_minutes !== undefined ? Number(work_minutes) : (start_time && end_time ? calcWorkMinutes(start_time, end_time) : cur.WorkMins);

    await pool.query(
      `UPDATE SchClass SET
        schName = ?, StartTime = ?, EndTime = ?, CheckInTime1 = ?, CheckInTime2 = ?,
        CheckOutTime1 = ?, CheckOutTime2 = ?, LateMinutes = ?, EarlyMinutes = ?,
        WorkDay = ?, WorkMins = ?
      WHERE schClassid = ?`,
      [String(name).trim(), sTime, eTime, in1, in2, out1, out2, late, early, wDay, wMins, id]
    );

    if (start_time || end_time) {
      await pool.query(
        'UPDATE NUM_RUN_DEIL SET STARTTIME = ?, ENDTIME = ? WHERE SCHCLASSID = ?',
        [sTime, eTime, id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S1-D. Delete shift class
app.delete('/api/shifts/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const [[usage]] = await pool.query(
      'SELECT COUNT(*) AS count FROM NUM_RUN_DEIL WHERE SCHCLASSID = ?',
      [id]
    );
    if (usage && usage.count > 0) {
      return res.status(400).json({
        error: `Cannot delete shift class because it is referenced in active schedules (${usage.count} schedule day rule(s)). Remove it from schedules first.`
      });
    }

    const [result] = await pool.query('DELETE FROM SchClass WHERE schClassid = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Shift class not found' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S2. Timetable / Schedule rotations
app.get('/api/schedules', requireAuth, async (req, res) => {
  try {
    const [schedules] = await pool.query(`
      SELECT n.NUM_RUNID AS id, n.NUM_RUNID, n.NAME AS name, n.NAME,
             DATE(n.STARTDATE) AS start_date, DATE(n.ENDDATE) AS end_date,
             n.CYLE AS cycle, n.UNITS AS units,
             COALESCE(u_cnt.cnt, 0) AS active_user_count,
             COALESCE(u_cnt.cnt, 0) AS assigned_users_count,
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

// S2-B. Create schedule rotation
app.post('/api/schedules', requireAdmin, async (req, res) => {
  const name = req.body.name || req.body.NAME;
  const start_date = req.body.start_date || req.body.startDate;
  const end_date = req.body.end_date || req.body.endDate;
  const cycle = req.body.cycle;
  const units = req.body.units;
  const rawDetails = req.body.details || req.body.days || [];
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Schedule name is required' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[maxRow]] = await conn.query('SELECT COALESCE(MAX(NUM_RUNID), 0) + 1 AS nextId FROM NUM_RUN');
    const newId = maxRow.nextId;

    const sDate = start_date ? `${start_date} 00:00:00` : '2020-01-01 00:00:00';
    const eDate = end_date ? `${end_date} 23:59:59` : '2200-12-31 23:59:59';

    await conn.query(
      'INSERT INTO NUM_RUN (NUM_RUNID, OLDID, NAME, STARTDATE, ENDDATE, CYLE, UNITS) VALUES (?, -1, ?, ?, ?, ?, ?)',
      [newId, String(name).trim(), sDate, eDate, parseInt(cycle, 10) || 1, parseInt(units, 10) || 1]
    );

    if (Array.isArray(rawDetails) && rawDetails.length > 0) {
      for (const d of rawDetails) {
        const shiftId = d.shift_class_id || d.shift_id;
        if (!shiftId) continue;
        const [sch] = await conn.query('SELECT StartTime, EndTime FROM SchClass WHERE schClassid = ?', [shiftId]);
        const sTime = d.start_time ? timeToDateTime(d.start_time) : (sch[0] ? sch[0].StartTime : timeToDateTime('08:00'));
        const eTime = d.end_time ? timeToDateTime(d.end_time) : (sch[0] ? sch[0].EndTime : timeToDateTime('17:00'));
        const sDay = d.start_day != null ? parseInt(d.start_day, 10) : (d.day_index != null ? parseInt(d.day_index, 10) : 1);
        const eDay = d.end_day != null ? parseInt(d.end_day, 10) : sDay;

        await conn.query(
          'INSERT INTO NUM_RUN_DEIL (NUM_RUNID, STARTTIME, ENDTIME, SDAYS, EDAYS, SCHCLASSID, OverTime) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [newId, sTime, eTime, sDay, eDay, shiftId, d.overtime ? 1 : 0]
        );
      }
    }

    await conn.commit();
    res.status(201).json({ success: true, id: newId, schedule_id: newId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// S2-C. Update schedule rotation
app.put('/api/schedules/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = req.body.name || req.body.NAME;
  const start_date = req.body.start_date || req.body.startDate;
  const end_date = req.body.end_date || req.body.endDate;
  const cycle = req.body.cycle;
  const units = req.body.units;
  const rawDetails = req.body.details || req.body.days;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Schedule name is required' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query('SELECT * FROM NUM_RUN WHERE NUM_RUNID = ?', [id]);
    if (existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Schedule not found' });
    }

    const cur = existing[0];
    const sDate = start_date ? `${start_date} 00:00:00` : cur.STARTDATE;
    const eDate = end_date ? `${end_date} 23:59:59` : cur.ENDDATE;
    const cyle = cycle !== undefined ? parseInt(cycle, 10) : cur.CYLE;
    const un = units !== undefined ? parseInt(units, 10) : cur.UNITS;

    await conn.query(
      'UPDATE NUM_RUN SET NAME = ?, STARTDATE = ?, ENDDATE = ?, CYLE = ?, UNITS = ? WHERE NUM_RUNID = ?',
      [String(name).trim(), sDate, eDate, cyle, un, id]
    );

    if (Array.isArray(rawDetails)) {
      await conn.query('DELETE FROM NUM_RUN_DEIL WHERE NUM_RUNID = ?', [id]);
      for (const d of rawDetails) {
        const shiftId = d.shift_class_id || d.shift_id;
        if (!shiftId) continue;
        const [sch] = await conn.query('SELECT StartTime, EndTime FROM SchClass WHERE schClassid = ?', [shiftId]);
        const sTime = d.start_time ? timeToDateTime(d.start_time) : (sch[0] ? sch[0].StartTime : timeToDateTime('08:00'));
        const eTime = d.end_time ? timeToDateTime(d.end_time) : (sch[0] ? sch[0].EndTime : timeToDateTime('17:00'));
        const sDay = d.start_day != null ? parseInt(d.start_day, 10) : (d.day_index != null ? parseInt(d.day_index, 10) : 1);
        const eDay = d.end_day != null ? parseInt(d.end_day, 10) : sDay;

        await conn.query(
          'INSERT INTO NUM_RUN_DEIL (NUM_RUNID, STARTTIME, ENDTIME, SDAYS, EDAYS, SCHCLASSID, OverTime) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, sTime, eTime, sDay, eDay, shiftId, d.overtime ? 1 : 0]
        );
      }
    }

    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// S2-D. Delete schedule rotation
app.delete('/api/schedules/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query('SELECT * FROM NUM_RUN WHERE NUM_RUNID = ?', [id]);
    if (existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Schedule not found' });
    }

    await conn.query('DELETE FROM NUM_RUN_DEIL WHERE NUM_RUNID = ?', [id]);
    await conn.query('DELETE FROM USER_OF_RUN WHERE NUM_OF_RUN_ID = ?', [id]);
    await conn.query('DELETE FROM NUM_RUN WHERE NUM_RUNID = ?', [id]);

    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
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

// S3-B. Assign employees to schedule
app.post('/api/schedules/:id/assignments', requireAdmin, async (req, res) => {
  const scheduleId = parseInt(req.params.id, 10);
  const rawUserIds = req.body.user_ids || req.body.userIds;
  const rawUserId = req.body.user_id || req.body.userId;
  const start_date = req.body.start_date || req.body.startDate;
  const end_date = req.body.end_date || req.body.endDate;

  let uids = [];
  if (Array.isArray(rawUserIds)) {
    uids = rawUserIds.map(u => parseInt(u, 10)).filter(u => !isNaN(u) && u > 0);
  } else if (rawUserId) {
    const uid = parseInt(rawUserId, 10);
    if (!isNaN(uid) && uid > 0) uids.push(uid);
  }

  if (uids.length === 0) {
    return res.status(400).json({ error: 'At least one valid user_id is required' });
  }

  const sDate = start_date ? `${start_date} 00:00:00` : new Date().toISOString().slice(0, 10) + ' 00:00:00';
  const eDate = end_date ? `${end_date} 23:59:59` : '2200-12-31 23:59:59';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [sched] = await conn.query('SELECT NUM_RUNID FROM NUM_RUN WHERE NUM_RUNID = ?', [scheduleId]);
    if (sched.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Schedule not found' });
    }

    for (const uid of uids) {
      // Clean up any existing assignment for this user to avoid conflicts
      await conn.query('DELETE FROM USER_OF_RUN WHERE USERID = ?', [uid]);
      await conn.query(
        'INSERT INTO USER_OF_RUN (USERID, NUM_OF_RUN_ID, STARTDATE, ENDDATE, ISNOTOF_RUN, ORDER_RUN) VALUES (?, ?, ?, ?, 0, 0)',
        [uid, scheduleId, sDate, eDate]
      );
    }

    await conn.commit();
    res.json({ success: true, count: uids.length });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// S3-C. Unassign employee from schedule
app.delete('/api/schedules/:id/assignments/:userId', requireAdmin, async (req, res) => {
  const scheduleId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  try {
    const [result] = await pool.query(
      'DELETE FROM USER_OF_RUN WHERE NUM_OF_RUN_ID = ? AND USERID = ?',
      [scheduleId, userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S3-D. Single employee schedule
app.get('/api/employees/:id/schedule', requireAuth, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  try {
    const [rows] = await pool.query(`
      SELECT u.NUM_OF_RUN_ID AS schedule_id, n.NAME AS schedule_name,
             DATE(u.STARTDATE) AS start_date, DATE(u.ENDDATE) AS end_date,
             n.CYLE AS cycle, n.UNITS AS units
      FROM USER_OF_RUN u
      JOIN NUM_RUN n ON n.NUM_RUNID = u.NUM_OF_RUN_ID
      WHERE u.USERID = ?
      ORDER BY u.STARTDATE DESC
      LIMIT 1
    `, [userId]);
    const sch = rows[0] || null;
    res.json({
      success: true,
      schedule: sch,
      schedule_id: sch ? sch.schedule_id : null,
      schedule_name: sch ? sch.schedule_name : null,
      ...(sch || {})
    });
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
  const status = (req.user.role === 'admin' && req.body.status)
    ? req.body.status
    : (req.user.role === 'admin' ? 'approved' : 'pending');
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

    if (req.user.role !== 'admin') {
      if (cur.status !== 'pending') {
        return res.status(403).json({ error: 'Cannot edit processed leave request' });
      }
      if (cur.user_id !== req.user.user_id) {
        return res.status(403).json({ error: 'You are not authorized to modify this leave record' });
      }
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
    res.status(500).json({ error: sanitizeErrorMessage(err) });
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

// ─── PUNCH RECONCILIATION ───────────────────────────────────────────────────

/**
 * POST /api/admin/reconcile-punches
 * Admin-only. Re-classifies existing punches in [from, to] date range using the
 * alternating toggle engine (hardware → toggle, 1-minute debounce). Only updates
 * rows whose classification has changed, and returns a diff report.
 *
 * Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', dryRun?: boolean }
 */
app.post('/api/admin/reconcile-punches', requireAdmin, async (req, res) => {
  try {
    const { from, to, dryRun = false } = req.body;
    if (!from || !to) {
      return res.status(400).json({ error: '"from" and "to" date fields are required (YYYY-MM-DD)' });
    }

    // Load all punches in range, sorted per user chronologically
    const [punches] = await pool.query(
      `SELECT id, user_id, check_time, check_type, normalized_type
       FROM checkinout
       WHERE check_time >= ? AND check_time <= ?
       ORDER BY user_id ASC, check_time ASC`,
      [`${from} 00:00:00`, `${to} 23:59:59`]
    );

    if (punches.length === 0) {
      return res.json({ usersProcessed: 0, punchesScanned: 0, punchesReclassified: 0, changes: [], dryRun });
    }

    // Seed toggle state from the punch immediately before the range for each user
    const userIds = [...new Set(punches.map(p => p.user_id))];
    const placeholders = userIds.map(() => '?').join(',');
    const [seedRows] = await pool.query(
      `SELECT c.user_id, c.normalized_type, c.check_time
       FROM checkinout c
       INNER JOIN (
         SELECT user_id, MAX(check_time) AS max_time
         FROM checkinout
         WHERE user_id IN (${placeholders}) AND check_time < ?
         GROUP BY user_id
       ) prev ON c.user_id = prev.user_id AND c.check_time = prev.max_time`,
      [...userIds, `${from} 00:00:00`]
    );
    const seedMap = new Map();
    for (const row of seedRows) {
      seedMap.set(row.user_id, { lastType: row.normalized_type, lastTime: new Date(row.check_time) });
    }

    // Walk each punch in order, resolve correct type, collect changes
    const changes = [];
    const currentState = new Map(seedMap);

    for (const punch of punches) {
      const state = currentState.get(punch.user_id) || { lastType: null, lastTime: null };
      const punchDate = new Date(punch.check_time);

      // normalizedType stored in DB never carries explicit hardware inOutStatus,
      // so always pass 0 (generic) — hardware signals were already applied on insert.
      // Reconciliation recomputes purely from toggle + debounce.
      const resolved = resolveNormalizedType(
        state.lastType,
        0,           // treat as generic for reconciliation
        punchDate,
        state.lastTime,
        []           // no shift windows — toggle only
      );

      if (resolved !== punch.normalized_type) {
        changes.push({
          id:       punch.id,
          user_id:  punch.user_id,
          check_time: punch.check_time,
          from:     punch.normalized_type,
          to:       resolved,
        });
      }

      // Update in-memory state regardless of whether there's a change
      currentState.set(punch.user_id, { lastType: resolved, lastTime: punchDate });
    }

    // Apply changes (unless dry run)
    if (!dryRun && changes.length > 0) {
      for (const change of changes) {
        const newCheckType = change.to === 'out' ? 'O' : 'I';
        await pool.query(
          'UPDATE checkinout SET check_type = ?, normalized_type = ? WHERE id = ?',
          [newCheckType, change.to, change.id]
        );
      }
    }

    res.json({
      usersProcessed:       userIds.length,
      punchesScanned:       punches.length,
      punchesReclassified:  changes.length,
      dryRun,
      changes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1. Health & Sync Status
app.get('/api/status', requireAuth, async (req, res) => {
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
    res.status(500).json({
      status: 'db_offline',
      syncInProgress: false,
      message: 'Database connection failed. Please contact the administrator.',
      error: sanitizeErrorMessage(err),
      stats: { employeeCount: 0, departmentCount: 0, punchCount: 0 }
    });
  }
});

// 2. Trigger On-Demand Sync (Biometric Hardware Clocks - Admin Only)
app.post('/api/sync', requireAdmin, async (req, res) => {
  if (isSyncInProgress) {
    return res.status(409).json({ error: 'A sync is already in progress' });
  }
  isSyncInProgress = true;
  try {
    const deviceResult = await syncAllActiveDevices(pool);
    res.json({
      success: true,
      result: deviceResult,
      deviceResult,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: sanitizeErrorMessage(err) });
  } finally {
    isSyncInProgress = false;
  }
});

// 3. Departments
app.get('/api/departments', requireAuth, async (req, res) => {
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
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 4. Employees with latest punch status
app.get('/api/employees', requireAuth, async (req, res) => {
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
        u_sched.NUM_OF_RUN_ID AS schedule_id,
        u_sched.schedule_name,
        latest.check_time AS last_punch_time,
        latest.normalized_type AS last_punch_type
      FROM employees e
      LEFT JOIN departments d ON e.dept_id = d.dept_id
      LEFT JOIN (
        SELECT u1.USERID, u1.NUM_OF_RUN_ID, n1.NAME AS schedule_name
        FROM USER_OF_RUN u1
        JOIN NUM_RUN n1 ON n1.NUM_RUNID = u1.NUM_OF_RUN_ID
        INNER JOIN (
          SELECT USERID, MAX(STARTDATE) AS max_start
          FROM USER_OF_RUN
          GROUP BY USERID
        ) u2 ON u1.USERID = u2.USERID AND u1.STARTDATE = u2.max_start
      ) u_sched ON e.user_id = u_sched.USERID
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
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 5. Single Employee Details + Attendance
app.get('/api/employees/:id', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const [empRows] = await pool.query(`
      SELECT e.*, d.dept_name,
             u_sched.NUM_OF_RUN_ID AS schedule_id,
             u_sched.schedule_name
      FROM employees e 
      LEFT JOIN departments d ON e.dept_id = d.dept_id 
      LEFT JOIN (
        SELECT u1.USERID, u1.NUM_OF_RUN_ID, n1.NAME AS schedule_name
        FROM USER_OF_RUN u1
        JOIN NUM_RUN n1 ON n1.NUM_RUNID = u1.NUM_OF_RUN_ID
        INNER JOIN (
          SELECT USERID, MAX(STARTDATE) AS max_start
          FROM USER_OF_RUN
          GROUP BY USERID
        ) u2 ON u1.USERID = u2.USERID AND u1.STARTDATE = u2.max_start
      ) u_sched ON e.user_id = u_sched.USERID
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
    const emp = empRows[0];
    res.json({
      ...emp,
      employee: emp,
      punches,
      rawPunches: punches,
      dailyAttendance,
      dailySummary: dailyAttendance.map(d => ({
        ...d,
        hours_worked: d.total_hours,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 6. Filterable Punch Log (Pagination & Range)
app.get('/api/punches', requireAuth, async (req, res) => {
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
    params.push(limit, offset);

    const [rows] = await pool.query(dataSql, params);

    const totalPages = Math.ceil(total / limit);
    res.json({
      punches: rows,
      data: rows,
      page,
      limit,
      total,
      totalPages,
      pagination: {
        page,
        limit,
        total,
        pages: totalPages
      }
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 7. Dashboard Overview
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const targetDate = req.query.date || getLocalDateString();
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
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 8. Daily Attendance Reports (Paired First In / Last Out)
app.get('/api/reports/daily', requireAuth, async (req, res) => {
  try {
    const { from, to, deptId, search } = req.query;
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

    if (search && search.trim()) {
      query += ` AND (e.name LIKE ? OR e.badge_number LIKE ?)`;
      params.push(`%${search.trim()}%`, `%${search.trim()}%`);
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
          is_auto_out: day.is_auto_out || false,
        });
      }
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// ─── DEVICE ADMINISTRATION CRUD ──────────────────────────────────────────────

// 9. List all devices (with punch count from checkinout.sn cross-reference)
app.get('/api/devices', requireAuth, async (req, res) => {
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
app.post('/api/devices', requireAdmin, async (req, res) => {
  const { sn, alias, ip_address, location, model, status, is_master } = req.body;
  if (!sn || !String(sn).trim()) {
    return res.status(400).json({ error: 'Serial number (SN) is required' });
  }
  let safeIp = null;
  if (ip_address && String(ip_address).trim()) {
    const ipCheck = isSafeDeviceIp(String(ip_address).trim());
    if (!ipCheck.valid) {
      return res.status(400).json({ error: ipCheck.error });
    }
    safeIp = ipCheck.ip;
  }
  const validStatuses = ['active', 'inactive'];
  const deviceStatus = validStatuses.includes(status) ? status : 'active';
  const isMasterVal = is_master ? 1 : 0;
  try {
    if (isMasterVal) {
      await pool.query('UPDATE devices SET is_master = 0');
    }
    const [result] = await pool.query(
      `INSERT INTO devices (sn, alias, ip_address, location, model, is_master, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(sn).trim(),
        alias ? String(alias).trim() : null,
        safeIp,
        location ? String(location).trim() : null,
        model ? String(model).trim() : null,
        isMasterVal,
        deviceStatus,
      ]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `A device with SN "${sn}" already exists` });
    }
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 10b. Helper to probe device socket on port 4370 (with SSRF protection)
function probeDevice(ip, port = 4370, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!ip || typeof ip !== 'string' || !ip.trim()) {
      return resolve({ connected: false, latencyMs: 0, error: 'No IP configured' });
    }
    const ipCheck = isSafeDeviceIp(ip);
    if (!ipCheck.valid) {
      return resolve({ connected: false, latencyMs: 0, error: ipCheck.error });
    }
    const cleanIp = ipCheck.ip;
    const safePort = 4370;
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    socket.setTimeout(timeoutMs);

    socket.connect(safePort, cleanIp, () => {
      if (settled) return;
      settled = true;
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ connected: true, latencyMs });
    });

    socket.on('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ connected: false, latencyMs: Date.now() - start, error: 'Connection timed out' });
    });

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ connected: false, latencyMs: Date.now() - start, error: err.message });
    });
  });
}

// 10c. Live network connectivity status for all devices (Admin only)
app.get('/api/devices/live-status', requireAdmin, async (req, res) => {
  try {
    const [devices] = await pool.query('SELECT id, sn, alias, ip_address FROM devices');
    const probePromises = devices.map(async (dev) => {
      if (!dev.ip_address) {
        return {
          id: dev.id,
          sn: dev.sn,
          ip_address: null,
          connected: false,
          latencyMs: 0,
          error: 'No IP configured'
        };
      }
      const status = await probeDevice(dev.ip_address, 4370, 1500);
      return {
        id: dev.id,
        sn: dev.sn,
        ip_address: dev.ip_address,
        ...status
      };
    });

    const results = await Promise.all(probePromises);
    const statusMap = {};
    for (const r of results) {
      statusMap[r.id] = r;
    }
    res.json({ success: true, statuses: statusMap });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 10d. Ping/Test connectivity of single device (Admin only)
app.get('/api/devices/:id/ping', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, sn, alias, ip_address FROM devices WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    const dev = rows[0];
    if (!dev.ip_address) {
      return res.json({ id: dev.id, sn: dev.sn, ip_address: null, connected: false, latencyMs: 0, error: 'No IP configured' });
    }
    const result = await probeDevice(dev.ip_address, 4370, 1500);
    res.json({
      id: dev.id,
      sn: dev.sn,
      ip_address: dev.ip_address,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 10e. Direct network sync for a single device (Admin only)
app.post('/api/devices/:id/sync', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    const dev = rows[0];
    if (!dev.ip_address) {
      return res.status(400).json({ error: 'Device has no IP address configured' });
    }
    const result = await syncSingleDevice(dev, pool);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: sanitizeErrorMessage(err) });
  }
});

// 10f. Direct network sync for all active devices (Admin only)
app.post('/api/devices/sync-all', requireAdmin, async (req, res) => {
  try {
    const result = await syncAllActiveDevices(pool);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: sanitizeErrorMessage(err) });
  }
});

// 10g. Propagate all enrolled users from Master Clock (GenReg1) to all active clocks (Admin only)
app.post('/api/devices/propagate-users', requireAdmin, async (req, res) => {
  try {
    const result = await propagateUsersFromMaster(pool);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: sanitizeErrorMessage(err) });
  }
});

// 10h. Promote a device to Master Clock (Admin only)
app.put('/api/devices/:id/set-master', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    await pool.query('UPDATE devices SET is_master = 0');
    await pool.query('UPDATE devices SET is_master = 1 WHERE id = ?', [id]);
    res.json({ success: true, masterDeviceId: id, alias: rows[0].alias });
  } catch (err) {
    res.status(500).json({ success: false, error: sanitizeErrorMessage(err) });
  }
});

// 10i. Synchronize internal clock (RTC) of a hardware device with server time (Admin only)
app.post('/api/devices/:id/sync-time', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    const dev = rows[0];
    const ipCheck = isSafeDeviceIp(dev.ip_address);
    if (!ipCheck.valid) return res.status(400).json({ error: ipCheck.error });

    const ZKLib = require('node-zklib');
    const zk = new ZKLib(ipCheck.ip, 4370, 5000, 4000);
    await zk.createSocket();
    const result = await syncDeviceTimeIfDrifted(zk, dev.alias || dev.sn, 0); // 0 threshold forces immediate sync
    await zk.disconnect();
    res.json({ success: true, result, alias: dev.alias || dev.sn });
  } catch (err) {
    res.status(500).json({ success: false, error: sanitizeErrorMessage(err) });
  }
});


// 11. Get single device
app.get('/api/devices/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (rows.length === 0) return res.status(404).json({ error: 'Device not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 12. Update a device
app.put('/api/devices/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { sn, alias, ip_address, location, model, status, is_master } = req.body;
  if (!sn || !String(sn).trim()) {
    return res.status(400).json({ error: 'Serial number (SN) is required' });
  }
  let safeIp = null;
  if (ip_address && String(ip_address).trim()) {
    const ipCheck = isSafeDeviceIp(String(ip_address).trim());
    if (!ipCheck.valid) {
      return res.status(400).json({ error: ipCheck.error });
    }
    safeIp = ipCheck.ip;
  }
  const validStatuses = ['active', 'inactive'];
  const deviceStatus = validStatuses.includes(status) ? status : 'active';
  try {
    if (is_master === true || is_master === 1 || is_master === '1') {
      await pool.query('UPDATE devices SET is_master = 0 WHERE id != ?', [id]);
    }
    const [result] = await pool.query(
      `UPDATE devices SET sn=?, alias=?, ip_address=?, location=?, model=?, status=?, is_master=COALESCE(?, is_master) WHERE id=?`,
      [
        String(sn).trim(),
        alias ? String(alias).trim() : null,
        safeIp,
        location ? String(location).trim() : null,
        model ? String(model).trim() : null,
        deviceStatus,
        is_master !== undefined ? (is_master ? 1 : 0) : null,
        id,
      ]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `A device with SN "${sn}" already exists` });
    }
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 13. Delete a device
app.delete('/api/devices/:id', requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM devices WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Device not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// ─── USER ADMINISTRATION CRUD (Admin Only) ───────────────────────────────────

// 14. Admin user list (employees with total punch count)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 15. Create a user/employee
app.post('/api/employees', requireAdmin, async (req, res) => {
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

    if (req.body.schedule_id) {
      const schedId = parseInt(req.body.schedule_id, 10);
      if (!isNaN(schedId) && schedId > 0) {
        await pool.query(
          'INSERT INTO USER_OF_RUN (USERID, NUM_OF_RUN_ID, STARTDATE, ENDDATE, ISNOTOF_RUN, ORDER_RUN) VALUES (?, ?, CURDATE(), "2200-12-31 23:59:59", 0, 0)',
          [uid, schedId]
        );
      }
    }

    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: `A user with ID ${user_id} already exists` });
    }
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 16. Update a user/employee
app.put('/api/employees/:id', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { badge_number, name, gender, dept_id, schedule_id } = req.body;
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

    if (schedule_id !== undefined) {
      await pool.query('DELETE FROM USER_OF_RUN WHERE USERID = ?', [userId]);
      const schedId = parseInt(schedule_id, 10);
      if (!isNaN(schedId) && schedId > 0) {
        await pool.query(
          'INSERT INTO USER_OF_RUN (USERID, NUM_OF_RUN_ID, STARTDATE, ENDDATE, ISNOTOF_RUN, ORDER_RUN) VALUES (?, ?, CURDATE(), "2200-12-31 23:59:59", 0, 0)',
          [userId, schedId]
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// 17. Delete a user/employee (cascades to checkinout via FK)
app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM USER_OF_RUN WHERE USERID = ?', [parseInt(req.params.id, 10)]);
    const [result] = await pool.query('DELETE FROM employees WHERE user_id = ?', [parseInt(req.params.id, 10)]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
});

// Automated direct hardware device sync (Port 4370 -> MySQL)
// Legacy Access MDB sync has been decommissioned in favor of direct clock communication.

// Setup scheduled direct hardware device sync if enabled (Port 4370 -> MySQL)
const deviceCronPattern = process.env.DEVICE_SYNC_CRON;
let deviceCronJob = null;
if (process.env.NODE_ENV !== 'test' && deviceCronPattern && deviceCronPattern.trim().toLowerCase() !== 'disabled') {
  console.log(`[Server] Scheduling automated direct device sync with cron: "${deviceCronPattern}"`);
  deviceCronJob = cron.schedule(deviceCronPattern, async () => {
    console.log('[Cron] Executing scheduled direct ZKTeco hardware -> MySQL sync...');
    try {
      await syncAllActiveDevices(pool);
    } catch (e) {
      console.error('[Cron] Scheduled direct device sync failed:', e.message);
    }
  });
}

// Fallback to SPA index.html
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

// Automatic Schema Migration on Container Startup
async function ensureSchema(dbPool = pool) {
  try {
    const [cols] = await dbPool.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'is_master'`
    );
    if (!cols || cols.length === 0) {
      console.log('[Migration] Adding column is_master to devices table...');
      await dbPool.query('ALTER TABLE devices ADD COLUMN is_master TINYINT(1) NOT NULL DEFAULT 0 AFTER model');
    }

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS biometric_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        uid INT NOT NULL,
        finger_id TINYINT NOT NULL,
        valid_flag TINYINT NOT NULL DEFAULT 1,
        template_size INT NOT NULL,
        template_data MEDIUMBLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_uid_fid (uid, finger_id),
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB;
    `);
  } catch (err) {
    console.warn('[Migration] ensureSchema warning:', err.message);
  }
}
app.ensureSchema = ensureSchema;

// Start Server
if (require.main === module) {
  ensureSchema().catch((err) => {
    console.error('[Migration] Failed to run schema migration on startup:', err.message);
  }).finally(() => {
    app.listen(port, () => {
      console.log(`[Server] Personnel Time & Attendance Server running at http://localhost:${port}`);
    });
  });
}

module.exports = app;
