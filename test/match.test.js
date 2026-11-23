import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayMs, formatClock, eventMinute, scorers, onPitch } from '../public/shared/match.js';

const match = { periodLength: 45, etPeriodLength: 15 };
const clock = (period, ms, extra = {}) => ({ period, running: false, startedAt: null, accumulatedMs: ms, addedTime: 0, ...extra });

test('clock jumps to the period base', () => {
  assert.equal(formatClock(displayMs(clock('1H', 0), match, 0)), '00:00');
  assert.equal(formatClock(displayMs(clock('2H', 0), match, 0)), '45:00');
  assert.equal(formatClock(displayMs(clock('ET1', 0), match, 0)), '90:00');
  assert.equal(formatClock(displayMs(clock('ET2', 61000), match, 0)), '106:01');
});

test('running clock is timestamp based', () => {
  const c = clock('1H', 60000, { running: true, startedAt: 1000 });
  assert.equal(displayMs(c, match, 1000 + 30500), 90500);
});

test('event minutes use football convention incl. stoppage time', () => {
  assert.equal(eventMinute(clock('1H', 0), match, 0), '1');
  assert.equal(eventMinute(clock('1H', 22 * 60000 + 5000), match, 0), '23');
  assert.equal(eventMinute(clock('1H', 46 * 60000 + 10000), match, 0), '45+2');
  assert.equal(eventMinute(clock('2H', 10 * 60000), match, 0), '56');
  assert.equal(eventMinute(clock('2H', 47 * 60000), match, 0), '90+3');
  assert.equal(eventMinute(clock('HT', 0), match, 0), '45');
});

test('scorers group by player and mark OG/P', () => {
  const state = {
    teams: {
      home: { squad: [{ id: 'a', name: 'Ann' }] },
      away: { squad: [{ id: 'b', name: 'Bob' }] },
    },
    events: [
      { type: 'goal', team: 'home', playerId: 'a', minute: '50' },
      { type: 'goal', team: 'home', playerId: 'a', minute: '10', penalty: true },
      { type: 'goal', team: 'home', playerId: 'b', minute: '70', ownGoal: true },
    ],
  };
  assert.deepEqual(scorers(state, 'home'), [
    { name: 'Ann', minutes: ["10' (P)", "50'"] },
    { name: 'Bob', minutes: ["70' (OG)"] },
  ]);
});

test('on-pitch set follows subs and red cards', () => {
  const team = { lineup: { starting: ['a', 'b', 'c'] } };
  const set = onPitch(team, [
    { type: 'sub', team: 'home', offId: 'a', onId: 'd' },
    { type: 'card', team: 'home', playerId: 'b', card: 'red' },
  ], 'home');
  assert.deepEqual([...set].sort(), ['c', 'd']);
});

test('timer minute for replay clip names: clock minutes, stoppage as 45+n', async () => {
  const { timerMinute } = await import('../public/shared/match.js');
  assert.equal(timerMinute(clock('1H', 23 * 60000 + 41000), match, 0), '23');
  assert.equal(timerMinute(clock('1H', 45 * 60000 + 30000), match, 0), '45');
  assert.equal(timerMinute(clock('1H', 47 * 60000 + 5000), match, 0), '45+2');
  assert.equal(timerMinute(clock('2H', 10 * 60000), match, 0), '55');
  assert.equal(timerMinute(clock('2H', 48 * 60000), match, 0), '90+3');
  assert.equal(timerMinute(clock('HT', 0), match, 0), '45');
  assert.equal(timerMinute(clock('PRE', 0), match, 0), '0');
});
