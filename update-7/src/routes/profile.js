'use strict';
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { verifyCsrf, verifyPassword } = require('../lib/security');
const { GENDERS } = require('../services/users');
const { ageOn } = require('../lib/age');
const opts = require('../lib/profile-options');
const { NEIGHBORHOODS, BY_KEY } = require('../lib/neighborhoods');

module.exports = (ctx) => {
  const { pool, storage, logger } = ctx;
  const r = express.Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: storage.tmpDir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    }),
    limits: { fileSize: storage.maxBytes, files: 1, fields: 5 },
    fileFilter: (req, file, cb) => {
      if (!storage.isAllowedMime(file.mimetype)) {
        const err = new Error('Alleen video’s in mp4-, mov- of webm-formaat zijn toegestaan.');
        err.code = 'BAD_TYPE';
        return cb(err);
      }
      cb(null, true);
    },
  });

  function promptValues(user) {
    const list = Array.isArray(user.prompts) ? user.prompts : [];
    return Array.from({ length: opts.PROMPT_SLOTS }, (_, i) => list[i] || { key: '', answer: '' });
  }

  function renderProfile(res, user, { errors = [], status = 200 } = {}) {
    res.status(status).render('profile/edit', { title: 'Mijn profiel', errors, genders: GENDERS, age: ageOn(user.birthdate), opts, promptValues: promptValues(user), neighborhoods: NEIGHBORHOODS });
  }

  r.get('/profiel', requireAuth, (req, res) => renderProfile(res, req.user));

  r.post('/profiel', requireAuth, async (req, res, next) => {
    try {
      const errors = [];
      const name = String(req.body.display_name || '').trim();
      const bio = String(req.body.bio || '').trim();
      const gender = req.body.gender || null;
      if (!name || name.length > 40) errors.push('Naam is verplicht (max. 40 tekens).');
      if (bio.length > 300) errors.push('Profieltekst mag maximaal 300 tekens zijn.');
      if (gender && !GENDERS.includes(gender)) errors.push('Ongeldige keuze voor gender.');
      const extras = opts.parseExtras(req.body);
      errors.push(...extras.errors);
      if (errors.length) {
        Object.assign(req.user, { prompts: extras.prompts, interests: extras.interests, languages: extras.languages });
        Object.assign(req.user, { display_name: name, bio, gender });
        return renderProfile(res, req.user, { errors, status: 422 });
      }
      await pool.query(
        `UPDATE users SET display_name=$2, bio=$3, gender=$4, prompts=$5, interests=$6, languages=$7, updated_at=now()
          WHERE id=$1`,
        [req.user.id, name, bio, gender, JSON.stringify(extras.prompts), extras.interests, extras.languages]
      );
      req.flash('success', 'Je profiel is opgeslagen ✨ Tijd om te swipen!');
      res.redirect('/profiel');
    } catch (err) {
      next(err);
    }
  });

  function renderPrefs(res, user, { errors = [], status = 200 } = {}) {
    res.status(status).render('profile/preferences', { title: 'Date-voorkeuren', errors, genders: GENDERS, neighborhoods: NEIGHBORHOODS });
  }

  r.get('/voorkeuren', requireAuth, (req, res) => renderPrefs(res, req.user));

  r.post('/voorkeuren', requireAuth, async (req, res, next) => {
    try {
      const errors = [];
      let prefGenders = req.body.pref_genders;
      if (prefGenders === undefined || prefGenders === '') prefGenders = [];
      if (!Array.isArray(prefGenders)) prefGenders = [prefGenders];
      const ageMin = req.body.pref_age_min ? Number(req.body.pref_age_min) : null;
      const ageMax = req.body.pref_age_max ? Number(req.body.pref_age_max) : null;
      if (prefGenders.some((g) => !GENDERS.includes(g))) errors.push('Ongeldige voorkeur voor gender.');
      for (const [label, v] of [['Minimale', ageMin], ['Maximale', ageMax]]) {
        if (v !== null && (!Number.isInteger(v) || v < 18 || v > 99)) errors.push(`${label} leeftijd moet tussen 18 en 99 liggen.`);
      }
      if (ageMin !== null && ageMax !== null && ageMin > ageMax) errors.push('Minimale leeftijd mag niet hoger zijn dan de maximale.');
      const neighborhood = req.body.neighborhood ? String(req.body.neighborhood) : null;
      const maxKm = req.body.max_distance_km ? Number(req.body.max_distance_km) : null;
      if (neighborhood && !BY_KEY.has(neighborhood)) errors.push('Kies een buurt uit de lijst.');
      if (maxKm !== null && (!Number.isInteger(maxKm) || maxKm < 1 || maxKm > 50)) errors.push('Kies een afstand tussen 1 en 50 km.');
      if (errors.length) {
        Object.assign(req.user, { pref_genders: prefGenders, pref_age_min: ageMin, pref_age_max: ageMax, neighborhood, max_distance_km: maxKm });
        return renderPrefs(res, req.user, { errors, status: 422 });
      }
      await pool.query(
        `UPDATE users SET pref_genders=$2, pref_age_min=$3, pref_age_max=$4, neighborhood=$5, max_distance_km=$6, updated_at=now() WHERE id=$1`,
        [req.user.id, prefGenders.length ? prefGenders : null, ageMin, ageMax, neighborhood, neighborhood ? maxKm : null]
      );
      req.flash('success', 'Voorkeuren opgeslagen 💘 Op naar de swipes!');
      res.redirect('/profiel');
    } catch (err) {
      next(err);
    }
  });

  r.post('/profiel/video', requireAuth, (req, res, next) => {
    upload.single('video')(req, res, async (err) => {
      const tmp = req.file && req.file.path;
      try {
        if (!verifyCsrf(req)) {
          await storage.discardTmp(tmp);
          return res.status(403).render('error', { title: 'Sessie verlopen', message: 'Vernieuw de pagina en probeer opnieuw.' });
        }
        if (err) {
          await storage.discardTmp(tmp);
          const msg =
            err.code === 'LIMIT_FILE_SIZE'
              ? `De video is te groot (maximaal ${Math.round(storage.maxBytes / 1024 / 1024)} MB).`
              : err.code === 'BAD_TYPE'
                ? err.message
                : 'Het uploaden is mislukt. Probeer het opnieuw.';
          if (!['LIMIT_FILE_SIZE', 'BAD_TYPE'].includes(err.code)) logger.error('[upload]', err);
          req.flash('error', msg);
          return res.redirect('/profiel');
        }
        if (!req.file) {
          req.flash('error', 'Kies eerst een videobestand.');
          return res.redirect('/profiel');
        }
        let stored;
        try {
          stored = await storage.commitUpload(tmp);
        } catch (e) {
          req.flash('error', e.code === 'INVALID_VIDEO' ? e.message : 'Het opslaan van de video is mislukt.');
          if (e.code !== 'INVALID_VIDEO') logger.error('[upload]', e);
          return res.redirect('/profiel');
        }
        const old = req.user.video_key;
        await pool.query(
          `UPDATE users SET video_key=$2, video_mime=$3, video_size_bytes=$4, video_uploaded_at=now(), updated_at=now() WHERE id=$1`,
          [req.user.id, stored.key, stored.mime, req.file.size]
        );
        if (old) await storage.remove(old).catch((e) => logger.error('[upload] oude video niet verwijderd', e.message));
        req.flash('success', 'Mooi, je video staat erop 🎬 Tijd om te swipen!');
        res.redirect('/profiel');
      } catch (e) {
        await storage.discardTmp(tmp).catch(() => {});
        next(e);
      }
    });
  });

  r.post('/profiel/video/verwijderen', requireAuth, async (req, res, next) => {
    try {
      const key = req.user.video_key;
      await pool.query(`UPDATE users SET video_key=NULL, video_mime=NULL, video_size_bytes=NULL, video_uploaded_at=NULL WHERE id=$1`, [
        req.user.id,
      ]);
      await storage.remove(key);
      req.flash('success', 'Je video is verwijderd. Zonder video ben je niet zichtbaar; upload gauw een nieuwe 🎬');
      res.redirect('/profiel');
    } catch (err) {
      next(err);
    }
  });

  r.get('/account/verwijderen', requireAuth, (req, res) => {
    res.render('profile/delete', { title: 'Account verwijderen', error: null });
  });

  r.post('/account/verwijderen', requireAuth, async (req, res, next) => {
    try {
      const ok = await verifyPassword(String(req.body.password || ''), req.user.password_hash);
      if (!ok || req.body.confirm !== 'VERWIJDER') {
        return res.status(422).render('profile/delete', {
          title: 'Account verwijderen',
          error: 'Vul je wachtwoord in en typ VERWIJDER om te bevestigen.',
        });
      }
      const key = req.user.video_key;
      await pool.query('DELETE FROM session WHERE (sess->>\'userId\') = $1', [String(req.user.id)]);
      await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
      await storage.remove(key).catch((e) => logger.error('[account] video niet verwijderd', e.message));
      req.session.destroy(() => {
        res.clearCookie('sid');
        res.render('profile/deleted', { title: 'Account verwijderd', user: null });
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
};
