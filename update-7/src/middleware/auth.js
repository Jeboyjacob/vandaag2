'use strict';
const { readiness, livenessOk } = require('../services/users');

function loadUser({ pool, config }) {
  return async (req, res, next) => {
    res.locals.user = null;
    res.locals.unreadCount = 0;
    if (!req.session.userId) return next();
    try {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
      const user = rows[0];
      if (!user) {
        delete req.session.userId;
        return next();
      }
      if (user.status !== 'active') {
        return req.session.regenerate(() => {
          res.status(403).render('error', {
            title: 'Account geblokkeerd',
            message: 'Je account is door de beheerder geblokkeerd. Neem contact op met de beheerder als je denkt dat dit onterecht is.',
          });
        });
      }
      user.livenessOk = livenessOk(user, config.devMode);
      user.readiness = readiness(user, config.devMode);
      req.user = user;
      res.locals.user = user;
      const n = await pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id]);
      res.locals.unreadCount = n.rows[0].n;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.method === 'GET' ? req.originalUrl : undefined;
    return res.redirect('/inloggen');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/inloggen');
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Geen toegang', message: 'Deze pagina is alleen voor beheerders.' });
  }
  next();
}

/** Liveness passed (or dev bypass in dev mode) and a profile video uploaded. */
function requireReady(req, res, next) {
  if (!req.user) return res.redirect('/inloggen');
  if (!req.user.readiness.ready) return res.redirect('/start');
  next();
}

/** Nieuwe gebruikers zien eerst de drie uitleg-schermpjes. */
function requireIntro(req, res, next) {
  if (req.user && !req.user.intro_seen_at) return res.redirect('/uitleg/1');
  next();
}

module.exports = { loadUser, requireAuth, requireAdmin, requireReady, requireIntro };
