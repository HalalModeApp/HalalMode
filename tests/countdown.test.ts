import assert from 'node:assert/strict';
import test from 'node:test';

import { countdownTo, countdownTick } from '../src/lib/countdown.ts';

/**
 * The line under "resets at Fajr in London".
 *
 * Now that every member's set resets at their own dawn, "at Fajr" is a
 * different hour for each of them and no longer answers "when". This does.
 */
const NOW = Date.parse('2026-08-13T09:00:00Z');

test('hours and minutes while there is a while to go', () => {
  const value = countdownTo('2026-08-13T14:30:00Z', NOW);
  assert.deepEqual(value, { hours: 5, minutes: 30, seconds: 0, done: false });
});

test('the last hour drops to minutes', () => {
  const value = countdownTo('2026-08-13T09:07:30Z', NOW);
  assert.equal(value?.hours, 0);
  assert.equal(value?.minutes, 7);
});

test('a passed reset reads as done rather than negative', () => {
  const value = countdownTo('2026-08-13T08:00:00Z', NOW);
  assert.equal(value?.done, true);
  assert.equal(value?.hours, 0);
  assert.equal(value?.minutes, 0);
});

test('nothing to count to is nothing to show', () => {
  assert.equal(countdownTo(null, NOW), null);
  assert.equal(countdownTo(undefined, NOW), null);
  assert.equal(countdownTo('not a date', NOW), null);
});

test('it only ticks every second in the final minute', () => {
  // A phone woken once a second for a number that changes once a minute is a
  // battery cost for nothing.
  assert.equal(countdownTick(countdownTo('2026-08-13T14:30:00Z', NOW)), 60_000);
  assert.equal(countdownTick(countdownTo('2026-08-13T09:00:40Z', NOW)), 1_000);
});
