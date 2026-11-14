'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { createPool, migrate } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/lib/security');

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://datingapp:devpass@localhost:5432/datingapp_test';

function testConfig(extra = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DEV_MODE: 'true',
    DATABASE_URL: TEST_DB,
    RATE_LIMIT_DISABLED: 'true',
    UPLOAD_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'datingapp-test-')),
    ...extra,
  });
}

function captureMailer() {
  const sent = [];
  return {
    sent,
    isConfigured: () => true,
    canDeliver: () => true,
    async send(msg) {
      sent.push(msg);
      return { status: 'sent' };
    },
  };
}

const silentLogger = { log() {}, warn() {}, error() {} };

async function setup({ env = {}, overrides = {} } = {}) {
  const config = testConfig(env);
  const pool = createPool(config);
  await migrate(pool, { log: () => {} });
  const mailer = overrides.mailer || captureMailer();
  const app = createApp({ config, pool, logger: silentLogger, overrides: { mailer, ...overrides } });
  return { config, pool, app, mailer, ctx: app.locals.ctx };
}

async function resetDb(pool) {
  await pool.query(`TRUNCATE users, venues, session, swipes, matches, blocks, date_plans, time_choices,
    availability_submissions, date_confirmations, date_events, notifications, reports, noshow_reports,
    password_reset_tokens RESTART IDENTITY CASCADE`);
}

function csrfFrom(html) {
  const m = /name="csrf-token" content="([^"]+)"/.exec(html) || /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('no csrf token in page');
  return m[1];
}

async function csrf(agent, url = '/inloggen') {
  const res = await agent.get(url);
  return csrfFrom(res.text);
}

/** Create a user directly in the DB. ready=true: liveness passed + video present. */
let counter = 0;
async function createUser(pool, opts = {}) {
  counter += 1;
  const email = opts.email || `user${counter}-${Date.now()}@example.test`;
  const password = opts.password || 'correct horse battery';
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, birthdate, gender, pref_genders, pref_age_min, pref_age_max,
                        liveness_status, video_key, video_mime, role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      email,
      await hashPassword(password),
      opts.name || `Persoon${counter}`,
      opts.birthdate || '1995-05-05',
      opts.gender || null,
      opts.prefGenders || null,
      opts.prefAgeMin || null,
      opts.prefAgeMax || null,
      opts.ready === false ? 'not_started' : opts.liveness || 'passed',
      opts.ready === false ? null : `test${counter}abcdefghij.mp4`,
      opts.ready === false ? null : 'video/mp4',
      opts.role || 'user',
    ]
  );
  await pool.query('UPDATE users SET intro_seen_at = now() WHERE id = $1', [rows[0].id]);
  return { ...rows[0], password };
}

async function loginAgent(app, user) {
  const agent = request.agent(app);
  const token = await csrf(agent);
  const res = await agent.post('/inloggen').type('form').send({ _csrf: token, email: user.email, password: user.password });
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  return agent;
}

async function createVenue(pool, opts = {}) {
  const all = {};
  for (const d of ['1', '2', '3', '4', '5', '6', '7']) all[d] = { open: '00:00', close: '23:59' };
  const { rows } = await pool.query(
    `INSERT INTO venues (name, kind, street_address, postcode, opening_hours, source_note, active)
     VALUES ($1,'bar',$2,'1011 AA',$3,'test',$4) RETURNING *`,
    [opts.name || 'Testbar', opts.street || 'Teststraat 1', JSON.stringify(opts.hours || all), opts.active !== false]
  );
  return rows[0];
}

module.exports = { setup, resetDb, csrf, csrfFrom, createUser, loginAgent, createVenue, captureMailer, testConfig, request };
