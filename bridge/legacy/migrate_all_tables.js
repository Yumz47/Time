/**
 * Migration Script: Migrate all remaining tables from legacy Access database (att2000.mdb) to MySQL
 * 
 * Features:
 * - Robust type mapping from MDB to MySQL types (utf8mb4)
 * - Safe reserved keyword escaping with backticks
 * - Chunked batch insertions with parameterized queries
 * - Full metadata synchronization between legacy 'Machines' and MySQL 'devices'
 * - Exportable modular functions for unit testing and QA validation
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const mysql = require('mysql2/promise');
const { default: MDBReader } = require('mdb-reader');
const { formatMySQLDateTime } = require('./helpers');

/**
 * Maps Access/MDB column type to standard MySQL data type
 * @param {string} mdbType
 * @returns {string}
 */
function mapColumnType(mdbType) {
  switch (String(mdbType).toLowerCase()) {
    case 'integer':
      return 'INT';
    case 'long':
      return 'BIGINT';
    case 'text':
      return 'VARCHAR(255)';
    case 'memo':
      return 'TEXT';
    case 'datetime':
      return 'DATETIME';
    case 'boolean':
      return 'TINYINT(1)';
    case 'double':
      return 'DOUBLE';
    case 'numeric':
      return 'DECIMAL(18, 4)';
    default:
      return 'TEXT';
  }
}

/**
 * Generates CREATE TABLE IF NOT EXISTS DDL for a given table and its columns
 * @param {string} tableName
 * @param {Array<{name: string, type: string}>} columns
 * @returns {string}
 */
function generateTableDDL(tableName, columns) {
  if (!tableName || !Array.isArray(columns) || columns.length === 0) {
    throw new Error(`Invalid table definition for ${tableName}`);
  }

  const colDefs = columns.map(c => {
    const colName = `\`${c.name}\``;
    const colType = mapColumnType(c.type);
    return `  ${colName} ${colType} DEFAULT NULL`;
  });

  return [
    `CREATE TABLE IF NOT EXISTS \`${tableName}\` (`,
    colDefs.join(',\n'),
    `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`
  ].join('\n');
}

/**
 * Prepares and sanitizes a single value for MySQL insertion
 * @param {any} val
 * @param {string} colType
 * @returns {any}
 */
function formatValueForMySQL(val, colType) {
  if (val === null || val === undefined) {
    return null;
  }

  if (val instanceof Date) {
    return formatMySQLDateTime(val);
  }

  const type = String(colType).toLowerCase();
  if (type === 'datetime') {
    return formatMySQLDateTime(val);
  }

  if (type === 'boolean') {
    return val ? 1 : 0;
  }

  if (type === 'integer' || type === 'long') {
    const num = Number(val);
    return isNaN(num) ? null : Math.trunc(num);
  }

  if (type === 'double' || type === 'numeric') {
    const num = Number(val);
    return isNaN(num) ? null : num;
  }

  return String(val);
}

/**
 * Creates MySQL connection pool
 * @param {Object} [customConfig]
 */
function createPool(customConfig = {}) {
  return mysql.createPool({
    host: customConfig.host || process.env.DB_HOST || '127.0.0.1',
    port: parseInt(customConfig.port || process.env.DB_PORT || '3306', 10),
    user: customConfig.user || process.env.DB_USER || 'timeclock_user',
    password: customConfig.password || process.env.DB_PASSWORD || 'TimeClock@2026!',
    database: customConfig.database || process.env.DB_NAME || 'timeclock_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });
}

/**
 * Migrates a single table from MDBReader into MySQL
 * @param {import('mysql2/promise').Connection} conn
 * @param {MDBReader} reader
 * @param {string} tableName
 * @param {string} [targetTableName] - Optional override table name in MySQL
 * @param {Object} [options]
 * @returns {Promise<{tableName: string, rowsRead: number, rowsInserted: number}>}
 */
async function migrateTable(conn, reader, tableName, targetTableName = null, options = {}) {
  const finalTableName = targetTableName || tableName;
  const table = reader.getTable(tableName);
  const cols = table.getColumns();
  const ddl = generateTableDDL(finalTableName, cols);

  if (options.verbose) {
    console.log(`[Migration] Creating table ${finalTableName}...`);
  }
  await conn.query(ddl);

  const rawRows = table.getData();
  if (rawRows.length === 0) {
    if (options.verbose) {
      console.log(`[Migration] Table ${finalTableName} has 0 rows. Schema created.`);
    }
    return { tableName: finalTableName, rowsRead: 0, rowsInserted: 0 };
  }

  const colNames = cols.map(c => c.name);
  const escapedColList = colNames.map(c => `\`${c}\``).join(', ');

  const BATCH_SIZE = options.batchSize || 500;
  let totalInserted = 0;

  for (let i = 0; i < rawRows.length; i += BATCH_SIZE) {
    const chunk = rawRows.slice(i, i + BATCH_SIZE);
    const valuesBatch = chunk.map(row => {
      return cols.map(c => formatValueForMySQL(row[c.name], c.type));
    });

    const insertSql = `INSERT IGNORE INTO \`${finalTableName}\` (${escapedColList}) VALUES ?`;
    const [result] = await conn.query(insertSql, [valuesBatch]);
    totalInserted += (result && result.affectedRows) ? result.affectedRows : 0;
  }

  if (options.verbose) {
    console.log(`[Migration] Table ${finalTableName}: ${rawRows.length} read, ${totalInserted} inserted.`);
  }

  return {
    tableName: finalTableName,
    rowsRead: rawRows.length,
    rowsInserted: totalInserted,
  };
}

/**
 * Synchronizes and enriches the MySQL 'devices' table using records from legacy 'Machines'
 * @param {import('mysql2/promise').Connection} conn
 * @param {MDBReader} reader
 * @returns {Promise<{updatedCount: number}>}
 */
async function syncDevicesFromMachines(conn, reader) {
  if (!reader.getTableNames().includes('Machines')) {
    return { updatedCount: 0 };
  }

  const machines = reader.getTable('Machines').getData();
  let updatedCount = 0;

  for (const m of machines) {
    if (!m.sn) continue;

    const sn = String(m.sn).trim();
    const alias = m.MachineAlias ? String(m.MachineAlias).trim() : `Device ${sn}`;
    const ip = m.IP ? String(m.IP).trim() : null;
    const model = m.ProductType ? `ZKTeco ${m.ProductType}` : 'ZKTeco';
    const location = m.ProductType ? String(m.ProductType) : null;
    const status = m.Enabled ? 'active' : 'inactive';

    const [res] = await conn.query(
      `INSERT INTO devices (sn, alias, ip_address, location, model, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         alias = VALUES(alias),
         ip_address = VALUES(ip_address),
         location = COALESCE(VALUES(location), location),
         model = VALUES(model),
         status = VALUES(status)`,
      [sn, alias, ip, location, model, status]
    );

    if (res && res.affectedRows > 0) {
      updatedCount++;
    }
  }

  return { updatedCount };
}

/**
 * Executes full migration of all tables from MDB to MySQL
 * @param {Object} [options]
 * @returns {Promise<{success: boolean, tablesMigrated: Array<Object>, devicesEnriched: number, totalDurationMs: number}>}
 */
async function runFullMigration(options = {}) {
  const startTime = Date.now();
  const dbPath = options.dbPath || process.env.ACCESS_DB_PATH || path.resolve(__dirname, '../att2000.mdb');

  console.log(`=== Starting Full Database Migration ===`);
  console.log(`Source MDB: ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Access database file not found at ${dbPath}`);
  }

  const fileBuffer = fs.readFileSync(dbPath);
  const reader = new MDBReader(fileBuffer);
  const allMdbTables = reader.getTableNames();
  console.log(`Found ${allMdbTables.length} tables in Access database.`);

  const pool = createPool(options.dbConfig);
  const conn = await pool.getConnection();

  const results = [];

  try {
    for (const mdbTable of allMdbTables) {
      // Map table names appropriately:
      // USERINFO -> userinfo (keeping employees intact)
      // CHECKINOUT -> checkinout_legacy (keeping checkinout intact)
      // DEPARTMENTS -> departments_legacy (keeping departments intact)
      let targetName = mdbTable;
      if (mdbTable === 'USERINFO') {
        targetName = 'userinfo';
      } else if (mdbTable === 'CHECKINOUT') {
        targetName = 'checkinout_legacy';
      } else if (mdbTable === 'DEPARTMENTS') {
        targetName = 'departments_legacy';
      }

      console.log(`[Migrating] ${mdbTable} -> \`${targetName}\`...`);
      const stat = await migrateTable(conn, reader, mdbTable, targetName, {
        batchSize: 500,
        verbose: true,
      });
      results.push(stat);
    }

    // Enrich devices table with Machines metadata
    console.log(`[Sync] Enriching devices table from Machines table...`);
    const deviceSyncStat = await syncDevicesFromMachines(conn, reader);
    console.log(`[Sync] Enriched ${deviceSyncStat.updatedCount} devices.`);

    const durationMs = Date.now() - startTime;
    console.log(`=== Migration Completed Successfully in ${(durationMs / 1000).toFixed(2)}s ===`);

    return {
      success: true,
      tablesMigrated: results,
      devicesEnriched: deviceSyncStat.updatedCount,
      totalDurationMs: durationMs,
    };
  } catch (error) {
    console.error(`[Migration Error]:`, error);
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

// CLI Execution
if (require.main === module) {
  runFullMigration()
    .then(() => {
      console.log('Done!');
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal Migration Failure:', err);
      process.exit(1);
    });
}

module.exports = {
  mapColumnType,
  generateTableDDL,
  formatValueForMySQL,
  createPool,
  migrateTable,
  syncDevicesFromMachines,
  runFullMigration,
};
