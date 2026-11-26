// The single source of truth for match state.
// Every change goes through dispatch(): it runs an action on a copy of the state,
// commits it, persists it to data/state.json and notifies listeners.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, readJson, writeJsonAtomic } from './config.js';
import { actions } from './actions.js';

export const STATE_FILE = path.join(DATA_DIR, 'state.json');
const UNDO_LIMIT = 30;

function emptySide() {
  return {
    id: null, name: '', short: '', colors: { primary: '#333333', secondary: '#ffffff', text: '#ffffff' }, logo: '', manager: '',
    squad: [], lineup: { starting: [], subs: [], captain: null, formation: null, slots: [] },
  };
}

export function defaultState() {
  return {
    rev: 0,
    match: { competition: '', competitionLogo: '', periodLength: 45, etPeriodLength: 15, firstLeg: { enabled: false, home: 0, away: 0 } },
    teams: { home: emptySide(), away: emptySide() },
    clock: { period: 'PRE', running: false, startedAt: null, accumulatedMs: 0, addedTime: 0 },
    events: [],
    shootout: { kicks: [] },
    graphics: {
      scorebug: { visible: true, clock: true },
      added: { visible: true },  // the "+3" added-time badge (Hide keeps the number)
      lowerThird: { visible: false, kind: null, eventId: null, title: '', subtitle: '', team: null, sting: false, shownAt: 0, hideAt: 0, id: null },
      board: { visible: false, kind: 'KO' },
      shootout: { visible: false },
      lineup: { visible: false, team: 'home' },
      eventQueue: [], // card/sub event ids waiting to be shown back to back ("Show")
    },
    settings: { autoShow: { goal: true, card: true, sub: true }, sting: true, stingAway: false },
  };
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(base)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v)
      ? merge(base[k], v) : v;
  }
  return out;
}

// The parts of state that undo restores. Graphics visibility is deliberately excluded.
const UNDO_KEYS = ['match', 'teams', 'clock', 'events', 'shootout'];

export class Store extends EventEmitter {
  constructor({ file = STATE_FILE, getTheme = () => ({}), persist = true } = {}) {
    super();
    this.file = file;
    this.getTheme = getTheme;
    this.persist = persist;
    const saved = persist ? readJson(file, null) : null;
    this.state = merge(defaultState(), saved?.state || {});
    this.undoStack = Array.isArray(saved?.undo) ? saved.undo.slice(-UNDO_LIMIT) : [];
    this.timer = null;
    this.scheduleTimers();
  }

  uid() { return crypto.randomBytes(5).toString('hex'); }

  /** Run an action. Returns { ok, error?, result? }. */
  dispatch(type, payload = {}, meta = {}) {
    if (type === 'undo') return this.undo();
    const def = actions[type];
    if (!def) return { ok: false, error: `Unknown action "${type}"` };
    const draft = structuredClone(this.state);
    const ctx = { now: Date.now(), theme: this.getTheme(), uid: () => this.uid(), meta };
    let result;
    try {
      result = def.run(draft, payload || {}, ctx);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (def.undo) {
      const label = typeof def.undo === 'function' ? def.undo(this.state, payload, draft) : def.undo;
      const snapshot = {};
      for (const k of UNDO_KEYS) snapshot[k] = this.state[k];
      this.undoStack.push({ label, type, snapshot: structuredClone(snapshot), at: ctx.now });
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    }
    const before = this.state;
    this.commit(draft);
    this.emit('action', { type, before, after: this.state });
    return { ok: true, result };
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return { ok: false, error: 'Nothing to undo' };
    const draft = structuredClone(this.state);
    Object.assign(draft, structuredClone(entry.snapshot));
    // Hide any lower third that refers to an event that no longer exists.
    const lt = draft.graphics.lowerThird;
    if (lt.visible && lt.eventId && !draft.events.some(e => e.id === lt.eventId)) lt.visible = false;
    const before = this.state;
    this.commit(draft);
    this.emit('action', { type: 'undo', undone: entry.type, before, after: this.state });
    return { ok: true, result: { undone: entry.label } };
  }

  /** Replace the whole state (used by demo mode to restore). */
  replace(state, undoStack = []) {
    this.undoStack = undoStack;
    this.commit(merge(defaultState(), state));
  }

  commit(draft) {
    draft.rev = (this.state.rev || 0) + 1;
    this.state = draft;
    this.save();
    this.scheduleTimers();
    this.emit('change', this.state);
  }

  save() {
    if (!this.persist) return;
    try {
      writeJsonAtomic(this.file, { savedAt: new Date().toISOString(), state: this.state, undo: this.undoStack });
    } catch (err) {
      console.error('[store] failed to save state:', err.message);
    }
  }

  undoInfo() {
    const top = this.undoStack[this.undoStack.length - 1];
    return { depth: this.undoStack.length, label: top ? top.label : null };
  }

  /** Auto-hide for lower thirds. hideAt is stored in state, so it survives restarts. */
  scheduleTimers() {
    clearTimeout(this.timer);
    const lt = this.state.graphics.lowerThird;
    if (lt.visible && lt.hideAt) {
      const id = lt.id;
      const delay = Math.max(0, lt.hideAt - Date.now());
      this.timer = setTimeout(() => this.dispatch('lowerThird.hide', { id }), Math.min(delay, 2 ** 31 - 1));
    }
  }
}
