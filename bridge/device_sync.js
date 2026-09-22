/**
 * Biometric Device Synchronization Engine
 * 
 * Directly interfaces with ZKTeco hardware devices over TCP port 4370.
 * Ingests user profiles, badges, and attendance punch logs directly into MySQL.
 */

// Patch node-zklib before it loads submodules:
// 1. decodeRecordData40 omits byte 31 (inOutStatus: 0=In, 1=Out, 4=OT In, 5=OT Out)
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

// 2. Patch ZKLibTCP requestData and readWithBuffer to safely handle incomplete/empty packets and listener cleanup
const ZKLibTCP = require('node-zklib/zklibtcp');
if (ZKLibTCP && ZKLibTCP.prototype) {
  const origReadWithBuffer = ZKLibTCP.prototype.readWithBuffer;
  if (typeof origReadWithBuffer === 'function') {
    ZKLibTCP.prototype.readWithBuffer = async function(reqData, cb = null) {
      try {
        const res = await origReadWithBuffer.call(this, reqData, cb);
        return res;
      } catch (err) {
        throw err;
      }
    };
  }
}

const ZKLib = require('node-zklib');
const mysql = require('mysql2/promise');
const net = require('net');
const path = require('path');
const { resolveNormalizedType, isSameDay } = require('./helpers');
const { isSafeDeviceIp } = require('../server/security');
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
    const ipCheck = isSafeDeviceIp(ip);
    if (!ipCheck.valid) {
      return resolve(false);
    }
    const cleanIp = ipCheck.ip;
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
    socket.connect(4370, cleanIp);
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
 * Encodes user record into exact 72-byte binary packet for ZKTeco CMD_USER_WRQ (code 8)
 * @param {Object} user - User record ({ uid, role, password, name, cardno, userId })
 * @returns {Buffer} 72-byte buffer
 */
function packUser72({ uid, role = 0, password = '', name = '', cardno = 0, userId }) {
  const buf = Buffer.alloc(72, 0);

  // Offset 0..1: Internal device UID (UInt16LE)
  buf.writeUInt16LE(parseInt(uid, 10) || 1, 0);

  // Offset 2: Role / privilege (UInt8) - 0 = Normal User, 14 = Super Admin
  buf.writeUInt8(parseInt(role, 10) || 0, 2);

  // Offset 3..10: Password (up to 8 ascii characters, null-padded)
  if (password) {
    buf.write(String(password).slice(0, 8), 3, 'ascii');
  }

  // Offset 11..34: Employee name (up to 24 characters, null-padded)
  if (name) {
    buf.write(String(name).slice(0, 24), 11, 'ascii');
  }

  // Offset 35..38: Card / Badge RFID number (UInt32LE)
  const cardNum = parseInt(cardno, 10) || 0;
  buf.writeUInt32LE(cardNum >>> 0, 35);

  // Offset 39: Group number (default 1)
  buf.writeUInt8(1, 39);

  // Offset 40..41: User timezone (UInt16LE, default 0)
  buf.writeUInt16LE(0, 40);

  // Offset 42..43: Verification style / flag (UInt16LE, default 1)
  buf.writeUInt16LE(1, 42);

  // Offset 48..71: Public Employee User ID (up to 24 characters, null-padded)
  const idStr = String(userId !== undefined && userId !== null ? userId : uid).trim();
  buf.write(idStr.slice(0, 24), 48, 'ascii');

  return buf;
}

/**
 * Writes a user record to a physical ZKTeco terminal over TCP
 * @param {Object} zk - Connected ZKLib instance
 * @param {Object} user - User payload ({ uid, role, password, name, cardno, userId })
 * @returns {Promise<boolean>}
 */
async function setUserOnDevice(zk, user) {
  if (!zk || !user) {
    throw new Error('Valid zk instance and user payload are required');
  }
  const { COMMANDS } = require('node-zklib/constants');
  const buf = packUser72(user);

  try {
    await zk.disableDevice();
  } catch (_) {}

  await zk.executeCmd(COMMANDS.CMD_USER_WRQ, buf);

  try {
    await zk.executeCmd(COMMANDS.CMD_REFRESHDATA, '');
  } catch (_) {}

  try {
    await zk.enableDevice();
  } catch (_) {}

  return true;
}

/**
 * Computes differential sync set between master users and slave users
 * @param {Array<Object>} masterUsers
 * @param {Array<Object>} slaveUsers
 * @returns {{toAdd: Array<Object>, toUpdate: Array<Object>, identical: number}}
 */
function diffUsers(masterUsers, slaveUsers) {
  const slaveMap = new Map();
  for (const u of (slaveUsers || [])) {
    if (!u) continue;
    const key = String(u.userId || u.uid).trim();
    slaveMap.set(key, u);
  }

  const toAdd = [];
  const toUpdate = [];
  let identical = 0;

  for (const m of (masterUsers || [])) {
    if (!m) continue;
    const key = String(m.userId || m.uid).trim();
    const existing = slaveMap.get(key);
    if (!existing) {
      toAdd.push(m);
    } else {
      const nameDiff = String(m.name || '').trim() !== String(existing.name || '').trim();
      const cardDiff = Number(m.cardno || 0) !== Number(existing.cardno || 0);
      const roleDiff = Number(m.role || 0) !== Number(existing.role || 0);
      const passDiff = Boolean(m.password && existing.password && m.password !== existing.password);
      if (nameDiff || cardDiff || roleDiff || passDiff) {
        toUpdate.push({ ...m, uid: existing.uid || m.uid });
      } else {
        identical++;
      }
    }
  }

  return { toAdd, toUpdate, identical };
}

/**
 * Encodes Date to ZKTeco 4-byte little-endian timestamp integer
 * @param {Date} [d=new Date()]
 * @returns {Buffer}
 */
function encodeZKTime(d = new Date()) {
  const year = d.getFullYear() % 100;
  const month = d.getMonth();
  const day = d.getDate() - 1;
  const hour = d.getHours();
  const minute = d.getMinutes();
  const second = d.getSeconds();
  const val = ((year * 12 * 31 + month * 31 + day) * 86400) +
              (hour * 60 + minute) * 60 +
              second;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(val, 0);
  return buf;
}

/**
 * Decodes ZKTeco 4-byte little-endian timestamp integer to Date
 * @param {number} t
 * @returns {Date}
 */
function decodeZKTime(t) {
  const second = t % 60;
  t = Math.floor(t / 60);
  const minute = t % 60;
  t = Math.floor(t / 60);
  const hour = t % 24;
  t = Math.floor(t / 24);
  const day = (t % 31) + 1;
  t = Math.floor(t / 31);
  const month = t % 12;
  t = Math.floor(t / 12);
  const year = t + 2000;
  return new Date(year, month, day, hour, minute, second);
}

/**
 * Reads hardware time from connected ZK device
 * @param {Object} zk
 * @returns {Promise<Date|null>}
 */
async function getDeviceTime(zk) {
  const tcp = zk.zklibTcp || zk;
  if (!tcp || !tcp.socket) return null;
  const rep = await tcp.executeCmd(201, ''); // CMD_GET_TIME (201)
  if (rep && rep.length >= 12) {
    return decodeZKTime(rep.readUInt32LE(8));
  }
  return null;
}

/**
 * Synchronizes hardware RTC clock on connected ZK device to the given Date
 * @param {Object} zk
 * @param {Date} [targetDate=new Date()]
 * @returns {Promise<boolean>}
 */
async function setDeviceTime(zk, targetDate = new Date()) {
  const tcp = zk.zklibTcp || zk;
  if (!tcp || !tcp.socket) return false;
  try {
    await tcp.disableDevice();
  } catch (_) {}
  const payload = encodeZKTime(targetDate);
  await tcp.executeCmd(202, payload); // CMD_SET_TIME (202)
  try {
    await tcp.executeCmd(1013, ''); // CMD_REFRESHDATA
  } catch (_) {}
  try {
    await tcp.enableDevice();
  } catch (_) {}
  return true;
}

/**
 * Checks clock drift and aligns device hardware time if drift exceeds threshold
 * @param {Object} zk
 * @param {string} [deviceAlias]
 * @param {number} [maxDriftSec=5]
 * @returns {Promise<{synced: boolean, driftSec: number, devTime: Date|null, sysTime: Date}>}
 */
async function syncDeviceTimeIfDrifted(zk, deviceAlias = 'Device', maxDriftSec = 5) {
  try {
    const devTime = await getDeviceTime(zk);
    if (!devTime) return { synced: false, driftSec: 0, devTime: null, sysTime: new Date() };
    const sysTime = new Date();
    const driftSec = Math.round((devTime.getTime() - sysTime.getTime()) / 1000);
    if (Math.abs(driftSec) > maxDriftSec) {
      console.log(`[DeviceSync] Clock drift detected on "${deviceAlias}": ${driftSec}s (${(driftSec/60).toFixed(1)}m). Re-aligning hardware RTC to server time...`);
      await setDeviceTime(zk, sysTime);
      return { synced: true, driftSec, devTime, sysTime };
    }
    return { synced: false, driftSec, devTime, sysTime };
  } catch (err) {
    console.warn(`[DeviceSync] Warning checking/setting time on "${deviceAlias}":`, err.message);
    return { synced: false, driftSec: 0, devTime: null, sysTime: new Date() };
  }
}


/**
 * Parses raw binary fingerprint templates buffer returned by ZKTeco readWithBuffer
 * @param {Buffer} buf
 * @returns {Array<{size: number, uid: number, fid: number, valid: number, template: Buffer}>}
 */
function parseTemplates(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 4) return [];
  let data = buf.subarray(4);
  const templates = [];
  while (data.length >= 6) {
    const size = data.readUInt16LE(0);
    const uid = data.readUInt16LE(2);
    const fid = data.readUInt8(4);
    const valid = data.readUInt8(5);
    if (size < 6 || size > data.length) break;
    const template = data.subarray(6, size);
    templates.push({ size, uid, fid, valid, template });
    data = data.subarray(size);
  }
  return templates;
}

/**
 * Safely fetches all enrolled biometric templates from a ZKTeco device
 * @param {Object} zk - Connected ZKLib instance
 * @returns {Promise<Array<Object>>}
 */
async function fetchDeviceTemplates(zk) {
  const reqTpl = Buffer.from([0x01, 0x09, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  try {
    const tcp = zk.zklibTcp || zk;
    if (tcp && tcp.socket) {
      await tcp.freeData();
      const res = await tcp.readWithBuffer(reqTpl);
      return parseTemplates(res.data);
    }
  } catch (err) {
    // When a device has 0 templates enrolled, readWithBuffer times out or returns empty
    return [];
  }
  return [];
}

/**
 * Computes differential set of fingerprint templates
 * @param {Array<Object>} masterTemplates
 * @param {Array<Object>} slaveTemplates
 * @returns {{toAdd: Array<Object>, identical: number, totalMaster: number, totalSlave: number}}
 */
function diffTemplates(masterTemplates = [], slaveTemplates = []) {
  const slaveMap = new Map();
  for (const st of slaveTemplates) {
    if (!st) continue;
    slaveMap.set(`${st.uid}:${st.fid}`, st);
  }

  const toAdd = [];
  let identical = 0;

  for (const mt of masterTemplates) {
    if (!mt) continue;
    const key = `${mt.uid}:${mt.fid}`;
    const match = slaveMap.get(key);
    if (!match) {
      toAdd.push(mt);
    } else if (match.template && mt.template && match.template.equals(mt.template)) {
      identical++;
    } else {
      toAdd.push(mt);
    }
  }

  return {
    toAdd,
    identical,
    totalMaster: masterTemplates.length,
    totalSlave: slaveTemplates.length
  };
}

/**
 * Constructs High-Rate ZKTeco packet for batch transmission of users and fingerprint templates
 * @param {Array<Object>} users
 * @param {Array<Object>} templates
 * @returns {Buffer}
 */
function buildHRUserTemplatesPacket(users = [], templates = []) {
  let upack = Buffer.alloc(0);
  let table = Buffer.alloc(0);
  let fpack = Buffer.alloc(0);
  const fnum = 0x10;
  let tstart = 0;

  const tplByUid = new Map();
  for (const t of templates) {
    if (!t) continue;
    if (!tplByUid.has(t.uid)) tplByUid.set(t.uid, []);
    tplByUid.get(t.uid).push(t);
  }

  for (const u of users) {
    const u72 = packUser72({
      uid: u.uid,
      role: u.role,
      password: u.password,
      name: u.name,
      cardno: u.cardno,
      userId: u.userId
    });
    const u73 = Buffer.concat([Buffer.from([2]), u72]);
    upack = Buffer.concat([upack, u73]);

    const userFingers = tplByUid.get(u.uid) || [];
    for (const finger of userFingers) {
      const tfp = Buffer.alloc(2 + finger.template.length);
      tfp.writeUInt16LE(finger.template.length, 0);
      finger.template.copy(tfp, 2);

      const tEntry = Buffer.alloc(8);
      tEntry.writeInt8(2, 0);
      tEntry.writeUInt16LE(u.uid, 1);
      tEntry.writeUInt8(fnum + finger.fid, 3);
      tEntry.writeUInt32LE(tstart, 4);

      table = Buffer.concat([table, tEntry]);
      fpack = Buffer.concat([fpack, tfp]);
      tstart += tfp.length;
    }
  }

  const head = Buffer.alloc(12);
  head.writeUInt32LE(upack.length, 0);
  head.writeUInt32LE(table.length, 4);
  head.writeUInt32LE(fpack.length, 8);

  return Buffer.concat([head, upack, table, fpack]);
}

/**
 * Transmits a large data buffer in chunks using CMD_PREPARE_DATA (1500) and CMD_DATA (1501)
 * @param {Object} zklibTcp
 * @param {Buffer} buffer
 * @param {number} [maxChunk=1024]
 */
async function sendBufferChunks(zklibTcp, buffer, maxChunk = 1024) {
  const size = buffer.length;
  await zklibTcp.freeData();

  const prepPayload = Buffer.alloc(4);
  prepPayload.writeUInt32LE(size, 0);
  await zklibTcp.executeCmd(1500, prepPayload);

  const remain = size % maxChunk;
  const packets = Math.floor((size - remain) / maxChunk);
  let start = 0;
  for (let i = 0; i < packets; i++) {
    const chunk = buffer.subarray(start, start + maxChunk);
    await zklibTcp.executeCmd(1501, chunk);
    start += maxChunk;
  }
  if (remain > 0) {
    const chunk = buffer.subarray(start, start + remain);
    await zklibTcp.executeCmd(1501, chunk);
  }
}

/**
 * Saves a batch of users and templates to device in high-rate mode
 * @param {Object} zk
 * @param {Array<Object>} users
 * @param {Array<Object>} templates
 */
async function saveUserTemplatesBatch(zk, users = [], templates = []) {
  const packet = buildHRUserTemplatesPacket(users, templates);
  const tcp = zk.zklibTcp || zk;
  await sendBufferChunks(tcp, packet);

  const cmdStr = Buffer.alloc(8);
  cmdStr.writeUInt32LE(12, 0);
  cmdStr.writeUInt16LE(0, 4);
  cmdStr.writeUInt16LE(8, 6);
  await tcp.executeCmd(110, cmdStr); // _CMD_SAVE_USERTEMPS (110)
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
  const ipCheck = isSafeDeviceIp(device.ip_address);
  if (!ipCheck.valid) {
    throw new Error(`Device IP security validation failed: ${ipCheck.error}`);
  }

  const startTime = Date.now();
  const ip = ipCheck.ip;
  const port = 4370;

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

    // 0. Auto-check and synchronize device hardware clock to server time if drifted (>5s)
    let timeSyncResult = null;
    try {
      timeSyncResult = await syncDeviceTimeIfDrifted(zk, device.alias || device.sn, 5);
    } catch (tErr) {
      console.warn(`[DeviceSync] Hardware RTC sync check warning for ${device.alias}:`, tErr.message);
    }

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

  // Automated differential user propagation from Master Clock (GenReg1) to all slave clocks
  let userPropagation = null;
  if (options.autoPropagate !== false && process.env.AUTO_PROPAGATE_USERS !== 'false') {
    try {
      userPropagation = await propagateUsersFromMaster(pool, options);
    } catch (propErr) {
      console.warn('[DeviceSync] Master clock user propagation warning:', propErr.message);
    }
  }

  return {
    totalDevices: devices.length,
    successfulDevices,
    totalPunchesInserted,
    results,
    userPropagation,
    durationMs,
  };
}

/**
 * Propagates users enrolled on the Master Clock (GenReg1) to all active slave clocks
 * @param {import('mysql2/promise').Pool} pool
 * @param {Object} [options]
 * @param {number} [options.timeout=5000]
 * @param {number} [options.probeTimeoutMs=1500]
 * @param {string} [options.masterAlias='GenReg1']
 * @returns {Promise<{success: boolean, masterId: number, masterAlias: string, masterIp: string, masterUsersCount: number, slaveCount: number, results: Array<Object>, durationMs: number}>}
 */
async function propagateUsersFromMaster(pool, options = {}) {
  const startTime = Date.now();

  // 1. Locate Master Device
  const masterAliasPattern = options.masterAlias || process.env.MASTER_CLOCK_ALIAS || 'GenReg1';
  const masterSn = process.env.MASTER_CLOCK_SN || 'KWQ3241600155';

  const [masterRows] = await pool.query(
    `SELECT id, sn, alias, ip_address, is_master, status
     FROM devices
     WHERE status = 'active' AND (is_master = 1 OR alias LIKE ? OR sn = ?)
     ORDER BY is_master DESC, id ASC
     LIMIT 1`,
    [`%${masterAliasPattern}%`, masterSn]
  );

  if (!masterRows || masterRows.length === 0) {
    console.warn('[PropagateUsers] No master clock configured or active. Skipping propagation.');
    return {
      success: false,
      reason: 'NO_MASTER_CLOCK',
      durationMs: Date.now() - startTime
    };
  }

  const master = masterRows[0];
  const masterIpCheck = isSafeDeviceIp(master.ip_address);
  if (!masterIpCheck.valid) {
    throw new Error(`Master clock IP security validation failed: ${masterIpCheck.error}`);
  }

  // 2. Fast socket probe before protocol handshake
  const probeMs = options.probeTimeoutMs || 1500;
  const isMasterOnline = await probeSocket(masterIpCheck.ip, 4370, probeMs);
  if (!isMasterOnline) {
    console.warn(`[PropagateUsers] Master clock "${master.alias || master.sn}" at ${masterIpCheck.ip}:4370 is unreachable (timed out after ${probeMs}ms).`);
    return {
      success: false,
      reason: 'MASTER_OFFLINE',
      masterId: master.id,
      masterAlias: master.alias,
      masterIp: masterIpCheck.ip,
      durationMs: Date.now() - startTime
    };
  }

  // 3. Connect to Master Clock and extract users & biometric fingerprint templates
  console.log(`[PropagateUsers] Sourcing master users and biodata from "${master.alias || master.sn}" at ${masterIpCheck.ip}...`);
  const masterZk = new ZKLib(masterIpCheck.ip, 4370, options.timeout || 5000, 4000);
  let rawMasterUsers = [];
  let rawMasterTemplates = [];

  try {
    await masterZk.createSocket();
    const uRes = await masterZk.getUsers();
    if (uRes && Array.isArray(uRes.data)) {
      rawMasterUsers = uRes.data;
    }
    rawMasterTemplates = await fetchDeviceTemplates(masterZk);
    console.log(`[PropagateUsers] Master clock sourced: ${rawMasterUsers.length} user(s), ${rawMasterTemplates.length} fingerprint template(s).`);
  } catch (mErr) {
    console.error(`[PropagateUsers] Error reading users/templates from master clock: ${mErr.message}`);
    throw mErr;
  } finally {
    try {
      await masterZk.disconnect();
    } catch (_) {}
  }

  if (rawMasterUsers.length === 0) {
    console.warn('[PropagateUsers] Master clock returned 0 users. Aborting propagation to prevent corrupting slave devices.');
    return {
      success: false,
      reason: 'EMPTY_MASTER_USERS',
      masterId: master.id,
      masterAlias: master.alias,
      durationMs: Date.now() - startTime
    };
  }

  // 4. Ensure Master Users are upserted into MySQL employees table
  const validMasterUsers = rawMasterUsers.map(normalizeDeviceUser).filter(Boolean);
  for (const u of validMasterUsers) {
    await pool.query(
      `INSERT INTO employees (user_id, badge_number, name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = IF(name IS NULL OR name = '' OR name LIKE 'Employee %', VALUES(name), name),
         badge_number = COALESCE(badge_number, VALUES(badge_number))`,
      [u.userId, u.badgeNumber, u.name]
    );
  }

  // 5. Cache & Audit Master Templates in MySQL biometric_templates table
  if (rawMasterTemplates.length > 0) {
    const uidToUserId = new Map();
    for (const u of rawMasterUsers) {
      uidToUserId.set(u.uid, parseInt(u.userId, 10) || u.uid);
    }
    for (const t of rawMasterTemplates) {
      const userId = uidToUserId.get(t.uid) || t.uid;
      try {
        await pool.query(
          `INSERT INTO biometric_templates (user_id, uid, finger_id, valid_flag, template_size, template_data)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             template_size = VALUES(template_size),
             template_data = VALUES(template_data),
             valid_flag = VALUES(valid_flag)`,
          [userId, t.uid, t.fid, t.valid, t.template.length, t.template]
        );
      } catch (sqlErr) {
        console.warn(`[PropagateUsers] Warning saving template for user ${userId} fid ${t.fid}:`, sqlErr.message);
      }
    }
  }

  // 6. Query active slave devices
  const [slaveDevices] = await pool.query(
    `SELECT id, sn, alias, ip_address, is_master, status
     FROM devices
     WHERE status = 'active' AND id != ? AND ip_address IS NOT NULL AND ip_address != ''`,
    [master.id]
  );

  console.log(`[PropagateUsers] Master has ${rawMasterUsers.length} enrolled user(s) and ${rawMasterTemplates.length} template(s). Propagating to ${slaveDevices.length} slave clock(s)...`);

  const slaveResults = [];

  for (const slave of slaveDevices) {
    const sIpCheck = isSafeDeviceIp(slave.ip_address);
    if (!sIpCheck.valid) {
      slaveResults.push({
        deviceId: slave.id,
        deviceAlias: slave.alias,
        deviceIp: slave.ip_address,
        status: 'error',
        error: `Invalid IP: ${sIpCheck.error}`,
        usersPushed: 0,
        templatesPushed: 0
      });
      continue;
    }

    const isSlaveOnline = await probeSocket(sIpCheck.ip, 4370, probeMs);
    if (!isSlaveOnline) {
      slaveResults.push({
        deviceId: slave.id,
        deviceAlias: slave.alias,
        deviceIp: sIpCheck.ip,
        status: 'offline',
        error: `Device unreachable (timed out after ${probeMs}ms)`,
        usersPushed: 0,
        templatesPushed: 0
      });
      continue;
    }

    const slaveZk = new ZKLib(sIpCheck.ip, 4370, options.timeout || 5000, 4000);
    try {
      await slaveZk.createSocket();
      let rawSlaveUsers = [];
      let rawSlaveTemplates = [];

      try {
        const suRes = await slaveZk.getUsers();
        if (suRes && Array.isArray(suRes.data)) {
          rawSlaveUsers = suRes.data;
        }
        rawSlaveTemplates = await fetchDeviceTemplates(slaveZk);
      } catch (getErr) {
        console.warn(`[PropagateUsers] Could not read existing users/templates from slave ${slave.alias} (${sIpCheck.ip}): ${getErr.message}`);
      }

      const userDiff = diffUsers(rawMasterUsers, rawSlaveUsers);
      const tplDiff = diffTemplates(rawMasterTemplates, rawSlaveTemplates);

      const needsSync = userDiff.toAdd.length > 0 || userDiff.toUpdate.length > 0 || tplDiff.toAdd.length > 0;
      let usersPushed = 0;
      let templatesPushed = 0;

      if (needsSync) {
        try {
          await slaveZk.zklibTcp.disableDevice();
        } catch (_) {}

        // Push users and biometric templates in batches of 20
        const BATCH_SIZE = 20;
        for (let b = 0; b < rawMasterUsers.length; b += BATCH_SIZE) {
          const batchUsers = rawMasterUsers.slice(b, b + BATCH_SIZE);
          const batchUids = new Set(batchUsers.map(u => u.uid));
          const batchTemplates = rawMasterTemplates.filter(t => batchUids.has(t.uid));

          await saveUserTemplatesBatch(slaveZk, batchUsers, batchTemplates);
          usersPushed += batchUsers.length;
          templatesPushed += batchTemplates.length;
        }

        try {
          await slaveZk.zklibTcp.executeCmd(1013, ''); // CMD_REFRESHDATA
        } catch (_) {}

        try {
          await slaveZk.zklibTcp.enableDevice();
        } catch (_) {}
      }

      slaveResults.push({
        deviceId: slave.id,
        deviceAlias: slave.alias,
        deviceIp: sIpCheck.ip,
        status: 'synced',
        usersExisting: rawSlaveUsers.length,
        usersAdded: userDiff.toAdd.length,
        usersUpdated: userDiff.toUpdate.length,
        usersIdentical: userDiff.identical,
        usersPushed,
        templatesExisting: rawSlaveTemplates.length,
        templatesAdded: tplDiff.toAdd.length,
        templatesIdentical: tplDiff.identical,
        templatesPushed,
        success: true
      });
      console.log(`[PropagateUsers] Slave "${slave.alias || slave.sn}" synced: ${usersPushed} user(s), ${templatesPushed} template(s) pushed (${userDiff.identical} users & ${tplDiff.identical} templates identical).`);
    } catch (err) {
      slaveResults.push({
        deviceId: slave.id,
        deviceAlias: slave.alias,
        deviceIp: sIpCheck.ip,
        status: 'error',
        error: err.message,
        usersPushed: 0,
        templatesPushed: 0
      });
      console.error(`[PropagateUsers] Error syncing slave "${slave.alias || slave.sn}":`, err.message);
    } finally {
      try {
        await slaveZk.disconnect();
      } catch (_) {}
    }
  }

  const durationMs = Date.now() - startTime;
  return {
    success: true,
    masterId: master.id,
    masterAlias: master.alias,
    masterIp: master.ip_address,
    masterUsersCount: rawMasterUsers.length,
    masterTemplatesCount: rawMasterTemplates.length,
    slaveCount: slaveDevices.length,
    results: slaveResults,
    durationMs
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
  packUser72,
  setUserOnDevice,
  diffUsers,
  parseTemplates,
  fetchDeviceTemplates,
  diffTemplates,
  buildHRUserTemplatesPacket,
  sendBufferChunks,
  saveUserTemplatesBatch,
  propagateUsersFromMaster,
  encodeZKTime,
  decodeZKTime,
  getDeviceTime,
  setDeviceTime,
  syncDeviceTimeIfDrifted,
  syncSingleDevice,
  syncAllActiveDevices,
};
