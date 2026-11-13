'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');

module.exports = (ctx) => {
  const { pool } = ctx;
  const r = express.Router();

  r.get('/meldingen', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
        [req.user.id]
      );
      await pool.query('UPDATE notifications SET read_at = now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
      res.render('notifications', { title: 'Meldingen', notifications: rows });
    } catch (err) {
      next(err);
    }
  });

  // Lightweight polling endpoint for the unread badge.
  r.get('/api/meldingen/aantal', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ unread: res.locals.unreadCount });
  });

  return r;
};
