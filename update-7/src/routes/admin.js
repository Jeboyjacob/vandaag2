'use strict';
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { parseVenueForm, DAY_KEYS, DAY_NAMES } = require('../services/venues');

module.exports = (ctx) => {
  const { pool, notifier, integrations, storage, logger } = ctx;
  const r = express.Router();
  r.use(requireAdmin);

  r.get('/', async (req, res, next) => {
    try {
      const q = async (sql) => (await pool.query(sql)).rows[0].n;
      res.render('admin/index', {
        title: 'Beheer',
        counts: {
          venues: await q(`SELECT count(*)::int n FROM venues WHERE active AND deleted_at IS NULL`),
          reports: await q(`SELECT count(*)::int n FROM reports WHERE status='open'`),
          noshows: await q(`SELECT count(*)::int n FROM noshow_reports WHERE status IN ('reported','disputed')`),
          users: await q(`SELECT count(*)::int n FROM users`),
        },
        integrations,
        mailConfigured: ctx.mailer.isConfigured(),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- Venues ----------
  r.get('/locaties', async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM venues WHERE deleted_at IS NULL ORDER BY active DESC, name`);
      res.render('admin/venues', { title: 'Locaties', venues: rows, DAY_NAMES });
    } catch (err) {
      next(err);
    }
  });

  const formView = (res, venue, errors = [], status = 200) =>
    res.status(status).render('admin/venue-form', { title: venue.id ? 'Locatie aanpassen' : 'Nieuwe locatie', venue, errors, DAY_KEYS, DAY_NAMES });

  r.get('/locaties/nieuw', (req, res) => formView(res, { active: true, opening_hours: {} }));

  r.post('/locaties', async (req, res, next) => {
    try {
      const { errors, values } = parseVenueForm(req.body);
      if (errors.length) return formView(res, { ...values }, errors, 422);
      await pool.query(
        `INSERT INTO venues (name, kind, street_address, postcode, neighborhood, website, opening_hours, source_note, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [values.name, values.kind, values.street_address, values.postcode, values.neighborhood, values.website, JSON.stringify(values.opening_hours), values.source_note, values.active]
      );
      req.flash('success', `Locatie "${values.name}" toegevoegd.`);
      res.redirect('/beheer/locaties');
    } catch (err) {
      next(err);
    }
  });

  r.get('/locaties/:id', async (req, res, next) => {
    try {
      const { rows } = await pool.query('SELECT * FROM venues WHERE id=$1 AND deleted_at IS NULL', [Number(req.params.id) || 0]);
      if (!rows[0]) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Locatie niet gevonden.' });
      formView(res, rows[0]);
    } catch (err) {
      next(err);
    }
  });

  r.post('/locaties/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id) || 0;
      const { errors, values } = parseVenueForm(req.body);
      if (errors.length) return formView(res, { id, ...values }, errors, 422);
      const upd = await pool.query(
        `UPDATE venues SET name=$2, kind=$3, street_address=$4, postcode=$5, neighborhood=$6, website=$7,
                opening_hours=$8, source_note=$9, active=$10, updated_at=now()
          WHERE id=$1 AND deleted_at IS NULL`,
        [id, values.name, values.kind, values.street_address, values.postcode, values.neighborhood, values.website, JSON.stringify(values.opening_hours), values.source_note, values.active]
      );
      if (!upd.rowCount) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Locatie niet gevonden.' });
      req.flash('success', 'Locatie bijgewerkt.');
      res.redirect('/beheer/locaties');
    } catch (err) {
      next(err);
    }
  });

  // Soft delete keeps history of past/confirmed dates intact.
  r.post('/locaties/:id/verwijderen', async (req, res, next) => {
    try {
      await pool.query('UPDATE venues SET deleted_at=now(), active=false WHERE id=$1', [Number(req.params.id) || 0]);
      req.flash('success', 'Locatie verwijderd. Openstaande voorstellen krijgen automatisch een andere locatie (indien beschikbaar).');
      res.redirect('/beheer/locaties');
    } catch (err) {
      next(err);
    }
  });

  // ---------- Reports (profiles, videos, unsafe dates) ----------
  r.get('/meldingen', async (req, res, next) => {
    try {
      const status = ['open', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
      const { rows } = await pool.query(
        `SELECT r.*, ru.display_name AS reporter_name, tu.display_name AS reported_name, tu.email AS reported_email,
                tu.status AS reported_status, tu.profile_hidden AS reported_hidden, tu.video_key AS reported_video
           FROM reports r
           LEFT JOIN users ru ON ru.id = r.reporter_id
           LEFT JOIN users tu ON tu.id = r.reported_user_id
          WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 200`,
        [status]
      );
      res.render('admin/reports', { title: 'Meldingen', reports: rows, status });
    } catch (err) {
      next(err);
    }
  });

  r.post('/meldingen/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id) || 0;
      const action = req.body.action;
      const note = String(req.body.admin_note || '').slice(0, 2000);
      const rep = (await pool.query('SELECT * FROM reports WHERE id=$1', [id])).rows[0];
      if (!rep) return res.status(404).render('error', { title: 'Niet gevonden', message: 'Melding niet gevonden.' });
      const target = rep.reported_user_id;
      let status = 'resolved';
      if (action === 'dismiss') status = 'dismissed';
      else if (action === 'hide' && target) await pool.query('UPDATE users SET profile_hidden=true WHERE id=$1', [target]);
      else if (action === 'remove_video' && target) {
        const u = (await pool.query('SELECT video_key FROM users WHERE id=$1', [target])).rows[0];
        await pool.query('UPDATE users SET video_key=NULL, video_mime=NULL, video_size_bytes=NULL, video_uploaded_at=NULL WHERE id=$1', [target]);
        if (u && u.video_key) await storage.remove(u.video_key).catch((e) => logger.error(e.message));
      } else if (action === 'suspend' && target) {
        await pool.query(`UPDATE users SET status='suspended' WHERE id=$1 AND role <> 'admin'`, [target]);
        await pool.query(`DELETE FROM session WHERE (sess->>'userId') = $1`, [String(target)]);
      } else if (action !== 'resolve') {
        req.flash('error', 'Onbekende actie.');
        return res.redirect('/beheer/meldingen');
      }
      await pool.query(
        `UPDATE reports SET status=$2, action_taken=$3, admin_note=$4, handled_by=$5, handled_at=now() WHERE id=$1`,
        [id, status, action, note, req.user.id]
      );
      req.flash('success', 'Melding afgehandeld.');
      res.redirect('/beheer/meldingen');
    } catch (err) {
      next(err);
    }
  });

  r.post('/gebruikers/:id/herstellen', async (req, res, next) => {
    try {
      await pool.query(`UPDATE users SET status='active', profile_hidden=false WHERE id=$1`, [Number(req.params.id) || 0]);
      req.flash('success', 'Gebruiker hersteld (actief en zichtbaar).');
      res.redirect('/beheer/meldingen?status=resolved');
    } catch (err) {
      next(err);
    }
  });

  // ---------- No-shows ----------
  r.get('/no-shows', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT n.*, ru.display_name AS reporter_name, tu.display_name AS reported_name,
                (SELECT count(*)::int FROM noshow_reports x WHERE x.plan_id = n.plan_id AND x.id <> n.id) AS counter_reports,
                (SELECT json_agg(json_build_object('type', e.type, 'user_id', e.user_id, 'payload', e.payload, 'at', e.created_at) ORDER BY e.created_at)
                   FROM date_events e WHERE e.plan_id = n.plan_id) AS events
           FROM noshow_reports n
           LEFT JOIN users ru ON ru.id = n.reporter_id
           LEFT JOIN users tu ON tu.id = n.reported_user_id
          ORDER BY (n.status IN ('reported','disputed')) DESC, n.reported_at DESC LIMIT 200`
      );
      res.render('admin/noshows', { title: 'No-shows', reports: rows, paymentsConfigured: integrations.payments.configured });
    } catch (err) {
      next(err);
    }
  });

  r.post('/no-shows/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id) || 0;
      const decision = req.body.decision;
      if (!['upheld', 'rejected'].includes(decision)) {
        req.flash('error', 'Kies terecht of onterecht.');
        return res.redirect('/beheer/no-shows');
      }
      const note = String(req.body.admin_note || '').slice(0, 2000);
      const upd = await pool.query(
        `UPDATE noshow_reports SET status=$2, admin_note=$3, decided_by=$4, decided_at=now(),
                payment_status = CASE WHEN $2 = 'rejected' THEN 'waived' ELSE payment_status END
          WHERE id=$1 AND status IN ('reported','disputed') RETURNING *`,
        [id, decision, note, req.user.id]
      );
      const rep = upd.rows[0];
      if (!rep) {
        req.flash('error', 'Deze melding is al beoordeeld of bestaat niet.');
        return res.redirect('/beheer/no-shows');
      }
      const link = `/no-shows/${id}`;
      const pending = [];
      const text =
        decision === 'upheld'
          ? 'De no-showmelding is beoordeeld als terecht. Er is nog geen betaling geïnd.'
          : 'De no-showmelding is beoordeeld als onterecht. Er worden geen kosten in rekening gebracht.';
      for (const uid of [rep.reporter_id, rep.reported_user_id].filter(Boolean)) {
        pending.push(await notifier.notify(uid, { type: 'noshow_decided', title: 'No-showmelding beoordeeld', body: text, link }));
      }
      for (const n of pending) await notifier.deliverEmail(n).catch(() => {});
      req.flash(
        'success',
        decision === 'upheld'
          ? 'Melding als terecht beoordeeld. LET OP: er is GEEN geld geïnd — de betaalkoppeling en no-showregels zijn nog niet vastgesteld.'
          : 'Melding als onterecht beoordeeld.'
      );
      res.redirect('/beheer/no-shows');
    } catch (err) {
      next(err);
    }
  });

  return r;
};
