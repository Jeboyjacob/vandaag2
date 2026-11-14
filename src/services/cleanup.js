'use strict';

/**
 * Nachtelijke opruiming (draait elke paar uur, doet alleen iets als er iets te wissen is):
 *  - afgelopen matches (en hun tijdkeuzes, voorstellen, bevestigingen en gebeurtenissen) worden
 *    na `matchRetentionDays` dagen echt verwijderd;
 *  - matches met een no-showmelding die nog beoordeeld moet worden blijven staan;
 *  - gelezen meldingen worden na 30 dagen gewist, alle meldingen na 90 dagen.
 * Meldingen aan de beheerder (reports, no-showmeldingen) houden hun eigen gegevens.
 */
async function cleanupOldData({ pool, config }) {
  const days = Math.max(1, Math.floor(Number(config.matchRetentionDays) || 7));
  const matches = await pool.query(
    `DELETE FROM matches m
      WHERE m.match_day < ((now() AT TIME ZONE 'Europe/Amsterdam')::date - $1::int)
        AND NOT EXISTS (
          SELECT 1 FROM date_plans p JOIN noshow_reports n ON n.plan_id = p.id
           WHERE p.match_id = m.id AND n.status IN ('reported', 'disputed'))`,
    [days]
  );
  const read = await pool.query(`DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '30 days'`);
  const any = await pool.query(`DELETE FROM notifications WHERE created_at < now() - interval '90 days'`);
  return { matches: matches.rowCount, notifications: read.rowCount + any.rowCount };
}

module.exports = { cleanupOldData };
