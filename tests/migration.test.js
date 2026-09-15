const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { default: MDBReader } = require('mdb-reader');
const {
  mapColumnType,
  generateTableDDL,
  formatValueForMySQL,
  createPool,
} = require('../bridge/migrate_all_tables');
const { serializeRecords, deserializeRecords } = require('../bridge/helpers');

describe('Database Migration & Type Mapping Standards', () => {
  test('mapColumnType accurately maps all 8 Access types to standard MySQL types', () => {
    assert.strictEqual(mapColumnType('integer'), 'INT');
    assert.strictEqual(mapColumnType('long'), 'BIGINT');
    assert.strictEqual(mapColumnType('text'), 'VARCHAR(255)');
    assert.strictEqual(mapColumnType('memo'), 'TEXT');
    assert.strictEqual(mapColumnType('datetime'), 'DATETIME');
    assert.strictEqual(mapColumnType('boolean'), 'TINYINT(1)');
    assert.strictEqual(mapColumnType('double'), 'DOUBLE');
    assert.strictEqual(mapColumnType('numeric'), 'DECIMAL(18, 4)');
    // Fallback for unknown or custom types
    assert.strictEqual(mapColumnType('unknown_custom_blob'), 'TEXT');
  });

  test('generateTableDDL produces valid SQL with escaped column and table names', () => {
    const columns = [
      { name: 'ID', type: 'long' },
      { name: 'ORDER', type: 'integer' }, // MySQL reserved word
      { name: 'DATE', type: 'datetime' },  // MySQL reserved word
      { name: 'Notes', type: 'memo' },
      { name: 'Active', type: 'boolean' }
    ];

    const ddl = generateTableDDL('CustomLog', columns);
    assert.ok(ddl.includes('CREATE TABLE IF NOT EXISTS `CustomLog`'));
    assert.ok(ddl.includes('`ID` BIGINT DEFAULT NULL'));
    assert.ok(ddl.includes('`ORDER` INT DEFAULT NULL'));
    assert.ok(ddl.includes('`DATE` DATETIME DEFAULT NULL'));
    assert.ok(ddl.includes('`Notes` TEXT DEFAULT NULL'));
    assert.ok(ddl.includes('`Active` TINYINT(1) DEFAULT NULL'));
    assert.ok(ddl.includes('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'));
  });

  test('generateTableDDL rejects invalid or empty arguments', () => {
    assert.throws(() => generateTableDDL('', []), /Invalid table definition/);
    assert.throws(() => generateTableDDL('test', []), /Invalid table definition/);
  });

  test('formatValueForMySQL correctly sanitizes types and edge cases', () => {
    // Nulls and undefined
    assert.strictEqual(formatValueForMySQL(null, 'text'), null);
    assert.strictEqual(formatValueForMySQL(undefined, 'integer'), null);

    // Booleans
    assert.strictEqual(formatValueForMySQL(true, 'boolean'), 1);
    assert.strictEqual(formatValueForMySQL(false, 'boolean'), 0);

    // Integers / Longs
    assert.strictEqual(formatValueForMySQL('42', 'integer'), 42);
    assert.strictEqual(formatValueForMySQL(104.9, 'long'), 104);
    assert.strictEqual(formatValueForMySQL('invalid-num', 'integer'), null);

    // Floats / Doubles
    assert.strictEqual(formatValueForMySQL(12.345, 'double'), 12.345);
    assert.strictEqual(formatValueForMySQL('99.5', 'numeric'), 99.5);
    assert.strictEqual(formatValueForMySQL('nan', 'double'), null);

    // Dates
    const testDate = new Date('2026-09-15T12:00:00Z');
    assert.strictEqual(formatValueForMySQL(testDate, 'datetime'), '2026-09-15 12:00:00');

    // Strings
    assert.strictEqual(formatValueForMySQL('ZKTeco Clock', 'text'), 'ZKTeco Clock');
  });

  test('Pickle / Serialization validation on full table rows', () => {
    const sampleRecord = {
      HOLIDAYID: 1,
      HOLIDAYNAME: 'National Day',
      STARTTIME: new Date('2026-10-01T00:00:00Z'),
      DURATION: 1,
      ACTIVE: true,
      METADATA: null
    };

    const serialized = serializeRecords([sampleRecord]);
    assert.strictEqual(typeof serialized, 'string');

    const deserialized = deserializeRecords(serialized);
    assert.strictEqual(deserialized.length, 1);
    assert.strictEqual(deserialized[0].HOLIDAYID, 1);
    assert.strictEqual(deserialized[0].HOLIDAYNAME, 'National Day');
    assert.strictEqual(deserialized[0].STARTTIME, '2026-10-01T00:00:00.000Z');
    assert.strictEqual(deserialized[0].ACTIVE, true);
    assert.strictEqual(deserialized[0].METADATA, null);
  });
});

describe('Database Live Verification & QA Metrics', () => {
  let pool;

  test('MySQL connects successfully and verifies all remaining tables exist', async () => {
    pool = createPool();
    const [rows] = await pool.query('SHOW TABLES IN timeclock_db;');
    const tableNames = rows.map(r => Object.values(r)[0]);

    // Check critical remaining legacy tables exist
    const requiredTables = [
      'Machines',
      'HOLIDAYS',
      'LeaveClass',
      'LeaveClass1',
      'SchClass',
      'NUM_RUN',
      'NUM_RUN_DEIL',
      'USER_OF_RUN',
      'AttParam',
      'SystemLog',
      'EmOpLog',
      'SECURITYDETAILS',
      'TEMPLATE',
      'userinfo',
      'devices',
      'departments',
      'employees',
      'checkinout'
    ];

    for (const tbl of requiredTables) {
      assert.ok(
        tableNames.includes(tbl),
        `Expected table ${tbl} to exist in timeclock_db`
      );
    }
  });

  test('Data integrity: row counts in MySQL match or exceed legacy data', async () => {
    if (!pool) pool = createPool();

    // Verify HOLIDAYS (11 records in MDB)
    const [[{ holidayCount }]] = await pool.query('SELECT COUNT(*) AS holidayCount FROM HOLIDAYS;');
    assert.strictEqual(Number(holidayCount), 11);

    // Verify Machines (6 records in MDB)
    const [[{ machineCount }]] = await pool.query('SELECT COUNT(*) AS machineCount FROM Machines;');
    assert.strictEqual(Number(machineCount), 6);

    // Verify LeaveClass (3 records in MDB)
    const [[{ leaveCount }]] = await pool.query('SELECT COUNT(*) AS leaveCount FROM LeaveClass;');
    assert.strictEqual(Number(leaveCount), 3);

    // Verify SchClass (5 shift intervals in MDB)
    const [[{ schCount }]] = await pool.query('SELECT COUNT(*) AS schCount FROM SchClass;');
    assert.strictEqual(Number(schCount), 5);

    // Verify devices enriched with real IPs
    const [devices] = await pool.query('SELECT sn, alias, ip_address FROM devices WHERE ip_address IS NOT NULL;');
    assert.ok(devices.length >= 6, 'All 6 devices should have IP addresses populated from Machines');

    const clockOld = devices.find(d => d.alias === 'CLOCKOLD');
    assert.ok(clockOld, 'CLOCKOLD device should be present');
    assert.strictEqual(clockOld.ip_address, '192.168.0.13');

    await pool.end();
  });
});
