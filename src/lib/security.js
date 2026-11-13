'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

// scrypt parameters (OWASP-compatible): N=2^15, r=8, p=1
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return crypto.timingSafeEqual(key, expected);
}

// A fixed hash used to keep login timing similar for unknown e-mail addresses.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** CSRF: synchronizer token stored in the session. */
function csrfMiddleware(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = randomToken(24);
  res.locals.csrfToken = req.session.csrfToken;
  next();
}
function verifyCsrf(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  return Boolean(sent && req.session.csrfToken && safeEqual(sent, req.session.csrfToken));
}
/** Check CSRF on all unsafe methods except multipart (checked after parsing) and webhooks. */
function csrfProtect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/webhooks/')) return next();
  if (req.is('multipart/form-data')) return next();
  if (!verifyCsrf(req)) {
    return res.status(403).render('error', { title: 'Sessie verlopen', message: 'Je formulier is verlopen. Ga terug, vernieuw de pagina en probeer opnieuw.' });
  }
  next();
}

module.exports = { hashPassword, verifyPassword, dummyHash, randomToken, sha256, safeEqual, csrfMiddleware, verifyCsrf, csrfProtect };
