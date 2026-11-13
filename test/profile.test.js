'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetDb, csrf, createUser, loginAgent, createVenue } = require('./helpers');
const opts = require('../src/lib/profile-options');
const { chooseVenue, parseVenueForm } = require('../src/services/venues');

let env;
before(async () => { env = await setup(); });
after(async () => { await env.pool.end(); });
beforeEach(async () => { await resetDb(env.pool); });

test('parseExtras accepts valid prompts, interests and languages', () => {
  const r = opts.parseExtras({
    prompt_key_0: 'openingszin', prompt_answer_0: 'Welke koffie neem jij?',
    prompt_key_1: 'vrienden', prompt_answer_1: 'Chaotisch maar lief',
    interests: ['cafes', 'standup'], languages: ['nl', 'en'],
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.prompts.length, 2);
  assert.deepEqual(r.interests, ['cafes', 'standup']);
});

test('parseExtras rejects bad input', () => {
  assert.ok(opts.parseExtras({ prompt_key_0: 'bestaat-niet', prompt_answer_0: 'x' }).errors.length);
  assert.ok(opts.parseExtras({ prompt_key_0: 'openingszin', prompt_answer_0: '' }).errors.length);
  assert.ok(opts.parseExtras({ prompt_key_0: 'openingszin', prompt_answer_0: 'x'.repeat(151) }).errors.length);
  assert.ok(opts.parseExtras({ prompt_key_0: 'zondag', prompt_answer_0: 'a', prompt_key_1: 'zondag', prompt_answer_1: 'b' }).errors.length);
  assert.ok(opts.parseExtras({ interests: ['verzonnen'] }).errors.length);
  assert.ok(opts.parseExtras({ languages: ['xx'] }).errors.length);
  const tooMany = opts.INTEREST_GROUPS.flatMap((g) => g.items.map((i) => i.key)).slice(0, 13);
  assert.ok(opts.parseExtras({ interests: tooMany }).errors.length);
});

test('profile form saves prompts, interests and languages and shows them to others', async () => {
  const me = await createUser(env.pool, { name: 'Anna' });
  const other = await createUser(env.pool, { name: 'Bram' });
  const agent = await loginAgent(env.app, me);
  const token = await csrf(agent, '/profiel');
  const res = await agent.post('/profiel').type('form').send({
    _csrf: token, display_name: 'Anna', bio: '', gender: '', pref_genders: '',
    prompt_key_0: 'openingszin', prompt_answer_0: 'Koffie of bier?',
    interests: ['cafes', 'muziek-maken'], languages: ['nl', 'fr'],
  });
  assert.equal(res.status, 302);
  const row = (await env.pool.query('SELECT prompts, interests, languages FROM users WHERE id=$1', [me.id])).rows[0];
  assert.deepEqual(row.prompts, [{ key: 'openingszin', answer: 'Koffie of bier?' }]);
  assert.deepEqual(row.interests, ['cafes', 'muziek-maken']);
  assert.deepEqual(row.languages, ['nl', 'fr']);

  const page = await agent.get('/profiel');
  assert.match(page.text, /Mijn favoriete openingszin is/);
  assert.match(page.text, /Frans/);

  // another user sees it on the discover card, with shared interests highlighted
  await env.pool.query(`UPDATE users SET interests='{cafes}' WHERE id=$1`, [other.id]);
  const agentB = await loginAgent(env.app, other);
  const disc = await agentB.get('/ontdekken');
  assert.match(disc.text, /Koffie of bier\?/);
  assert.match(disc.text, /Jullie delen: Café’s/);
});

test('profile form rejects invalid extras with an error', async () => {
  const me = await createUser(env.pool, {});
  const agent = await loginAgent(env.app, me);
  const token = await csrf(agent, '/profiel');
  const res = await agent.post('/profiel').type('form').send({
    _csrf: token, display_name: 'Anna', bio: '', prompt_key_0: 'openingszin', prompt_answer_0: '', interests: ['nep'],
  });
  assert.equal(res.status, 422);
  assert.match(res.text, /Vul een antwoord in/);
});

test('venues: only bar and koffie are allowed, restaurants are rejected', () => {
  const base = {
    name: 'X', street_address: 'Straat 1', postcode: '1011 AA', source_note: 'gecheckt', open_1: '09:00', close_1: '18:00',
  };
  assert.equal(parseVenueForm({ ...base, kind: 'koffie' }).errors.length, 0);
  assert.equal(parseVenueForm({ ...base, kind: 'bar' }).errors.length, 0);
  assert.ok(parseVenueForm({ ...base, kind: 'restaurant' }).errors.length);
});

test('chooseVenue never picks a legacy restaurant', async () => {
  const v = await createVenue(env.pool, { name: 'Oud restaurant' });
  await env.pool.query(`ALTER TABLE venues DROP CONSTRAINT venues_kind_check`);
  await env.pool.query(`UPDATE venues SET kind='restaurant' WHERE id=$1`, [v.id]);
  try {
    const picked = await chooseVenue(env.pool, new Date(Date.now() + 3600e3));
    assert.equal(picked, null);
  } finally {
    await env.pool.query(`UPDATE venues SET kind='bar'`);
    await env.pool.query(`ALTER TABLE venues ADD CONSTRAINT venues_kind_check CHECK (kind IN ('bar','koffie')) NOT VALID`);
  }
});
