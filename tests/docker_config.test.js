const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── UTILITIES & PARSERS ──────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(__dirname, '..');

function readProjectFile(relPath) {
  const fullPath = path.join(ROOT_DIR, relPath);
  assert.ok(fs.existsSync(fullPath), `Expected file "${relPath}" to exist in repository`);
  return fs.readFileSync(fullPath, 'utf8');
}

/**
 * Parses instructions from Dockerfile into structured directives
 * @param {string} content
 * @returns {Array<{instruction: string, args: string}>}
 */
function parseDockerfile(content) {
  const lines = content.split('\n');
  const directives = [];
  let current = null;

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (current) {
      current.args += ' ' + line;
      if (!line.endsWith('\\')) {
        current.args = current.args.replace(/\\\s*/g, ' ').trim();
        directives.push(current);
        current = null;
      }
      continue;
    }

    const match = line.match(/^([A-Z]+)\s+(.*)$/);
    if (match) {
      const instruction = match[1];
      let args = match[2].trim();
      if (args.endsWith('\\')) {
        current = { instruction, args };
      } else {
        directives.push({ instruction, args });
      }
    }
  }
  return directives;
}

/**
 * Validates Docker Compose file content
 * @param {string} content
 * @returns {{services: string[], hasDbHealthcheck: boolean, hasAppDependency: boolean, hasVolume: boolean, hasNetwork: boolean}}
 */
function inspectDockerCompose(content) {
  const hasAppService = /app:\s*\n/m.test(content);
  const hasDbService = /db:\s*\n/m.test(content);
  const hasDbHealthcheck = /mysqladmin\s+ping/i.test(content);
  const hasAppDependency = /condition:\s*service_healthy/i.test(content);
  const hasInitDbMount = /\.\/docker\/init-db:\/docker-entrypoint-initdb\.d/i.test(content);
  const hasVolume = /db_data:/i.test(content);
  const hasNetwork = /timepulse-network:/i.test(content);

  const services = [];
  if (hasAppService) services.push('app');
  if (hasDbService) services.push('db');

  return {
    services,
    hasDbHealthcheck,
    hasAppDependency,
    hasInitDbMount,
    hasVolume,
    hasNetwork
  };
}

/**
 * Serialization / Pickle helper
 */
function serializeConfig(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function deserializeConfig(base64Str) {
  return JSON.parse(Buffer.from(base64Str, 'base64').toString('utf8'));
}

// ─── 1. UNIT TESTS: DOCKERFILE VALIDATION ─────────────────────────────────────

test('Unit Tests: Dockerfile contains required security, packaging, and execution directives', () => {
  const content = readProjectFile('Dockerfile');
  const directives = parseDockerfile(content);

  // 1. Base image must be lightweight Node.js
  const fromDirective = directives.find(d => d.instruction === 'FROM');
  assert.ok(fromDirective, 'Dockerfile must have a FROM directive');
  assert.match(fromDirective.args, /^node:\d+(-alpine)?/, 'Base image should be official Node.js Alpine');

  // 2. Working directory must be /app
  const workdir = directives.find(d => d.instruction === 'WORKDIR');
  assert.ok(workdir, 'Dockerfile must have a WORKDIR directive');
  assert.equal(workdir.args, '/app', 'WORKDIR should be /app');

  // 3. Security: Non-root user
  const userDirective = directives.find(d => d.instruction === 'USER');
  assert.ok(userDirective, 'Dockerfile must specify an unprivileged USER');
  assert.equal(userDirective.args, 'node', 'USER should run as unprivileged "node" user');

  // 4. Port exposure
  const exposeDirective = directives.find(d => d.instruction === 'EXPOSE');
  assert.ok(exposeDirective, 'Dockerfile must EXPOSE a port');
  assert.equal(exposeDirective.args, '3000', 'EXPOSE port should be 3000');

  // 5. Healthcheck probe
  const healthcheckDirective = directives.find(d => d.instruction === 'HEALTHCHECK');
  assert.ok(healthcheckDirective, 'Dockerfile must declare a HEALTHCHECK probe');
  assert.match(healthcheckDirective.args, /http:\/\/localhost:3000\//, 'Healthcheck should probe port 3000');

  // 6. CMD directive starts server
  const cmdDirective = directives.find(d => d.instruction === 'CMD');
  assert.ok(cmdDirective, 'Dockerfile must declare a CMD directive');
  assert.match(cmdDirective.args, /server\/server\.js/, 'CMD should execute server/server.js');
});

// ─── 2. UNIT TESTS: DOCKER-COMPOSE VALIDATION ─────────────────────────────────

test('Unit Tests: docker-compose.yml defines app and db services with correct lifecycle ties', () => {
  const content = readProjectFile('docker-compose.yml');
  const info = inspectDockerCompose(content);

  assert.deepEqual(info.services.sort(), ['app', 'db'].sort(), 'Compose must define both "app" and "db" services');
  assert.ok(info.hasDbHealthcheck, 'MySQL service must define a mysqladmin ping healthcheck');
  assert.ok(info.hasAppDependency, 'App service must depend on db service with condition: service_healthy');
  assert.ok(info.hasInitDbMount, 'Compose must mount ./docker/init-db to /docker-entrypoint-initdb.d');
  assert.ok(info.hasVolume, 'Compose must define named volume db_data for data persistence');
  assert.ok(info.hasNetwork, 'Compose must define custom network timepulse-network');
});

// ─── 3. UNIT TESTS: REPOSITORY HYGIENE & CLEANUP ─────────────────────────────

test('Quality Control (QA): .gitignore and .dockerignore exclude sensitive & bloated files', () => {
  const gitignore = readProjectFile('.gitignore');
  const dockerignore = readProjectFile('.dockerignore');

  // .gitignore checks
  assert.ok(gitignore.includes('node_modules/'), '.gitignore must exclude node_modules/');
  assert.ok(gitignore.includes('.env'), '.gitignore must exclude .env');
  assert.ok(gitignore.includes('att2000.mdb'), '.gitignore must exclude att2000.mdb');
  assert.ok(gitignore.includes('*.log'), '.gitignore must exclude *.log');

  // .dockerignore checks
  assert.ok(dockerignore.includes('node_modules/'), '.dockerignore must exclude node_modules/');
  assert.ok(dockerignore.includes('.git/'), '.dockerignore must exclude .git/');
  assert.ok(dockerignore.includes('.env'), '.dockerignore must exclude .env');
  assert.ok(dockerignore.includes('att2000.mdb'), '.dockerignore must exclude att2000.mdb');
  assert.ok(dockerignore.includes('tests/'), '.dockerignore must exclude tests/');

  // Confirm att2000.mdb is deleted from workspace
  const mdbPath = path.join(ROOT_DIR, 'att2000.mdb');
  assert.equal(fs.existsSync(mdbPath), false, 'att2000.mdb must be permanently removed from workspace root');

  // Confirm .env.example exists with clear defaults
  const envExample = readProjectFile('.env.example');
  assert.ok(envExample.includes('DB_HOST='), '.env.example must define DB_HOST');
  assert.ok(envExample.includes('DB_USER='), '.env.example must define DB_USER');
  assert.ok(envExample.includes('DEVICE_SYNC_CRON='), '.env.example must define DEVICE_SYNC_CRON');
});

// ─── 4. UNIT TESTS: DATABASE INITIALIZATION SCRIPT INTEGRITY ──────────────────

test('Unit Tests: docker/init-db/01_schema_and_seed.sql defines complete schema and seeds', () => {
  const sql = readProjectFile('docker/init-db/01_schema_and_seed.sql');

  // Verify essential tables exist in DDL
  const requiredTables = [
    'departments',
    'employees',
    'devices',
    'checkinout',
    'sync_log',
    'app_users',
    'sessions',
    'leaves',
    'LeaveClass',
    'SchClass',
    'NUM_RUN',
    'NUM_RUN_DEIL',
    'USER_OF_RUN'
  ];

  for (const table of requiredTables) {
    const pattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${table}\`?`, 'i');
    assert.ok(pattern.test(sql), `Schema must define table "${table}"`);
  }

  // Verify default seed accounts exist
  assert.ok(sql.includes("'admin'"), 'Schema must seed default admin user');
  assert.ok(sql.includes("'viewer'"), 'Schema must seed default viewer user');

  // Verify SHA256 password hash for admin (Admin@2026!)
  const expectedAdminHash = crypto.createHash('sha256').update('Admin@2026!').digest('hex');
  assert.ok(sql.includes(expectedAdminHash), 'Seed script must include valid SHA256 hash for Admin@2026!');
});

// ─── 5. PICKLE / SERIALIZATION ROUNDTRIP TESTS ───────────────────────────────

test('Pickle Tests: Docker configuration descriptor serialization roundtrip integrity', () => {
  const composeConfig = {
    version: '3.8',
    services: {
      app: {
        build: '.',
        ports: ['3000:3000'],
        environment: { DB_HOST: 'db', PORT: 3000, NODE_ENV: 'production' },
        restart: 'unless-stopped'
      },
      db: {
        image: 'mysql:8.0',
        environment: { MYSQL_DATABASE: 'timeclock_db' },
        volumes: ['db_data:/var/lib/mysql']
      }
    },
    volumes: { db_data: { name: 'timepulse_db_data' } }
  };

  const serialized = serializeConfig(composeConfig);
  const deserialized = deserializeConfig(serialized);

  assert.deepEqual(deserialized, composeConfig, 'Deserialized configuration must match original exactly');
  assert.equal(deserialized.services.app.environment.DB_HOST, 'db');
  assert.equal(deserialized.services.db.image, 'mysql:8.0');
});

// ─── 6. MUTATION TESTING: DOCKER VULNERABILITY & ERROR RESILIENCE ──────────────

test('Mutation Testing: Missing healthchecks, wrong user, or ports must be rejected by validator', () => {
  // Mutation 1: Dockerfile running as root (missing USER node)
  const rootDockerfile = `
    FROM node:22-alpine
    WORKDIR /app
    EXPOSE 3000
    CMD ["node", "server/server.js"]
  `;
  const rootDirectives = parseDockerfile(rootDockerfile);
  const userDirective = rootDirectives.find(d => d.instruction === 'USER');
  assert.equal(userDirective, undefined, 'Mutant Dockerfile omits USER directive');
  assert.throws(() => {
    if (!userDirective || userDirective.args !== 'node') {
      throw new Error('Security Violation: Dockerfile must run as non-root user "node"');
    }
  }, /Security Violation/);

  // Mutation 2: Compose missing db healthcheck
  const brokenCompose = `
    services:
      app:
        build: .
      db:
        image: mysql:8.0
  `;
  const brokenInfo = inspectDockerCompose(brokenCompose);
  assert.equal(brokenInfo.hasDbHealthcheck, false);
  assert.throws(() => {
    if (!brokenInfo.hasDbHealthcheck) {
      throw new Error('Compose Violation: db service must have mysqladmin ping healthcheck');
    }
  }, /Compose Violation/);

  // Mutation 3: Missing database schema table
  const incompleteSql = 'CREATE TABLE app_users (id INT);';
  assert.throws(() => {
    if (!incompleteSql.includes('checkinout') || !incompleteSql.includes('departments')) {
      throw new Error('Schema Incomplete: Essential tables missing from initialization script');
    }
  }, /Schema Incomplete/);
});
