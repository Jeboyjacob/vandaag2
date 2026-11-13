'use strict';
/** Time helpers for Europe/Amsterdam without external dependencies (DST-aware via Intl). */
const TZ = 'Europe/Amsterdam';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function zonedParts(date) {
  const out = {};
  for (const p of partsFmt.formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday],
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD' of the given instant in Amsterdam. */
function amsterdamDate(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function offsetMs(date) {
  const p = zonedParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert an Amsterdam wall-clock time ('YYYY-MM-DD', 'HH:MM') to a UTC Date. */
function amsterdamToUtc(dayStr, timeStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - offsetMs(new Date(guess));
  const second = guess - offsetMs(new Date(result));
  if (second !== result) result = second;
  return new Date(result);
}

/** ISO weekday (1 = Monday) of an Amsterdam calendar day. */
function weekdayOf(dayStr) {
  return zonedParts(amsterdamToUtc(dayStr, '12:00')).weekday;
}

function formatTime(date) {
  const p = zonedParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

const longDateFmt = new Intl.DateTimeFormat('nl-NL', {
  timeZone: TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const dateTimeFmt = new Intl.DateTimeFormat('nl-NL', {
  timeZone: TZ,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatLongDate(date) {
  return longDateFmt.format(date);
}
function formatDateTime(date) {
  return dateTimeFmt.format(date);
}

function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Candidate date slots for an Amsterdam day, only those starting at or after
 * now + minLeadMinutes.
 */
function generateSlots(dayStr, cfg, now = new Date()) {
  const start = minutesOf(cfg.slotStart);
  const end = minutesOf(cfg.slotEnd);
  const earliest = now.getTime() + cfg.slotMinLeadMinutes * 60000;
  const slots = [];
  for (let t = start; t <= end; t += cfg.slotIntervalMinutes) {
    const slot = amsterdamToUtc(dayStr, `${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
    if (amsterdamDate(slot) !== dayStr) continue; // DST edge safety
    if (slot.getTime() >= earliest) slots.push(slot);
  }
  return slots;
}

module.exports = {
  TZ,
  zonedParts,
  amsterdamDate,
  amsterdamToUtc,
  weekdayOf,
  formatTime,
  formatLongDate,
  formatDateTime,
  minutesOf,
  generateSlots,
};
