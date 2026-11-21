import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shootoutSummary } from '../public/shared/match.js';

const k = seq => seq.split(' ').map(x => ({ team: x[0] === 'h' ? 'home' : 'away', scored: x[1] === '1' }));

test('empty shootout', () => {
  const s = shootoutSummary([]);
  assert.deepEqual([s.home, s.away, s.set, s.decided, s.next], [0, 0, 0, false, 'home']);
  assert.deepEqual(s.rows.home, [null, null, null, null, null]);
});

test('next kicker alternates and follows whoever went first', () => {
  assert.equal(shootoutSummary(k('a1')).next, 'home');
  assert.equal(shootoutSummary(k('a1 h1')).next, 'away');
});

test('decided early when one side cannot catch up', () => {
  // home 3/3, away 0/3: away can reach at most 2
  const s = shootoutSummary(k('h1 a0 h1 a0 h1 a0'));
  assert.equal(s.decided, true);
  assert.equal(s.winner, 'home');
  assert.deepEqual(s.rows.away, ['missed', 'missed', 'missed', null, null]);
});

test('level after five goes to a new sudden-death row', () => {
  const five = 'h1 a1 h1 a1 h0 a0 h1 a1 h1 a1';
  let s = shootoutSummary(k(five));
  assert.equal(s.decided, false);
  assert.equal(s.set, 0);
  s = shootoutSummary(k(five + ' h1'));
  assert.equal(s.set, 1);
  assert.equal(s.suddenDeath, true);
  assert.deepEqual(s.rows.home, ['scored', null, null, null, null]);
  assert.deepEqual(s.rows.away, [null, null, null, null, null]);
  assert.equal(s.decided, false, 'away still to kick');
  s = shootoutSummary(k(five + ' h1 a0'));
  assert.deepEqual([s.decided, s.winner, s.home, s.away], [true, 'home', 5, 4]);
});
