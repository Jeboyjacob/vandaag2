'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetDb, csrf, createUser, loginAgent, request } = require('./helpers');
const { amsterdamDate } = require('../src/lib/time');

let env;
test.before(async () => {
  env = await setup();
});
test.after(async () => env.pool.end());
test.beforeEach(async () => resetDb(env.pool));

function yearsAgo(n, dayOffset = 0) {
  const [y, m, d] = amsterdamDate().split('-').map(Number);
  const dt = new Date(Date.UTC(y - n, m - 1, d + dayOffset));
  return dt.toISOString().slice(0, 10);
}

async function register(agent, fields) {
  const token = await csrf(agent, '/registreren');
  return agent
    .post('/registreren')
    .type('form')
    .send({ _csrf: token, password: 'een-lang-wachtwoord', password_confirm: 'een-lang-wachtwoord', accept_terms: 'yes', ...fields });
}

test('registration creates an account with a hashed password and logs in', async () => {
  const agent = request.agent(env.app);
  const res = await register(agent, { email: 'Anna@Example.test', display_name: 'Anna', birthdate: yearsAgo(25) });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/start');
  const { rows } = await env.pool.query('SELECT * FROM users');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'anna@example.test');
  assert.match(rows[0].password_hash, /^scrypt\$/);
  assert.ok(!rows[0].password_hash.includes('een-lang-wachtwoord'));
  assert.equal(rows[0].age_verification_status, 'unverified');
  assert.equal(rows[0].liveness_status, 'not_started');
  const start = await agent.get('/start');
  assert.equal(start.status, 200);
  assert.match(start.text, /Gezichtscheck/);
});

test('under-18 registration is blocked and nothing is stored', async () => {
  const agent = request.agent(env.app);
  const res = await register(agent, { email: 'kid@example.test', display_name: 'Kid', birthdate: yearsAgo(18, 1) });
  assert.equal(res.status, 403);
  assert.match(res.text, /18 jaar/);
  const { rows } = await env.pool.query('SELECT count(*)::int AS n FROM users');
  assert.equal(rows[0].n, 0);
});

test('exactly 18 today is allowed', async () => {
  const agent = request.agent(env.app);
  const res = await register(agent, { email: 'eighteen@example.test', display_name: 'Achttien', birthdate: yearsAgo(18) });
  assert.equal(res.status, 302);
});

test('duplicate e-mail and weak password are rejected', async () => {
  await createUser(env.pool, { email: 'taken@example.test' });
  const agent = request.agent(env.app);
  const dup = await register(agent, { email: 'TAKEN@example.test', display_name: 'X', birthdate: yearsAgo(30) });
  assert.equal(dup.status, 422);
  const token = await csrf(agent, '/registreren');
  const weak = await agent
    .post('/registreren')
    .type('form')
    .send({ _csrf: token, email: 'new@example.test', display_name: 'X', birthdate: yearsAgo(30), password: 'short', password_confirm: 'short', accept_terms: 'yes' });
  assert.equal(weak.status, 422);
});

test('POST without CSRF token is refused', async () => {
  const res = await request(env.app).post('/inloggen').type('form').send({ email: 'a@b.c', password: 'x' });
  assert.equal(res.status, 403);
});

test('login, wrong password, logout', async () => {
  const u = await createUser(env.pool);
  const agent = request.agent(env.app);
  let token = await csrf(agent);
  const bad = await agent.post('/inloggen').type('form').send({ _csrf: token, email: u.email, password: 'wrong password' });
  assert.equal(bad.status, 401);
  const ok = await agent.post('/inloggen').type('form').send({ _csrf: token, email: u.email, password: u.password });
  assert.equal(ok.status, 302);
  const prof = await agent.get('/profiel');
  assert.equal(prof.status, 200);
  token = await csrf(agent, '/profiel');
  await agent.post('/uitloggen').type('form').send({ _csrf: token });
  const after = await agent.get('/profiel');
  assert.equal(after.status, 302);
  assert.equal(after.headers.location, '/inloggen');
});

test('suspended users cannot log in', async () => {
  const u = await createUser(env.pool);
  await env.pool.query(`UPDATE users SET status='suspended' WHERE id=$1`, [u.id]);
  const agent = request.agent(env.app);
  const token = await csrf(agent);
  const res = await agent.post('/inloggen').type('form').send({ _csrf: token, email: u.email, password: u.password });
  assert.equal(res.status, 403);
});

test('password reset: token works once and logs out other sessions', async () => {
  const u = await createUser(env.pool, { email: 'reset@example.test' });
  const other = await loginAgent(env.app, u);
  const agent = request.agent(env.app);
  const token = await csrf(agent, '/wachtwoord-vergeten');
  const res = await agent.post('/wachtwoord-vergeten').type('form').send({ _csrf: token, email: 'reset@example.test' });
  assert.equal(res.status, 200);
  assert.equal(env.mailer.sent.length, 1);
  const link = /\/wachtwoord-herstellen\/([A-Za-z0-9_-]+)/.exec(env.mailer.sent[0].text)[1];
  const tokenRows = await env.pool.query('SELECT token_hash FROM password_reset_tokens');
  assert.notEqual(tokenRows.rows[0].token_hash, link, 'token must be stored hashed');

  const page = await agent.get(`/wachtwoord-herstellen/${link}`);
  const t2 = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  const set = await agent
    .post(`/wachtwoord-herstellen/${link}`)
    .type('form')
    .send({ _csrf: t2, password: 'nieuw-wachtwoord-123', password_confirm: 'nieuw-wachtwoord-123' });
  assert.equal(set.status, 302);
  const reuse = await agent
    .post(`/wachtwoord-herstellen/${link}`)
    .type('form')
    .send({ _csrf: t2, password: 'nog-een-wachtwoord', password_confirm: 'nog-een-wachtwoord' });
  assert.equal(reuse.status, 400);
  const otherSession = await other.get('/profiel');
  assert.equal(otherSession.status, 302, 'old sessions are logged out');
  await loginAgent(env.app, { email: u.email, password: 'nieuw-wachtwoord-123' });
});

test('dev bypass of the face check is never shown as verified', async () => {
  const u = await createUser(env.pool, { ready: false });
  const agent = await loginAgent(env.app, u);
  const token = await csrf(agent, '/verificatie');
  await agent.post('/verificatie/dev-overslaan').type('form').send({ _csrf: token });
  const { rows } = await env.pool.query('SELECT liveness_status FROM users WHERE id=$1', [u.id]);
  assert.equal(rows[0].liveness_status, 'dev_bypass');
  const prof = await agent.get('/profiel');
  assert.match(prof.text, /Niet geverifieerd \(ontwikkelmodus\)/);
  assert.doesNotMatch(prof.text, /Live-check geslaagd/);
});

test('without liveness provider and outside dev mode, public registration is blocked', async () => {
  const prodLike = await setup({ env: { DEV_MODE: 'false' } });
  try {
    const agent = request.agent(prodLike.app);
    const page = await agent.get('/registreren');
    assert.match(page.text, /Registratie is gesloten/);
    const token = await csrf(agent, '/registreren');
    const res = await agent
      .post('/registreren')
      .type('form')
      .send({ _csrf: token, email: 'x@example.test', display_name: 'X', birthdate: '1990-01-01', password: 'een-lang-wachtwoord', password_confirm: 'een-lang-wachtwoord', accept_terms: 'yes' });
    assert.equal(res.status, 503);
    const { rows } = await prodLike.pool.query('SELECT count(*)::int AS n FROM users');
    assert.equal(rows[0].n, 0);
    // The dev bypass route does not exist outside dev mode
    const u = await createUser(prodLike.pool, { ready: false });
    const a2 = await loginAgent(prodLike.app, u);
    const t2 = await csrf(a2, '/verificatie');
    const bypass = await a2.post('/verificatie/dev-overslaan').type('form').send({ _csrf: t2 });
    assert.equal(bypass.status, 404);
    // Face-check start is honestly unavailable
    const start = await a2.post('/verificatie/gezicht/start').type('form').send({ _csrf: t2 });
    assert.equal(start.status, 503);
  } finally {
    await prodLike.pool.end();
  }
});

test('password reset is unavailable without e-mail delivery (non-dev)', async () => {
  const noMail = await setup({
    env: { DEV_MODE: 'false' },
    overrides: { mailer: { isConfigured: () => false, canDeliver: () => false, send: async () => ({ status: 'not_configured' }) } },
  });
  try {
    const res = await request(noMail.app).get('/wachtwoord-vergeten');
    assert.match(res.text, /nog niet beschikbaar/);
  } finally {
    await noMail.pool.end();
  }
});
