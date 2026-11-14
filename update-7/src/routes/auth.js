'use strict';
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { hashPassword, verifyPassword, dummyHash, randomToken, sha256 } = require('../lib/security');
const { ageOn, parseBirthdate } = require('../lib/age');
const { amsterdamDate } = require('../lib/time');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MIN_PASSWORD = 10;

function registrationOpen(ctx) {
  return ctx.integrations.liveness.configured || ctx.config.devMode;
}

function validatePassword(pw, pw2) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Kies een wachtwoord van minstens ${MIN_PASSWORD} tekens.`;
  if (pw.length > 200) return 'Wachtwoord is te lang.';
  if (pw !== pw2) return 'De wachtwoorden komen niet overeen.';
  return null;
}

function login(req, user, cb) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return cb(err);
    req.session.userId = user.id;
    cb(null, returnTo);
  });
}

module.exports = (ctx) => {
  const { pool, config, mailer } = ctx;
  const r = express.Router();
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => config.rateLimitDisabled,
    handler: (req, res) =>
      res.status(429).render('error', { title: 'Te veel pogingen', message: 'Te veel pogingen. Wacht een kwartier en probeer het opnieuw.' }),
  });

  r.get('/', (req, res) => {
    if (req.user) return res.redirect(req.user.readiness.ready ? '/ontdekken' : '/start');
    res.render('home', { title: 'Vandaag nog daten', registrationOpen: registrationOpen(ctx) });
  });

  // ---------- Registration ----------
  r.get('/registreren', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('auth/register', { title: 'Account maken', registrationOpen: registrationOpen(ctx), values: {}, errors: [] });
  });

  r.post('/registreren', limiter, async (req, res, next) => {
    try {
      if (!registrationOpen(ctx)) {
        return res.status(503).render('auth/register', {
          title: 'Account maken',
          registrationOpen: false,
          values: {},
          errors: ['Registratie is gesloten omdat de gezichtscheck nog niet beschikbaar is.'],
        });
      }
      const email = String(req.body.email || '').trim().toLowerCase();
      const name = String(req.body.display_name || '').trim();
      const birthdate = parseBirthdate(String(req.body.birthdate || ''));
      const errors = [];
      if (!EMAIL_RE.test(email)) errors.push('Vul een geldig e-mailadres in.');
      if (!name || name.length > 40) errors.push('Vul een voornaam of roepnaam in (max. 40 tekens).');
      if (!birthdate) errors.push('Vul een geldige geboortedatum in.');
      const pwErr = validatePassword(req.body.password, req.body.password_confirm);
      if (pwErr) errors.push(pwErr);
      if (!req.body.accept_terms) errors.push('Je moet akkoord gaan met de voorwaarden en het privacybeleid.');
      let underage = false;
      if (birthdate) {
        const age = ageOn(birthdate, amsterdamDate());
        if (age < 18) underage = true;
        else if (age > 110) errors.push('Controleer je geboortedatum.');
      }
      if (underage) {
        // Block, and store nothing about the person.
        return res.status(403).render('auth/underage', { title: 'Alleen voor 18+' });
      }
      if (errors.length) {
        return res.status(422).render('auth/register', { title: 'Account maken', registrationOpen: true, values: { email, display_name: name, birthdate: req.body.birthdate }, errors });
      }
      const exists = await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
      if (exists.rowCount) {
        return res.status(422).render('auth/register', {
          title: 'Account maken',
          registrationOpen: true,
          values: { email, display_name: name, birthdate },
          errors: ['Er bestaat al een account met dit e-mailadres. Log in of herstel je wachtwoord.'],
        });
      }
      const hash = await hashPassword(req.body.password);
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, display_name, birthdate) VALUES ($1,$2,$3,$4) RETURNING id`,
        [email, hash, name, birthdate]
      );
      login(req, { id: rows[0].id }, (err) => {
        if (err) return next(err);
        req.flash('success', 'Welkom bij Vandaag 🎉 Je account staat klaar!');
        res.redirect('/start');
      });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(422).render('auth/register', { title: 'Account maken', registrationOpen: true, values: {}, errors: ['Er bestaat al een account met dit e-mailadres.'] });
      }
      next(err);
    }
  });

  // ---------- Login / logout ----------
  r.get('/inloggen', (req, res) => {
    if (req.user) return res.redirect('/');
    res.render('auth/login', { title: 'Inloggen', email: '', error: null });
  });

  r.post('/inloggen', limiter, async (req, res, next) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const { rows } = await pool.query('SELECT id, password_hash, status FROM users WHERE lower(email) = $1', [email]);
      const user = rows[0];
      const ok = user ? await verifyPassword(password, user.password_hash) : (await verifyPassword(password, await dummyHash()), false);
      if (!ok) {
        return res.status(401).render('auth/login', { title: 'Inloggen', email, error: 'E-mailadres of wachtwoord klopt niet.' });
      }
      if (user.status !== 'active') {
        return res.status(403).render('auth/login', { title: 'Inloggen', email, error: 'Dit account is geblokkeerd door de beheerder.' });
      }
      login(req, user, (err, returnTo) => {
        if (err) return next(err);
        res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
      });
    } catch (err) {
      next(err);
    }
  });

  r.post('/uitloggen', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('sid');
      res.redirect('/');
    });
  });

  // ---------- Password reset ----------
  r.get('/wachtwoord-vergeten', (req, res) => {
    res.render('auth/forgot', { title: 'Wachtwoord vergeten', available: mailer.canDeliver(), message: null, error: null });
  });

  r.post('/wachtwoord-vergeten', limiter, async (req, res, next) => {
    try {
      if (!mailer.canDeliver()) {
        return res.status(503).render('auth/forgot', { title: 'Wachtwoord vergeten', available: false, message: null, error: null });
      }
      const email = String(req.body.email || '').trim().toLowerCase();
      const { rows } = await pool.query('SELECT id, email FROM users WHERE lower(email) = $1', [email]);
      let message = 'Als dit e-mailadres bij een account hoort, is er een herstellink naartoe gestuurd. De link is 1 uur geldig.';
      if (rows[0]) {
        const token = randomToken(32);
        await pool.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`,
          [rows[0].id, sha256(token)]
        );
        const result = await mailer.send({
          to: rows[0].email,
          subject: 'Wachtwoord herstellen',
          text: `Via deze link stel je een nieuw wachtwoord in (1 uur geldig):\n${config.baseUrl}/wachtwoord-herstellen/${token}\n\nHeb jij dit niet aangevraagd? Dan kun je deze e-mail negeren.`,
        });
        if (result.status === 'failed') {
          return res.status(502).render('auth/forgot', {
            title: 'Wachtwoord vergeten',
            available: true,
            message: null,
            error: 'Het versturen van de e-mail is mislukt. Probeer het later opnieuw.',
          });
        }
      }
      if (config.devMode && !mailer.isConfigured()) {
        message = 'Ontwikkelmodus: er is GEEN e-mail verstuurd. Als het account bestaat, staat de herstellink in de serverlog.';
      }
      res.render('auth/forgot', { title: 'Wachtwoord vergeten', available: true, message, error: null });
    } catch (err) {
      next(err);
    }
  });

  async function findToken(token) {
    const { rows } = await pool.query(
      `SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [sha256(String(token))]
    );
    return rows[0] || null;
  }

  r.get('/wachtwoord-herstellen/:token', async (req, res, next) => {
    try {
      const t = await findToken(req.params.token);
      res.render('auth/reset', { title: 'Nieuw wachtwoord', valid: Boolean(t), token: req.params.token, error: null });
    } catch (err) {
      next(err);
    }
  });

  r.post('/wachtwoord-herstellen/:token', limiter, async (req, res, next) => {
    try {
      const t = await findToken(req.params.token);
      if (!t) return res.status(400).render('auth/reset', { title: 'Nieuw wachtwoord', valid: false, token: '', error: null });
      const pwErr = validatePassword(req.body.password, req.body.password_confirm);
      if (pwErr) return res.status(422).render('auth/reset', { title: 'Nieuw wachtwoord', valid: true, token: req.params.token, error: pwErr });
      const hash = await hashPassword(req.body.password);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const used = await client.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL', [t.id]);
        if (!used.rowCount) throw new Error('token already used');
        await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [t.user_id, hash]);
        await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [t.user_id]);
        // Log out all existing sessions of this user.
        await client.query(`DELETE FROM session WHERE (sess->>'userId') = $1`, [String(t.user_id)]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      req.flash('success', 'Je wachtwoord is gewijzigd. Log in met je nieuwe wachtwoord.');
      res.redirect('/inloggen');
    } catch (err) {
      next(err);
    }
  });

  return r;
};

module.exports.registrationOpen = registrationOpen;
