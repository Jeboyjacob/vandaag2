'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');

module.exports = (ctx) => {
  const { pool, config, integrations } = ctx;
  const r = express.Router();

  /** Onboarding checklist: what is still needed before the user can swipe. */
  r.get('/start', requireAuth, (req, res) => {
    if (req.user.readiness.ready) return res.redirect('/ontdekken');
    res.render('start', { title: 'Je account afronden' });
  });

  r.get('/verificatie', requireAuth, (req, res) => {
    res.render('verify', {
      title: 'Verificatie',
      liveness: integrations.liveness,
      ageVerification: integrations.ageVerification,
    });
  });

  r.post('/verificatie/gezicht/start', requireAuth, async (req, res, next) => {
    try {
      if (!integrations.liveness.configured) {
        return res.status(503).render('error', { title: 'Nog niet beschikbaar', message: 'De gezichtscheck is nog niet beschikbaar. Er is nog geen verificatiedienst gekoppeld.' });
      }
      // A real adapter returns a provider-hosted URL or SDK token; status becomes
      // 'passed' only through the provider's signed webhook.
      const session = await integrations.liveness.startSession(req.user);
      await pool.query(
        `UPDATE users SET liveness_status='pending', liveness_provider=$2, liveness_reference=$3 WHERE id=$1`,
        [req.user.id, integrations.liveness.providerName, session.reference]
      );
      res.redirect(session.redirectUrl);
    } catch (err) {
      next(err);
    }
  });

  r.post('/verificatie/leeftijd/start', requireAuth, async (req, res, next) => {
    try {
      if (!integrations.ageVerification.configured) {
        return res.status(503).render('error', { title: 'Nog niet beschikbaar', message: 'Leeftijdsverificatie is nog niet beschikbaar. Er is nog geen verificatiedienst gekoppeld.' });
      }
      const session = await integrations.ageVerification.startSession(req.user);
      await pool.query(
        `UPDATE users SET age_verification_status='pending', age_verification_provider=$2, age_verification_reference=$3 WHERE id=$1`,
        [req.user.id, integrations.ageVerification.providerName, session.reference]
      );
      res.redirect(session.redirectUrl);
    } catch (err) {
      next(err);
    }
  });

  /** Development only: skip the face check. Never counts as verification. */
  r.post('/verificatie/dev-overslaan', requireAuth, async (req, res) => {
    if (!config.devMode) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Deze pagina bestaat niet.' });
    await pool.query(`UPDATE users SET liveness_status='dev_bypass' WHERE id=$1 AND liveness_status <> 'passed'`, [req.user.id]);
    req.flash('warning', 'Ontwikkelmodus: gezichtscheck overgeslagen. Dit is GEEN verificatie en werkt niet in productie.');
    res.redirect('/start');
  });

  return r;
};
