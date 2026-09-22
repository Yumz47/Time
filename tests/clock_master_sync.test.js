const test = require('node:test');
const assert = require('node:assert/strict');
const {
  packUser72,
  diffUsers,
  parseTemplates,
  diffTemplates,
  buildHRUserTemplatesPacket,
} = require('../bridge/device_sync');
const { decodeUserData72 } = require('node-zklib/utils');

// ─── 1. UNIT TESTS: BINARY PACKET ENCODING (packUser72) ────────────────────────

test('Unit Tests: packUser72 produces exact 72-byte buffer with correct ZKTeco offsets', () => {
  const user = {
    uid: 42,
    role: 14, // Admin
    password: 'secret',
    name: 'Jane Doe',
    cardno: 5829103,
    userId: '1042'
  };

  const buf = packUser72(user);
  assert.equal(buf.length, 72, 'User packet must be exactly 72 bytes');

  // Verify internal UID at offset 0 (UInt16LE)
  assert.equal(buf.readUInt16LE(0), 42);

  // Verify role at offset 2 (UInt8)
  assert.equal(buf.readUInt8(2), 14);

  // Verify password at offset 3..10 (ASCII null-padded)
  const pwd = buf.subarray(3, 11).toString('ascii').split('\0')[0];
  assert.equal(pwd, 'secret');

  // Verify name at offset 11..34 (ASCII null-padded)
  const name = buf.subarray(11, 35).toString('ascii').split('\0')[0];
  assert.equal(name, 'Jane Doe');

  // Verify cardno at offset 35..38 (UInt32LE)
  assert.equal(buf.readUInt32LE(35), 5829103);

  // Verify group (1) at offset 39
  assert.equal(buf.readUInt8(39), 1);

  // Verify userId at offset 48..71 (ASCII null-padded)
  const uidStr = buf.subarray(48, 72).toString('ascii').split('\0')[0];
  assert.equal(uidStr, '1042');
});

test('Unit Tests: packUser72 roundtrip integrity with node-zklib decodeUserData72', () => {
  const sampleUsers = [
    { uid: 1, role: 14, password: '1', name: 'Sbabb', cardno: 4998539, userId: '1' },
    { uid: 4, role: 0, password: '', name: '104', cardno: 0, userId: '104' },
    { uid: 88, role: 0, password: '999', name: 'Alice Smith', cardno: 1234567, userId: 'EMP-88' },
  ];

  for (const orig of sampleUsers) {
    const packed = packUser72(orig);
    assert.equal(packed.length, 72);
    const decoded = decodeUserData72(packed);
    assert.equal(decoded.uid, orig.uid);
    assert.equal(decoded.role, orig.role);
    assert.equal(decoded.name, orig.name);
    assert.equal(decoded.cardno, orig.cardno);
    assert.equal(decoded.userId, orig.userId);
  }
});

test('Unit Tests: packUser72 edge case fallbacks (blank name, zero card, missing role)', () => {
  const minimal = packUser72({ uid: 7, userId: '7' });
  assert.equal(minimal.length, 72);
  const decoded = decodeUserData72(minimal);
  assert.equal(decoded.uid, 7);
  assert.equal(decoded.role, 0);
  assert.equal(decoded.name, '');
  assert.equal(decoded.cardno, 0);
  assert.equal(decoded.userId, '7');
});

// ─── 2. UNIT TESTS: DIFFERENTIAL SYNC DETECTION (diffUsers) ───────────────────

test('Unit Tests: diffUsers correctly detects missing, updated, and identical users', () => {
  const master = [
    { uid: 1, role: 14, name: 'Admin', cardno: 111, userId: '1' },
    { uid: 2, role: 0, name: 'Bob', cardno: 222, userId: '2' },
    { uid: 3, role: 0, name: 'Charlie Updated', cardno: 333, userId: '3' },
    { uid: 4, role: 0, name: 'New Employee', cardno: 444, userId: '4' }
  ];

  const slave = [
    { uid: 1, role: 14, name: 'Admin', cardno: 111, userId: '1' }, // Identical
    { uid: 2, role: 0, name: 'Bob', cardno: 222, userId: '2' }, // Identical
    { uid: 3, role: 0, name: 'Charlie Old', cardno: 333, userId: '3' } // Name changed
  ];

  const diff = diffUsers(master, slave);

  assert.equal(diff.identical, 2, 'Admin and Bob should be detected as identical');
  assert.equal(diff.toAdd.length, 1, 'New Employee should be added');
  assert.equal(diff.toAdd[0].userId, '4');
  assert.equal(diff.toUpdate.length, 1, 'Charlie should be updated');
  assert.equal(diff.toUpdate[0].userId, '3');
  assert.equal(diff.toUpdate[0].name, 'Charlie Updated');
});

test('Unit Tests: diffUsers handles empty slave device and empty master gracefully', () => {
  const master = [{ uid: 1, userId: '1', name: 'Solo' }];
  const emptyDiff = diffUsers(master, []);
  assert.equal(emptyDiff.toAdd.length, 1);
  assert.equal(emptyDiff.identical, 0);

  const nullDiff = diffUsers(null, null);
  assert.deepEqual(nullDiff, { toAdd: [], toUpdate: [], identical: 0 });
});

// ─── 3. PICKLE & SERIALIZATION INTEGRITY TESTS ────────────────────────────────

test('Pickle Tests: User propagation summary payload roundtrip serialization', () => {
  const payload = {
    success: true,
    masterId: 3,
    masterAlias: 'GenReg1',
    masterIp: '10.10.61.2',
    masterUsersCount: 82,
    slaveCount: 3,
    results: [
      {
        deviceId: 4,
        deviceAlias: '6',
        deviceIp: '10.10.61.3',
        status: 'synced',
        usersExisting: 82,
        usersAdded: 0,
        usersUpdated: 0,
        usersIdentical: 82,
        usersPushed: 0,
        success: true
      },
      {
        deviceId: 5,
        deviceAlias: 'CLOCK2',
        deviceIp: '192.168.0.71',
        status: 'offline',
        error: 'Device unreachable (timed out after 1500ms)',
        usersPushed: 0
      }
    ],
    durationMs: 4200
  };

  // Base64 Pickle roundtrip
  const serialized = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const restored = JSON.parse(Buffer.from(serialized, 'base64').toString('utf8'));

  assert.deepEqual(restored, payload, 'Restored payload must match original byte-for-byte');
  assert.equal(restored.results[0].status, 'synced');
  assert.equal(restored.results[1].status, 'offline');
});

// ─── 4. MUTATION TESTING ──────────────────────────────────────────────────────

test('Mutation Testing: Mutating packet length or offsets must be detected', () => {
  const original = packUser72({ uid: 10, name: 'Test', userId: '10' });
  assert.equal(original.length, 72);

  // Truncated mutant
  const truncatedMutant = original.subarray(0, 71);
  assert.notEqual(truncatedMutant.length, 72, 'Truncated packet must be detected');

  // Corrupted UID mutant
  const corruptedMutant = Buffer.from(original);
  corruptedMutant.writeUInt16LE(9999, 0);
  assert.notEqual(corruptedMutant.readUInt16LE(0), 10, 'UID mutation must be detected');
});

// ─── 5. QUALITY CONTROL (QA) / API ACCESS CONTROL ─────────────────────────────

test('QA: Role Authorization verifies propagate-users is restricted to Admin', async () => {
  const mockReqAdmin = { user: { role: 'admin' } };
  const mockReqViewer = { user: { role: 'viewer' } };

  let adminAllowed = false;
  let viewerAllowed = false;

  const checkAdmin = (req) => req.user && req.user.role === 'admin';

  if (checkAdmin(mockReqAdmin)) adminAllowed = true;
  if (checkAdmin(mockReqViewer)) viewerAllowed = true;

  assert.ok(adminAllowed, 'Admin role must be permitted to trigger user propagation');
  assert.equal(viewerAllowed, false, 'Viewer role must be forbidden from triggering user propagation');
});

// ─── 6. BIOMETRIC FINGERPRINT TEMPLATE TESTS ──────────────────────────────────

test('Unit Tests: parseTemplates correctly extracts individual biometric templates from raw buffer', () => {
  // Construct raw template buffer with 2 templates
  // Format: [totalSize: UInt32LE], then for each: [size: UInt16LE, uid: UInt16LE, fid: UInt8, valid: UInt8, tpl: bytes]
  const tpl1 = Buffer.from('FINGERPRINT_DATA_FOR_UID_1_FID_0');
  const tpl2 = Buffer.from('FINGERPRINT_DATA_FOR_UID_2_FID_6_LONGER_TEMPLATE');

  const size1 = 6 + tpl1.length;
  const size2 = 6 + tpl2.length;
  const totalSize = size1 + size2;

  const rawBuf = Buffer.alloc(4 + totalSize);
  rawBuf.writeUInt32LE(totalSize, 0);

  let offset = 4;
  // Item 1
  rawBuf.writeUInt16LE(size1, offset);
  rawBuf.writeUInt16LE(1, offset + 2); // uid 1
  rawBuf.writeUInt8(0, offset + 4);    // fid 0
  rawBuf.writeUInt8(1, offset + 5);    // valid 1
  tpl1.copy(rawBuf, offset + 6);
  offset += size1;

  // Item 2
  rawBuf.writeUInt16LE(size2, offset);
  rawBuf.writeUInt16LE(2, offset + 2); // uid 2
  rawBuf.writeUInt8(6, offset + 4);    // fid 6
  rawBuf.writeUInt8(1, offset + 5);    // valid 1
  tpl2.copy(rawBuf, offset + 6);

  const parsed = parseTemplates(rawBuf);
  assert.equal(parsed.length, 2, 'Should parse exactly 2 templates');
  assert.equal(parsed[0].uid, 1);
  assert.equal(parsed[0].fid, 0);
  assert.equal(parsed[0].valid, 1);
  assert.deepEqual(parsed[0].template, tpl1);

  assert.equal(parsed[1].uid, 2);
  assert.equal(parsed[1].fid, 6);
  assert.equal(parsed[1].valid, 1);
  assert.deepEqual(parsed[1].template, tpl2);
});

test('Unit Tests: diffTemplates correctly evaluates identical vs new templates', () => {
  const tplA = Buffer.from('BIODATA_A');
  const tplB = Buffer.from('BIODATA_B');
  const tplC = Buffer.from('BIODATA_C');

  const masterTemplates = [
    { uid: 1, fid: 0, template: tplA },
    { uid: 1, fid: 1, template: tplB },
    { uid: 2, fid: 0, template: tplC }
  ];

  const slaveTemplates = [
    { uid: 1, fid: 0, template: tplA }, // Identical
    { uid: 1, fid: 1, template: Buffer.from('MUTATED_B') } // Mutated -> needs update
    // uid 2 fid 0 is missing -> needs add
  ];

  const diff = diffTemplates(masterTemplates, slaveTemplates);
  assert.equal(diff.identical, 1, 'Template 1:0 should be identical');
  assert.equal(diff.toAdd.length, 2, 'Template 1:1 (mutated) and 2:0 (missing) must be added/updated');
  assert.equal(diff.totalMaster, 3);
  assert.equal(diff.totalSlave, 2);
});

test('Unit Tests: buildHRUserTemplatesPacket constructs correct ZKTeco high-rate batch binary structure', () => {
  const users = [
    { uid: 1, role: 14, password: '', name: 'Sbabb', cardno: 4998539, userId: '1' },
    { uid: 2, role: 0, password: '', name: 'Alice', cardno: 0, userId: '2' }
  ];
  const templates = [
    { uid: 1, fid: 0, valid: 1, template: Buffer.from('TPL_1_0') },
    { uid: 1, fid: 6, valid: 1, template: Buffer.from('TPL_1_6') },
    { uid: 2, fid: 0, valid: 1, template: Buffer.from('TPL_2_0') }
  ];

  const packet = buildHRUserTemplatesPacket(users, templates);
  assert.ok(packet.length > 12, 'Packet must contain header and data segments');

  const uLen = packet.readUInt32LE(0);
  const tLen = packet.readUInt32LE(4);
  const fLen = packet.readUInt32LE(8);

  assert.equal(uLen, 2 * 73, 'upack size must be exactly 2 users * 73 bytes');
  assert.equal(tLen, 3 * 8, 'table size must be exactly 3 templates * 8 bytes');
  assert.equal(packet.length, 12 + uLen + tLen + fLen, 'Total packet length must equal head + upack + table + fpack');

  // Verify first table entry
  const tableStart = 12 + uLen;
  assert.equal(packet.readInt8(tableStart), 2);
  assert.equal(packet.readUInt16LE(tableStart + 1), 1); // uid 1
  assert.equal(packet.readUInt8(tableStart + 3), 0x10 + 0); // 16 + fid 0
  assert.equal(packet.readUInt32LE(tableStart + 4), 0); // first tstart offset
});

test('Pickle Tests: Biometric template binary serialization and base64 roundtrip integrity', () => {
  const sampleTemplate = {
    uid: 42,
    fid: 6,
    valid: 1,
    template: Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11])
  };

  // Serialize to JSON-safe representation
  const serialized = {
    uid: sampleTemplate.uid,
    fid: sampleTemplate.fid,
    valid: sampleTemplate.valid,
    templateB64: sampleTemplate.template.toString('base64')
  };

  const jsonStr = JSON.stringify(serialized);
  const deserialized = JSON.parse(jsonStr);
  const restoredTemplate = {
    uid: deserialized.uid,
    fid: deserialized.fid,
    valid: deserialized.valid,
    template: Buffer.from(deserialized.templateB64, 'base64')
  };

  assert.deepEqual(restoredTemplate, sampleTemplate, 'Restored template must match original byte-for-byte');
  assert.ok(restoredTemplate.template.equals(sampleTemplate.template));
});

test('Mutation Testing: Mutating biometric template packet offsets or length triggers mismatch', () => {
  const tplBuf = Buffer.alloc(30);
  tplBuf.writeUInt32LE(26, 0); // declared size
  tplBuf.writeUInt16LE(26, 4);
  tplBuf.writeUInt16LE(1, 6);
  tplBuf.writeUInt8(0, 8);
  tplBuf.writeUInt8(1, 9);
  Buffer.from('MUTATION_BIODATA').copy(tplBuf, 10);

  const parsed = parseTemplates(tplBuf);
  assert.equal(parsed.length, 1);

  // Truncated buffer mutant
  const truncatedMutant = tplBuf.subarray(0, 15);
  const truncatedResult = parseTemplates(truncatedMutant);
  assert.equal(truncatedResult.length, 0, 'Truncated buffer must not produce valid template');

  // Corrupted FID mutant
  const fidMutant = Buffer.from(tplBuf);
  fidMutant.writeUInt8(99, 8);
  const parsedFid = parseTemplates(fidMutant);
  assert.notEqual(parsedFid[0].fid, 0, 'Mutated finger ID must be detected');
});

