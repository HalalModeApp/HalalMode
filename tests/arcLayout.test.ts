import assert from 'node:assert/strict';
import test from 'node:test';

import { computeArcLayout } from '../src/lib/arcLayout';

const items = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `profile-${index}` }));

test('empty rounds have stable, finite geometry', () => {
  const layout = computeArcLayout([], 'missing');
  assert.deepEqual(layout.slots, []);
  assert.equal(layout.isGrid, false);
  assert.equal(layout.stripHeight, 86);
});

test('five faces form a symmetric shallow arc around the active face', () => {
  const layout = computeArcLayout(items(5), 'profile-2');
  assert.equal(layout.isGrid, false);
  assert.equal(layout.slots.filter((slot) => slot.isActive).length, 1);
  assert.equal(layout.slots[2]?.x, 0);
  assert.equal(layout.slots[2]?.y, 0);
  assert.ok(Math.abs((layout.slots[1]?.x ?? 0) + (layout.slots[3]?.x ?? 0)) < 1e-9);
  assert.ok(Math.abs((layout.slots[0]?.x ?? 0) + (layout.slots[4]?.x ?? 0)) < 1e-9);
  assert.equal(layout.slots[1]?.y, layout.slots[3]?.y);
  assert.equal(layout.slots[0]?.y, layout.slots[4]?.y);
  assert.ok((layout.slots[1]?.scale ?? 0) > (layout.slots[0]?.scale ?? 0));
});

test('circular order takes the shortest path across the list boundary', () => {
  const layout = computeArcLayout(items(5), 'profile-0');
  assert.ok((layout.slots[4]?.x ?? 0) < 0);
  assert.ok((layout.slots[1]?.x ?? 0) > 0);
  assert.equal(layout.slots[4]?.scale, layout.slots[1]?.scale);
});

test('stale active ids fall back to exactly one active face', () => {
  const layout = computeArcLayout(items(3), 'released-profile');
  assert.equal(layout.slots[0]?.isActive, true);
  assert.equal(layout.slots.filter((slot) => slot.isActive).length, 1);
});

test('Premium rounds use a bounded, centred two-row grid', () => {
  const layout = computeArcLayout(items(10), 'profile-7');
  assert.equal(layout.isGrid, true);
  assert.equal(layout.slots.length, 10);
  assert.ok(layout.slots.every((slot) => slot.size >= 34 && slot.size <= 52));
  assert.ok(layout.slots.every((slot) => Number.isFinite(slot.x) && Number.isFinite(slot.y)));
  assert.equal(layout.slots.filter((slot) => slot.isActive).length, 1);

  for (const row of [layout.slots.slice(0, 5), layout.slots.slice(5)]) {
    const sum = row.reduce((total, slot) => total + slot.x, 0);
    assert.ok(Math.abs(sum) < 1e-9);
  }
});
