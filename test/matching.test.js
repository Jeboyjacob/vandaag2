'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, resetDb, csrf, createUser, loginAgent } = require('./helpers');

let env;
test.before(async () => {
  env = await setup();
});
test.after(async () => env.pool.end());
test.beforeEach(async () => resetDb(env.pool));

const m = () => env.ctx.matching;

test('swipes are stored and a second swipe on the same person is rejected', async () => {
  const a = await createUser(env.pool);
  const b = await createUser(env.pool);
  const r1 = await m().swipe(a.id, b.id, 'left');
  assert.equal(r1.matched, false);
  const r2 = await m().swipe(a.id, b.id, 'right');
  assert.equal(r2.duplicate, true);
  assert.equal(r2.matched, false);
  const { rows } = await env.pool.query('SELECT * FROM swipes');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'left');
});

test('one-sided right swipe is not a match; mutual right swipe is exactly one match', async () => {
  const a = await createUser(env.pool);
  const b = await createUser(env.pool);
  const r1 = await m().swipe(a.id, b.id, 'right');
  assert.equal(r1.matched, false);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM matches')).rows[0].n, 0);
  const r2 = await m().swipe(b.id, a.id, 'right');
  assert.equal(r2.matched, true);
  const matches = (await env.pool.query('SELECT * FROM matches')).rows;
  assert.equal(matches.length, 1);
  assert.ok(matches[0].user_a < matches[0].user_b);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM date_plans')).rows[0].n, 1);
  const notes = (await env.pool.query(`SELECT user_id FROM notifications WHERE type='match' ORDER BY user_id`)).rows;
  assert.deepEqual(notes.map((n) => n.user_id), [a.id, b.id].sort((x, y) => x - y));
});

test('left + right is not a match', async () => {
  const a = await createUser(env.pool);
  const b = await createUser(env.pool);
  await m().swipe(a.id, b.id, 'left');
  const r = await m().swipe(b.id, a.id, 'right');
  assert.equal(r.matched, false);
});

test('simultaneous mutual right swipes create only one match', async () => {
  for (let i = 0; i < 5; i++) {
    const a = await createUser(env.pool);
    const b = await createUser(env.pool);
    const results = await Promise.all([m().swipe(a.id, b.id, 'right'), m().swipe(b.id, a.id, 'right')]);
    assert.ok(results.some((r) => r.matched), 'at least one side sees the match');
    const n = (
      await env.pool.query('SELECT count(*)::int n FROM matches WHERE user_a = LEAST($1::bigint,$2::bigint) AND user_b = GREATEST($1::bigint,$2::bigint)', [a.id, b.id])
    ).rows[0].n;
    assert.equal(n, 1);
  }
});

test('deck shows one profile at a time and never yourself or already-swiped people', async () => {
  const me = await createUser(env.pool);
  const others = [await createUser(env.pool), await createUser(env.pool)];
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    const p = await m().nextProfile(me.id);
    assert.ok(p && p.id !== me.id && !seen.has(p.id));
    seen.add(p.id);
    await m().swipe(me.id, p.id, 'left');
  }
  assert.equal(await m().nextProfile(me.id), null);
  assert.equal(seen.size, others.length);
});

test('users who are not ready (no liveness / no video) are not shown and cannot swipe', async () => {
  const me = await createUser(env.pool);
  const notReady = await createUser(env.pool, { ready: false });
  assert.equal(await m().nextProfile(me.id), null);
  await assert.rejects(m().swipe(notReady.id, me.id, 'right'));
  const agent = await loginAgent(env.app, notReady);
  const res = await agent.get('/ontdekken');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/start');
});

test('preferences: gender and age filters apply in both directions', async () => {
  const me = await createUser(env.pool, { gender: 'vrouw', prefGenders: ['man'], prefAgeMin: 25, prefAgeMax: 35, birthdate: '1996-01-01' });
  const fits = await createUser(env.pool, { gender: 'man', prefGenders: ['vrouw'], birthdate: '1994-01-01' });
  await createUser(env.pool, { gender: 'vrouw', birthdate: '1994-01-01' }); // wrong gender
  await createUser(env.pool, { gender: 'man', birthdate: '1980-01-01' }); // too old
  await createUser(env.pool, { gender: 'man', prefGenders: ['man'], birthdate: '1994-01-01' }); // I don't fit his prefs
  await createUser(env.pool, { gender: 'man', prefAgeMax: 22, birthdate: '1994-01-01' }); // I'm too old for him
  const p = await m().nextProfile(me.id);
  assert.equal(p.id, fits.id);
  await m().swipe(me.id, p.id, 'left');
  assert.equal(await m().nextProfile(me.id), null);
});

test('no preferences means everyone is shown', async () => {
  const me = await createUser(env.pool);
  await createUser(env.pool, { gender: 'man' });
  await createUser(env.pool, { gender: 'vrouw' });
  await createUser(env.pool);
  let n = 0;
  for (let p = await m().nextProfile(me.id); p; p = await m().nextProfile(me.id)) {
    n += 1;
    await m().swipe(me.id, p.id, 'left');
  }
  assert.equal(n, 3);
});

test('blocked users are hidden both ways and their date is cancelled', async () => {
  const a = await createUser(env.pool);
  const b = await createUser(env.pool);
  await m().swipe(a.id, b.id, 'right');
  const r = await m().swipe(b.id, a.id, 'right');
  await env.ctx.dates.block(a.id, b.id);
  const plan = (await env.pool.query('SELECT status FROM date_plans WHERE match_id=$1', [r.matchId])).rows[0];
  assert.equal(plan.status, 'cancelled');
  const c = await createUser(env.pool);
  await env.ctx.dates.block(c.id, a.id);
  assert.equal(await m().nextProfile(a.id), null);
});

test('video access control: owner yes, eligible user yes, blocked or not-ready no, anonymous no', async () => {
  const owner = await createUser(env.pool);
  const viewer = await createUser(env.pool);
  const notReady = await createUser(env.pool, { ready: false });
  // place a real file for the owner's key
  const file = env.ctx.storage.pathFor(owner.video_key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from('00000018667479706d703432', 'hex'));

  const anon = await require('supertest')(env.app).get(`/media/video/${owner.id}`);
  assert.equal(anon.status, 302);
  assert.equal((await (await loginAgent(env.app, owner)).get(`/media/video/${owner.id}`)).status, 200);
  const va = await loginAgent(env.app, viewer);
  assert.equal((await va.get(`/media/video/${owner.id}`)).status, 200);
  assert.equal((await (await loginAgent(env.app, notReady)).get(`/media/video/${owner.id}`)).status, 403);
  await env.ctx.dates.block(owner.id, viewer.id);
  assert.equal((await va.get(`/media/video/${owner.id}`)).status, 404);
});

test('video upload: real video accepted, fake file rejected, deletion removes file', async () => {
  const u = await createUser(env.pool, { ready: false });
  const agent = await loginAgent(env.app, u);
  let token = await csrf(agent, '/profiel');
  const fake = await agent.post('/profiel/video').field('_csrf', token).attach('video', Buffer.from('not a video at all'), { filename: 'x.mp4', contentType: 'video/mp4' });
  assert.equal(fake.status, 302);
  assert.equal((await env.pool.query('SELECT video_key FROM users WHERE id=$1', [u.id])).rows[0].video_key, null);

  const mp4 = Buffer.concat([Buffer.from('00000018667479706d703432', 'hex'), Buffer.alloc(64)]);
  token = await csrf(agent, '/profiel');
  const ok = await agent.post('/profiel/video').field('_csrf', token).attach('video', mp4, { filename: 'me.mp4', contentType: 'video/mp4' });
  assert.equal(ok.status, 302);
  const key = (await env.pool.query('SELECT video_key FROM users WHERE id=$1', [u.id])).rows[0].video_key;
  assert.ok(key);
  assert.ok(fs.existsSync(env.ctx.storage.pathFor(key)));

  const noCsrf = await agent.post('/profiel/video').attach('video', mp4, { filename: 'me.mp4', contentType: 'video/mp4' });
  assert.equal(noCsrf.status, 403);

  token = await csrf(agent, '/profiel');
  await agent.post('/profiel/video/verwijderen').type('form').send({ _csrf: token });
  assert.equal(fs.existsSync(env.ctx.storage.pathFor(key)), false);
});

test('account deletion removes user, swipes and matches', async () => {
  const a = await createUser(env.pool);
  const b = await createUser(env.pool);
  await m().swipe(a.id, b.id, 'right');
  await m().swipe(b.id, a.id, 'right');
  const agent = await loginAgent(env.app, a);
  const token = await csrf(agent, '/account/verwijderen');
  const bad = await agent.post('/account/verwijderen').type('form').send({ _csrf: token, password: a.password, confirm: 'nee' });
  assert.equal(bad.status, 422);
  const res = await agent.post('/account/verwijderen').type('form').send({ _csrf: token, password: a.password, confirm: 'VERWIJDER' });
  assert.equal(res.status, 200);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM users WHERE id=$1', [a.id])).rows[0].n, 0);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM matches')).rows[0].n, 0);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM swipes')).rows[0].n, 0);
});

test('reporting a profile creates a report for the admin', async () => {
  const a = await createUser(env.pool);
  const b = await createUser(env.pool);
  const agent = await loginAgent(env.app, a);
  const token = await csrf(agent, `/melden/${b.id}`);
  const res = await agent.post(`/melden/${b.id}`).type('form').send({ _csrf: token, kind: 'video', reason: 'Spam of reclame', also_block: 'yes' });
  assert.equal(res.status, 302);
  const rep = (await env.pool.query('SELECT * FROM reports')).rows[0];
  assert.equal(rep.kind, 'video');
  assert.equal(rep.reported_user_id, b.id);
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM blocks')).rows[0].n, 1);
});
