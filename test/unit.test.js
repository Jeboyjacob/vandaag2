'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickBestSlot, normalizeChoices, ValidationError } = require('../src/lib/scheduling');
const { ageOn, parseBirthdate } = require('../src/lib/age');
const { amsterdamToUtc, amsterdamDate, generateSlots, formatTime } = require('../src/lib/time');
const { isOpenAt, parseVenueForm } = require('../src/services/venues');
const { loadConfig, ConfigError } = require('../src/config');

const day = '2026-11-14';
const at = (hhmm) => amsterdamToUtc(day, hhmm);
const now = at('09:00');

test('age: exact birthday boundaries', () => {
  assert.equal(ageOn('2008-11-14', '2026-11-14'), 18);
  assert.equal(ageOn('2008-11-15', '2026-11-14'), 17);
  assert.equal(ageOn('2000-02-29', '2026-02-28'), 25);
  assert.equal(parseBirthdate('2001-02-30'), null);
  assert.equal(parseBirthdate('not-a-date'), null);
  assert.equal(parseBirthdate('1990-01-31'), '1990-01-31');
});

test('time: Amsterdam conversion is DST-aware', () => {
  assert.equal(amsterdamToUtc('2026-07-01', '20:00').toISOString(), '2026-07-01T18:00:00.000Z'); // CEST
  assert.equal(amsterdamToUtc('2026-12-01', '20:00').toISOString(), '2026-12-01T19:00:00.000Z'); // CET
  assert.equal(amsterdamDate(new Date('2026-11-13T23:30:00Z')), '2026-11-14');
  assert.equal(formatTime(at('19:30')), '19:30');
});

test('slots: only future times for that day', () => {
  const cfg = { slotStart: '12:00', slotEnd: '23:00', slotIntervalMinutes: 30, slotMinLeadMinutes: 30 };
  const all = generateSlots(day, cfg, now);
  assert.equal(all.length, 23);
  const later = generateSlots(day, cfg, at('20:10'));
  assert.deepEqual(later.map(formatTime), ['21:00', '21:30', '22:00', '22:30', '23:00']);
  assert.equal(generateSlots(day, cfg, at('23:00')).length, 0);
});

test('pickBestSlot: lowest rank sum wins', () => {
  const a = [{ slotStart: at('19:00'), rank: 1 }, { slotStart: at('20:00'), rank: 2 }, { slotStart: at('21:00'), rank: 3 }];
  const b = [{ slotStart: at('21:00'), rank: 1 }, { slotStart: at('20:00'), rank: 2 }];
  const best = pickBestSlot(a, b, { now });
  assert.equal(formatTime(best.slotStart), '20:00'); // 2+2=4 beats 3+1=4? tie -> earliest
  assert.equal(best.score, 4);
});

test('pickBestSlot: ties resolve to the earliest time', () => {
  const a = [{ slotStart: at('21:00'), rank: 1 }, { slotStart: at('19:00'), rank: 2 }];
  const b = [{ slotStart: at('19:00'), rank: 1 }, { slotStart: at('21:00'), rank: 2 }];
  assert.equal(formatTime(pickBestSlot(a, b, { now }).slotStart), '19:00');
});

test('pickBestSlot: clear winner is not overridden by earliness', () => {
  const a = [{ slotStart: at('22:00'), rank: 1 }, { slotStart: at('18:00'), rank: 3 }];
  const b = [{ slotStart: at('22:00'), rank: 1 }, { slotStart: at('18:00'), rank: 2 }];
  assert.equal(formatTime(pickBestSlot(a, b, { now }).slotStart), '22:00');
});

test('pickBestSlot: no overlap and past slots', () => {
  assert.equal(pickBestSlot([{ slotStart: at('19:00'), rank: 1 }], [{ slotStart: at('20:00'), rank: 1 }], { now }), null);
  const past = [{ slotStart: at('08:00'), rank: 1 }];
  assert.equal(pickBestSlot(past, past, { now }), null);
});

test('normalizeChoices: validates ranks and allowed slots', () => {
  const allowed = [at('19:00'), at('19:30'), at('20:00')];
  const ok = normalizeChoices(
    [{ slot: at('20:00').toISOString(), rank: '2' }, { slot: at('19:00').toISOString(), rank: '1' }],
    allowed,
    6
  );
  assert.deepEqual(ok.map((c) => c.rank), [1, 2]);
  assert.throws(() => normalizeChoices([{ slot: at('19:00').toISOString(), rank: '2' }], allowed, 6), ValidationError);
  assert.throws(
    () => normalizeChoices([{ slot: at('19:00').toISOString(), rank: '1' }, { slot: at('19:30').toISOString(), rank: '1' }], allowed, 6),
    ValidationError
  );
  assert.throws(() => normalizeChoices([{ slot: at('08:00').toISOString(), rank: '1' }], allowed, 6), ValidationError);
  assert.throws(() => normalizeChoices([], allowed, 6), ValidationError);
});

test('venues: opening hours incl. after midnight', () => {
  // 2026-11-14 is a Saturday (6); 2026-11-15 Sunday (7)
  const hours = { 6: { open: '17:00', close: '02:00' } };
  assert.equal(isOpenAt(hours, at('18:00')), true);
  assert.equal(isOpenAt(hours, at('16:59')), false);
  assert.equal(isOpenAt(hours, amsterdamToUtc('2026-11-15', '01:30')), true);
  assert.equal(isOpenAt(hours, amsterdamToUtc('2026-11-15', '18:00')), false);
});

test('venues: form validation refuses incomplete data', () => {
  const { errors } = parseVenueForm({ name: '', kind: 'club', postcode: 'abc' });
  assert.ok(errors.length >= 4);
});

test('config: dev mode can never run in production', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DEV_MODE: 'true' }), ConfigError);
  assert.throws(() => loadConfig({ DEV_MODE: 'true' }), ConfigError); // NODE_ENV unset = production
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', SESSION_SECRET: 'short', APP_BASE_URL: 'https://a.nl' }), ConfigError);
  const prod = loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(40), APP_BASE_URL: 'https://a.nl' });
  assert.equal(prod.devMode, false);
  assert.equal(prod.noShowFeeCents, 750);
});
