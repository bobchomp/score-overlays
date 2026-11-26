import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { score } from '../public/shared/match.js';

const theme = { timings: { lowerThirdSec: 8, stingMs: 2600 } };
function fresh() {
  const s = new Store({ persist: false, getTheme: () => theme });
  const ok = r => { assert.equal(r.ok, true, r.error); return r; };
  ok(s.dispatch('match.setup', { newMatch: true, home: { teamId: 'riverside', lineup: { starting: ['p1', 'p9'] } }, away: { teamId: 'hillcrest' } }));
  return { s, ok };
}

test('goal adds to score, shows lower third with sting, and undo removes it', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('goal.add', { team: 'home', playerId: 'p9' }));
  assert.deepEqual(score(s.state.events), { home: 1, away: 0 });
  const lt = s.state.graphics.lowerThird;
  assert.equal(lt.visible, true);
  assert.equal(lt.kind, 'goal');
  assert.equal(lt.sting, true);
  assert.ok(lt.hideAt > lt.shownAt + 8000);
  ok(s.dispatch('undo'));
  assert.deepEqual(score(s.state.events), { home: 0, away: 0 });
  assert.equal(s.state.graphics.lowerThird.visible, false, 'lower third for undone goal is hidden');
  clearTimeout(s.timer);
});

test('own goal scorer comes from the other squad', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('goal.add', { team: 'home', playerId: 'p3', ownGoal: true }));
  assert.equal(s.state.events[0].team, 'home');
  // p3 exists in both squads; a made-up id must be rejected
  assert.equal(s.dispatch('goal.add', { team: 'home', playerId: 'nope', ownGoal: true }).ok, false);
  clearTimeout(s.timer);
});

test('second yellow becomes red and a sent-off player cannot be carded again', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('card.add', { team: 'away', playerId: 'p4', card: 'yellow' }));
  const r = ok(s.dispatch('card.add', { team: 'away', playerId: 'p4', card: 'yellow' }));
  assert.equal(r.result.event.card, 'red');
  assert.equal(r.result.event.secondYellow, true);
  assert.equal(s.dispatch('card.add', { team: 'away', playerId: 'p4', card: 'yellow' }).ok, false);
  clearTimeout(s.timer);
});

test('clock start from PRE goes to 1H; HT start goes to 2H; FT refuses', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('clock.start'));
  assert.equal(s.state.clock.period, '1H');
  assert.equal(s.state.clock.running, true);
  ok(s.dispatch('clock.period', { period: 'HT' }));
  assert.equal(s.state.clock.running, false);
  ok(s.dispatch('clock.toggle'));
  assert.equal(s.state.clock.period, '2H');
  ok(s.dispatch('clock.period', { period: 'FT' }));
  assert.equal(s.dispatch('clock.start').ok, false);
});

test('undo restores a mistaken clock reset', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('clock.period', { period: '1H' }));
  ok(s.dispatch('clock.set', { ms: 600000 }));
  ok(s.dispatch('clock.reset'));
  assert.equal(s.state.clock.accumulatedMs, 0);
  ok(s.dispatch('undo'));
  assert.equal(s.state.clock.accumulatedMs, 600000);
});

test('stale auto-hide does not hide a newer lower third', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('lowerThird.text', { title: 'A', subtitle: 'one' }));
  const firstId = s.state.graphics.lowerThird.id;
  ok(s.dispatch('lowerThird.text', { title: 'B', subtitle: 'two' }));
  ok(s.dispatch('lowerThird.hide', { id: firstId }));
  assert.equal(s.state.graphics.lowerThird.visible, true);
  clearTimeout(s.timer);
});

test('reset everything clears match, teams and lineups, and can be undone', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('goal.add', { team: 'home', playerId: 'p9' }));
  ok(s.dispatch('clock.start'));
  ok(s.dispatch('match.resetAll'));
  assert.equal(s.state.events.length, 0);
  assert.equal(s.state.clock.period, 'PRE');
  assert.equal(s.state.teams.home.id, null);
  assert.equal(s.state.graphics.lowerThird.visible, false);
  ok(s.dispatch('undo'));
  assert.equal(s.state.teams.home.id, 'riverside');
  assert.equal(s.state.events.length, 1);
  clearTimeout(s.timer);
});

test('away goals skip the GOAL sting unless enabled', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('goal.add', { team: 'away', playerId: 'p9' }));
  assert.equal(s.state.graphics.lowerThird.visible, true, 'scorer lower third still shows');
  assert.equal(s.state.graphics.lowerThird.sting, false);
  ok(s.dispatch('goal.add', { team: 'home', playerId: 'p9' }));
  assert.equal(s.state.graphics.lowerThird.sting, true);
  ok(s.dispatch('settings.set', { stingAway: true }));
  ok(s.dispatch('goal.add', { team: 'away', playerId: 'p9' }));
  assert.equal(s.state.graphics.lowerThird.sting, true);
  clearTimeout(s.timer);
});

test('pending goal: score now with sting only, scorer lower third later', () => {
  const { s, ok } = fresh();
  const r = ok(s.dispatch('goal.add', { team: 'home', pending: true }));
  assert.deepEqual(score(s.state.events), { home: 1, away: 0 });
  const lt = s.state.graphics.lowerThird;
  assert.equal(lt.sting, true);
  assert.equal(lt.stingOnly, true);
  assert.ok(lt.hideAt <= lt.shownAt + 2600 + 250, 'hides right after the sting');
  ok(s.dispatch('event.update', { id: r.result.event.id, playerId: 'p9' }));
  ok(s.dispatch('lowerThird.event', { id: r.result.event.id }));
  assert.equal(s.state.graphics.lowerThird.stingOnly, false);
  assert.equal(s.state.graphics.lowerThird.sting, false);
  // away pending goal: no sting, so nothing on screen yet
  ok(s.dispatch('lowerThird.hide'));
  ok(s.dispatch('goal.add', { team: 'away', pending: true }));
  assert.equal(s.state.graphics.lowerThird.visible, false);
  clearTimeout(s.timer);
});

test('scorebug clock can be hidden and shown without affecting the clock', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('clock.start'));
  ok(s.dispatch('scorebug.clock', { visible: false }));
  assert.equal(s.state.graphics.scorebug.clock, false);
  assert.equal(s.state.clock.running, true);
  ok(s.dispatch('scorebug.clock', {}));
  assert.equal(s.state.graphics.scorebug.clock, true);
});

test('shootout kicks are undoable, refused once decided, and cleared by reset', () => {
  const { s, ok } = fresh();
  for (const [team, scored] of [['home', true], ['away', false], ['home', true], ['away', false], ['home', true], ['away', false]]) {
    ok(s.dispatch('shootout.kick', { team, scored }));
  }
  assert.equal(s.dispatch('shootout.kick', { team: 'away', scored: true }).ok, false, 'decided 3-0');
  ok(s.dispatch('undo'));
  assert.equal(s.state.shootout.kicks.length, 5);
  ok(s.dispatch('shootout.show', { visible: true }));
  assert.equal(s.state.graphics.shootout.visible, true);
  ok(s.dispatch('match.reset'));
  assert.equal(s.state.shootout.kicks.length, 0);
  assert.equal(s.state.graphics.shootout.visible, false);
});

test('two-legged tie: first leg stored, aggregate adds this match', async () => {
  const { aggregate } = await import('../public/shared/match.js');
  const { s, ok } = fresh();
  assert.equal(aggregate(s.state), null);
  ok(s.dispatch('match.update', { firstLeg: { enabled: true, home: 1, away: '2' } }));
  ok(s.dispatch('goal.add', { team: 'home', playerId: 'p9' }));
  ok(s.dispatch('goal.add', { team: 'home', playerId: 'p9' }));
  assert.deepEqual(aggregate(s.state), { home: 3, away: 2, firstLeg: { home: 1, away: 2 }, leader: 'home' });
  ok(s.dispatch('match.update', { firstLeg: { enabled: false, home: 1, away: 2 } }));
  assert.equal(aggregate(s.state), null);
  clearTimeout(s.timer);
});

test('starting a new match also clears the penalty shootout', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('shootout.kick', { team: 'home', scored: true }));
  ok(s.dispatch('match.setup', { newMatch: true, home: { teamId: 'riverside' }, away: { teamId: 'hillcrest' } }));
  assert.equal(s.state.shootout.kicks.length, 0);
});

test('added time badge: hide keeps the number, show brings it back, a new period re-arms it', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('clock.period', { period: '1H', start: true }));
  ok(s.dispatch('clock.addedTime', { minutes: 3 }));
  assert.equal(s.state.graphics.added.visible, true);
  ok(s.dispatch('added.show', { visible: false }));
  assert.equal(s.state.clock.addedTime, 3, 'number kept');
  assert.equal(s.state.graphics.added.visible, false);
  ok(s.dispatch('clock.addedTime', { minutes: 4 }));
  assert.equal(s.state.graphics.added.visible, false, 'typing a new number while hidden keeps it hidden');
  ok(s.dispatch('added.show', { visible: true }));
  assert.equal(s.state.graphics.added.visible, true);
  ok(s.dispatch('added.show', { visible: false }));
  ok(s.dispatch('clock.period', { period: 'HT' }));
  assert.equal(s.state.graphics.added.visible, true, 're-armed for the next period');
  clearTimeout(s.timer);
});

test('store reports goal edits so the replay of a disallowed goal can be renamed', () => {
  const { s, ok } = fresh();
  const seen = [];
  s.on('action', a => seen.push([a.type, a.before.events.length, a.after.events.length]));
  ok(s.dispatch('clock.period', { period: '1H', start: true }));
  ok(s.dispatch('goal.add', { team: 'home' }));
  ok(s.dispatch('goal.removeLast', { team: 'home' }));
  ok(s.dispatch('undo'));
  assert.deepEqual(seen.slice(1), [['goal.add', 0, 1], ['goal.removeLast', 1, 0], ['undo', 0, 1]]);
  clearTimeout(s.timer);
});

test('subs queue: subs wait, Show plays them as one lower third that steps through, then closes', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('clock.period', { period: '2H', start: true }));
  const a = ok(s.dispatch('sub.add', { team: 'home', offId: 'p9', onId: 'p12' })).result.event;
  const b = ok(s.dispatch('sub.add', { team: 'away', offId: 'p1', onId: 'p12' })).result.event;
  const c = ok(s.dispatch('sub.add', { team: 'home', offId: 'p1', onId: 'p13' })).result.event;
  assert.equal(s.state.graphics.lowerThird.visible, false, 'nothing shown yet');
  assert.deepEqual(s.state.graphics.eventQueue, [a.id, b.id, c.id]);
  ok(s.dispatch('eventQueue.move', { id: c.id, dir: 'up' }));
  assert.deepEqual(s.state.graphics.eventQueue, [a.id, c.id, b.id]);
  ok(s.dispatch('eventQueue.remove', { id: a.id }));
  ok(s.dispatch('eventQueue.add', { id: a.id }));
  assert.deepEqual(s.state.graphics.eventQueue, [c.id, b.id, a.id]);
  ok(s.dispatch('event.delete', { id: b.id })); // deleted subs drop out
  const r = ok(s.dispatch('eventQueue.show'));
  assert.equal(r.result.count, 2);
  const lt = s.state.graphics.lowerThird;
  assert.equal(lt.kind, 'queue');
  assert.deepEqual(lt.eventIds, [c.id, a.id]);
  const secs = Number(theme.timings?.lowerThirdSec) || 8;
  assert.equal(lt.stepMs, secs * 1000);
  assert.equal(lt.hideAt - lt.shownAt, 2 * secs * 1000, 'each sub gets the normal lower third time');
  assert.deepEqual(s.state.graphics.eventQueue, [], 'queue emptied');
  assert.equal(s.dispatch('eventQueue.show').ok, false, 'nothing left to show');
  clearTimeout(s.timer);
});

test('subs queue: turning off "Queue sub graphics" logs the sub without queueing it; a new match clears the queue', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('sub.add', { team: 'home', offId: 'p9', onId: 'p12' }));
  ok(s.dispatch('match.reset'));
  assert.deepEqual(s.state.graphics.eventQueue, []);
  ok(s.dispatch('settings.set', { autoShow: { sub: false } }));
  ok(s.dispatch('sub.add', { team: 'home', offId: 'p9', onId: 'p12' }));
  assert.deepEqual(s.state.graphics.eventQueue, []);
  assert.equal(s.state.events.length, 1);
  clearTimeout(s.timer);
});

test('cards join the same queue as subs and play in one lower third in queue order', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('clock.period', { period: '1H', start: true }));
  const y = ok(s.dispatch('card.add', { team: 'away', playerId: 'p4', card: 'yellow' }));
  assert.equal(y.result.queued, true);
  assert.equal(s.state.graphics.lowerThird.visible, false, 'card waits');
  const sb = ok(s.dispatch('sub.add', { team: 'home', offId: 'p9', onId: 'p12' })).result.event;
  const r2 = ok(s.dispatch('card.add', { team: 'away', playerId: 'p4', card: 'yellow' })).result.event; // second yellow
  assert.deepEqual(s.state.graphics.eventQueue, [y.result.event.id, sb.id, r2.id]);
  ok(s.dispatch('eventQueue.show'));
  const lt = s.state.graphics.lowerThird;
  assert.equal(lt.kind, 'queue');
  assert.deepEqual(lt.eventIds, [y.result.event.id, sb.id, r2.id]);
  ok(s.dispatch('settings.set', { autoShow: { card: false } }));
  ok(s.dispatch('card.add', { team: 'home', playerId: 'p9', card: 'yellow' }));
  assert.deepEqual(s.state.graphics.eventQueue, [], 'card graphics off: logged, not queued');
  clearTimeout(s.timer);
});

test('goal numbers for replay names: deleting an earlier goal never reuses a number; removing the latest frees it', () => {
  const { s, ok } = fresh();
  ok(s.dispatch('clock.period', { period: '1H', start: true }));
  const g1 = ok(s.dispatch('goal.add', { team: 'home' })).result;
  const g2 = ok(s.dispatch('goal.add', { team: 'home' })).result;
  assert.deepEqual([g1.teamGoals, g2.teamGoals], [1, 2]);
  ok(s.dispatch('event.delete', { id: g1.event.id }));            // earlier goal deleted with ✕
  assert.equal(ok(s.dispatch('goal.add', { team: 'home' })).result.teamGoals, 3, 'not a second "2"');
  ok(s.dispatch('goal.removeLast', { team: 'home' }));             // latest disallowed
  assert.equal(ok(s.dispatch('goal.add', { team: 'home' })).result.teamGoals, 3, 'number reused after − remove');
  assert.equal(ok(s.dispatch('goal.add', { team: 'away' })).result.teamGoals, 1, 'each team counts separately');
  clearTimeout(s.timer);
});

test('undo reports which action it undid (so a mistaken goal can drop its replay)', () => {
  const { s, ok } = fresh();
  const seen = [];
  s.on('action', a => seen.push(a.undone));
  ok(s.dispatch('goal.add', { team: 'home' }));
  ok(s.dispatch('undo'));
  assert.equal(seen.at(-1), 'goal.add');
  clearTimeout(s.timer);
});
