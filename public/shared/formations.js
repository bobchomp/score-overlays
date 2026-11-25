// Formations for the lineup graphic. Shared by the server, the Lineups tab and the overlay.
//
// A lineup with a formation has 11 "slots": slot 0 is the goalkeeper, then each line from the
// back to the front, left to right as seen by the team (attacking up the screen).

export const FORMATIONS = [
  '4-4-2', '4-4-1-1', '4-3-3', '4-2-3-1', '4-1-4-1', '4-1-2-1-2', '4-3-1-2', '4-5-1',
  '3-5-2', '3-4-3', '3-4-1-2', '3-4-2-1', '5-3-2', '5-4-1',
];

/** Outfield line sizes from the back, e.g. '4-2-3-1' → [4, 2, 3, 1]. */
export function lines(formation) {
  return String(formation || '').split('-').map(Number);
}

export function isFormation(f) {
  return FORMATIONS.includes(f);
}

/** The squad position each slot wants (used to fill slots automatically). */
export function slotRoles(formation) {
  const ls = lines(formation);
  const roles = ['GK'];
  ls.forEach((n, i) => {
    const role = i === 0 ? 'DEF' : i === ls.length - 1 ? 'FWD' : 'MID';
    for (let k = 0; k < n; k++) roles.push(role);
  });
  return roles;
}

/** Where each slot sits on a pitch, as percentages: x from the left, y from the top (goalkeeper at the bottom). */
export function slotPositions(formation) {
  const ls = lines(formation);
  const out = [{ x: 50, y: 88 }];
  const SPAN = { 1: 0, 2: 34, 3: 56, 4: 74, 5: 84 };
  const back = 71, front = 15;
  ls.forEach((n, i) => {
    const y = ls.length === 1 ? (back + front) / 2 : back - (back - front) * (i / (ls.length - 1));
    const span = SPAN[n] ?? 84;
    for (let k = 0; k < n; k++) out.push({ x: n === 1 ? 50 : 50 - span / 2 + (span * k) / (n - 1), y });
  });
  return out;
}

/**
 * Put the starting XI into the formation's slots. Players already in a slot keep it; the rest go to
 * the first free slot that wants their position (by shirt number), then any free slot.
 * Returns 11 entries (player id or null).
 */
export function fitSlots(formation, slots, starting, squad) {
  const roles = slotRoles(formation);
  const xi = new Set(starting);
  const out = roles.map((_, i) => (slots?.[i] && xi.has(slots[i]) ? slots[i] : null));
  const placed = new Set(out.filter(Boolean));
  const byId = new Map((squad || []).map(p => [p.id, p]));
  const todo = starting.filter(id => !placed.has(id))
    .sort((a, b) => (byId.get(a)?.number ?? 999) - (byId.get(b)?.number ?? 999));
  for (const pass of ['role', 'any']) {
    for (const id of [...todo]) {
      const pos = byId.get(id)?.position;
      const i = out.findIndex((v, k) => !v && (pass === 'any' || roles[k] === pos));
      if (i >= 0) { out[i] = id; todo.splice(todo.indexOf(id), 1); }
    }
  }
  return out;
}

/**
 * The XI as it stands now: subs take over the slot of the player they replaced, and players sent
 * off are marked. Returns [{ id, subbedOn, sentOff }] per slot.
 */
export function currentSlots(slots, events, side) {
  const evs = (events || []).filter(e => e.team === side);
  return (slots || []).map(start => {
    if (!start) return null;
    let id = start;
    let subbedOn = false;
    for (const e of evs) {
      if (e.type === 'sub' && e.offId === id) { id = e.onId; subbedOn = true; }
    }
    const sentOff = evs.some(e => e.type === 'card' && e.card === 'red' && e.playerId === id);
    return { id, subbedOn, sentOff };
  });
}
