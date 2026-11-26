// Action handlers. Each `run(state, payload, ctx)` mutates a draft copy of the state.
// `undo` is either a label string or a function returning one; actions without it are not undoable.
import { loadTeam } from './config.js';
import { isFormation, fitSlots } from '../public/shared/formations.js';
import {
  PERIODS, PLAYING_PERIODS, eventMinute, shootoutSummary, elapsedMs, findPlayer, otherSide, yellowCount, isSentOff,
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
  // A lower third replaces any full-screen graphic (and the shootout lower third).
  state.graphics.board.visible = false;
  state.graphics.lineup.visible = false;
  state.graphics.shootout.visible = false;
}

/** Queued card/sub ids that still exist (one deleted or undone drops out of the queue). */
function liveEventQueue(state) {
  const ok = new Set(state.events.filter(e => e.type === 'sub' || e.type === 'card').map(e => e.id));
  return (state.graphics.eventQueue || []).filter(id => ok.has(id));
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

/** Two-legged tie: goals each side (as named in THIS match) scored in the first leg. */
function cleanFirstLeg(v) {
  const n = x => Math.max(0, Math.min(99, Math.round(Number(x) || 0)));
  return { enabled: !!v?.enabled, home: n(v?.home), away: n(v?.away) };
}

function buildSide(teamId, opts = {}) {
  const team = loadTeam(teamId);
  if (!team) throw new Error(`Team "${teamId}" not found`);
  const ids = new Set(team.squad.map(p => p.id));
  const lineup = opts.lineup || {};
  const starting = (lineup.starting || []).filter(id => ids.has(id));
  const subs = (lineup.subs || []).filter(id => ids.has(id) && !starting.includes(id));
  // Formation (optional): the lineup graphic draws the XI on a pitch; without one it lists them.
  const formation = isFormation(lineup.formation) ? lineup.formation : null;
  const slots = formation ? fitSlots(formation, lineup.slots, starting, team.squad) : [];
  return {
    ...team,
    colors: { ...team.colors, ...(opts.colors || {}) },
    lineup: { starting, subs, captain: ids.has(lineup.captain) ? lineup.captain : null, formation, slots },
  };
}

export const actions = {
  // ---------------- match setup ----------------
  'match.setup': {
    undo: 'Lineups',
    run(state, p) {
      for (const s of SIDES) {
        if (p[s]?.teamId) state.teams[s] = buildSide(p[s].teamId, p[s]);
      }
      if (p.competition !== undefined) state.match.competition = String(p.competition).slice(0, 80);
      if (p.competitionLogo !== undefined) state.match.competitionLogo = String(p.competitionLogo);
      if (p.firstLeg !== undefined) state.match.firstLeg = cleanFirstLeg(p.firstLeg);
      // A new match wipes everything from the previous one (same as "Reset score, events & clock").
      if (p.newMatch) actions['match.reset'].run(state);
    },
  },

  'match.update': {
    undo: 'Edit match details',
    run(state, p) {
      if (p.competition !== undefined) state.match.competition = String(p.competition).slice(0, 80);
      if (p.competitionLogo !== undefined) state.match.competitionLogo = String(p.competitionLogo);
      if (p.firstLeg !== undefined) state.match.firstLeg = cleanFirstLeg(p.firstLeg);
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
            formation: lu.formation || null,
            slots: (lu.slots || []).map(id => (id && ids.has(id) ? id : null)),
          },
        };
      }
    },
  },

  'match.reset': {
    undo: 'New match (reset)',
    run(state) {
      state.events = [];
      state.shootout = { kicks: [] };
      state.clock = { period: 'PRE', running: false, startedAt: null, accumulatedMs: 0, addedTime: 0 };
      state.graphics.lowerThird.visible = false;
      state.graphics.board.visible = false;
      state.graphics.lineup.visible = false;
      state.graphics.shootout.visible = false;
      state.graphics.eventQueue = [];
    },
  },

  /** Wipe everything entered for this game: score, events, clock, teams, lineups and competition. */
  'match.resetAll': {
    undo: 'Reset everything',
    run(state) {
      actions['match.reset'].run(state);
      state.match.competition = '';
      state.match.competitionLogo = '';
      state.match.firstLeg = { enabled: false, home: 0, away: 0 };
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
      // The team's goal number (used to name its replay "<team> <n>"): one more than the highest goal still
      // standing, so deleting an earlier goal never reuses a number that's already on a clip, while a
      // disallowed latest goal (− remove) frees its number for the next one.
      const own = state.events.filter(e => e.type === 'goal' && e.team === s);
      ev.number = Math.max(0, ...own.map((e, i) => e.number ?? i + 1)) + 1;
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
      return { event: ev, teamGoals: ev.number };
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
      // Like subs, the card graphic waits in the queue until "Show" plays everything queued.
      const queued = p.show ?? state.settings.autoShow.card;
      if (queued) state.graphics.eventQueue.push(ev.id);
      return { event: ev, queued };
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
      // The graphic waits in the subs queue; "Show subs" plays everything queued back to back.
      const queued = p.show ?? state.settings.autoShow.sub;
      if (queued) state.graphics.eventQueue.push(ev.id);
      return { event: ev, queued };
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
      state.graphics.added.visible = true; // a new period starts with the badge ready to show
      if (p.start && PLAYING_PERIODS.includes(p.period)) { c.running = true; c.startedAt = ctx.now; }
    },
  },
  /** Show/hide the "+3" badge without changing the number. */
  'added.show': {
    run(state, p) { state.graphics.added.visible = p.visible ?? !state.graphics.added.visible; },
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
  /** Show/hide the clock part of the scorebug (time, added time, ET tag). The clock keeps running. */
  'scorebug.clock': {
    run(state, p) { state.graphics.scorebug.clock = p.visible ?? !state.graphics.scorebug.clock; },
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
  // ---------------- cards & subs queue ----------------
  'eventQueue.show': {
    run(state, p, ctx) {
      const ids = liveEventQueue(state);
      state.graphics.eventQueue = [];
      if (!ids.length) throw new Error('No cards or subs waiting to be shown');
      // One lower third that swaps from one card/sub to the next in place; it closes after the last one.
      const secs = Number(ctx.theme.timings?.lowerThirdSec) || 0;
      const stepMs = (secs > 0 ? secs : 6) * 1000;
      const first = state.events.find(e => e.id === ids[0]);
      lowerThirdFor(state, ctx, { kind: 'queue', eventIds: ids, team: first.team, stepMs, autoHide: false });
      if (secs > 0) state.graphics.lowerThird.hideAt = ctx.now + stepMs * ids.length; // 0 = stays on the last one until hidden
      return { count: ids.length };
    },
  },
  'eventQueue.remove': {
    run(state, p) { state.graphics.eventQueue = state.graphics.eventQueue.filter(id => id !== p.id); },
  },
  'eventQueue.move': {
    run(state, p) {
      const q = state.graphics.eventQueue;
      const i = q.indexOf(p.id);
      const j = i + (p.dir === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= q.length) return;
      [q[i], q[j]] = [q[j], q[i]];
    },
  },
  'eventQueue.add': {
    run(state, p) {
      const ev = state.events.find(e => e.id === p.id && (e.type === 'sub' || e.type === 'card'));
      if (!ev) throw new Error('Card or sub not found');
      if (!state.graphics.eventQueue.includes(ev.id)) state.graphics.eventQueue.push(ev.id);
    },
  },
  'eventQueue.clear': { run(state) { state.graphics.eventQueue = []; } },

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
      state.graphics.shootout.visible = false;
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
      state.graphics.shootout.visible = false;
    },
  },
  'lineup.hide': { run(state) { state.graphics.lineup.visible = false; } },
  'graphics.hideAll': {
    run(state) {
      state.graphics.lowerThird.visible = false;
      state.graphics.board.visible = false;
      state.graphics.lineup.visible = false;
      state.graphics.shootout.visible = false;
    },
  },

  // ---------------- penalty shootout ----------------
  'shootout.kick': {
    undo: (state, p) => `Penalty ${teamShort(state, p.team)} ${p.scored ? 'scored' : 'missed'}`,
    run(state, p, ctx) {
      const s = side(p.team);
      if (shootoutSummary(state.shootout.kicks).decided) throw new Error('The shootout is already decided. Undo or clear it to log more kicks.');
      state.shootout.kicks.push({ id: ctx.uid(), team: s, scored: !!p.scored, ts: ctx.now });
    },
  },
  'shootout.removeLast': {
    undo: 'Remove last penalty',
    run(state) {
      if (!state.shootout.kicks.length) throw new Error('No penalties logged yet');
      state.shootout.kicks.pop();
    },
  },
  'shootout.clear': {
    undo: 'Clear shootout',
    run(state) { state.shootout.kicks = []; },
  },
  'shootout.show': {
    run(state, p) {
      const g = state.graphics.shootout;
      g.visible = p.visible ?? !g.visible;
      if (g.visible) {
        state.graphics.lowerThird.visible = false;
        state.graphics.board.visible = false;
        state.graphics.lineup.visible = false;
      }
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
