'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { eligibleSql } = require('../services/users');

/**
 * Access-controlled video streaming. Allowed:
 *  - the owner and admins;
 *  - other users who are themselves eligible, when the owner is eligible and
 *    neither has blocked the other.
 */
module.exports = (ctx) => {
  const { pool, config, storage } = ctx;
  const r = express.Router();

  r.get('/media/video/:userId', requireAuth, async (req, res, next) => {
    try {
      const ownerId = Number(req.params.userId);
      if (!Number.isInteger(ownerId)) return res.sendStatus(404);
      const me = req.user;
      let row;
      if (me.id === ownerId || me.role === 'admin') {
        row = (await pool.query('SELECT video_key, video_mime FROM users WHERE id=$1', [ownerId])).rows[0];
      } else {
        if (!me.readiness.ready) return res.sendStatus(403);
        row = (
          await pool.query(
            `SELECT u.video_key, u.video_mime FROM users u
              WHERE u.id = $1 AND ${eligibleSql('u', config.devMode)}
                AND NOT EXISTS (SELECT 1 FROM blocks b
                     WHERE (b.blocker_id = $2 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $2))`,
            [ownerId, me.id]
          )
        ).rows[0];
      }
      if (!row || !row.video_key) return res.sendStatus(404);
      res.set('Cache-Control', 'private, no-store');
      res.set('Content-Type', row.video_mime);
      res.set('X-Content-Type-Options', 'nosniff');
      res.sendFile(storage.pathFor(row.video_key), { headers: { 'Content-Type': row.video_mime } }, (err) => {
        if (err && !res.headersSent) res.sendStatus(err.status === 404 ? 404 : 500);
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
};
