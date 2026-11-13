'use strict';
const { formatTime } = require('../lib/time');
const { eligibleSql } = require('./users');
const { deckConditions } = require('./matching');

/**
 * Stuurt (maximaal één per dag, nooit 's nachts) een melding in de app:
 * "Er zijn 5 nieuwe mensen in jouw buurt 👀". Alleen in de app, geen e-mail of
 * push: voor commerciële e-mail is eerst toestemming nodig.
 */
async function notifyNewPeople({ pool, config, notifier }, now = new Date()) {
  const hour = Number(formatTime(now).slice(0, 2));
  if (hour < 9 || hour >= 22) return { sent: 0, skipped: 'quiet_hours' };
  const validHours = Math.max(1, Math.floor(Number(config.swipeValidHours) || 12));
  const { rows } = await pool.query(
    `SELECT me.id, me.neighborhood, count(*)::int AS n
       FROM users me
       JOIN users u ON TRUE
      WHERE ${eligibleSql('me', config.devMode)}
        AND (me.last_new_people_notice_at IS NULL OR me.last_new_people_notice_at < now() - interval '20 hours')
        AND ${deckConditions(config.devMode)}
        AND u.video_uploaded_at > COALESCE(me.last_new_people_notice_at, me.created_at)
        AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.swiper_id = me.id AND s.target_id = u.id
               AND (s.direction = 'left' OR now() < swipe_expires_at(s.created_at, ${validHours})))
      GROUP BY me.id, me.neighborhood
     HAVING count(*) >= $1`,
    [config.newPeopleMinCount]
  );
  for (const r of rows) {
    await notifier.notify(r.id, {
      type: 'new_people',
      title: `👀 ${r.n} nieuwe mensen ${r.neighborhood ? 'in jouw buurt' : 'op Vandaag'}`,
      body: 'Kom even swipen, wie weet zit je match erbij! 🔥',
      link: '/ontdekken',
    });
    await pool.query('UPDATE users SET last_new_people_notice_at = now() WHERE id = $1', [r.id]);
  }
  return { sent: rows.length };
}

module.exports = { notifyNewPeople };
