'use strict';

const AGE_SQL = (a) =>
  `date_part('year', age((now() AT TIME ZONE 'Europe/Amsterdam')::date, ${a}.birthdate))::int`;

/** SQL condition: may this user appear to others / use swiping? */
function eligibleSql(a, devMode) {
  const liveness = devMode
    ? `${a}.liveness_status IN ('passed','dev_bypass')`
    : `${a}.liveness_status = 'passed'`;
  return `(${a}.status = 'active' AND NOT ${a}.profile_hidden AND ${a}.video_key IS NOT NULL AND ${liveness})`;
}

function livenessOk(user, devMode) {
  return user.liveness_status === 'passed' || (devMode && user.liveness_status === 'dev_bypass');
}

/** What the user still needs to do before they can swipe. */
function readiness(user, devMode) {
  const missing = [];
  if (!livenessOk(user, devMode)) missing.push('liveness');
  if (!user.video_key) missing.push('video');
  if (user.profile_hidden) missing.push('hidden');
  return { ready: missing.length === 0, missing };
}

const GENDERS = ['vrouw', 'man', 'non-binair'];

module.exports = { AGE_SQL, eligibleSql, livenessOk, readiness, GENDERS };
