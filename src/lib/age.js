'use strict';
const { amsterdamDate } = require('./time');

/** Whole years between birthdate ('YYYY-MM-DD') and an Amsterdam day ('YYYY-MM-DD'). */
function ageOn(birthdate, today = amsterdamDate()) {
  const [by, bm, bd] = String(birthdate).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

/** Strictly parse 'YYYY-MM-DD'; returns null if not a real calendar date. */
function parseBirthdate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900) return null;
  return value;
}

function toDateString(value) {
  if (value instanceof Date) {
    // pg returns DATE as local-midnight Date; use local components
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

module.exports = { ageOn, parseBirthdate, toDateString };
