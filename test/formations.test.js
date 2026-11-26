import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMATIONS, slotRoles, slotPositions, fitSlots, currentSlots } from '../public/shared/formations.js';

const squad = [
  { id: 'g', number: 1, position: 'GK' },
  ...[2, 3, 4, 5].map(n => ({ id: `d${n}`, number: n, position: 'DEF' })),
  ...[6, 8, 10].map(n => ({ id: `m${n}`, number: n, position: 'MID' })),
  ...[7, 9, 11].map(n => ({ id: `f${n}`, number: n, position: 'FWD' })),
  { id: 's12', number: 12, position: 'FWD' },
];
const xi = squad.slice(0, 11).map(p => p.id);

test('every formation has 11 slots with a goalkeeper at the bottom', () => {
  for (const f of FORMATIONS) {
    assert.equal(slotRoles(f).length, 11, f);
    const pos = slotPositions(f);
    assert.equal(pos.length, 11, f);
    assert.ok(pos.slice(1).every(p => p.y < pos[0].y), `${f}: goalkeeper lowest`);
    assert.ok(pos.every(p => p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100), f);
  }
});

test('the XI fills slots by position, then swaps and formation changes keep players placed', () => {
  const slots = fitSlots('4-3-3', [], xi, squad);
  assert.equal(slots[0], 'g');
  assert.deepEqual(slots.slice(1, 5), ['d2', 'd3', 'd4', 'd5']);
  assert.deepEqual(slots.slice(5, 8), ['m6', 'm8', 'm10']);
  assert.deepEqual(slots.slice(8), ['f7', 'f9', 'f11']);
  [slots[8], slots[10]] = [slots[10], slots[8]];
  assert.deepEqual(fitSlots('4-3-3', slots, xi, squad), slots, 'a swap survives a refit');
  const fewer = fitSlots('4-3-3', slots, xi.filter(id => id !== 'm8'), squad);
  assert.equal(fewer[6], null, 'a player dropped from the XI leaves a gap');
  const back = fitSlots('4-3-3', fewer, [...xi.filter(id => id !== 'm8'), 's12'], squad);
  assert.equal(back.filter(Boolean).length, 11, 'a new player fills the gap');
});

test('during the match a sub takes the slot and a red card marks the player', () => {
  const slots = fitSlots('4-4-2', [], xi, squad);
  const events = [
    { type: 'sub', team: 'home', offId: 'f9', onId: 's12' },
    { type: 'card', team: 'home', card: 'red', playerId: 'd3' },
    { type: 'sub', team: 'away', offId: 'f7', onId: 'x' },
  ];
  const now = currentSlots(slots, events, 'home');
  const i9 = slots.indexOf('f9');
  assert.deepEqual(now[i9], { id: 's12', subbedOn: true, sentOff: false });
  assert.equal(now[slots.indexOf('d3')].sentOff, true);
  assert.equal(now[slots.indexOf('f7')].id, 'f7', "other team's subs ignored");
});

test('the away team is turned round: keeper at the top, their left on the viewer\'s right', () => {
  const home = slotPositions('4-3-3');
  const away = slotPositions('4-3-3', { turned: true });
  assert.ok(away[0].y < away.slice(1).reduce((m, p) => Math.min(m, p.y), 100), 'keeper highest');
  assert.ok(home[1].x < 50 && away[1].x > 50, 'left-back on the other side');
  assert.deepEqual(away.map(p => [p.x + home[away.indexOf(p)].x, p.y + home[away.indexOf(p)].y]).every(([x, y]) => x === 100 && y === 100), true);
});
