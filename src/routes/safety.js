'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { DateError } = require('../services/dates');

const REASONS = [
  'Nepprofiel of iemand anders',
  'Ongepaste of seksuele video',
  'Lijkt jonger dan 18',
  'Intimidatie of bedreiging',
  'Spam of reclame',
  'Anders',
];

module.exports = (ctx) => {
  const { pool, dates } = ctx;
  const r = express.Router();

  async function loadTarget(req, res) {
    const id = Number(req.params.userId);
    if (!Number.isInteger(id) || id === req.user.id) return null;
    const { rows } = await pool.query('SELECT id, display_name FROM users WHERE id=$1', [id]);
    return rows[0] || null;
  }

  r.get('/melden/:userId', requireAuth, async (req, res, next) => {
    try {
      const target = await loadTarget(req, res);
      if (!target) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Gebruiker niet gevonden.' });
      res.render('report', { title: 'Melden', target, reasons: REASONS, error: null });
    } catch (err) {
      next(err);
    }
  });

  r.post('/melden/:userId', requireAuth, async (req, res, next) => {
    try {
      const target = await loadTarget(req, res);
      if (!target) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Gebruiker niet gevonden.' });
      const kind = req.body.kind === 'video' ? 'video' : 'profile';
      const reason = String(req.body.reason || '');
      if (!REASONS.includes(reason)) {
        return res.status(422).render('report', { title: 'Melden', target, reasons: REASONS, error: 'Kies een reden.' });
      }
      await pool.query(
        `INSERT INTO reports (reporter_id, reported_user_id, kind, reason, details) VALUES ($1,$2,$3,$4,$5)`,
        [req.user.id, target.id, kind, reason, String(req.body.details || '').slice(0, 2000)]
      );
      if (req.body.also_block === 'yes') await dates.block(req.user.id, target.id);
      req.flash('success', `Je melding is ontvangen en wordt door de beheerder bekeken.${req.body.also_block === 'yes' ? ' Je hebt deze persoon ook geblokkeerd.' : ''}`);
      res.redirect(req.body.also_block === 'yes' ? '/ontdekken' : '/');
    } catch (err) {
      next(err);
    }
  });

  r.post('/blokkeren/:userId', requireAuth, async (req, res, next) => {
    try {
      const target = await loadTarget(req, res);
      if (!target) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Gebruiker niet gevonden.' });
      await dates.block(req.user.id, target.id);
      req.flash('success', `${target.display_name} is geblokkeerd. Jullie zien elkaar niet meer.`);
      res.redirect('/matches');
    } catch (err) {
      if (err instanceof DateError) {
        req.flash('error', err.message);
        return res.redirect('/matches');
      }
      next(err);
    }
  });

  r.get('/geblokkeerd', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.display_name, b.created_at FROM blocks b JOIN users u ON u.id = b.blocked_id
          WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
        [req.user.id]
      );
      res.render('blocked', { title: 'Geblokkeerd', blocked: rows });
    } catch (err) {
      next(err);
    }
  });

  r.post('/geblokkeerd/:userId/opheffen', requireAuth, async (req, res, next) => {
    try {
      await pool.query('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.user.id, Number(req.params.userId) || 0]);
      req.flash('success', 'Blokkade opgeheven. Een eerdere match komt niet terug.');
      res.redirect('/geblokkeerd');
    } catch (err) {
      next(err);
    }
  });

  return r;
};
