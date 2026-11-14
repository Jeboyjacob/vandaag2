'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { DateError, ValidationError } = require('../services/dates');

module.exports = (ctx) => {
  const { dates, matching, notifier, pool } = ctx;
  const r = express.Router();

  const matchId = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new DateError('NOT_FOUND', 'Deze match bestaat niet.');
    return id;
  };

  /** Wrap an action: known errors become a flash message, delivery status is reported honestly. */
  function action(fn) {
    return async (req, res, next) => {
      const back = `/matches/${req.params.id}`;
      try {
        const result = await fn(req, res);
        if (result && result.otherId && result.deliveries) {
          const d = result.deliveries.find((x) => x.userId === result.otherId);
          if (d) {
            const other = (await pool.query('SELECT display_name FROM users WHERE id=$1', [result.otherId])).rows[0];
            req.flash('info', notifier.describeDelivery(other ? other.display_name : 'Je match', d));
          }
        }
        if (!res.headersSent) res.redirect(back);
      } catch (err) {
        if (err instanceof DateError || err instanceof ValidationError) {
          if (err.code === 'NOT_FOUND') {
            return res.status(404).render('error', { title: 'Niet gevonden', message: err.message });
          }
          req.flash('error', err.message);
          return res.redirect(back);
        }
        next(err);
      }
    };
  }

  r.get('/matches', requireAuth, async (req, res, next) => {
    try {
      res.render('matches/list', { title: 'Matches', matches: await matching.listMatches(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  r.get('/matches/:id', requireAuth, async (req, res, next) => {
    try {
      const data = await dates.view(matchId(req), req.user.id);
      res.render('matches/show', { title: `Date met ${data.other.display_name}`, ...data, changeTimes: req.query.wijzig === '1' });
    } catch (err) {
      if (err instanceof DateError && err.code === 'NOT_FOUND') {
        return res.status(404).render('error', { title: 'Niet gevonden', message: err.message });
      }
      next(err);
    }
  });

  /** Agenda-bestand (.ics): werkt met Apple Agenda, Google Agenda en Outlook. */
  r.get('/matches/:id/agenda.ics', requireAuth, async (req, res, next) => {
    try {
      const data = await dates.view(matchId(req), req.user.id);
      if (data.plan.status !== 'confirmed' || !data.plan.proposed_start) return res.redirect(`/matches/${req.params.id}`);
      const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
      const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const start = new Date(data.plan.proposed_start);
      const end = new Date(start.getTime() + 90 * 60000);
      const v = data.venue;
      const where = v ? `${v.name}, ${v.street_address}, ${v.postcode} ${v.city}` : '';
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Vandaag//Date//NL',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:date-${data.plan.id}-${data.plan.proposal_version}@vandaag`,
        `DTSTAMP:${stamp(new Date())}`,
        `DTSTART:${stamp(start)}`,
        `DTEND:${stamp(end)}`,
        `SUMMARY:${esc(`Date met ${data.other.display_name} 🥂`)}`,
        `LOCATION:${esc(where)}`,
        `DESCRIPTION:${esc('Je date via Vandaag. Kan het toch niet? Annuleer in de app.')}`,
        'BEGIN:VALARM',
        'TRIGGER:-PT1H',
        'ACTION:DISPLAY',
        `DESCRIPTION:${esc('Je date begint over een uur!')}`,
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n');
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="vandaag-date.ics"');
      res.send(ics);
    } catch (err) {
      if (err instanceof DateError) return res.status(404).render('error', { title: 'Niet gevonden', message: err.message });
      next(err);
    }
  });

  r.post(
    '/matches/:id/tijden',
    requireAuth,
    action(async (req) => {
      // Form sends rank_<ISO> = number
      const raw = [];
      for (const [k, v] of Object.entries(req.body)) {
        if (k.startsWith('rank_') && v !== '') raw.push({ slot: k.slice(5), rank: v });
      }
      const result = await dates.submitChoices(matchId(req), req.user.id, raw);
      const msg = {
        waiting: 'Top, je tijden staan erin ✅ Zodra je match ook kiest, hoor je het meteen. Swipe intussen lekker verder 🔥',
        confirmed: '🎉 Jullie hadden dezelfde tijd gekozen, dus de date staat! Zin in!',
        proposed: '✨ Jullie hebben een gezamenlijke tijd. De locatie volgt zo.',
        suggested: '💡 Jullie tijden vielen net naast elkaar, dus Vandaag heeft een voorstel gedaan. Past het? Tik op “Ja, past!”.',
        no_overlap: '🙈 Net niet op dezelfde tijd gelukt. Kies nog een paar andere tijden, dan komt het goed!',
      }[result.outcome];
      if (msg) req.flash(['no_overlap'].includes(result.outcome) ? 'warning' : 'success', msg);
      return result;
    })
  );

  r.post(
    '/matches/:id/bevestigen',
    requireAuth,
    action(async (req) => {
      const result = await dates.confirm(matchId(req), req.user.id, {
        proposalVersion: req.body.proposal_version,
      });
      const msg = {
        confirmed: '🎉 Jullie date staat! Zin in!',
        waiting_other: '✅ Top! Zodra je match ook ja zegt, staat de date. Swipe intussen lekker verder 🔥',
        duplicate: 'Je had al ja gezegd 😊',
        already_confirmed: 'Deze date staat al 🎉',
      }[result.outcome];
      req.flash('success', msg);
      return result;
    })
  );

  r.post(
    '/matches/:id/past-niet',
    requireAuth,
    action(async (req) => {
      const result = await dates.declineProposal(matchId(req), req.user.id);
      req.flash(
        result.outcome === 'new_suggestion' ? 'success' : 'warning',
        result.outcome === 'new_suggestion'
          ? '👍 Geen probleem! Hier is een ander voorstel.'
          : '🙈 Nog geen tijd die voor allebei past. Kies zelf een paar andere tijden, dan lukt het vast!'
      );
      return result;
    })
  );

  r.post(
    '/matches/:id/vertraagd',
    requireAuth,
    action(async (req) => {
      const result = await dates.delay(matchId(req), req.user.id, req.body.minutes);
      req.flash('success', '🏃 Doorgegeven! Je match weet dat je iets later bent.');
      return result;
    })
  );

  r.post(
    '/matches/:id/annuleren',
    requireAuth,
    action(async (req) => {
      if (req.body.confirm !== 'yes') throw new DateError('INVALID', 'Bevestig dat je wilt annuleren.');
      const result = await dates.cancel(matchId(req), req.user.id);
      req.flash('success', 'De date is geannuleerd. Geen zorgen, er komen vast nieuwe matches 💫 Ga lekker verder swipen!');
      return result;
    })
  );

  r.get('/matches/:id/onveilig', requireAuth, async (req, res, next) => {
    try {
      const data = await dates.view(matchId(req), req.user.id);
      if (data.plan.status !== 'confirmed') return res.redirect(`/matches/${req.params.id}`);
      res.render('matches/unsafe', { title: 'Ik voel me niet veilig', ...data });
    } catch (err) {
      if (err instanceof DateError) return res.status(404).render('error', { title: 'Niet gevonden', message: err.message });
      next(err);
    }
  });

  r.post(
    '/matches/:id/onveilig',
    requireAuth,
    action(async (req) => {
      const result = await dates.endUnsafe(matchId(req), req.user.id, {
        doBlock: req.body.block === 'yes',
        doReport: req.body.report === 'yes',
        details: req.body.details,
      });
      const extra = [req.body.block === 'yes' ? 'geblokkeerd' : null, req.body.report === 'yes' ? 'gemeld bij de beheerder' : null]
        .filter(Boolean)
        .join(' en ');
      req.flash('success', `De date is beëindigd${extra ? ` en je match is ${extra}` : ''}. Fijn dat je het aangaf 💛 Pas goed op jezelf.`);
      return result;
    })
  );

  r.post(
    '/matches/:id/no-show',
    requireAuth,
    action(async (req) => {
      const result = await dates.reportNoShow(matchId(req), req.user.id);
      req.flash('success', 'Je melding is vastgelegd. Jammer dat het zo ging 😕 Je match kan bezwaar maken; de beheerder beoordeelt het. Kop op: er komt vast een betere date!');
      return result;
    })
  );

  // ---------- No-show detail & dispute ----------
  r.get('/no-shows/:id', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT n.*, p.match_id FROM noshow_reports n LEFT JOIN date_plans p ON p.id = n.plan_id
          WHERE n.id = $1 AND ($2 IN (n.reporter_id, n.reported_user_id))`,
        [Number(req.params.id) || 0, req.user.id]
      );
      if (!rows[0]) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Melding niet gevonden.' });
      res.render('noshow', { title: 'No-showmelding', report: rows[0], paymentsConfigured: ctx.integrations.payments.configured });
    } catch (err) {
      next(err);
    }
  });

  r.post('/no-shows/:id/bezwaar', requireAuth, async (req, res, next) => {
    const back = `/no-shows/${req.params.id}`;
    try {
      await dates.disputeNoShow(Number(req.params.id) || 0, req.user.id, req.body.dispute_text);
      req.flash('success', 'Je bezwaar is ingediend. De beheerder beoordeelt de melding.');
      res.redirect(back);
    } catch (err) {
      if (err instanceof DateError) {
        req.flash('error', err.message);
        return res.redirect(back);
      }
      next(err);
    }
  });

  return r;
};
