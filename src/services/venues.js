'use strict';
const { zonedParts, amsterdamDate, minutesOf } = require('../lib/time');

const DAY_KEYS = ['1', '2', '3', '4', '5', '6', '7'];
const DAY_NAMES = { 1: 'maandag', 2: 'dinsdag', 3: 'woensdag', 4: 'donderdag', 5: 'vrijdag', 6: 'zaterdag', 7: 'zondag' };

/**
 * Is the venue open at `when`? opening_hours: {"1":{"open":"17:00","close":"01:00"}, ...}
 * A close time <= open time means the venue closes after midnight.
 */
function isOpenAt(openingHours, when) {
  const hours = openingHours || {};
  const p = zonedParts(when);
  const t = p.hour * 60 + p.minute;
  const today = hours[String(p.weekday)];
  if (today && today.open && today.close) {
    const o = minutesOf(today.open);
    const c = minutesOf(today.close);
    if (c > o ? t >= o && t < c : t >= o) return true;
  }
  const prevDay = p.weekday === 1 ? 7 : p.weekday - 1;
  const prev = hours[String(prevDay)];
  if (prev && prev.open && prev.close) {
    const o = minutesOf(prev.open);
    const c = minutesOf(prev.close);
    if (c <= o && t < c) return true;
  }
  return false;
}

/**
 * Choose one active venue that is open at the start time. Among candidates the venue
 * with the fewest planned dates that day is chosen (spreads load), ties by lowest id.
 * Returns null when no suitable real venue has been entered by the admin.
 */
async function chooseVenue(client, slotStart) {
  const { rows } = await client.query(
    `SELECT v.*, (SELECT count(*) FROM date_plans p
                   WHERE p.venue_id = v.id AND p.day = $1
                     AND p.status IN ('proposed','confirmed'))::int AS load
       FROM venues v
      WHERE v.active AND v.deleted_at IS NULL AND v.kind IN ('bar','koffie')
      ORDER BY load ASC, v.id ASC`,
    [amsterdamDate(slotStart)]
  );
  return rows.find((v) => isOpenAt(v.opening_hours, slotStart)) || null;
}

function parseVenueForm(body) {
  const errors = [];
  const name = String(body.name || '').trim();
  const kind = body.kind;
  const street = String(body.street_address || '').trim();
  const postcode = String(body.postcode || '').trim().toUpperCase().replace(/\s+/, ' ');
  const neighborhood = String(body.neighborhood || '').trim();
  const website = String(body.website || '').trim();
  const sourceNote = String(body.source_note || '').trim();
  if (!name || name.length > 120) errors.push('Naam is verplicht (max. 120 tekens).');
  if (!['bar', 'koffie'].includes(kind)) errors.push('Kies bar of koffieplek. Restaurants zijn niet toegestaan.');
  if (!street || street.length > 200) errors.push('Straat en huisnummer zijn verplicht.');
  if (!/^\d{4} ?[A-Z]{2}$/.test(postcode)) errors.push('Postcode moet het formaat 1234 AB hebben.');
  if (website && !/^https:\/\/[^\s]+$/.test(website)) errors.push('Website moet met https:// beginnen.');
  if (!sourceNote) errors.push('Vul in waar en wanneer je deze gegevens hebt gecontroleerd.');
  const opening = {};
  for (const d of DAY_KEYS) {
    if (body[`closed_${d}`]) continue;
    const o = String(body[`open_${d}`] || '').trim();
    const c = String(body[`close_${d}`] || '').trim();
    if (!o && !c) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(o) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(c) || o === c) {
      errors.push(`Openingstijden voor ${DAY_NAMES[d]} zijn ongeldig.`);
      continue;
    }
    opening[d] = { open: o, close: c };
  }
  if (!Object.keys(opening).length) errors.push('Vul voor minstens één dag openingstijden in.');
  return {
    errors,
    values: {
      name,
      kind,
      street_address: street,
      postcode: postcode.replace(/^(\d{4})([A-Z]{2})$/, '$1 $2'),
      neighborhood,
      website,
      source_note: sourceNote,
      opening_hours: opening,
      active: Boolean(body.active),
    },
  };
}

module.exports = { isOpenAt, chooseVenue, parseVenueForm, DAY_KEYS, DAY_NAMES };
