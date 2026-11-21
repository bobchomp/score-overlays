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
