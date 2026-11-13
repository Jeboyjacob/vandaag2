'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, resetDb, csrf, createUser, loginAgent, createVenue } = require('./helpers');
const { amsterdamToUtc, formatTime } = require('../src/lib/time');

let env;
test.before(async () => {
  env = await setup();
});
test.after(async () => env.pool.end());
test.beforeEach(async () => resetDb(env.pool));

// A fixed future day so tests do not depend on the current clock.
const DAY = '2030-06-14';
const at = (hhmm) => amsterdamToUtc(DAY, hhmm);
const MORNING = at('09:00');
const choice = (hhmm, rank) => ({ slot: at(hhmm).toISOString(), rank });

async function matchedPair() {
  const a = await createUser(env.pool, { name: 'Anna' });
  const b = await createUser(env.pool, { name: 'Bram' });
  await env.ctx.matching.swipe(a.id, b.id, 'right');
  const r = await env.ctx.matching.swipe(b.id, a.id, 'right');
  await env.pool.query('UPDATE date_plans SET day=$1 WHERE match_id=$2', [DAY, r.matchId]);
  return { a, b, matchId: r.matchId };
}

const d = () => env.ctx.dates;
const plan = async (matchId) => (await env.pool.query('SELECT * FROM date_plans WHERE match_id=$1', [matchId])).rows[0];

async function confirmedDate() {
  await createVenue(env.pool);
  const p = await matchedPair();
  await d().submitChoices(p.matchId, p.a.id, [choice('19:00', 1)], MORNING);
  await d().submitChoices(p.matchId, p.b.id, [choice('19:00', 1)], MORNING);
  assert.equal((await plan(p.matchId)).status, 'confirmed');
  return p;
}

test('overlap: best combined rank is proposed, ties go to the earliest time', async () => {
  await createVenue(env.pool);
  const { a, b, matchId } = await matchedPair();
  const r1 = await d().submitChoices(matchId, a.id, [choice('21:00', 1), choice('19:00', 2), choice('20:00', 3)], MORNING);
  assert.equal(r1.outcome, 'waiting');
  assert.equal((await plan(matchId)).status, 'collecting');
  const r2 = await d().submitChoices(matchId, b.id, [choice('19:00', 1), choice('21:00', 2), choice('20:00', 3)], MORNING);
  assert.equal(r2.outcome, 'confirmed');
  const p = await plan(matchId);
  assert.equal(p.status, 'confirmed');
  // 21:00 = 1+2 = 3, 19:00 = 2+1 = 3 -> tie -> earliest (19:00)
  assert.equal(formatTime(p.proposed_start), '19:00');
  assert.ok(p.venue_id);
});

test('no overlap: the app suggests the nearest time, both tap "ja, past!"', async () => {
  await createVenue(env.pool);
  const { a, b, matchId } = await matchedPair();
  await d().submitChoices(matchId, a.id, [choice('19:00', 1)], MORNING);
  const r = await d().submitChoices(matchId, b.id, [choice('20:00', 1)], MORNING);
  assert.equal(r.outcome, 'suggested');
  const p = await plan(matchId);
  assert.equal(p.status, 'proposed');
  assert.equal(p.suggested, true);
  assert.equal(formatTime(p.proposed_start), '19:30'); // precies tussen de twee keuzes in
  assert.ok(p.venue_id);
  const n = (await env.pool.query(`SELECT count(*)::int n FROM notifications WHERE type='proposed'`)).rows[0].n;
  assert.equal(n, 2);
  const v = p.proposal_version;
  assert.equal((await d().confirm(matchId, a.id, { proposalVersion: v }, MORNING)).outcome, 'waiting_other');
  assert.equal((await d().confirm(matchId, b.id, { proposalVersion: v }, MORNING)).outcome, 'confirmed');
  assert.equal((await plan(matchId)).status, 'confirmed');
});

test('suggestion declined: second suggestion differs, then people choose themselves', async () => {
  await createVenue(env.pool);
  const { a, b, matchId } = await matchedPair();
  await d().submitChoices(matchId, a.id, [choice('19:00', 1)], MORNING);
  await d().submitChoices(matchId, b.id, [choice('21:00', 1)], MORNING);
  const first = formatTime((await plan(matchId)).proposed_start);
  const r1 = await d().declineProposal(matchId, a.id, MORNING);
  assert.equal(r1.outcome, 'new_suggestion');
  const p2 = await plan(matchId);
  assert.notEqual(formatTime(p2.proposed_start), first);
  assert.equal(p2.suggest_count, 2);
  const r2 = await d().declineProposal(matchId, b.id, MORNING);
  assert.equal(r2.outcome, 'no_overlap');
  assert.equal((await plan(matchId)).status, 'no_overlap');
  // pick own times again -> new round
  await d().submitChoices(matchId, a.id, [choice('20:00', 1)], MORNING);
  assert.equal((await plan(matchId)).round, 2);
  const r3 = await d().submitChoices(matchId, b.id, [choice('20:00', 1)], MORNING);
  assert.equal(r3.outcome, 'confirmed');
});

test('declining is only possible for app suggestions', async () => {
  const { matchId, a } = await confirmedDate();
  await assert.rejects(d().declineProposal(matchId, a.id, MORNING), /geen voorstel/);
});

test('only future slots can be chosen', async () => {
  const { a, matchId } = await matchedPair();
  const late = at('20:10');
  await assert.rejects(d().submitChoices(matchId, a.id, [choice('20:00', 1)], late), /niet \(meer\) beschikbaar/);
  await assert.rejects(d().submitChoices(matchId, a.id, [choice('20:30', 1)], late), /niet \(meer\) beschikbaar/); // within 30 min lead
  const ok = await d().submitChoices(matchId, a.id, [choice('21:00', 1)], late);
  assert.equal(ok.outcome, 'waiting');
});

test('no proposal is possible without a match', async () => {
  const a = await createUser(env.pool);
  const b = await createUser(env.pool);
  await env.ctx.matching.swipe(a.id, b.id, 'right');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM date_plans')).rows[0].n, 0);
  const stranger = await createUser(env.pool);
  const { matchId } = await matchedPair();
  await assert.rejects(d().submitChoices(matchId, stranger.id, [choice('19:00', 1)], MORNING), /bestaat niet/);
});

test('without real venues there is no location and confirming is impossible', async () => {
  const { a, b, matchId } = await matchedPair();
  await d().submitChoices(matchId, a.id, [choice('19:00', 1)], MORNING);
  await d().submitChoices(matchId, b.id, [choice('19:00', 1)], MORNING);
  const p = await plan(matchId);
  assert.equal(p.status, 'proposed');
  assert.equal(p.venue_id, null);
  await assert.rejects(d().confirm(matchId, a.id, { proposalVersion: p.proposal_version }, MORNING), /geen locatie/);
  // When the admin adds a venue, the proposal gets it on the next view.
  await createVenue(env.pool);
  const view = await d().view(matchId, a.id, MORNING);
  assert.ok(view.venue);
});

test('venue must be open at the proposed time', async () => {
  await createVenue(env.pool, { hours: { 6: { open: '21:00', close: '02:00' } } }); // 2030-06-14 = Friday(5)
  const { a, b, matchId } = await matchedPair();
  await d().submitChoices(matchId, a.id, [choice('19:00', 1)], MORNING);
  await d().submitChoices(matchId, b.id, [choice('19:00', 1)], MORNING);
  assert.equal((await plan(matchId)).venue_id, null);
});

test('suggested proposal: one tap is not enough, both make it definitive', async () => {
  await createVenue(env.pool);
  const { a, b, matchId } = await matchedPair();
  await d().submitChoices(matchId, a.id, [choice('19:00', 1)], MORNING);
  await d().submitChoices(matchId, b.id, [choice('20:00', 1)], MORNING);
  const v = (await plan(matchId)).proposal_version;
  const r1 = await d().confirm(matchId, a.id, { proposalVersion: v }, MORNING);
  assert.equal(r1.outcome, 'waiting_other');
  assert.equal((await plan(matchId)).status, 'proposed');
  assert.equal((await d().confirm(matchId, a.id, { proposalVersion: v }, MORNING)).outcome, 'duplicate');
  assert.equal((await d().confirm(matchId, b.id, { proposalVersion: v }, MORNING)).outcome, 'confirmed');
  const confs = (await env.pool.query('SELECT * FROM date_confirmations WHERE plan_id=$1', [(await plan(matchId)).id])).rows;
  assert.equal(confs.length, 2);
});

test('automatic confirmation: same time picked means definitive without any tap', async () => {
  await createVenue(env.pool);
  const { a, b, matchId } = await matchedPair();
  await d().submitChoices(matchId, a.id, [choice('19:00', 1)], MORNING);
  const r = await d().submitChoices(matchId, b.id, [choice('19:00', 1)], MORNING);
  assert.equal(r.outcome, 'confirmed');
  assert.ok(r.venue);
  const confs = (await env.pool.query('SELECT * FROM date_confirmations')).rows;
  assert.equal(confs.length, 2);
  const notes = (await env.pool.query(`SELECT * FROM notifications WHERE type='confirmed'`)).rows;
  assert.equal(notes.length, 2);
});

test('confirming a stale proposal is refused (time or location changed)', async () => {
  await createVenue(env.pool);
  const { a, b, matchId } = await matchedPair();
  await d().submitChoices(matchId, a.id, [choice('19:00', 1)], MORNING);
  await d().submitChoices(matchId, b.id, [choice('20:00', 1)], MORNING);
  const v1 = (await plan(matchId)).proposal_version;
  await d().confirm(matchId, a.id, { proposalVersion: v1 }, MORNING);
  await d().declineProposal(matchId, b.id, MORNING);
  const p = await plan(matchId);
  assert.ok(p.proposal_version > v1);
  await assert.rejects(d().confirm(matchId, b.id, { proposalVersion: v1 }, MORNING), /gewijzigd/);
  const r = await d().confirm(matchId, b.id, { proposalVersion: p.proposal_version }, MORNING);
  assert.equal(r.outcome, 'waiting_other'); // a's old confirmation does not count for the new proposal
});

test('proposal expires when its start time passes unconfirmed', async () => {
  await createVenue(env.pool);
  const { a, b, matchId } = await matchedPair();
  await d().submitChoices(matchId, a.id, [choice('19:00', 1)], MORNING);
  await d().submitChoices(matchId, b.id, [choice('19:30', 1)], MORNING);
  assert.equal((await plan(matchId)).status, 'proposed');
  await d().view(matchId, a.id, at('23:00'));
  assert.equal((await plan(matchId)).status, 'expired');
});

test('"Ik ben vertraagd" notifies the other user', async () => {
  const { a, b, matchId } = await confirmedDate();
  const r = await d().delay(matchId, a.id, 15, at('18:50'));
  assert.equal(r.outcome, 'delayed');
  const note = (await env.pool.query(`SELECT * FROM notifications WHERE type='delayed'`)).rows;
  assert.equal(note.length, 1);
  assert.equal(note[0].user_id, b.id);
  assert.equal(note[0].email_status, 'sent');
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM date_events WHERE type='delayed'`)).rows[0].n, 1);
  await assert.rejects(d().delay(matchId, a.id, 7, at('18:50')), /minuten/);
});

test('"Ik wil annuleren" changes status and notifies; not after the start', async () => {
  const p1 = await confirmedDate();
  await assert.rejects(d().cancel(p1.matchId, p1.a.id, at('19:01')), /voorbij/);
  const r = await d().cancel(p1.matchId, p1.a.id, at('18:00'));
  assert.equal(r.outcome, 'cancelled');
  assert.equal((await plan(p1.matchId)).status, 'cancelled');
  const note = (await env.pool.query(`SELECT * FROM notifications WHERE type='cancelled'`)).rows[0];
  assert.equal(note.user_id, p1.b.id);
  await assert.rejects(d().reportNoShow(p1.matchId, p1.b.id, at('20:00')), /definitieve date/);
});

test('"Ik voel me niet veilig" ends the date, can block and report, other gets a neutral message', async () => {
  const { a, b, matchId } = await confirmedDate();
  await d().endUnsafe(matchId, a.id, { doBlock: true, doReport: true, details: 'test' }, at('19:20'));
  assert.equal((await plan(matchId)).status, 'ended_unsafe');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [a.id, b.id])).rows[0].n, 1);
  const rep = (await env.pool.query(`SELECT * FROM reports WHERE kind='unsafe_date'`)).rows[0];
  assert.equal(rep.reported_user_id, b.id);
  const note = (await env.pool.query(`SELECT * FROM notifications WHERE user_id=$1 AND type='ended'`, [b.id])).rows[0];
  assert.ok(note);
  assert.doesNotMatch(note.title + note.body, /veilig/);
});

test('no-show: only after 30 minutes, only once, then status/dispute/decision', async () => {
  const { a, b, matchId } = await confirmedDate();
  await assert.rejects(d().reportNoShow(matchId, a.id, at('19:29')), /30 minuten/);
  const r = await d().reportNoShow(matchId, a.id, at('19:30'));
  assert.equal(r.outcome, 'reported');
  await assert.rejects(d().reportNoShow(matchId, a.id, at('19:40')), /al een no-show/);
  const rep = (await env.pool.query('SELECT * FROM noshow_reports')).rows[0];
  assert.equal(rep.reporter_id, a.id);
  assert.equal(rep.reported_user_id, b.id);
  assert.equal(rep.fee_cents, 750);
  assert.equal(rep.status, 'reported');
  assert.equal(rep.payment_status, 'not_collected');
  assert.equal(formatTime(rep.scheduled_start), '19:00');
  assert.equal(rep.venue_name, 'Testbar');

  await assert.rejects(d().disputeNoShow(rep.id, a.id, 'ik ben de melder zelf', at('20:00')), /niet gevonden/);
  await assert.rejects(d().disputeNoShow(rep.id, b.id, 'kort', at('20:00')), /10 tekens/);
  await d().disputeNoShow(rep.id, b.id, 'Ik was er wel, om 19:05 aan de bar.', at('20:00'));
  assert.equal((await env.pool.query('SELECT status FROM noshow_reports WHERE id=$1', [rep.id])).rows[0].status, 'disputed');
});

test('admin decision on a no-show never claims money was collected', async () => {
  const { a, b, matchId } = await confirmedDate();
  await d().reportNoShow(matchId, a.id, at('19:45'));
  const rep = (await env.pool.query('SELECT * FROM noshow_reports')).rows[0];
  const admin = await createUser(env.pool, { role: 'admin' });
  const agent = await loginAgent(env.app, admin);
  const token = await csrf(agent, '/beheer/no-shows');
  const res = await agent.post(`/beheer/no-shows/${rep.id}`).type('form').send({ _csrf: token, decision: 'upheld', admin_note: 'ok' });
  assert.equal(res.status, 302);
  const after = (await env.pool.query('SELECT * FROM noshow_reports WHERE id=$1', [rep.id])).rows[0];
  assert.equal(after.status, 'upheld');
  assert.equal(after.payment_status, 'not_collected');
  const page = await agent.get('/beheer/no-shows');
  assert.match(page.text, /GEEN geld geïnd|niets automatisch geïnd/);
  const userPage = await (await loginAgent(env.app, b)).get(`/no-shows/${rep.id}`);
  assert.match(userPage.text, /Er is geen geld geïnd/);
});

test('non-admins cannot reach admin pages', async () => {
  const u = await createUser(env.pool);
  const agent = await loginAgent(env.app, u);
  assert.equal((await agent.get('/beheer')).status, 403);
  assert.equal((await agent.get('/beheer/locaties')).status, 403);
});

test('admin can add, edit and delete a venue', async () => {
  const admin = await createUser(env.pool, { role: 'admin' });
  const agent = await loginAgent(env.app, admin);
  let token = await csrf(agent, '/beheer/locaties/nieuw');
  const bad = await agent.post('/beheer/locaties').type('form').send({ _csrf: token, name: 'X' });
  assert.equal(bad.status, 422);
  const ok = await agent.post('/beheer/locaties').type('form').send({
    _csrf: token,
    name: 'Café Test',
    kind: 'bar',
    street_address: 'Teststraat 1',
    postcode: '1011aa',
    open_5: '16:00',
    close_5: '01:00',
    source_note: 'test',
    active: '1',
  });
  assert.equal(ok.status, 302);
  const v = (await env.pool.query('SELECT * FROM venues')).rows[0];
  assert.equal(v.postcode, '1011 AA');
  assert.deepEqual(v.opening_hours, { 5: { open: '16:00', close: '01:00' } });
  token = await csrf(agent, `/beheer/locaties/${v.id}`);
  await agent.post(`/beheer/locaties/${v.id}/verwijderen`).type('form').send({ _csrf: token });
  assert.ok((await env.pool.query('SELECT deleted_at FROM venues WHERE id=$1', [v.id])).rows[0].deleted_at);
});

test('match page renders for both users and 404s for strangers', async () => {
  const { a, b, matchId } = await matchedPair();
  await env.pool.query('UPDATE date_plans SET day = (now() AT TIME ZONE \'Europe/Amsterdam\')::date WHERE match_id=$1', [matchId]);
  const aa = await loginAgent(env.app, a);
  const page = await aa.get(`/matches/${matchId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Bram/);
  const stranger = await loginAgent(env.app, await createUser(env.pool));
  assert.equal((await stranger.get(`/matches/${matchId}`)).status, 404);
  assert.equal((await (await loginAgent(env.app, b)).get('/matches')).status, 200);
});

test('match page renders for suggestion, confirmed, cancelled; profile page shows location fields', async () => {
  await createVenue(env.pool);
  const { a, b, matchId } = await matchedPair();
  await env.pool.query(`UPDATE date_plans SET day = (now() AT TIME ZONE 'Europe/Amsterdam')::date + 1 WHERE match_id=$1`, [matchId]);
  const day = (await plan(matchId)).day;
  const dayStr = day instanceof Date ? day.toLocaleDateString('sv-SE') : String(day).slice(0, 10);
  const mk = (hhmm, rank) => ({ slot: amsterdamToUtc(dayStr, hhmm).toISOString(), rank });
  const now = new Date();
  await d().submitChoices(matchId, a.id, [mk('19:00', 1)], now);
  const r = await d().submitChoices(matchId, b.id, [mk('21:00', 1)], now);
  assert.equal(r.outcome, 'suggested');
  const aa = await loginAgent(env.app, a);
  let page = await aa.get(`/matches/${matchId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Ja, past!/);
  assert.match(page.text, /Past niet/);
  const v = (await plan(matchId)).proposal_version;
  await d().confirm(matchId, a.id, { proposalVersion: v });
  await d().confirm(matchId, b.id, { proposalVersion: v });
  page = await aa.get(`/matches/${matchId}`);
  assert.match(page.text, /Jullie date staat/);
  await d().cancel(matchId, b.id);
  page = await aa.get(`/matches/${matchId}`);
  assert.match(page.text, /niet getreurd/);
  const prefs = await aa.get('/voorkeuren');
  assert.equal(prefs.status, 200);
  assert.match(prefs.text, /Buurt in Amsterdam/);
  const tok = (await aa.get('/voorkeuren')).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const save = await aa.post('/voorkeuren').type('form').send({ _csrf: tok, neighborhood: 'oost', max_distance_km: '5', pref_age_min: '25' });
  assert.equal(save.status, 302);
  const row = (await env.pool.query('SELECT neighborhood, max_distance_km, pref_age_min FROM users WHERE id=$1', [a.id])).rows[0];
  assert.deepEqual(row, { neighborhood: 'oost', max_distance_km: 5, pref_age_min: 25 });
});
