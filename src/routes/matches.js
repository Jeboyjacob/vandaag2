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
      if (result.outcome === 'waiting') req.flash('success', 'Je tijden zijn opgeslagen. We wachten op je match.');
      if (result.outcome === 'no_overlap') req.flash('warning', 'Jullie tijden overlappen niet. Kies andere tijden.');
      if (result.outcome === 'proposed') req.flash('success', 'Er is een gezamenlijke tijd gevonden!');
      return result;
    })
  );

  r.post(
    '/matches/:id/bevestigen',
    requireAuth,
    action(async (req) => {
      const result = await dates.confirm(matchId(req), req.user.id, {
        acceptTerms: req.body.accept_noshow_terms === 'yes',
        proposalVersion: req.body.proposal_version,
      });
      const msg = {
        confirmed: 'Jullie date is definitief!',
        waiting_other: 'Je hebt bevestigd. De date is definitief zodra je match ook bevestigt.',
        duplicate: 'Je had dit voorstel al bevestigd.',
        already_confirmed: 'Deze date was al definitief.',
      }[result.outcome];
      req.flash('success', msg);
      return result;
    })
  );

  r.post(
    '/matches/:id/vertraagd',
    requireAuth,
    action(async (req) => {
      const result = await dates.delay(matchId(req), req.user.id, req.body.minutes);
      req.flash('success', 'Je vertraging is doorgegeven.');
      return result;
    })
  );

  r.post(
    '/matches/:id/annuleren',
    requireAuth,
    action(async (req) => {
      if (req.body.confirm !== 'yes') throw new DateError('INVALID', 'Bevestig dat je wilt annuleren.');
      const result = await dates.cancel(matchId(req), req.user.id);
      req.flash('success', 'De date is geannuleerd.');
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
      req.flash('success', `De date is beëindigd${extra ? ` en je match is ${extra}` : ''}.`);
      return result;
    })
  );

  r.post(
    '/matches/:id/no-show',
    requireAuth,
    action(async (req) => {
      const result = await dates.reportNoShow(matchId(req), req.user.id);
      req.flash('success', 'Je no-showmelding is vastgelegd. Je match kan bezwaar maken; de beheerder beoordeelt de melding.');
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
