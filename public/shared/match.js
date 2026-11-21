// Shared match logic: used by the Node server AND the browser pages.
// Keep this file dependency-free ES module code.

export const PERIODS = ['PRE', '1H', 'HT', '2H', 'FT', 'ET1', 'ET2', 'PEN'];

// Periods during which the clock is meaningful (can run).
export const PLAYING_PERIODS = ['1H', '2H', 'ET1', 'ET2'];

/** Minute the clock shows at the start of each playing period. */
export function periodBaseMinutes(period, match = {}) {
  const half = match.periodLength ?? 45;
  const et = match.etPeriodLength ?? 15;
  switch (period) {
    case '2H': return half;
    case 'ET1': return half * 2;
    case 'ET2': return half * 2 + et;
    default: return 0;
  }
}

/** Regulation length (minutes) of a playing period. */
export function periodLengthMinutes(period, match = {}) {
  if (period === 'ET1' || period === 'ET2') return match.etPeriodLength ?? 15;
  return match.periodLength ?? 45;
}

/** Milliseconds elapsed within the current period. */
export function elapsedMs(clock, now) {
  if (!clock) return 0;
  let ms = clock.accumulatedMs || 0;
  if (clock.running && clock.startedAt) ms += Math.max(0, now - clock.startedAt);
  return Math.max(0, ms);
}

/** Total match-clock milliseconds as displayed (period base + elapsed). */
export function displayMs(clock, match, now) {
  return periodBaseMinutes(clock.period, match) * 60000 + elapsedMs(clock, now);
}

/** "MM:SS" (minutes can exceed 99 in extra time). */
export function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Football-style minute for an event: 1st minute is "1", stoppage time is "45+2".
 */
export function eventMinute(clock, match, now) {
  const period = PLAYING_PERIODS.includes(clock.period) ? clock.period : null;
  if (!period) {
    // Logged outside a playing period (e.g. at HT): use end of the previous period.
    const prev = { HT: '1H', FT: '2H', PEN: 'ET2' }[clock.period];
    if (!prev) return '0';
    return String(periodBaseMinutes(prev, match) + periodLengthMinutes(prev, match));
  }
  const base = periodBaseMinutes(period, match);
  const len = periodLengthMinutes(period, match);
  const inPeriod = Math.floor(elapsedMs(clock, now) / 60000) + 1;
  if (inPeriod > len) return `${base + len}+${inPeriod - len}`;
  return String(base + inPeriod);
}

/** Sort key for minutes like "45+2". */
export function minuteSortValue(minute) {
  const [a, b] = String(minute).split('+').map(Number);
  return (a || 0) + (b || 0) / 100;
}

export function score(events) {
  const s = { home: 0, away: 0 };
  for (const e of events || []) if (e.type === 'goal') s[e.team] += 1;
  return s;
}

export function otherSide(side) {
  return side === 'home' ? 'away' : 'home';
}

export function findPlayer(team, id) {
  return team?.squad?.find(p => p.id === id) || null;
}

/** Number of yellow cards a player has received (a second yellow is logged as red). */
export function yellowCount(events, side, playerId) {
  return (events || []).filter(e => e.type === 'card' && e.team === side && e.playerId === playerId && e.card === 'yellow').length;
}

export function isSentOff(events, side, playerId) {
  return (events || []).some(e => e.type === 'card' && e.team === side && e.playerId === playerId && e.card === 'red');
}

/** Set of player ids currently on the pitch for a side (starting XI adjusted by subs and red cards). */
export function onPitch(team, events, side) {
  const set = new Set(team?.lineup?.starting || []);
  for (const e of events || []) {
    if (e.team !== side) continue;
    if (e.type === 'sub') { set.delete(e.offId); if (e.onId) set.add(e.onId); }
    if (e.type === 'card' && e.card === 'red') set.delete(e.playerId);
  }
  return set;
}

/**
 * Goalscorers per side, grouped by player: [{ name, minutes: ["23", "45+2 (P)"] }].
 * Own goals are listed under the side that was credited with the goal.
 */
export function scorers(state, side) {
  const out = [];
  const byKey = new Map();
  const goals = (state.events || []).filter(e => e.type === 'goal' && e.team === side)
    .sort((a, b) => minuteSortValue(a.minute) - minuteSortValue(b.minute));
  for (const g of goals) {
    const squadSide = g.ownGoal ? otherSide(side) : side;
    const p = findPlayer(state.teams?.[squadSide], g.playerId);
    const name = p ? p.name : (g.ownGoal ? 'Own goal' : 'Goal');
    const key = `${squadSide}:${g.playerId || 'unknown'}:${g.ownGoal ? 'og' : ''}`;
    const tag = g.ownGoal ? ' (OG)' : g.penalty ? ' (P)' : '';
    if (!byKey.has(key)) { const row = { name, minutes: [] }; byKey.set(key, row); out.push(row); }
    byKey.get(key).minutes.push(`${g.minute}'${tag}`);
  }
  return out;
}

export function surname(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || '';
}

export const POSITION_ORDER = ['GK', 'DEF', 'MID', 'FWD'];
export const POSITION_NAMES = { GK: 'Goalkeeper', DEF: 'Defenders', MID: 'Midfielders', FWD: 'Forwards' };
