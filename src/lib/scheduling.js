'use strict';
/**
 * Pure scheduling logic.
 *
 * Each user ranks one or more slots (rank 1 = most preferred). The best overlapping
 * slot is the one chosen by both users with the lowest sum of both ranks.
 * Ties are broken by picking the earliest slot. Slots in the past are ignored.
 */

class ValidationError extends Error {}

function pickBestSlot(choicesA, choicesB, { now = new Date() } = {}) {
  const byTimeB = new Map(choicesB.map((c) => [new Date(c.slotStart).getTime(), c.rank]));
  const candidates = [];
  for (const a of choicesA) {
    const t = new Date(a.slotStart).getTime();
    if (t <= now.getTime()) continue;
    if (!byTimeB.has(t)) continue;
    const rankB = byTimeB.get(t);
    candidates.push({ slotStart: new Date(t), rankA: a.rank, rankB, score: a.rank + rankB });
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => x.score - y.score || x.slotStart - y.slotStart);
  return candidates[0];
}

/**
 * Validate user input: an object/array of { slot: ISO string, rank: number }.
 * Ranks must be unique and form 1..n; slots must be in the allowed list.
 */
function normalizeChoices(raw, allowedSlots, maxChoices) {
  const allowed = new Set(allowedSlots.map((d) => d.getTime()));
  const entries = [];
  for (const item of raw || []) {
    if (item == null || item.rank === '' || item.rank == null) continue;
    const rank = Number(item.rank);
    const t = new Date(item.slot).getTime();
    if (!Number.isInteger(rank) || rank < 1) throw new ValidationError('Ongeldige rangorde.');
    if (!Number.isFinite(t) || !allowed.has(t)) {
      throw new ValidationError('Een gekozen tijd is niet (meer) beschikbaar. Kies opnieuw.');
    }
    entries.push({ slotStart: new Date(t), rank });
  }
  if (!entries.length) throw new ValidationError('Kies minstens één tijd.');
  if (entries.length > maxChoices) throw new ValidationError(`Kies maximaal ${maxChoices} tijden.`);
  const times = new Set(entries.map((e) => e.slotStart.getTime()));
  if (times.size !== entries.length) throw new ValidationError('Elke tijd mag maar één keer gekozen worden.');
  const ranks = entries.map((e) => e.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) throw new ValidationError('Geef je keuzes de volgorde 1, 2, 3 … zonder gaten of dubbele nummers.');
  }
  return entries.sort((a, b) => a.rank - b.rank);
}

/**
 * No shared slot? Suggest the available slot that is closest to what BOTH people picked.
 * The slot that is fairest wins (smallest gap for the person who has to move the most),
 * then the smallest total gap, then the earliest time.
 */
function suggestSlot(choicesA, choicesB, allowedSlots, { exclude = [] } = {}) {
  const skip = new Set(exclude.map((d) => new Date(d).getTime()));
  const gap = (t, choices) => Math.min(...choices.map((c) => Math.abs(new Date(c.slotStart).getTime() - t))) / 60000;
  if (!choicesA.length || !choicesB.length) return null;
  let best = null;
  for (const slot of allowedSlots) {
    const t = slot.getTime();
    if (skip.has(t)) continue;
    const gapA = gap(t, choicesA);
    const gapB = gap(t, choicesB);
    const cand = { slotStart: new Date(t), gapA, gapB, worst: Math.max(gapA, gapB), total: gapA + gapB };
    if (
      !best ||
      cand.worst < best.worst ||
      (cand.worst === best.worst && cand.total < best.total) ||
      (cand.worst === best.worst && cand.total === best.total && cand.slotStart < best.slotStart)
    ) {
      best = cand;
    }
  }
  return best;
}

module.exports = { pickBestSlot, suggestSlot, normalizeChoices, ValidationError };
