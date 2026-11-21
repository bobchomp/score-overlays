// Demo mode: plays through a simulated match so every graphic can be checked without a game.
// Your real match state is backed up first and restored when the demo stops.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DATA_DIR, listTeams, readJson, writeJsonAtomic } from './config.js';

const BACKUP = path.join(DATA_DIR, 'demo-backup.json');
const min = (m, s = 0) => (m * 60 + s) * 1000;

export class Demo extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.timers = [];
    this.running = false;
    this.step = '';
    // A demo can't survive a restart; put the real match back if one was interrupted.
    const backup = readJson(BACKUP, null);
    if (backup?.state) {
      console.log('[demo] restoring match state saved before an interrupted demo');
      store.replace(backup.state, backup.undo || []);
      fs.rmSync(BACKUP, { force: true });
    }
  }

  status() { return { running: this.running, step: this.step }; }

  start() {
    if (this.running) throw new Error('Demo already running');
    const teams = listTeams();
    if (teams.length < 2) throw new Error('Demo needs at least two teams in config/teams');
    const home = teams.find(t => t.id === 'riverside') || teams[0];
    const away = teams.find(t => t.id === 'hillcrest' && t !== home) || teams.find(t => t !== home);

    writeJsonAtomic(BACKUP, { state: this.store.state, undo: this.store.undoStack });
    this.running = true;

    const lineup = t => ({ starting: t.squad.slice(0, 11).map(p => p.id), subs: t.squad.slice(11).map(p => p.id), captain: t.squad[Math.min(5, t.squad.length - 1)]?.id });
    const pick = (t, pos, n = 0) => (t.squad.slice(0, 11).filter(p => p.position === pos)[n] || t.squad[n])?.id;
    const bench = (t, n = 0) => t.squad[11 + n]?.id;
    const d = (a, p = {}) => () => {
      const r = this.store.dispatch(a, p, { source: 'demo' });
      if (!r.ok) console.warn(`[demo] ${a} failed: ${r.error}`);
    };

    const script = [
      [0, 'Setting up teams', d('match.setup', { newMatch: true, competition: 'Demo Cup · Round 3', home: { teamId: home.id, lineup: lineup(home) }, away: { teamId: away.id, lineup: lineup(away) } })],
      [1500, 'Kick-off board', d('board.show', { kind: 'KO' })],
      [6000, `Lineup: ${home.short}`, d('lineup.show', { team: 'home' })],
      [7000, `Lineup: ${away.short}`, d('lineup.show', { team: 'away' })],
      [7000, 'Kick-off', () => { d('graphics.hideAll')(); d('clock.period', { period: '1H', start: true })(); }],
      [4000, 'Clock jump to 11:40', d('clock.set', { ms: min(11, 40) })],
      [3000, `Goal ${home.short}`, d('goal.add', { team: 'home', playerId: pick(home, 'FWD') })],
      [12000, 'Yellow card', d('card.add', { team: 'away', playerId: pick(away, 'DEF', 1), card: 'yellow' })],
      [10000, 'Substitution', () => { d('clock.set', { ms: min(31, 10) })(); d('sub.add', { team: 'away', offId: pick(away, 'MID', 2), onId: bench(away, 4) })(); }],
      [10000, 'Free-text lower third', d('lowerThird.text', { title: 'Attendance', subtitle: "Today's crowd: 412", autoHide: true })],
      [10000, 'Added time +2', () => { d('lowerThird.hide')(); d('clock.set', { ms: min(44, 50) })(); d('clock.addedTime', { minutes: 2 })(); }],
      [5000, `Penalty goal ${away.short} (45+2)`, () => { d('clock.set', { ms: min(46, 15) })(); d('goal.add', { team: 'away', playerId: pick(away, 'FWD'), penalty: true })(); }],
      [12000, 'Half time', () => { d('clock.period', { period: 'HT' })(); d('board.show', { kind: 'HT' })(); }],
      [9000, 'Second half', () => { d('board.hide')(); d('clock.period', { period: '2H', start: true })(); }],
      [3000, 'Clock jump to 63:00', d('clock.set', { ms: min(18) })],
      [2000, `Own goal for ${home.short}`, d('goal.add', { team: 'home', playerId: pick(away, 'DEF', 2), ownGoal: true })],
      [12000, 'Second yellow → red', () => { d('clock.set', { ms: min(27, 30) })(); d('card.add', { team: 'away', playerId: pick(away, 'DEF', 1), card: 'yellow' })(); }],
      [10000, `Substitution ${home.short}`, d('sub.add', { team: 'home', offId: pick(home, 'FWD', 1), onId: bench(home, 5) })],
      [10000, `Goal ${home.short}`, () => { d('clock.set', { ms: min(41, 5) })(); d('goal.add', { team: 'home', playerId: pick(home, 'MID', 2) })(); }],
      [12000, 'Added time +4', () => { d('clock.set', { ms: min(45, 20) })(); d('clock.addedTime', { minutes: 4 })(); }],
      [6000, 'Full time', () => { d('clock.period', { period: 'FT' })(); d('board.show', { kind: 'FT' })(); }],
      [10000, 'Man of the Match', () => {
        const p = home.squad.find(x => x.id === pick(home, 'MID', 2));
        d('lowerThird.text', { title: 'Man of the Match', subtitle: p ? `#${p.number} ${p.name} · ${home.name}` : home.name, team: 'home' })();
      }],
      [10000, 'Demo finished. Press "Stop demo" to restore your match.', d('lowerThird.hide')],
    ];

    let at = 0;
    for (const [delay, label, fn] of script) {
      at += delay;
      this.timers.push(setTimeout(() => {
        this.step = label;
        console.log(`[demo] ${label}`);
        try { fn(); } catch (err) { console.warn('[demo] step failed:', err.message); }
        this.emit('change');
      }, at));
    }
    this.step = 'Starting…';
    this.emit('change');
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (!this.running) return;
    this.running = false;
    this.step = '';
    const backup = readJson(BACKUP, null);
    if (backup?.state) this.store.replace(backup.state, backup.undo || []);
    fs.rmSync(BACKUP, { force: true });
    this.emit('change');
  }
}
