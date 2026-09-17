const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const mysql = require('mysql2/promise');
const { default: MDBReader } = require('mdb-reader');
const { normalizeCheckType, formatMySQLDateTime } = require('./helpers');

/**
 * Creates MySQL connection pool
 */
function createPool() {
  return mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'timeclock_user',
    password: process.env.DB_PASSWORD || 'TimeClock@2026!',
    database: process.env.DB_NAME || 'timeclock_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
}

/**
 * Main synchronization engine
 * @param {Object} options
 * @param {boolean} options.dryRun
 * @returns {Promise<{success: boolean, departmentsCount: number, employeesCount: number, punchesCount: number, durationMs: number}>}
 */
async function runSync(options = {}) {
  const isDryRun = options.dryRun || process.argv.includes('--dry-run');
  const startTime = Date.now();
  const dbPath = process.env.ACCESS_DB_PATH || path.resolve(__dirname, '../att2000.mdb');

  console.log(`[Bridge] Starting sync from: ${dbPath}`);
  console.log(`[Bridge] Mode: ${isDryRun ? 'DRY-RUN (read-only)' : 'LIVE SYNC'}`);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Access database file not found at ${dbPath}`);
  }

  // 1. Read Access Database (strictly read-only buffer)
  const fileBuffer = fs.readFileSync(dbPath);
  const reader = new MDBReader(fileBuffer);

  const mdbTables = reader.getTableNames();
  console.log(`[Bridge] Found ${mdbTables.length} tables in Access database`);

  // Read Departments
  const rawDepts = reader.getTable('DEPARTMENTS').getData();
  console.log(`[Bridge] Read ${rawDepts.length} departments`);

  // Read Employees
  const rawUsers = reader.getTable('USERINFO').getData();
  console.log(`[Bridge] Read ${rawUsers.length} employees`);

  // Read Punches
  const rawCheckinout = reader.getTable('CHECKINOUT').getData();
  console.log(`[Bridge] Read ${rawCheckinout.length} punch records`);

  if (isDryRun) {
    const durationMs = Date.now() - startTime;
    console.log(`[Bridge] Dry run completed in ${durationMs}ms. No database changes made.`);
    return {
      success: true,
      departmentsCount: rawDepts.length,
      employeesCount: rawUsers.length,
      punchesCount: rawCheckinout.length,
      durationMs,
    };
  }

  // 2. Connect to MySQL
  const pool = createPool();
  const conn = await pool.getConnection();

  let syncLogId = null;

  try {
    // Start sync log entry
    const [logResult] = await conn.query(
      'INSERT INTO sync_log (sync_start, status, records_read) VALUES (NOW(), ?, ?)',
      ['RUNNING', rawCheckinout.length]
    );
    syncLogId = logResult.insertId;

    // 3. Sync Departments
    console.log(`[Bridge] Syncing ${rawDepts.length} departments to MySQL...`);
    for (const d of rawDepts) {
      if (!d.DEPTID) continue;
      await conn.query(
        `INSERT INTO departments (dept_id, dept_name)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE dept_name = VALUES(dept_name)`,
        [d.DEPTID, d.DEPTNAME || `Dept ${d.DEPTID}`]
      );
    }

    // 4. Sync Employees
    console.log(`[Bridge] Syncing ${rawUsers.length} employees to MySQL...`);
    for (const u of rawUsers) {
      if (!u.USERID) continue;
      const deptId = (u.DEFAULTDEPTID && rawDepts.some(d => d.DEPTID === u.DEFAULTDEPTID))
        ? u.DEFAULTDEPTID
        : null;

      await conn.query(
        `INSERT INTO employees (user_id, badge_number, name, gender, dept_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           badge_number = VALUES(badge_number),
           name = VALUES(name),
           gender = VALUES(gender),
           dept_id = VALUES(dept_id)`,
        [
          u.USERID,
          u.Badgenumber ? String(u.Badgenumber) : String(u.USERID),
          u.Name || `Employee ${u.USERID}`,
          u.Gender || null,
          deptId
        ]
      );
    }

    // 5. Sync Checkinout Punches in Batches
    console.log(`[Bridge] Syncing ${rawCheckinout.length} punches in chunks...`);
    const BATCH_SIZE = 2500;
    let insertedTotal = 0;

    for (let i = 0; i < rawCheckinout.length; i += BATCH_SIZE) {
      const chunk = rawCheckinout.slice(i, i + BATCH_SIZE);
      const values = [];

      for (const row of chunk) {
        if (!row.USERID || !row.CHECKTIME) continue;

        const checkTime = formatMySQLDateTime(row.CHECKTIME);
        if (!checkTime) continue;

        const normType = normalizeCheckType(row.CHECKTYPE);
        const checkType = String(row.CHECKTYPE || 'I');
        const sensorId = row.SENSORID ? String(row.SENSORID) : null;
        const workCode = typeof row.WorkCode === 'number' ? row.WorkCode : 0;
        const sn = row.sn ? String(row.sn) : null;

        values.push([row.USERID, checkTime, checkType, normType, sensorId, workCode, sn]);
      }

      if (values.length > 0) {
        const sql = `INSERT IGNORE INTO checkinout
          (user_id, check_time, check_type, normalized_type, sensor_id, work_code, sn)
          VALUES ?`;
        const [res] = await conn.query(sql, [values]);
        insertedTotal += res.affectedRows;
      }

      if ((i + BATCH_SIZE) % 25000 === 0 || i + BATCH_SIZE >= rawCheckinout.length) {
        const pct = Math.min(100, Math.round(((i + chunk.length) / rawCheckinout.length) * 100));
        console.log(`[Bridge] Progress: ${pct}% (${i + chunk.length}/${rawCheckinout.length} processed)`);
      }
    }

    const durationMs = Date.now() - startTime;

    // Complete sync log entry
    await conn.query(
      `UPDATE sync_log
       SET sync_end = NOW(), records_inserted = ?, status = 'SUCCESS'
       WHERE id = ?`,
      [insertedTotal, syncLogId]
    );

    console.log(`[Bridge] Sync completed successfully in ${(durationMs / 1000).toFixed(1)}s!`);
    console.log(`[Bridge] Summary: ${rawDepts.length} depts, ${rawUsers.length} emps, ${insertedTotal} punches inserted.`);

    return {
      success: true,
      departmentsCount: rawDepts.length,
      employeesCount: rawUsers.length,
      punchesCount: rawCheckinout.length,
      recordsInserted: insertedTotal,
      durationMs,
    };
  } catch (error) {
    console.error('[Bridge] Error during sync:', error);
    if (syncLogId) {
      await conn.query(
        `UPDATE sync_log
         SET sync_end = NOW(), status = 'ERROR', error_message = ?
         WHERE id = ?`,
        [error.message, syncLogId]
      ).catch(() => {});
    }
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

// Execute directly if run as CLI script
if (require.main === module) {
  runSync()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runSync };
