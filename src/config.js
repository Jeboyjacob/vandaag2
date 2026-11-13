'use strict';
/**
 * Central configuration. All secrets come from environment variables.
 *
 * Development-mode safety:
 *  - DEV_MODE=true is only accepted together with NODE_ENV=development or NODE_ENV=test.
 *  - Any other combination (including NODE_ENV=production, or NODE_ENV unset) with
 *    DEV_MODE=true makes the server refuse to start. Dev mode can therefore never be
 *    switched on silently in production.
 *  - When dev mode is active a red banner is rendered on every page.
 */
require('dotenv').config({ quiet: true });

class ConfigError extends Error {}

function bool(v) {
  return String(v || '').toLowerCase() === 'true';
}
function int(v, def) {
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new ConfigError(`Ongeldige numerieke waarde: ${v}`);
  return n;
}
function hhmm(v, def) {
  const s = v || def;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new ConfigError(`Ongeldige tijd (HH:MM): ${s}`);
  return s;
}

function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'production'; // unset is treated as production
  const devRequested = bool(env.DEV_MODE);
  if (devRequested && !['development', 'test'].includes(nodeEnv)) {
    throw new ConfigError(
      'DEV_MODE=true is alleen toegestaan met NODE_ENV=development of NODE_ENV=test. ' +
        'De server weigert te starten zodat de ontwikkelmodus nooit ongemerkt in productie draait.'
    );
  }
  const isProduction = nodeEnv === 'production';
  const devMode = devRequested;

  const cfg = {
    nodeEnv,
    isProduction,
    isTest: nodeEnv === 'test',
    devMode,
    appName: env.APP_NAME || 'Vandaag',
    companyName: env.COMPANY_NAME || 'het bedrijf achter deze app',
    port: int(env.PORT, 3000),
    baseUrl: (env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL || '',
    databaseSsl: bool(env.DATABASE_SSL),
    sessionSecret: env.SESSION_SECRET || '',
    trustProxy: env.TRUST_PROXY || '',
    uploadDir: env.UPLOAD_DIR || './data/uploads',
    videoMaxMb: int(env.VIDEO_MAX_MB, 100),
    rateLimitDisabled: nodeEnv === 'test' && bool(env.RATE_LIMIT_DISABLED),

    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SECURE),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || '',
    },

    // External integrations: empty means "not configured". See README / OPEN-BESLISSINGEN.md.
    liveness: {
      provider: env.LIVENESS_PROVIDER || '',
      apiKey: env.LIVENESS_API_KEY || '',
      webhookSecret: env.LIVENESS_WEBHOOK_SECRET || '',
    },
    ageVerification: {
      provider: env.AGE_VERIFICATION_PROVIDER || '',
      apiKey: env.AGE_VERIFICATION_API_KEY || '',
      webhookSecret: env.AGE_VERIFICATION_WEBHOOK_SECRET || '',
    },
    payments: {
      provider: env.PAYMENT_PROVIDER || '',
      apiKey: env.PAYMENT_API_KEY || '',
      webhookSecret: env.PAYMENT_WEBHOOK_SECRET || '',
    },

    // Date planning
    timezone: 'Europe/Amsterdam',
    slotStart: hhmm(env.SLOT_START, '12:00'),
    slotEnd: hhmm(env.SLOT_END, '23:00'),
    slotIntervalMinutes: int(env.SLOT_INTERVAL_MINUTES, 30),
    slotMinLeadMinutes: int(env.SLOT_MIN_LEAD_MINUTES, 30),
    maxTimeChoices: int(env.MAX_TIME_CHOICES, 6),

    // No-show (fixed by product spec)
    noShowFeeCents: 750,
    noShowReportDelayMinutes: 30,
    noShowTermsVersion: 'noshow-v1',
    noShowDisputeDays: int(env.NOSHOW_DISPUTE_DAYS, 14),
  };

  if (isProduction) {
    const problems = [];
    if (!cfg.databaseUrl) problems.push('DATABASE_URL ontbreekt');
    if (cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET moet minstens 32 tekens zijn');
    if (!cfg.baseUrl.startsWith('https://')) problems.push('APP_BASE_URL moet met https:// beginnen');
    if (problems.length) throw new ConfigError('Productieconfiguratie onvolledig: ' + problems.join('; '));
  } else if (!cfg.sessionSecret) {
    cfg.sessionSecret = 'dev-only-insecure-secret-do-not-use-in-production';
  }
  if (cfg.slotIntervalMinutes < 5 || cfg.slotIntervalMinutes > 240) {
    throw new ConfigError('SLOT_INTERVAL_MINUTES moet tussen 5 en 240 liggen');
  }
  return cfg;
}

module.exports = { loadConfig, ConfigError };
