'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const SLIDES = [
  {
    emoji: '🎥',
    title: 'Swipe op video’s',
    lines: ['Je ziet één korte video per keer van singles (18+) in Amsterdam.', '♥ rechts = ja, ✕ links = nee.', 'Swipen jullie allebei ja? Dan is het een match 💘'],
  },
  {
    emoji: '⏰',
    title: 'Alles is vandaag',
    lines: ['Je ja blijft staan tot morgenochtend. Swipet iemand jou later terug, dan is het meteen een match.', 'Een match geldt alleen vandaag: jullie spreken vandaag af, niet volgende week.', 'Zo weet je zeker dat de ander er ook echt is.'],
  },
  {
    emoji: '🍸',
    title: 'Wij regelen de rest',
    lines: ['Geen eindeloos chatten. Kies je tijden en jullie krijgen een bar of koffieplek.', 'Dezelfde tijd gekozen? Dan staat je date meteen. Anders doen wij een voorstel.', 'Je kunt altijd annuleren, melden of blokkeren. Veilig daten staat voorop 💛'],
  },
];

module.exports = () => {
  const r = express.Router();

  r.get('/uitleg', requireAuth, (req, res) => res.redirect('/uitleg/1'));

  r.get('/uitleg/:n', requireAuth, (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1 || n > SLIDES.length) return res.redirect('/uitleg/1');
    res.render('intro', { title: 'Zo werkt Vandaag', slide: SLIDES[n - 1], n, total: SLIDES.length });
  });

  r.post('/uitleg/klaar', requireAuth, async (req, res, next) => {
    try {
      await req.app.locals.ctx.pool.query('UPDATE users SET intro_seen_at = COALESCE(intro_seen_at, now()) WHERE id = $1', [req.user.id]);
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  return r;
};
