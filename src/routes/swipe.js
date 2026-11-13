'use strict';
const express = require('express');
const { requireReady } = require('../middleware/auth');

module.exports = (ctx) => {
  const { matching } = ctx;
  const r = express.Router();

  r.get('/ontdekken', requireReady, async (req, res, next) => {
    try {
      const profile = await matching.nextProfile(req.user.id);
      res.render('discover', { title: 'Ontdekken', profile });
    } catch (err) {
      next(err);
    }
  });

  r.post('/swipe', requireReady, async (req, res, next) => {
    try {
      const targetId = Number(req.body.target_id);
      const direction = req.body.direction;
      if (!Number.isInteger(targetId)) return res.status(400).render('error', { title: 'Ongeldig', message: 'Ongeldige swipe.' });
      let result;
      try {
        result = await matching.swipe(req.user.id, targetId, direction);
      } catch (err) {
        if (err.code === 'NOT_AVAILABLE' || err.code === 'INVALID') {
          req.flash('warning', `${err.message} Op naar de volgende! 🔥`);
          return res.redirect('/ontdekken');
        }
        throw err;
      }
      if (result.duplicate) req.flash('warning', 'Deze had je al gezien 😉 Op naar de volgende!');
      if (result.matched && result.isNew) {
        req.flash('success', '💘 Het is een match! Kies nu de tijden waarop je vandaag kunt.');
        return res.redirect(`/matches/${result.matchId}`);
      }
      res.redirect('/ontdekken');
    } catch (err) {
      next(err);
    }
  });

  return r;
};
