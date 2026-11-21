// Match event log export for highlights and match reports.
import { score, findPlayer, otherSide, minuteSortValue } from '../public/shared/match.js';

function rows(state) {
  const name = (side, id) => findPlayer(state.teams[side], id)?.name || '';
  const num = (side, id) => findPlayer(state.teams[side], id)?.number ?? '';
  return [...state.events]
    .sort((a, b) => minuteSortValue(a.minute) - minuteSortValue(b.minute) || a.ts - b.ts)
    .map(e => {
      const base = { minute: e.minute, time: new Date(e.ts).toISOString(), team: state.teams[e.team].short, side: e.team, type: e.type };
      if (e.type === 'goal') {
        const sq = e.ownGoal ? otherSide(e.team) : e.team;
        return { ...base, detail: e.ownGoal ? 'own goal' : e.penalty ? 'penalty' : '', player: name(sq, e.playerId), number: num(sq, e.playerId), player2: '', number2: '' };
      }
      if (e.type === 'card') {
        return { ...base, detail: e.secondYellow ? 'second yellow' : e.card, player: name(e.team, e.playerId), number: num(e.team, e.playerId), player2: '', number2: '' };
      }
      return { ...base, detail: 'off / on', player: name(e.team, e.offId), number: num(e.team, e.offId), player2: name(e.team, e.onId), number2: num(e.team, e.onId) };
    });
}

export function exportJson(state) {
  return {
    exportedAt: new Date().toISOString(),
    competition: state.match.competition,
    home: { name: state.teams.home.name, short: state.teams.home.short },
    away: { name: state.teams.away.name, short: state.teams.away.short },
    score: score(state.events),
    period: state.clock.period,
    events: rows(state),
  };
}

export function exportCsv(state) {
  const cols = ['minute', 'time', 'team', 'side', 'type', 'detail', 'player', 'number', 'player2', 'number2'];
  const esc = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheets treating names as formulas
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows(state).map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}
