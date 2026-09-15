const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mysql = require('mysql2/promise');
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

    res.json({
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Dashboard Overview
app.get('/api/dashboard', async (req, res) => {
  try {
    // Current date (default to today or latest available date in database if no records today)
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];

    const [totals] = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM employees) AS totalEmployees,
        (SELECT COUNT(DISTINCT user_id) FROM checkinout WHERE DATE(check_time) = ?) AS activeToday,
        (SELECT COUNT(*) FROM checkinout WHERE DATE(check_time) = ?) AS punchesToday
    `, [targetDate, targetDate]);

    // Latest 10 punches
    const [recentPunches] = await pool.query(`
      SELECT 
        c.id, c.user_id, c.check_time, c.normalized_type,
        e.name AS employee_name, d.dept_name
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
        COUNT(DISTINCT c.user_id) AS present_count
      FROM departments d
      JOIN employees e ON d.dept_id = e.dept_id
      JOIN checkinout c ON e.user_id = c.user_id AND DATE(c.check_time) = ?
      GROUP BY d.dept_id, d.dept_name
      ORDER BY present_count DESC
    `, [targetDate]);

    res.json({
      date: targetDate,
      summary: totals[0],
      recentPunches,
      deptBreakdown,
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
