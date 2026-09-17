/**
 * Biometric Device Synchronization Engine
 * 
 * Directly interfaces with ZKTeco hardware devices over TCP port 4370.
 * Ingests user profiles, badges, and attendance punch logs directly into MySQL.
 */

// Patch node-zklib before it loads submodules:
// decodeRecordData40 omits byte 31 (inOutStatus: 0=In, 1=Out, 4=OT In, 5=OT Out)
// and byte 26 (verifyType). Without this patch, all punches default to inOutStatus=0 (IN).
const zklibUtils = require('node-zklib/utils');
if (zklibUtils && typeof zklibUtils.decodeRecordData40 === 'function') {
  const origDecode40 = zklibUtils.decodeRecordData40;
  zklibUtils.decodeRecordData40 = (recordData) => {
    const record = origDecode40(recordData);
    if (record && recordData && recordData.length >= 32) {
      record.verifyType = recordData[26];
      record.inOutStatus = recordData[31];
    }
    return record;
  };
}

const ZKLib = require('node-zklib');
const mysql = require('mysql2/promise');
const net = require('net');
const path = require('path');
const { resolveNormalizedType, isSameDay } = require('./helpers');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

/**
 * Fast network probe to test if port 4370 is listening before attempting full ZK protocol handshake
 * @param {string} ip
 * @param {number} [port=4370]
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<boolean>}
 */
function probeSocket(ip, port = 4370, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isSettled = false;
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      isSettled = true;
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      if (!isSettled) {
        isSettled = true;
        socket.destroy();
        resolve(false);
      }
    });
    socket.on('error', () => {
      if (!isSettled) {
        isSettled = true;
        socket.destroy();
        resolve(false);
      }
    });
    socket.connect(port, ip);
  });
}

/**
 * Formats a Date object into MySQL DATETIME string (YYYY-MM-DD HH:mm:ss) using local clock time
 * @param {Date|string} dateInput
 * @returns {string|null}
 */
function formatLocalMySQLDateTime(dateInput) {
  if (!dateInput) return null;
  const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Normalizes user payload from ZK device
 * @param {Object} rawUser
 * @returns {{userId: number, badgeNumber: string, name: string}|null}
 */
function normalizeDeviceUser(rawUser) {
  if (!rawUser || rawUser.userId === undefined || rawUser.userId === null) {
    return null;
  }
  const cleanIdStr = String(rawUser.userId).trim();
  const userId = parseInt(cleanIdStr, 10);
  if (isNaN(userId) || userId <= 0) {
    return null;
  }

  const rawName = typeof rawUser.name === 'string' ? rawUser.name.trim() : '';
  const name = rawName.length > 0 ? rawName : `Employee ${userId}`;
  const badgeNumber = rawUser.cardno && Number(rawUser.cardno) > 0
    ? String(rawUser.cardno)
    : cleanIdStr;

  return {
    userId,
    badgeNumber,
    name,
  };
}

/**
 * Normalizes attendance punch payload from ZK device
 * @param {Object} rawAtt
 * @param {string} [deviceSn]
 * @returns {{userId: number, checkTime: string, checkType: string, normType: string, sensorId: string, workCode: number, sn: string|null}|null}
 */
function normalizeDeviceAttendance(rawAtt, deviceSn = null) {
  if (!rawAtt) return null;

  const idStr = String(rawAtt.deviceUserId || rawAtt.userId || '').trim();
  const userId = parseInt(idStr, 10);
  if (isNaN(userId) || userId <= 0) {
    return null;
  }

  const formattedTime = formatLocalMySQLDateTime(rawAtt.recordTime || rawAtt.checkTime);
  if (!formattedTime) {
    return null;
  }

  // ZKTeco inOutStatus codes: 0 = Check In, 1 = Check Out, 4 = Overtime In, 5 = Overtime Out
  const inOutStatus = rawAtt.inOutStatus ?? rawAtt.type ?? 0;
  const isOut = inOutStatus === 1 || inOutStatus === 5;

  return {
    userId,
    checkTime: formattedTime,
    checkType: isOut ? 'O' : 'I',
    normType: isOut ? 'out' : 'in',
    inOutStatus,
    sensorId: rawAtt.userSn ? String(rawAtt.userSn) : '1',
    workCode: 0,
    sn: deviceSn ? String(deviceSn).trim() : null,
  };
}

/**
 * Synchronizes a single device with MySQL
 * @param {Object} device - Row from `devices` table ({ id, sn, alias, ip_address })
 * @param {import('mysql2/promise').Pool} pool
 * @param {Object} [options]
 * @param {number} [options.timeout=5000]
 * @returns {Promise<{success: boolean, deviceId: number, deviceSn: string, usersRead: number, usersUpserted: number, punchesRead: number, punchesInserted: number, durationMs: number}>}
 */
async function syncSingleDevice(device, pool, options = {}) {
  if (!device || !device.ip_address) {
    throw new Error('Device record must contain a valid ip_address');
  }

  const startTime = Date.now();
  const ip = String(device.ip_address).trim();
  const port = options.port || 4370;

  // 1. Fast socket probe before protocol handshake
  const probeMs = options.probeTimeoutMs || 1500;
  const isOnline = await probeSocket(ip, port, probeMs);
  if (!isOnline) {
    throw new Error(`Device at ${ip}:${port} is unreachable (probe timed out after ${probeMs}ms)`);
  }

  const timeoutMs = options.timeout || 5000;
  console.log(`[DeviceSync] Connecting to device "${device.alias || device.sn}" at ${ip}:${port}...`);
  const zk = new ZKLib(ip, port, timeoutMs, 4000);

  let usersRead = 0;
  let usersUpserted = 0;
  let punchesRead = 0;
  let punchesInserted = 0;

  try {
    await zk.createSocket();

    // 1. Fetch users from device
    let rawUsers = [];
    try {
      const usersRes = await zk.getUsers();
      if (usersRes && Array.isArray(usersRes.data)) {
        rawUsers = usersRes.data;
      }
    } catch (uErr) {
      console.warn(`[DeviceSync] Warning: Failed to retrieve users from ${ip}: ${uErr.message}`);
    }
    usersRead = rawUsers.length;

    // 2. Fetch punches from device
    let rawAtt = [];
    try {
      const attRes = await zk.getAttendances();
      if (attRes && Array.isArray(attRes.data)) {
        rawAtt = attRes.data;
      }
    } catch (aErr) {
      console.warn(`[DeviceSync] Warning: Failed to retrieve attendances from ${ip}: ${aErr.message}`);
    }
    punchesRead = rawAtt.length;

    // Disconnect socket early before batch DB writes
    try {
      await zk.disconnect();
    } catch (dcErr) {
      // Ignore cleanup disconnect error
    }

    // 3. Upsert Users into MySQL `employees`
    if (rawUsers.length > 0) {
      const validUsers = rawUsers
        .map(normalizeDeviceUser)
        .filter(Boolean);

      for (const u of validUsers) {
        const [res] = await pool.query(
          `INSERT INTO employees (user_id, badge_number, name)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE
             name = IF(name IS NULL OR name = '' OR name LIKE 'Employee %', VALUES(name), name),
             badge_number = COALESCE(badge_number, VALUES(badge_number))`,
          [u.userId, u.badgeNumber, u.name]
        );
        if (res && (res.affectedRows === 1 || res.affectedRows === 2)) {
          usersUpserted++;
        }
      }
    }

    // 4. Ingest Punches into MySQL `checkinout` with alternating IN/OUT toggle
    if (rawAtt.length > 0) {
      const validPunches = rawAtt
        .map(a => normalizeDeviceAttendance(a, device.sn))
        .filter(Boolean);

      // --- Group valid punches by user and sort chronologically ---
      const byUser = new Map();
      for (const p of validPunches) {
        if (!byUser.has(p.userId)) byUser.set(p.userId, []);
        byUser.get(p.userId).push(p);
      }
      for (const punches of byUser.values()) {
        punches.sort((a, b) => new Date(a.checkTime).getTime() - new Date(b.checkTime).getTime());
      }

      // --- Toggle State Bootstrap ---
      // Bulk-load the latest punch time and normalized_type per user from MySQL.
      // This seeds toggle state so new punches alternate off whatever was last recorded in DB.
      const deviceUserIds = [...byUser.keys()];
      const latestDbMap = new Map(); // userId -> { maxTime: Date, lastType: string, lastTime: Date }
      const firstInDbMap = new Map(); // userId -> Date
      const shiftWindowsMap = new Map(); // userId -> Array<Object>

      if (deviceUserIds.length > 0) {
        const placeholders = deviceUserIds.map(() => '?').join(',');

        const [lastRows] = await pool.query(
          `SELECT c.user_id, c.normalized_type, c.check_time
           FROM checkinout c
           INNER JOIN (
             SELECT user_id, MAX(check_time) AS max_time
             FROM checkinout
             WHERE user_id IN (${placeholders})
             GROUP BY user_id
           ) latest ON c.user_id = latest.user_id AND c.check_time = latest.max_time`,
          deviceUserIds
        );
        for (const row of lastRows) {
          const rowTime = new Date(row.check_time);
          latestDbMap.set(row.user_id, {
            maxTime: rowTime,
            lastType: row.normalized_type,
            lastTime: rowTime,
          });
        }

        // Bulk-load first punch of today per user for departure heuristic
        const [firstRows] = await pool.query(
          `SELECT user_id, MIN(check_time) AS first_time
           FROM checkinout
           WHERE user_id IN (${placeholders}) AND DATE(check_time) = CURDATE()
           GROUP BY user_id`,
          deviceUserIds
        );
        for (const row of firstRows) {
          firstInDbMap.set(row.user_id, new Date(row.first_time));
        }

        // Bulk-load shift schedule windows from USER_OF_RUN + NUM_RUN_DEIL + SchClass
        const [schedRows] = await pool.query(
          `SELECT u.USERID AS user_id, sc.*, d.SDAYS, d.EDAYS
           FROM USER_OF_RUN u
           JOIN NUM_RUN_DEIL d ON u.NUM_OF_RUN_ID = d.NUM_RUNID
           JOIN SchClass sc ON d.SCHCLASSID = sc.schClassid
           WHERE u.USERID IN (${placeholders})`,
          deviceUserIds
        );
        for (const row of schedRows) {
          if (!shiftWindowsMap.has(row.user_id)) {
            shiftWindowsMap.set(row.user_id, []);
          }
          shiftWindowsMap.get(row.user_id).push(row);
        }
      }

      // --- Filter and Classify NEW Punches Only ("just from now on forward") ---
      // Punches already recorded in MySQL (checkTime <= maxTime) are preserved as-is.
      // Only new punches are classified via resolveNormalizedType and appended.
      const punchesToInsert = [];

      for (const [uid, userPunches] of byUser.entries()) {
        const dbState = latestDbMap.get(uid);
        let lastType = dbState ? dbState.lastType : null;
        let lastTime = dbState ? dbState.lastTime : null;
        let firstIn = firstInDbMap.get(uid) || null;
        const userWindows = shiftWindowsMap.get(uid) || [];

        const newPunches = dbState
          ? userPunches.filter(p => new Date(p.checkTime).getTime() > dbState.maxTime.getTime())
          : userPunches;

        for (const p of newPunches) {
          const punchDate = new Date(p.checkTime);

          if (!firstIn || !isSameDay(punchDate, firstIn)) {
            firstIn = punchDate;
            firstInDbMap.set(uid, firstIn);
          }

          const resolved = resolveNormalizedType(
            lastType,
            p.inOutStatus ?? 0,
            punchDate,
            lastTime,
            userWindows,
            firstIn
          );

          p.normType = resolved;
          p.checkType = resolved === 'out' ? 'O' : 'I';

          lastType = resolved;
          lastTime = punchDate;
          punchesToInsert.push(p);
        }
      }

      // --- Batch INSERT New Punches (INSERT IGNORE preserves historical records) ---
      const BATCH_SIZE = 500;
      for (let i = 0; i < punchesToInsert.length; i += BATCH_SIZE) {
        const chunk = punchesToInsert.slice(i, i + BATCH_SIZE);
        const values = chunk.map(p => [
          p.userId,
          p.checkTime,
          p.checkType,
          p.normType,
          p.sensorId,
          p.workCode,
          p.sn,
        ]);

        if (values.length > 0) {
          const [insRes] = await pool.query(
            `INSERT IGNORE INTO checkinout
             (user_id, check_time, check_type, normalized_type, sensor_id, work_code, sn)
             VALUES ?`,
            [values]
          );
          punchesInserted += (insRes && insRes.affectedRows) ? insRes.affectedRows : 0;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(`[DeviceSync] Completed sync for "${device.alias || device.sn}" in ${durationMs}ms: ` +
      `${usersRead} users read (${usersUpserted} upserted), ${punchesRead} punches read (${punchesInserted} inserted).`);

    return {
      success: true,
      deviceId: device.id,
      deviceSn: device.sn,
      deviceAlias: device.alias,
      deviceIp: ip,
      usersRead,
      usersUpserted,
      punchesRead,
      punchesInserted,
      durationMs,
    };
  } catch (err) {
    try {
      await zk.disconnect();
    } catch (_) {}
    console.error(`[DeviceSync] Error syncing device "${device.alias || device.sn}" (${ip}):`, err.message);
    throw err;
  }
}

/**
 * Synchronizes all active devices configured in MySQL
 * @param {import('mysql2/promise').Pool} pool
 * @param {Object} [options]
 * @returns {Promise<{totalDevices: number, successfulDevices: number, results: Array<Object>, durationMs: number}>}
 */
async function syncAllActiveDevices(pool, options = {}) {
  const startTime = Date.now();
  const [devices] = await pool.query(
    "SELECT id, sn, alias, ip_address, model, status FROM devices WHERE status = 'active' AND ip_address IS NOT NULL AND ip_address != ''"
  );

  console.log(`[DeviceSync] Starting concurrent batch sync for ${devices.length} active device(s)...`);

  const syncPromises = devices.map(async (dev) => {
    try {
      return await syncSingleDevice(dev, pool, options);
    } catch (err) {
      return {
        success: false,
        deviceId: dev.id,
        deviceSn: dev.sn,
        deviceAlias: dev.alias,
        deviceIp: dev.ip_address,
        error: err.message,
      };
    }
  });

  const results = await Promise.all(syncPromises);
  const successfulDevices = results.filter(r => r.success).length;
  const totalPunchesInserted = results.reduce((acc, r) => acc + (r.punchesInserted || 0), 0);
  const durationMs = Date.now() - startTime;

  // Record audit log
  try {
    await pool.query(
      `INSERT INTO sync_log (sync_start, sync_end, records_read, records_inserted, status, error_message)
       VALUES (NOW(), NOW(), ?, ?, ?, ?)`,
      [
        results.reduce((acc, r) => acc + (r.punchesRead || 0), 0),
        totalPunchesInserted,
        successfulDevices === devices.length ? 'SUCCESS' : (successfulDevices > 0 ? 'PARTIAL' : 'ERROR'),
        results.filter(r => !r.success).map(r => `${r.deviceAlias || r.deviceSn}: ${r.error}`).join('; ') || null
      ]
    );
  } catch (logErr) {
    console.warn('[DeviceSync] Failed to write to sync_log:', logErr.message);
  }

  return {
    totalDevices: devices.length,
    successfulDevices,
    totalPunchesInserted,
    results,
    durationMs,
  };
}

// Execute directly if run as CLI script
if (require.main === module) {
  (async () => {
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
    try {
      console.log('[DeviceSync] Running biometric clock hardware sync from CLI...');
      const summary = await syncAllActiveDevices(pool);
      console.log(`[DeviceSync] Completed in ${(summary.durationMs / 1000).toFixed(2)}s: ${summary.successfulDevices}/${summary.totalDevices} devices reached, ${summary.totalPunchesInserted || 0} punches inserted.`);
      process.exit(0);
    } catch (err) {
      console.error('[DeviceSync] CLI sync error:', err);
      process.exit(1);
    } finally {
      await pool.end();
    }
  })();
}

module.exports = {
  formatLocalMySQLDateTime,
  normalizeDeviceUser,
  normalizeDeviceAttendance,
  syncSingleDevice,
  syncAllActiveDevices,
};
