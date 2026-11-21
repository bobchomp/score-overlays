// Action handlers. Each `run(state, payload, ctx)` mutates a draft copy of the state.
// `undo` is either a label string or a function returning one; actions without it are not undoable.
import { loadTeam } from './config.js';
import {
  PERIODS, PLAYING_PERIODS, eventMinute, elapsedMs, findPlayer, otherSide, yellowCount, isSentOff,
} from '../public/shared/match.js';

const SIDES = ['home', 'away'];

function side(v) {
  if (!SIDES.includes(v)) throw new Error('team must be "home" or "away"');
  return v;
}

function teamShort(state, s) { return state.teams[s].short || s.toUpperCase(); }

function playerLabel(state, s, id) {
  const p = findPlayer(state.teams[s], id);
  return p ? p.name : 'unknown';
}

function requirePlayer(state, s, id, label = 'player') {
  if (!id) return null;
  const p = findPlayer(state.teams[s], id);
  if (!p) throw new Error(`Unknown ${label} for ${teamShort(state, s)}`);
  return p;
}

function lowerThirdFor(state, ctx, fields) {
  const timings = ctx.theme.timings || {};
  const sting = !!fields.sting;
  const secs = Number(timings.lowerThirdSec) || 0;
  const stingMs = sting ? Number(timings.stingMs) || 0 : 0;
  const autoHide = fields.autoHide ?? (fields.kind !== 'text');
  state.graphics.lowerThird = {
    visible: true, kind: null, eventId: null, title: '', subtitle: '', team: null, stingOnly: false,
    ...fields,
    sting,
    id: ctx.uid(),
    shownAt: ctx.now,
    hideAt: fields.stingOnly ? ctx.now + stingMs + 250
      : autoHide && secs > 0 ? ctx.now + stingMs + secs * 1000 : 0,
  };
  delete state.graphics.lowerThird.autoHide;
  // A lower third replaces any full-screen graphic.
  state.graphics.board.visible = false;
  state.graphics.lineup.visible = false;
}

function showEvent(state, ctx, ev, { sting = false } = {}) {
  lowerThirdFor(state, ctx, { kind: ev.type, eventId: ev.id, team: ev.team, sting: ev.type === 'goal' && sting });
}

function pauseClock(clock, now) {
  if (clock.running) {
    clock.accumulatedMs = elapsedMs(clock, now);
    clock.running = false;
    clock.startedAt = null;
  }
}

function buildSide(teamId, opts = {}) {
  const team = loadTeam(teamId);
  if (!team) throw new Error(`Team "${teamId}" not found`);
  const ids = new Set(team.squad.map(p => p.id));
  const lineup = opts.lineup || {};
  const starting = (lineup.starting || []).filter(id => ids.has(id));
  const subs = (lineup.subs || []).filter(id => ids.has(id) && !starting.includes(id));
  return {
    ...team,
    colors: { ...team.colors, ...(opts.colors || {}) },
    lineup: { starting, subs, captain: ids.has(lineup.captain) ? lineup.captain : null },
  };
}

export const actions = {
  // ---------------- match setup ----------------
  'match.setup': {
    undo: 'Match setup',
    run(state, p) {
      for (const s of SIDES) {
        if (p[s]?.teamId) state.teams[s] = buildSide(p[s].teamId, p[s]);
      }
      if (p.competition !== undefined) state.match.competition = String(p.competition).slice(0, 80);
      if (p.competitionLogo !== undefined) state.match.competitionLogo = String(p.competitionLogo);
      if (p.newMatch) {
        state.events = [];
        state.clock = { period: 'PRE', running: false, startedAt: null, accumulatedMs: 0, addedTime: 0 };
        state.graphics.lowerThird.visible = false;
        state.graphics.board.visible = false;
        state.graphics.lineup.visible = false;
      }
    },
  },

  'match.update': {
    undo: 'Edit match details',
    run(state, p) {
      if (p.competition !== undefined) state.match.competition = String(p.competition).slice(0, 80);
      if (p.competitionLogo !== undefined) state.match.competitionLogo = String(p.competitionLogo);
      for (const s of SIDES) {
        if (p[s]?.colors) state.teams[s].colors = { ...state.teams[s].colors, ...p[s].colors };
      }
    },
  },

  /** Internal: a team config file was edited, refresh the copy held in the match. */
  'team.refresh': {
    run(state, p) {
      for (const s of SIDES) {
        if (state.teams[s].id !== p.teamId) continue;
        const fresh = loadTeam(p.teamId);
        if (!fresh) continue;
        const ids = new Set(fresh.squad.map(x => x.id));
        const lu = state.teams[s].lineup;
        state.teams[s] = {
          ...fresh,
          lineup: {
            starting: lu.starting.filter(id => ids.has(id)),
            subs: lu.subs.filter(id => ids.has(id)),
            captain: ids.has(lu.captain) ? lu.captain : null,
          },
        };
      }
    },
  },

  'match.reset': {
    undo: 'New match (reset)',
    run(state) {
      state.events = [];
      state.clock = { period: 'PRE', running: false, startedAt: null, accumulatedMs: 0, addedTime: 0 };
      state.graphics.lowerThird.visible = false;
      state.graphics.board.visible = false;
      state.graphics.lineup.visible = false;
    },
  },

  /** Wipe everything entered for this game: score, events, clock, teams, lineups and competition. */
  'match.resetAll': {
    undo: 'Reset everything',
    run(state) {
      actions['match.reset'].run(state);
      state.match.competition = '';
      state.match.competitionLogo = '';
      for (const s of SIDES) {
        state.teams[s] = {
          id: null, name: '', short: '', colors: { primary: '#333333', secondary: '#ffffff', text: '#ffffff' }, logo: '',
          squad: [], lineup: { starting: [], subs: [], captain: null },
        };
      }
    },
  },

  // ---------------- goals ----------------
  'goal.add': {
    undo: (state, p) => `Goal ${teamShort(state, p.team)}`,
    run(state, p, ctx) {
      const s = side(p.team);
      const ownGoal = !!p.ownGoal;
      // For an own goal the scorer comes from the other squad.
      requirePlayer(state, ownGoal ? otherSide(s) : s, p.playerId, 'scorer');
      const ev = {
        id: ctx.uid(), type: 'goal', team: s, playerId: p.playerId || null,
        ownGoal, penalty: !ownGoal && !!p.penalty,
        minute: p.minute ? String(p.minute) : eventMinute(state.clock, state.match, ctx.now),
        ts: ctx.now,
      };
      state.events.push(ev);
      const show = p.show ?? state.settings.autoShow.goal;
      // The big GOAL! sting plays for home goals; away goals only if the operator turned that on.
      const sting = state.settings.sting && (s === 'home' || state.settings.stingAway);
      if (show) {
        if (p.pending) {
          // Scorer not known yet: play just the GOAL! sting now; the name lower third follows once a scorer is picked.
          if (sting) lowerThirdFor(state, ctx, { kind: 'goal', eventId: ev.id, team: s, sting: true, stingOnly: true });
        } else {
          showEvent(state, ctx, ev, { sting });
        }
      }
      return { event: ev };
    },
  },

  'goal.removeLast': {
    undo: (state, p) => `Remove goal ${teamShort(state, p.team)}`,
    run(state, p) {
      const s = side(p.team);
      const idx = state.events.map(e => e.type === 'goal' && e.team === s).lastIndexOf(true);
      if (idx < 0) throw new Error(`${teamShort(state, s)} has no goals to remove`);
      const [removed] = state.events.splice(idx, 1);
      if (state.graphics.lowerThird.eventId === removed.id) state.graphics.lowerThird.visible = false;
    },
  },

  // ---------------- cards ----------------
  'card.add': {
    undo: (state, p) => `${p.card === 'red' ? 'Red' : 'Yellow'} card ${playerLabel(state, p.team, p.playerId)}`,
    run(state, p, ctx) {
      const s = side(p.team);
      const player = requirePlayer(state, s, p.playerId);
      if (!player) throw new Error('Pick a player for the card');
      if (!['yellow', 'red'].includes(p.card)) throw new Error('card must be yellow or red');
      if (isSentOff(state.events, s, player.id)) throw new Error(`${player.name} has already been sent off`);
      let card = p.card;
      let secondYellow = false;
      if (card === 'yellow' && yellowCount(state.events, s, player.id) >= 1) { card = 'red'; secondYellow = true; }
      const ev = {
        id: ctx.uid(), type: 'card', team: s, playerId: player.id, card, secondYellow,
        minute: p.minute ? String(p.minute) : eventMinute(state.clock, state.match, ctx.now), ts: ctx.now,
      };
      state.events.push(ev);
      if (p.show ?? state.settings.autoShow.card) showEvent(state, ctx, ev);
      return { event: ev };
    },
  },

  // ---------------- substitutions ----------------
  'sub.add': {
    undo: (state, p) => `Sub ${teamShort(state, p.team)}`,
    run(state, p, ctx) {
      const s = side(p.team);
      const off = requirePlayer(state, s, p.offId, 'player off');
      const on = requirePlayer(state, s, p.onId, 'player on');
      if (!off || !on) throw new Error('Pick both the player coming off and the player coming on');
      if (off.id === on.id) throw new Error('Player off and player on must be different');
      const ev = {
        id: ctx.uid(), type: 'sub', team: s, offId: off.id, onId: on.id,
        minute: p.minute ? String(p.minute) : eventMinute(state.clock, state.match, ctx.now), ts: ctx.now,
      };
      state.events.push(ev);
      if (p.show ?? state.settings.autoShow.sub) showEvent(state, ctx, ev);
      return { event: ev };
    },
  },

  // ---------------- events ----------------
  'event.delete': {
    undo: 'Delete event',
    run(state, p) {
      const idx = state.events.findIndex(e => e.id === p.id);
      if (idx < 0) throw new Error('Event not found');
      state.events.splice(idx, 1);
      if (state.graphics.lowerThird.eventId === p.id) state.graphics.lowerThird.visible = false;
    },
  },

  'event.update': {
    undo: 'Edit event',
    run(state, p) {
      const ev = state.events.find(e => e.id === p.id);
      if (!ev) throw new Error('Event not found');
      if (p.minute !== undefined) ev.minute = String(p.minute).replace(/'/g, '').trim() || ev.minute;
      if (ev.type === 'goal') {
        if (p.ownGoal !== undefined) ev.ownGoal = !!p.ownGoal;
        if (p.penalty !== undefined) ev.penalty = !ev.ownGoal && !!p.penalty;
        if (p.playerId !== undefined) {
          requirePlayer(state, ev.ownGoal ? otherSide(ev.team) : ev.team, p.playerId, 'scorer');
          ev.playerId = p.playerId || null;
        }
      }
    },
  },

  // ---------------- clock ----------------
  'clock.start': {
    undo: 'Start clock',
    run(state, p, ctx) {
      const c = state.clock;
      if (!PLAYING_PERIODS.includes(c.period)) {
        // Starting from pre-match / a break moves to the next playing period.
        const next = { PRE: '1H', HT: '2H' }[c.period];
        if (!next) throw new Error(`Clock can't run during ${c.period}. Pick a period first.`);
        Object.assign(c, { period: next, accumulatedMs: 0, addedTime: 0 });
      }
      if (!c.running) { c.running = true; c.startedAt = ctx.now; }
    },
  },
  'clock.pause': {
    undo: 'Pause clock',
    run(state, p, ctx) { pauseClock(state.clock, ctx.now); },
  },
  'clock.toggle': {
    undo: s => (s.clock.running ? 'Pause clock' : 'Start clock'),
    run(state, p, ctx) {
      if (state.clock.running) pauseClock(state.clock, ctx.now);
      else actions['clock.start'].run(state, p, ctx);
    },
  },
  'clock.reset': {
    undo: 'Reset clock',
    run(state) {
      Object.assign(state.clock, { running: false, startedAt: null, accumulatedMs: 0, addedTime: 0 });
    },
  },
  /** Set time elapsed in the current period, in ms. */
  'clock.set': {
    undo: 'Set clock',
    run(state, p, ctx) {
      const ms = Math.max(0, Math.round(Number(p.ms) || 0));
      state.clock.accumulatedMs = ms;
      if (state.clock.running) state.clock.startedAt = ctx.now;
    },
  },
  'clock.adjust': {
    undo: 'Adjust clock',
    run(state, p, ctx) {
      const c = state.clock;
      const cur = elapsedMs(c, ctx.now);
      c.accumulatedMs = Math.max(0, cur + (Number(p.deltaMs) || 0));
      if (c.running) c.startedAt = ctx.now;
    },
  },
  'clock.period': {
    undo: (s, p) => `Set period ${p.period}`,
    run(state, p, ctx) {
      if (!PERIODS.includes(p.period)) throw new Error(`Unknown period ${p.period}`);
      const c = state.clock;
      pauseClock(c, ctx.now);
      c.period = p.period;
      c.accumulatedMs = 0;
      c.addedTime = 0;
      if (p.start && PLAYING_PERIODS.includes(p.period)) { c.running = true; c.startedAt = ctx.now; }
    },
  },
  'clock.addedTime': {
    undo: 'Added time',
    run(state, p) {
      state.clock.addedTime = Math.max(0, Math.min(30, Math.round(Number(p.minutes) || 0)));
    },
  },

  // ---------------- graphics ----------------
  'scorebug.set': {
    run(state, p) { state.graphics.scorebug.visible = p.visible ?? !state.graphics.scorebug.visible; },
  },
  'lowerThird.event': {
    run(state, p, ctx) {
      const ev = state.events.find(e => e.id === p.id);
      if (!ev) throw new Error('Event not found');
      showEvent(state, ctx, ev, { sting: !!p.sting });
    },
  },
  'lowerThird.text': {
    run(state, p, ctx) {
      const title = String(p.title || '').trim().slice(0, 80);
      const subtitle = String(p.subtitle || '').trim().slice(0, 120);
      if (!title && !subtitle) throw new Error('Enter a title or subtitle');
      lowerThirdFor(state, ctx, {
        kind: 'text', title, subtitle,
        team: SIDES.includes(p.team) ? p.team : null,
        autoHide: !!p.autoHide,
      });
    },
  },
  'lowerThird.hide': {
    run(state, p) {
      // If an id is given, only hide that specific lower third (stale auto-hide timers are ignored).
      if (p.id && state.graphics.lowerThird.id !== p.id) return;
      state.graphics.lowerThird.visible = false;
    },
  },
  'board.show': {
    run(state, p) {
      if (!['KO', 'HT', 'FT', 'SCORE'].includes(p.kind)) throw new Error('Unknown board');
      const b = state.graphics.board;
      if (p.toggle && b.visible && b.kind === p.kind) { b.visible = false; return; }
      state.graphics.board = { visible: true, kind: p.kind };
      state.graphics.lineup.visible = false;
      state.graphics.lowerThird.visible = false;
    },
  },
  'board.hide': { run(state) { state.graphics.board.visible = false; } },
  'lineup.show': {
    run(state, p) {
      const s = side(p.team);
      const l = state.graphics.lineup;
      if (p.toggle && l.visible && l.team === s) { l.visible = false; return; }
      state.graphics.lineup = { visible: true, team: s };
      state.graphics.board.visible = false;
      state.graphics.lowerThird.visible = false;
    },
  },
  'lineup.hide': { run(state) { state.graphics.lineup.visible = false; } },
  'graphics.hideAll': {
    run(state) {
      state.graphics.lowerThird.visible = false;
      state.graphics.board.visible = false;
      state.graphics.lineup.visible = false;
    },
  },

  // ---------------- settings ----------------
  'settings.set': {
    run(state, p) {
      if (p.autoShow) for (const k of ['goal', 'card', 'sub']) if (k in p.autoShow) state.settings.autoShow[k] = !!p.autoShow[k];
      if ('sting' in p) state.settings.sting = !!p.sting;
      if ('stingAway' in p) state.settings.stingAway = !!p.stingAway;
    },
  },
};
