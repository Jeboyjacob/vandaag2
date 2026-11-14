'use strict';
const { tx } = require('../db');
const { generateSlots, formatTime, formatLongDate } = require('../lib/time');
const { pickBestSlot, suggestSlot, normalizeChoices, ValidationError } = require('../lib/scheduling');
const { chooseVenue } = require('./venues');

class DateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const PLANNING = ['collecting', 'no_overlap', 'proposed'];
const DELAY_OPTIONS = [5, 10, 15, 20, 30, 45, 60];
const MAX_SUGGESTIONS = 2; // zoveel tijdvoorstellen doet de app zelf voordat mensen zelf nieuwe tijden kiezen

function createDates({ pool, config, notifier }) {
  const minutes = (n) => n * 60000;

  /** Run a mutation in a transaction; deliver e-mails for created notifications after commit. */
  async function run(fn) {
    const pending = [];
    const notify = async (c, userId, n) => pending.push(await notifier.notify(userId, n, c));
    const result = await tx(pool, (c) => fn(c, notify));
    const deliveries = [];
    for (const n of pending) {
      const r = await notifier.deliverEmail(n).catch((e) => ({ status: 'failed', error: e.message }));
      deliveries.push({ userId: n.userId, ...r });
    }
    return { ...result, deliveries };
  }

  async function lockPlan(c, matchId, userId) {
    const { rows } = await c.query(
      `SELECT p.*, m.user_a, m.user_b, m.status AS match_status
         FROM date_plans p JOIN matches m ON m.id = p.match_id
        WHERE p.match_id = $1 FOR UPDATE OF p`,
      [matchId]
    );
    const plan = rows[0];
    if (!plan || (plan.user_a !== userId && plan.user_b !== userId)) {
      throw new DateError('NOT_FOUND', 'Deze match bestaat niet.');
    }
    plan.otherId = plan.user_a === userId ? plan.user_b : plan.user_a;
    return plan;
  }

  async function nameOf(c, userId) {
    const { rows } = await c.query('SELECT display_name FROM users WHERE id = $1', [userId]);
    return rows[0] ? rows[0].display_name : 'Je match';
  }

  async function setStatus(c, plan, status, extra = {}) {
    const fields = { status, ...extra };
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await c.query(`UPDATE date_plans SET ${sets}, updated_at = now() WHERE id = $1`, [
      plan.id,
      ...keys.map((k) => fields[k]),
    ]);
    Object.assign(plan, fields);
  }

  async function event(c, plan, userId, type, payload = {}) {
    await c.query('INSERT INTO date_events (plan_id, user_id, type, payload) VALUES ($1,$2,$3,$4)', [
      plan.id,
      userId,
      type,
      JSON.stringify(payload),
    ]);
  }

  /** Expire stale planning states and (re)assign a venue where needed. */
  async function refresh(c, plan, now) {
    if (PLANNING.includes(plan.status) && plan.match_status !== 'active') {
      await setStatus(c, plan, 'cancelled', { closed_at: now });
      return;
    }
    if (PLANNING.includes(plan.status)) {
      const startPassed = plan.status === 'proposed' && plan.proposed_start && plan.proposed_start <= now;
      const noSlotsLeft = plan.status !== 'proposed' && generateSlots(plan.day, config, now).length === 0;
      if (startPassed || noSlotsLeft) {
        await setStatus(c, plan, 'expired', { closed_at: now });
        return;
      }
    }
    if (plan.status === 'proposed') {
      let needVenue = !plan.venue_id;
      if (plan.venue_id) {
        const v = await c.query('SELECT active, deleted_at FROM venues WHERE id = $1', [plan.venue_id]);
        needVenue = !v.rows[0] || !v.rows[0].active || v.rows[0].deleted_at !== null;
      }
      if (needVenue) {
        const venue = await chooseVenue(c, plan.proposed_start);
        const newId = venue ? venue.id : null;
        if (newId !== plan.venue_id) {
          await setStatus(c, plan, 'proposed', { venue_id: newId, proposal_version: plan.proposal_version + 1 });
        }
      }
    }
  }

  // ---------- Read model ----------

  async function view(matchId, userId, now = new Date()) {
    // Apply time-based transitions first (in a short transaction).
    await tx(pool, async (c) => {
      const plan = await lockPlan(c, matchId, userId);
      await refresh(c, plan, now);
    });
    const c = pool;
    const plan = (
      await c.query(
        `SELECT p.*, m.user_a, m.user_b, m.status AS match_status, m.match_day
           FROM date_plans p JOIN matches m ON m.id = p.match_id WHERE p.match_id = $1`,
        [matchId]
      )
    ).rows[0];
    const otherId = plan.user_a === userId ? plan.user_b : plan.user_a;
    const other = (
      await c.query(
        `SELECT id, display_name, bio, prompts, interests, languages, video_key, liveness_status, age_verification_status,
                date_part('year', age((now() AT TIME ZONE 'Europe/Amsterdam')::date, birthdate))::int AS age
           FROM users WHERE id = $1`,
        [otherId]
      )
    ).rows[0];
    const venue = plan.venue_id ? (await c.query('SELECT * FROM venues WHERE id = $1', [plan.venue_id])).rows[0] : null;
    const myChoices = (
      await c.query(
        'SELECT slot_start, rank FROM time_choices WHERE plan_id=$1 AND user_id=$2 AND round=$3 ORDER BY rank',
        [plan.id, userId, plan.round]
      )
    ).rows;
    const subs = (
      await c.query('SELECT user_id FROM availability_submissions WHERE plan_id=$1 AND round=$2', [plan.id, plan.round])
    ).rows.map((r) => r.user_id);
    const confirmations = (
      await c.query('SELECT user_id, terms_accepted_at FROM date_confirmations WHERE plan_id=$1 AND proposal_version=$2', [
        plan.id,
        plan.proposal_version,
      ])
    ).rows;
    const events = (
      await c.query('SELECT * FROM date_events WHERE plan_id=$1 ORDER BY created_at DESC LIMIT 20', [plan.id])
    ).rows;
    const noShows = (await c.query('SELECT * FROM noshow_reports WHERE plan_id=$1', [plan.id])).rows;
    const blockedByMe = (
      await c.query('SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [userId, otherId])
    ).rowCount > 0;

    const slots = PLANNING.includes(plan.status) ? generateSlots(plan.day, config, now) : [];
    const start = plan.proposed_start;
    const noShowOpensAt = start ? new Date(start.getTime() + minutes(config.noShowReportDelayMinutes)) : null;
    return {
      plan,
      other,
      venue,
      slots,
      myChoices,
      iSubmitted: subs.includes(userId),
      otherSubmitted: subs.includes(otherId),
      iConfirmed: confirmations.some((r) => r.user_id === userId),
      otherConfirmed: confirmations.some((r) => r.user_id === otherId),
      events,
      myNoShowReport: noShows.find((r) => r.reporter_id === userId) || null,
      noShowAgainstMe: noShows.find((r) => r.reported_user_id === userId) || null,
      noShowOpensAt,
      canReportNoShow: plan.status === 'confirmed' && noShowOpensAt && now >= noShowOpensAt,
      startPassed: start ? now >= start : false,
      blockedByMe,
      delayOptions: DELAY_OPTIONS,
    };
  }

  // ---------- Mutations ----------

  async function submitChoices(matchId, userId, raw, now = new Date()) {
    return run(async (c, notify) => {
      const plan = await lockPlan(c, matchId, userId);
      await refresh(c, plan, now);
      if (!PLANNING.includes(plan.status)) throw new DateError('CLOSED', 'Voor deze match kun je geen tijden meer kiezen.');
      const allowed = generateSlots(plan.day, config, now);
      const choices = normalizeChoices(raw, allowed, config.maxTimeChoices);

      if (plan.status === 'no_overlap' || plan.status === 'proposed') {
        // Start a new round: everybody chooses again. Old confirmations no longer apply
        // because a new proposal always gets a new proposal_version.
        await setStatus(c, plan, 'collecting', {
          round: plan.round + 1,
          proposed_start: null,
          venue_id: null,
          suggested: false,
          suggest_count: 0,
          rejected_slots: [],
        });
      }
      await c.query('DELETE FROM time_choices WHERE plan_id=$1 AND user_id=$2 AND round=$3', [plan.id, userId, plan.round]);
      for (const ch of choices) {
        await c.query('INSERT INTO time_choices (plan_id, user_id, round, slot_start, rank) VALUES ($1,$2,$3,$4,$5)', [
          plan.id,
          userId,
          plan.round,
          ch.slotStart,
          ch.rank,
        ]);
      }
      await c.query(
        `INSERT INTO availability_submissions (plan_id, user_id, round) VALUES ($1,$2,$3)
         ON CONFLICT (plan_id, user_id, round) DO UPDATE SET submitted_at = now()`,
        [plan.id, userId, plan.round]
      );
      await event(c, plan, userId, 'times_submitted', { round: plan.round, count: choices.length });

      const otherSub = await c.query('SELECT 1 FROM availability_submissions WHERE plan_id=$1 AND user_id=$2 AND round=$3', [
        plan.id,
        plan.otherId,
        plan.round,
      ]);
      const myName = await nameOf(c, userId);
      const link = `/matches/${matchId}`;
      if (!otherSub.rowCount) {
        await notify(c, plan.otherId, {
          type: 'times_submitted',
          title: `⏰ ${myName} heeft tijden gekozen`,
          body: 'Nu jij nog! Kies je tijden voor vandaag, dan staat de date zo vast 🎉',
          link,
        });
        return { outcome: 'waiting' };
      }
      const rows = (
        await c.query('SELECT user_id, slot_start, rank FROM time_choices WHERE plan_id=$1 AND round=$2', [plan.id, plan.round])
      ).rows;
      const mine = rows.filter((r) => r.user_id === userId).map((r) => ({ slotStart: r.slot_start, rank: r.rank }));
      const theirs = rows.filter((r) => r.user_id === plan.otherId).map((r) => ({ slotStart: r.slot_start, rank: r.rank }));
      const minStart = new Date(now.getTime() + minutes(config.slotMinLeadMinutes) - 1);
      const best = pickBestSlot(mine, theirs, { now: minStart });

      if (best) {
        const venue = await chooseVenue(c, best.slotStart);
        if (venue) {
          // Allebei dezelfde tijd gekozen: meteen definitief, niemand hoeft nog iets te accepteren.
          await setStatus(c, plan, 'confirmed', {
            proposed_start: best.slotStart,
            venue_id: venue.id,
            proposal_version: plan.proposal_version + 1,
            suggested: false,
            confirmed_at: now,
          });
          for (const uid of [userId, plan.otherId]) {
            await c.query(
              `INSERT INTO date_confirmations (plan_id, user_id, proposal_version, confirmed_start, confirmed_venue_id)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [plan.id, uid, plan.proposal_version, best.slotStart, venue.id]
            );
          }
          await event(c, plan, null, 'confirmed', { auto: true, start: best.slotStart, venueId: venue.id, score: best.score });
          const when = `${formatLongDate(best.slotStart)} om ${formatTime(best.slotStart)}`;
          for (const uid of [userId, plan.otherId]) {
            await notify(c, uid, {
              type: 'confirmed',
              title: '🎉 Jullie date staat!',
              body: `${when} bij ${venue.name}. Zin in! 🥂 Kan het toch niet? Je kunt altijd annuleren in de app.`,
              link,
            });
          }
          return { outcome: 'confirmed', start: best.slotStart, venue };
        }
        // Wel overlap, maar nog geen open locatie: voorstel zonder locatie (bevestigen kan zodra er een is).
        await setStatus(c, plan, 'proposed', {
          proposed_start: best.slotStart,
          venue_id: null,
          proposal_version: plan.proposal_version + 1,
          suggested: false,
        });
        await event(c, plan, null, 'proposed', { start: best.slotStart, venueId: null, score: best.score });
        const when = `${formatLongDate(best.slotStart)} om ${formatTime(best.slotStart)}`;
        for (const uid of [userId, plan.otherId]) {
          await notify(c, uid, {
            type: 'proposed',
            title: '✨ Jullie hebben een gezamenlijke tijd!',
            body: `${when}. Er is alleen nog geen locatie beschikbaar; die komt er zo aan 🍸`,
            link,
          });
        }
        return { outcome: 'proposed', start: best.slotStart, venue: null };
      }

      // Geen overlap: de app doet zelf een voorstel dat zo dicht mogelijk bij beide wensen ligt.
      const suggestion = await makeSuggestion(c, plan, notify, now, { firstOne: true });
      if (suggestion) return { outcome: 'suggested', start: suggestion.start, venue: suggestion.venue };

      await setStatus(c, plan, 'no_overlap');
      await event(c, plan, null, 'no_overlap', { round: plan.round });
      for (const uid of [userId, plan.otherId]) {
        await notify(c, uid, {
          type: 'no_overlap',
          title: '🙈 Net niet op dezelfde tijd',
          body: 'Jullie tijden en een open bar of koffieplek kwamen net niet samen. Kies nog een paar andere tijden, dan lukt het vast alsnog! 💪',
          link,
        });
      }
      return { outcome: 'no_overlap' };
    });
  }

  /**
   * Geen gezamenlijke tijd: stel de beschikbare tijd voor die het dichtst bij beide wensen ligt
   * (en waar een open locatie is). Geeft null als er niets te vinden is.
   */
  async function makeSuggestion(c, plan, notify, now, { firstOne = false, declinedBy = null } = {}) {
    if (plan.suggest_count >= MAX_SUGGESTIONS) return null;
    const rows = (
      await c.query('SELECT user_id, slot_start, rank FROM time_choices WHERE plan_id=$1 AND round=$2', [plan.id, plan.round])
    ).rows;
    const a = rows.filter((r) => r.user_id === plan.user_a).map((r) => ({ slotStart: r.slot_start }));
    const b = rows.filter((r) => r.user_id === plan.user_b).map((r) => ({ slotStart: r.slot_start }));
    const minStart = now.getTime() + minutes(config.slotMinLeadMinutes) - 1;
    const allowed = generateSlots(plan.day, config, now).filter((d) => d.getTime() > minStart);
    const exclude = [...(plan.rejected_slots || [])];
    let pick = null;
    let venue = null;
    for (let i = 0; i < allowed.length + 1; i++) {
      const cand = suggestSlot(a, b, allowed, { exclude });
      if (!cand) break;
      const v = await chooseVenue(c, cand.slotStart);
      if (v) {
        pick = cand;
        venue = v;
        break;
      }
      exclude.push(cand.slotStart);
    }
    if (!pick) return null;

    await setStatus(c, plan, 'proposed', {
      proposed_start: pick.slotStart,
      venue_id: venue.id,
      proposal_version: plan.proposal_version + 1,
      suggested: true,
      suggest_count: plan.suggest_count + 1,
    });
    await event(c, plan, null, 'suggested', { start: pick.slotStart, venueId: venue.id, gapA: pick.gapA, gapB: pick.gapB });
    const when = `${formatLongDate(pick.slotStart)} om ${formatTime(pick.slotStart)}`;
    const intro = firstOne
      ? 'Jullie tijden vielen net naast elkaar 🙈 Daarom stelt Vandaag zelf iets voor:'
      : 'Geen probleem, hier is een ander voorstel:';
    for (const uid of [plan.user_a, plan.user_b]) {
      await notify(c, uid, {
        type: 'proposed',
        title: '💡 Vandaag heeft een voorstel voor jullie',
        body: `${intro} ${when} bij ${venue.name}. Past dat? Tik op “Ja, past!” in de app ✅`,
        link: `/matches/${plan.match_id}`,
      });
    }
    return { start: pick.slotStart, venue };
  }

  /** "Past niet": de app komt met een ander voorstel (max. twee keer), daarna kiezen jullie zelf. */
  async function declineProposal(matchId, userId, now = new Date()) {
    return run(async (c, notify) => {
      const plan = await lockPlan(c, matchId, userId);
      await refresh(c, plan, now);
      if (plan.status !== 'proposed' || !plan.suggested) {
        throw new DateError('NOT_PROPOSED', 'Er is geen voorstel van de app om af te wijzen.');
      }
      const name = await nameOf(c, userId);
      plan.rejected_slots = [...(plan.rejected_slots || []), plan.proposed_start];
      await c.query('UPDATE date_plans SET rejected_slots = $2 WHERE id = $1', [plan.id, plan.rejected_slots]);
      await event(c, plan, userId, 'suggestion_declined', { start: plan.proposed_start });
      const next = await makeSuggestion(c, plan, notify, now, { declinedBy: userId });
      if (next) return { outcome: 'new_suggestion', start: next.start, venue: next.venue, otherId: plan.otherId };

      await setStatus(c, plan, 'no_overlap', { suggested: false });
      await event(c, plan, null, 'no_overlap', { round: plan.round, afterSuggestions: true });
      for (const uid of [userId, plan.otherId]) {
        await notify(c, uid, {
          type: 'no_overlap',
          title: '🙈 Nog geen tijd die voor allebei past',
          body: `${uid === userId ? 'Kies' : `${name} en jij kiezen`} nog even zelf een paar andere tijden, dan lukt het vast alsnog! 💪`,
          link: `/matches/${matchId}`,
        });
      }
      return { outcome: 'no_overlap', otherId: plan.otherId };
    });
  }

  async function confirm(matchId, userId, { proposalVersion }, now = new Date()) {
    return run(async (c, notify) => {
      const plan = await lockPlan(c, matchId, userId);
      await refresh(c, plan, now);
      if (plan.status === 'confirmed') return { outcome: 'already_confirmed' };
      if (plan.status !== 'proposed') throw new DateError('NOT_PROPOSED', 'Er is geen open datevoorstel om te bevestigen.');
      if (!plan.venue_id) throw new DateError('NO_VENUE', 'Er is nog geen locatie beschikbaar, dus bevestigen kan nog niet.');
      if (Number(proposalVersion) !== plan.proposal_version) {
        throw new DateError('STALE', 'Het voorstel is intussen gewijzigd. Bekijk het nieuwe voorstel en bevestig opnieuw.');
      }

      const ins = await c.query(
        `INSERT INTO date_confirmations (plan_id, user_id, proposal_version, confirmed_start, confirmed_venue_id,
            terms_version, noshow_fee_cents, terms_accepted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING user_id`,
        [plan.id, userId, plan.proposal_version, plan.proposed_start, plan.venue_id, config.noShowTermsVersion, config.noShowFeeCents, now]
      );
      if (!ins.rowCount) return { outcome: 'duplicate' };
      await event(c, plan, userId, 'confirmed_by_user', { version: plan.proposal_version });

      const both = await c.query(
        `SELECT count(DISTINCT user_id)::int AS n FROM date_confirmations
          WHERE plan_id=$1 AND proposal_version=$2 AND confirmed_start=$3 AND confirmed_venue_id=$4`,
        [plan.id, plan.proposal_version, plan.proposed_start, plan.venue_id]
      );
      const myName = await nameOf(c, userId);
      const link = `/matches/${matchId}`;
      if (both.rows[0].n >= 2) {
        await setStatus(c, plan, 'confirmed', { confirmed_at: now });
        await event(c, plan, null, 'confirmed');
        for (const uid of [userId, plan.otherId]) {
          await notify(c, uid, {
            type: 'confirmed',
            title: '🎉 Jullie date staat!',
            body: `Vandaag om ${formatTime(plan.proposed_start)}. Bekijk de locatie in de app. Zin in! 🥂`,
            link,
          });
        }
        return { outcome: 'confirmed' };
      }
      await notify(c, plan.otherId, {
        type: 'confirmed_by_other',
        title: `✅ ${myName} zegt ja!`,
        body: 'Past het voor jou ook? Tik op “Ja, past!” en de date staat.',
        link,
      });
      return { outcome: 'waiting_other' };
    });
  }

  function requireConfirmed(plan) {
    if (plan.status !== 'confirmed') throw new DateError('NOT_CONFIRMED', 'Deze actie kan alleen bij een definitieve date.');
  }

  async function delay(matchId, userId, mins, now = new Date()) {
    const m = Number(mins);
    if (!DELAY_OPTIONS.includes(m)) throw new DateError('INVALID', 'Kies hoeveel minuten je later bent.');
    return run(async (c, notify) => {
      const plan = await lockPlan(c, matchId, userId);
      requireConfirmed(plan);
      if (now.getTime() > plan.proposed_start.getTime() + minutes(120)) {
        throw new DateError('TOO_LATE', 'Deze date is al te lang geleden begonnen.');
      }
      await event(c, plan, userId, 'delayed', { minutes: m });
      const name = await nameOf(c, userId);
      await notify(c, plan.otherId, {
        type: 'delayed',
        title: `🏃 ${name} is iets later`,
        body: `${name} verwacht ongeveer ${m} minuten later te zijn. Even geduld, het wordt gezellig! 😊`,
        link: `/matches/${matchId}`,
      });
      return { outcome: 'delayed', otherId: plan.otherId };
    });
  }

  async function cancel(matchId, userId, now = new Date()) {
    return run(async (c, notify) => {
      const plan = await lockPlan(c, matchId, userId);
      await refresh(c, plan, now);
      if (!['confirmed', 'proposed', 'collecting', 'no_overlap'].includes(plan.status)) {
        throw new DateError('CLOSED', 'Deze date is al afgesloten.');
      }
      if (plan.status === 'confirmed' && now >= plan.proposed_start) {
        throw new DateError('STARTED', 'De afgesproken starttijd is al voorbij; annuleren kan niet meer.');
      }
      const wasConfirmed = plan.status === 'confirmed';
      await setStatus(c, plan, 'cancelled', { closed_by: userId, closed_at: now });
      await event(c, plan, userId, 'cancelled', { wasConfirmed });
      const name = await nameOf(c, userId);
      await notify(c, plan.otherId, {
        type: 'cancelled',
        title: wasConfirmed ? '😕 Helaas, je date heeft geannuleerd' : '😕 Deze date gaat helaas niet door',
        body: 'Maar niet getreurd: er komt snel een nieuwe match jouw kant op! 💫 Blijf swipen, de volgende kan de ware zijn.',
        link: `/matches/${matchId}`,
      });
      return { outcome: 'cancelled', otherId: plan.otherId };
    });
  }

  /** Block another user; ends the match and cancels any open or confirmed date. */
  async function blockInTx(c, notify, blockerId, blockedId, now) {
    await c.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [blockerId, blockedId]);
    const [a, b] = blockerId < blockedId ? [blockerId, blockedId] : [blockedId, blockerId];
    const m = await c.query(`UPDATE matches SET status='ended' WHERE user_a=$1 AND user_b=$2 RETURNING id`, [a, b]);
    if (!m.rowCount) return;
    const planRes = await c.query('SELECT * FROM date_plans WHERE match_id=$1 FOR UPDATE', [m.rows[0].id]);
    const plan = planRes.rows[0];
    if (plan && [...PLANNING, 'confirmed'].includes(plan.status)) {
      const wasConfirmed = plan.status === 'confirmed';
      await setStatus(c, plan, 'cancelled', { closed_by: blockerId, closed_at: now });
      await event(c, plan, blockerId, 'cancelled_by_block');
      if (wasConfirmed) {
        await notify(c, blockedId, {
          type: 'cancelled',
          title: '😕 Helaas, je date gaat niet door',
          body: 'Maar niet getreurd: er komt snel een nieuwe match jouw kant op! 💫 Blijf swipen.',
          link: '/ontdekken',
        });
      }
    }
  }

  async function block(blockerId, blockedId, now = new Date()) {
    if (blockerId === blockedId) throw new DateError('INVALID', 'Je kunt jezelf niet blokkeren.');
    return run(async (c, notify) => {
      const u = await c.query('SELECT 1 FROM users WHERE id=$1', [blockedId]);
      if (!u.rowCount) throw new DateError('NOT_FOUND', 'Gebruiker niet gevonden.');
      await blockInTx(c, notify, blockerId, blockedId, now);
      return { outcome: 'blocked' };
    });
  }

  async function endUnsafe(matchId, userId, { doBlock, doReport, details }, now = new Date()) {
    return run(async (c, notify) => {
      const plan = await lockPlan(c, matchId, userId);
      requireConfirmed(plan);
      await setStatus(c, plan, 'ended_unsafe', { closed_by: userId, closed_at: now });
      await event(c, plan, userId, 'ended_unsafe', { block: Boolean(doBlock), report: Boolean(doReport) });
      const name = await nameOf(c, userId);
      // Neutral message on purpose: the other user is not told why.
      await notify(c, plan.otherId, {
        type: 'ended',
        title: '😕 Je date is beëindigd',
        body: 'De afspraak van vandaag gaat niet (verder) door. Niet getreurd, er wacht vast iemand leuks! 💫 Blijf swipen.',
        link: `/matches/${matchId}`,
      });
      if (doReport) {
        await c.query(
          `INSERT INTO reports (reporter_id, reported_user_id, kind, reason, details, plan_id)
           VALUES ($1,$2,'unsafe_date','Voelde zich niet veilig tijdens/voor de date',$3,$4)`,
          [userId, plan.otherId, String(details || '').slice(0, 2000), plan.id]
        );
      }
      if (doBlock) {
        await blockInTx(c, notify, userId, plan.otherId, now);
      }
      return { outcome: 'ended', otherId: plan.otherId };
    });
  }

  async function reportNoShow(matchId, userId, now = new Date()) {
    return run(async (c, notify) => {
      const plan = await lockPlan(c, matchId, userId);
      requireConfirmed(plan);
      const opens = plan.proposed_start.getTime() + minutes(config.noShowReportDelayMinutes);
      if (now.getTime() < opens) {
        throw new DateError(
          'TOO_EARLY',
          `Een no-show melden kan pas ${config.noShowReportDelayMinutes} minuten na de afgesproken starttijd.`
        );
      }
      const venue = (await c.query('SELECT name, street_address, postcode FROM venues WHERE id=$1', [plan.venue_id])).rows[0];
      const ins = await c.query(
        `INSERT INTO noshow_reports (plan_id, reporter_id, reported_user_id, scheduled_start, venue_name, venue_address, fee_cents, reported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (plan_id, reporter_id) DO NOTHING RETURNING id`,
        [plan.id, userId, plan.otherId, plan.proposed_start, venue.name, `${venue.street_address}, ${venue.postcode} Amsterdam`, config.noShowFeeCents, now]
      );
      if (!ins.rowCount) throw new DateError('DUPLICATE', 'Je hebt voor deze date al een no-show gemeld.');
      await event(c, plan, userId, 'noshow_reported', { reportId: ins.rows[0].id });
      await notify(c, plan.otherId, {
        type: 'noshow_reported',
        title: '⚠️ Er is een no-show over jou gemeld',
        body: `Je match meldt dat je niet bent gekomen. Klopt dat niet? Je kunt binnen ${config.noShowDisputeDays} dagen bezwaar maken in de app. Er wordt niets geïnd zolang de melding niet is beoordeeld.`,
        link: `/no-shows/${ins.rows[0].id}`,
      });
      return { outcome: 'reported', reportId: ins.rows[0].id, otherId: plan.otherId };
    });
  }

  async function disputeNoShow(reportId, userId, text, now = new Date()) {
    const clean = String(text || '').trim();
    if (clean.length < 10) throw new DateError('INVALID', 'Leg in minstens 10 tekens uit waarom de melding niet klopt.');
    return run(async (c, notify) => {
      const r = (await c.query('SELECT * FROM noshow_reports WHERE id=$1 FOR UPDATE', [reportId])).rows[0];
      if (!r || r.reported_user_id !== userId) throw new DateError('NOT_FOUND', 'Melding niet gevonden.');
      if (r.status !== 'reported') throw new DateError('CLOSED', 'Voor deze melding kun je geen bezwaar (meer) maken.');
      if (now.getTime() > r.reported_at.getTime() + config.noShowDisputeDays * 86400000) {
        throw new DateError('TOO_LATE', 'De bezwaartermijn is verlopen.');
      }
      await c.query(`UPDATE noshow_reports SET status='disputed', dispute_text=$2, disputed_at=$3 WHERE id=$1`, [
        reportId,
        clean.slice(0, 4000),
        now,
      ]);
      if (r.reporter_id) {
        await notify(c, r.reporter_id, {
          type: 'noshow_disputed',
          title: '📩 Bezwaar tegen je no-showmelding',
          body: 'Je match heeft bezwaar gemaakt. De beheerder beoordeelt de melding.',
          link: `/no-shows/${reportId}`,
        });
      }
      return { outcome: 'disputed' };
    });
  }

  return { view, submitChoices, confirm, declineProposal, delay, cancel, endUnsafe, block, reportNoShow, disputeNoShow, run, DELAY_OPTIONS };
}

module.exports = { createDates, DateError, ValidationError };
