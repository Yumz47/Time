/**
 * Security utilities, cryptographic helpers, input sanitizers,
 * and security middleware for the TimePulse platform.
 */

const crypto = require('crypto');

// ─── 1. PASSWORD CRYPTOGRAPHY (SCRYPT + LEGACY SHA-256 COMPATIBILITY) ──────

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/**
 * Derives a secure password hash using scrypt with a unique random salt
 * @param {string} password
 * @param {Buffer} [salt] - Optional salt for deterministic testing
 * @returns {string} Encoded hash string: scrypt$16384$8$1$<saltHex>$<hashHex>
 */
function hashPassword(password, salt = null) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const saltBuf = salt || crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(password, saltBuf, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 32 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltBuf.toString('hex')}$${derivedKey.toString('hex')}`;
}

/**
 * Legacy SHA-256 hash calculation (for verification and upgrade only)
 * @param {string} password
 * @returns {string} 64-character hex string
 */
function legacySha256(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

/**
 * Constant-time string equality check
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a plaintext password against a stored hash (scrypt or legacy SHA-256).
 * @param {string} password
 * @param {string} storedHash
 * @returns {{ valid: boolean, needsUpgrade: boolean }}
 */
function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return { valid: false, needsUpgrade: false };

  // Handle scrypt hash format
  if (storedHash.startsWith('scrypt$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 6) return { valid: false, needsUpgrade: false };

    const [, nStr, rStr, pStr, saltHex, expectedHashHex] = parts;
    const n = parseInt(nStr, 10);
    const r = parseInt(rStr, 10);
    const p = parseInt(pStr, 10);
    const saltBuf = Buffer.from(saltHex, 'hex');

    try {
      const derivedKey = crypto.scryptSync(password, saltBuf, Buffer.from(expectedHashHex, 'hex').length, {
        N: n,
        r,
        p,
        maxmem: 64 * 1024 * 1024,
      });
      const valid = constantTimeEqual(derivedKey.toString('hex'), expectedHashHex);
      return { valid, needsUpgrade: false };
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }

  // Handle legacy SHA-256 hash (64 hex characters)
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const computed = legacySha256(password);
    const valid = constantTimeEqual(computed.toLowerCase(), storedHash.toLowerCase());
    return { valid, needsUpgrade: valid }; // Needs upgrade to scrypt if valid
  }

  return { valid: false, needsUpgrade: false };
}

// ─── 2. SSRF & DEVICE IP SANITIZATION ───────────────────────────────────────

/**
 * Validates whether an IP address is a safe destination for hardware clock socket communication.
 * Blocks loopback, link-local / cloud metadata (169.254.169.254), multicast, broadcast, and invalid formats.
 * @param {string} ipStr
 * @returns {{ valid: boolean, error?: string, ip?: string }}
 */
function isSafeDeviceIp(ipStr) {
  if (!ipStr || typeof ipStr !== 'string') {
    return { valid: false, error: 'IP address must be a non-empty string' };
  }
  const cleanIp = ipStr.trim();

  // Validate strict IPv4 format
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = cleanIp.match(ipv4Regex);
  if (!match) {
    return { valid: false, error: 'Invalid IPv4 address format' };
  }

  const octets = [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10), parseInt(match[4], 10)];
  for (const octet of octets) {
    if (octet < 0 || octet > 255) {
      return { valid: false, error: 'IPv4 octets must be between 0 and 255' };
    }
  }

  // 1. Block loopback (127.0.0.0/8)
  if (octets[0] === 127) {
    return { valid: false, error: 'Loopback IP addresses (127.0.0.0/8) are not permitted' };
  }

  // 2. Block link-local / cloud metadata service (169.254.0.0/16 - AWS/GCP/Azure 169.254.169.254)
  if (octets[0] === 169 && octets[1] === 254) {
    return { valid: false, error: 'Link-local / cloud metadata IP addresses (169.254.0.0/16) are not permitted' };
  }

  // 3. Block unspecified / current network (0.0.0.0/8)
  if (octets[0] === 0) {
    return { valid: false, error: 'Unspecified network address (0.0.0.0/8) is not permitted' };
  }

  // 4. Block multicast (224.0.0.0/4) and broadcast (255.255.255.255)
  if (octets[0] >= 224) {
    return { valid: false, error: 'Multicast and reserved addresses (>= 224.0.0.0) are not permitted' };
  }

  return { valid: true, ip: cleanIp };
}

// ─── 3. CSV FORMULA & INJECTION DEFENSES ────────────────────────────────────

/**
 * Sanitizes cell values for CSV export to prevent spreadsheet formula injection (Excel / Calc macro injection)
 * Any value beginning with =, +, -, @, \t, \r is prefixed with a single apostrophe (') to force text mode.
 * Double quotes are escaped as "".
 * @param {any} value
 * @returns {string} Quoted safe CSV string
 */
function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  let str = String(value);

  // If first character is a formula trigger, neutralize with leading single quote
  const formulaTriggers = ['=', '+', '-', '@', '\t', '\r'];
  if (str.length > 0 && formulaTriggers.includes(str.charAt(0))) {
    str = `'${str}`;
  }

  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Validates a YYYY-MM-DD date string to prevent HTTP header splitting / CRLF injection in Content-Disposition
 * @param {string} dateStr
 * @returns {string} Sanitized date string
 */
function sanitizeFilenameDate(dateStr) {
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    return dateStr.trim();
  }
  return 'report';
}

// ─── 4. RATE LIMITER (IN-MEMORY SLIDING WINDOW) ─────────────────────────────

/**
 * Creates an Express rate limiter middleware for authentication endpoints
 * @param {Object} options
 * @param {number} [options.windowMs=300000] - 5 minutes
 * @param {number} [options.maxAttempts=10] - Max failed attempts per window
 * @returns {Function} Express middleware with .reset(key) method
 */
function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 5 * 60 * 1000;
  const maxAttempts = options.maxAttempts || 10;
  const attempts = new Map();

  const middleware = (req, res, next) => {
    // In automated testing with mock credentials, allow test environment bypass if configured
    if (process.env.DISABLE_RATE_LIMIT === 'true') {
      return next();
    }

    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const record = attempts.get(clientIp);

    if (record) {
      // Filter out timestamps outside sliding window
      record.timestamps = record.timestamps.filter(ts => now - ts < windowMs);
      if (record.timestamps.length >= maxAttempts) {
        const retryAfter = Math.ceil((record.timestamps[0] + windowMs - now) / 1000);
        res.setHeader('Retry-After', Math.max(retryAfter, 1));
        return res.status(429).json({
          error: 'Too many failed login attempts. Please try again later.',
          retryAfterSeconds: Math.max(retryAfter, 1)
        });
      }
    }

    // Attach tracker to request so route can register a failure or success
    req.registerAuthFailure = () => {
      const cur = attempts.get(clientIp) || { timestamps: [] };
      cur.timestamps.push(Date.now());
      attempts.set(clientIp, cur);
    };

    req.registerAuthSuccess = () => {
      attempts.delete(clientIp);
    };

    next();
  };

  middleware.reset = (clientIp) => {
    if (clientIp) {
      attempts.delete(clientIp);
    } else {
      attempts.clear();
    }
  };

  middleware.getAttempts = (clientIp) => {
    const record = attempts.get(clientIp);
    if (!record) return 0;
    const now = Date.now();
    return record.timestamps.filter(ts => now - ts < windowMs).length;
  };

  return middleware;
}

// ─── 5. SECURITY HEADERS MIDDLEWARE ─────────────────────────────────────────

/**
 * Standard HTTP security headers middleware (clickjacking, MIME sniffing, CSP)
 */
function securityHeadersMiddleware(req, res, next) {
  // Hide Express server footprint
  res.removeHeader('X-Powered-By');

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent framing (Clickjacking protection)
  res.setHeader('X-Frame-Options', 'DENY');

  // Strict referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Content Security Policy
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'"
  );

  next();
}

// ─── 6. SAFE ERROR SANITIZATION ─────────────────────────────────────────────

/**
 * Sanitizes server error messages to prevent exposing database internals, SQL queries, or file paths
 * @param {Error|any} err
 * @returns {string}
 */
function sanitizeErrorMessage(err) {
  if (!err) return 'An unexpected error occurred';
  const msg = err.message ? String(err.message) : String(err);

  // Preserve benign client/validation errors
  if (
    msg.includes('required') ||
    msg.includes('not found') ||
    msg.includes('already exists') ||
    msg.includes('Invalid') ||
    msg.includes('must be') ||
    msg.includes('Cannot delete')
  ) {
    return msg;
  }

  // Log full error securely server-side
  console.error('[ServerError]', err);

  // Return generic error to client
  return 'An internal database or server error occurred. Please contact the administrator.';
}

module.exports = {
  hashPassword,
  legacySha256,
  verifyPassword,
  constantTimeEqual,
  isSafeDeviceIp,
  sanitizeCsvCell,
  sanitizeFilenameDate,
  createRateLimiter,
  securityHeadersMiddleware,
  sanitizeErrorMessage,
};
