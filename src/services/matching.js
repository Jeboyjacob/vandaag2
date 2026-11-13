'use strict';
const { tx } = require('../db');
const { amsterdamDate } = require('../lib/time');
const { AGE_SQL, eligibleSql } = require('./users');

class MatchingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function deckConditions(devMode) {
  return `
    u.id <> me.id AND ${eligibleSql('u', devMode)}
    AND NOT EXISTS (SELECT 1 FROM blocks b
         WHERE (b.blocker_id = me.id AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = me.id))
    AND (me.pref_genders IS NULL OR u.gender = ANY(me.pref_genders))
    AND (u.pref_genders IS NULL OR me.gender = ANY(u.pref_genders))
    AND (me.pref_age_min IS NULL OR ${AGE_SQL('u')} >= me.pref_age_min)
    AND (me.pref_age_max IS NULL OR ${AGE_SQL('u')} <= me.pref_age_max)
    AND (u.pref_age_min IS NULL OR ${AGE_SQL('me')} >= u.pref_age_min)
    AND (u.pref_age_max IS NULL OR ${AGE_SQL('me')} <= u.pref_age_max)
    AND (me.max_distance_km IS NULL OR me.neighborhood IS NULL OR u.neighborhood IS NULL
         OR neighborhood_km(me.neighborhood, u.neighborhood) <= me.max_distance_km)
    AND (u.max_distance_km IS NULL OR me.neighborhood IS NULL OR u.neighborhood IS NULL
         OR neighborhood_km(me.neighborhood, u.neighborhood) <= u.max_distance_km)`;
}

function createMatching({ pool, config, notifier }) {
  // Een ja geldt maar een beperkt aantal uur (geheel getal uit de config, dus veilig in SQL).
  const validHours = Math.max(1, Math.floor(Number(config.swipeValidHours) || 12));
  /** Next single profile to show, or null. */
  async function nextProfile(meId) {
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name, u.bio, u.prompts, u.interests, u.languages, u.gender, u.liveness_status, u.age_verification_status,
              ${AGE_SQL('u')} AS age
         FROM users u, users me
        WHERE me.id = $1 AND ${deckConditions(config.devMode)}
          AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.swiper_id = me.id AND s.target_id = u.id
                 AND (s.direction = 'left' OR now() < swipe_expires_at(s.created_at, ${validHours})))
        ORDER BY md5(u.id::text || ':' || me.id::text)
        LIMIT 1`,
      [meId]
    );
    return rows[0] || null;
  }

  /**
   * Record a swipe. Idempotent: a second swipe on the same person is rejected.
   * A match is created only when both users swiped right; concurrent swipes are
   * serialised with an advisory lock on the user pair.
   */
  async function swipe(meId, targetId, direction) {
    if (!['left', 'right'].includes(direction)) throw new MatchingError('INVALID', 'Ongeldige swipe.');
    const pending = [];
    const result = await tx(pool, async (c) => {
      const ok = await c.query(
        `SELECT 1 FROM users u, users me WHERE me.id = $1 AND u.id = $2 AND ${eligibleSql('me', config.devMode)}
           AND ${deckConditions(config.devMode)}`,
        [meId, targetId]
      );
      if (!ok.rowCount) throw new MatchingError('NOT_AVAILABLE', 'Dit profiel is niet (meer) beschikbaar.');

      // Een ja geldt maar een paar uur. Een verlopen ja mag opnieuw gegeven worden.
      const ins = await c.query(
        `INSERT INTO swipes (swiper_id, target_id, direction) VALUES ($1,$2,$3)
         ON CONFLICT (swiper_id, target_id) DO UPDATE SET direction = EXCLUDED.direction, created_at = now()
           WHERE swipes.direction = 'right'
             AND now() >= swipe_expires_at(swipes.created_at, ${validHours})
         RETURNING id`,
        [meId, targetId, direction]
      );
      if (!ins.rowCount) return { duplicate: true, matched: false };
      if (direction !== 'right') return { duplicate: false, matched: false };

      const [a, b] = meId < targetId ? [meId, targetId] : [targetId, meId];
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`match:${a}:${b}`]);
      const back = await c.query(
        `SELECT 1 FROM swipes WHERE swiper_id = $1 AND target_id = $2 AND direction = 'right'
            AND now() < swipe_expires_at(created_at, ${validHours})`,
        [targetId, meId]
      );
      if (!back.rowCount) return { duplicate: false, matched: false };

      const day = amsterdamDate(new Date());
      const m = await c.query(
        `INSERT INTO matches (user_a, user_b, match_day) VALUES ($1,$2,$3)
         ON CONFLICT (user_a, user_b) DO NOTHING RETURNING id`,
        [a, b, day]
      );
      if (!m.rowCount) {
        const existing = await c.query('SELECT id FROM matches WHERE user_a=$1 AND user_b=$2', [a, b]);
        return { duplicate: false, matched: true, matchId: existing.rows[0].id, isNew: false };
      }
      const matchId = m.rows[0].id;
      await c.query('INSERT INTO date_plans (match_id, day) VALUES ($1,$2)', [matchId, day]);
      for (const uid of [a, b]) {
        pending.push(
          await notifier.notify(
            uid,
            {
              type: 'match',
              title: '💘 Het is een match!',
              body: 'Kies de tijden waarop je vandaag kunt afspreken. Dat doe je in een minuutje ⏰',
              link: `/matches/${matchId}`,
            },
            c
          )
        );
      }
      return { duplicate: false, matched: true, matchId, isNew: true };
    });
    for (const n of pending) await notifier.deliverEmail(n).catch(() => {});
    return result;
  }

  async function listMatches(meId) {
    const { rows } = await pool.query(
      `SELECT m.id, m.match_day, m.status AS match_status, m.created_at,
              o.id AS other_id, o.display_name AS other_name,
              p.status AS plan_status, p.proposed_start
         FROM matches m
         JOIN users o ON o.id = CASE WHEN m.user_a = $1 THEN m.user_b ELSE m.user_a END
         LEFT JOIN date_plans p ON p.match_id = m.id
        WHERE (m.user_a = $1 OR m.user_b = $1)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = o.id)
        ORDER BY m.created_at DESC`,
      [meId]
    );
    return rows;
  }

  return { nextProfile, swipe, listMatches };
}

module.exports = { createMatching, MatchingError, deckConditions };
