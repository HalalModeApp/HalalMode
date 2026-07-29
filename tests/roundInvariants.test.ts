import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getRoundInteractionState,
  resolveActiveId,
} from '../src/lib/roundInvariants';

test('Premium Pop mode remains available in the chosen zone until one remains', () => {
  assert.deepEqual(getRoundInteractionState(3, 3), {
    inChosenZone: true,
    remaining: 0,
    canPop: true,
  });
  assert.equal(getRoundInteractionState(1, 3).canPop, false);
});

test('remaining releases never becomes negative', () => {
  assert.equal(getRoundInteractionState(8, 3).remaining, 5);
  assert.equal(getRoundInteractionState(0, 3).remaining, 0);
  assert.equal(getRoundInteractionState(-4, 3).remaining, 0);
});

test('active selection survives unrelated changes and falls back after release', () => {
  const live = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(resolveActiveId(live, 'b'), 'b');
  assert.equal(resolveActiveId(live.filter((item) => item.id !== 'b'), 'b'), 'a');
  assert.equal(resolveActiveId([], 'b'), null);
});
