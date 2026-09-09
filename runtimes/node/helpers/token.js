/**
 * token.js — Nodaic Token System
 *
 * Token format: 256 uppercase hex chars (alphanumeric only, no special characters).
 *
 * Binary layout (128 bytes → 256 hex chars):
 *   [0]      role      : 0x00=admin  0x01=device
 *   [1]      version   : 0x01
 *   [2]      context   : 0x00=api  0x01=session  0x02=otp
 *   [3]      reserved  : 0x00
 *   [4-7]    epoch     : uint32 BE
 *   [8-11]   expiry    : uint32 BE (unix seconds)
 *   [12-31]  keyId     : UTF-8, null-padded to 20 bytes
 *   [32-95]  nonce     : 64 random bytes (uniqueness)
 *   [96-127] HMAC-SHA256 : over bytes [0..95]
 *
 * Validation returns role directly — no string parsing needed.
 */

'use strict';

const crypto = require('crypto');

/* ─── Constants ──────────────────────────────────────────────────── */

const TOKEN_CONTEXTS = {
    OTP:     'auth:otp',
    SESSION: 'auth:session',
    API:     'auth:api'
};

const ROLE_ENCODE = { admin: 0x00, device: 0x01 };
const ROLE_DECODE = { 0x00: 'admin', 0x01: 'device' };
const CTX_ENCODE  = { 'auth:api': 0x00, 'auth:session': 0x01, 'auth:otp': 0x02 };

const TOKEN_BYTES = 128;
const KEYID_BYTES = 20;  // max keyId field width
const NONCE_BYTES = 64;
const HMAC_OFFSET = 96;  // bytes 96-127

/* ─── Internal ───────────────────────────────────────────────────── */

function _hmac(secret, data) {
    return crypto.createHmac('sha256', secret).update(data).digest();
}

function _encodeToken(role, context, epoch, expiresAt, keyId, rootSecret) {
    const buf = Buffer.alloc(TOKEN_BYTES, 0);

    buf[0] = ROLE_ENCODE[role] ?? 0xFF;
    buf[1] = 0x01;
    buf[2] = CTX_ENCODE[context] ?? 0xFF;
    buf[3] = 0x00;
    buf.writeUInt32BE(epoch >>> 0, 4);
    buf.writeUInt32BE(expiresAt >>> 0, 8);
    Buffer.from(String(keyId), 'utf8').subarray(0, KEYID_BYTES).copy(buf, 12);
    crypto.randomBytes(NONCE_BYTES).copy(buf, 32);
    _hmac(rootSecret, buf.subarray(0, HMAC_OFFSET)).copy(buf, HMAC_OFFSET);

    return buf.toString('hex').toUpperCase();
}

/* ─── Public API ─────────────────────────────────────────────────── */

/**
 * Validate any 256-char hex token.
 * Returns { valid, role, keyId, id, epoch, expiresAt } on success.
 * Returns { valid: false, error } on failure.
 *
 * @param {string} token
 * @param {string} rootSecret
 * @param {string} context   - TOKEN_CONTEXTS.API / SESSION / OTP
 * @param {number} epoch     - minimum valid epoch
 * @returns {Promise<Object>}
 */
async function validateToken(token, rootSecret, context, epoch = 1) {
    if (typeof token !== 'string' || token.length !== 256) {
        return { valid: false, error: 'Invalid token length' };
    }
    if (!/^[0-9A-Fa-f]{256}$/.test(token)) {
        return { valid: false, error: 'Invalid token characters' };
    }

    const buf      = Buffer.from(token, 'hex');
    const expected = _hmac(rootSecret, buf.subarray(0, HMAC_OFFSET));
    const provided = buf.subarray(HMAC_OFFSET, TOKEN_BYTES);

    if (!crypto.timingSafeEqual(expected, provided)) {
        return { valid: false, error: 'Invalid signature' };
    }

    const roleCode = buf[0];
    const ctxCode  = buf[2];
    const tokenEpoch = buf.readUInt32BE(4);
    const expiry     = buf.readUInt32BE(8);
    const keyId      = buf.subarray(12, 12 + KEYID_BYTES).toString('utf8').replace(/\0+$/, '');
    const role       = ROLE_DECODE[roleCode];

    if (!role) {
        return { valid: false, error: 'Unknown role code' };
    }

    // Context check (if caller passes a known context)
    const expectedCtxCode = CTX_ENCODE[context];
    if (expectedCtxCode !== undefined && ctxCode !== expectedCtxCode) {
        return { valid: false, error: 'Context mismatch' };
    }

    if (tokenEpoch < epoch) {
        return { valid: false, error: 'Token epoch revoked' };
    }

    if (Math.floor(Date.now() / 1000) > expiry) {
        return { valid: false, error: 'Token expired' };
    }

    return {
        valid: true,
        role,
        keyId,
        id: `${role}:${keyId}`,   // kept for any legacy readers
        epoch: tokenEpoch,
        expiresAt: expiry
    };
}

/**
 * Generate API key — 256 alphanumeric hex chars.
 * @param {string} rootSecret
 * @param {string} id           - 'role:keyId'  (e.g. 'admin:boot')
 * @param {number} epoch
 * @param {number} expiresInSeconds  (default: 90 days)
 * @returns {Promise<string>} 256-char uppercase hex token
 */
async function generateAPIKey(rootSecret, id, epoch = 1, expiresInSeconds = 90 * 24 * 60 * 60) {
    const sep  = id.indexOf(':');
    const role = sep > 0 ? id.slice(0, sep) : id;
    const keyId = sep > 0 ? id.slice(sep + 1) : '';
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    return _encodeToken(role, TOKEN_CONTEXTS.API, epoch, expiresAt, keyId, rootSecret);
}

/**
 * Generate session token — 256 alphanumeric hex chars.
 * @param {string} rootSecret
 * @param {string} id           - 'role:keyId'
 * @param {number} epoch
 * @param {number} expiresInSeconds  (default: 24 h)
 * @returns {Promise<string>}
 */
async function generateSessionToken(rootSecret, id, epoch = 1, expiresInSeconds = 86400) {
    const sep  = id.indexOf(':');
    const role = sep > 0 ? id.slice(0, sep) : id;
    const keyId = sep > 0 ? id.slice(sep + 1) : '';
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    return _encodeToken(role, TOKEN_CONTEXTS.SESSION, epoch, expiresAt, keyId, rootSecret);
}

/**
 * Generate OTP — returns a 6-digit numeric code plus the full 256-char token.
 * @param {string} rootSecret
 * @param {string} id   - identifier (role:keyId or plain string)
 * @param {number} epoch
 * @returns {Promise<{ code: string, fullToken: string, expiresIn: number }>}
 */
async function generateOTP(rootSecret, id, epoch = 1) {
    const now        = Math.floor(Date.now() / 1000);
    const windowSecs = 300; // 5-minute window
    const expiresAt  = Math.ceil(now / windowSecs) * windowSecs; // end of current window
    const sep  = id.indexOf(':');
    const role = sep > 0 ? id.slice(0, sep) : 'device';
    const keyId = sep > 0 ? id.slice(sep + 1) : id;

    const fullToken = _encodeToken(role, TOKEN_CONTEXTS.OTP, epoch, expiresAt, keyId, rootSecret);

    // Derive 6-digit code from HMAC bytes (last 4 bytes of HMAC as uint32 mod 1e6)
    const hmacBuf = Buffer.from(fullToken.slice(192, 256), 'hex');
    const code = String(hmacBuf.readUInt32BE(28) % 1_000_000).padStart(6, '0');

    return { code, fullToken, expiresIn: expiresAt - now };
}

/**
 * Legacy wrapper kept for any caller that passes the old signature format.
 * Internally delegates to generateAPIKey.
 */
async function generateToken(rootSecret, id, context, epoch = 1, metadata) {
    if (context === TOKEN_CONTEXTS.OTP) {
        const { fullToken } = await generateOTP(rootSecret, id, epoch);
        return fullToken;
    }
    const expiresInSeconds = typeof metadata === 'number'
        ? Math.max(0, metadata - Math.floor(Date.now() / 1000))
        : 90 * 24 * 60 * 60;
    return generateAPIKey(rootSecret, id, epoch, expiresInSeconds);
}

module.exports = {
    TOKEN_CONTEXTS,
    generateToken,
    validateToken,
    generateOTP,
    generateSessionToken,
    generateAPIKey
};