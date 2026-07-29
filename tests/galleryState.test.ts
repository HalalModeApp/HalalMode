import assert from 'node:assert/strict';
import test from 'node:test';

import { getGalleryState, safeGalleryIndex } from '../src/lib/galleryState';

test('gallery distinguishes a stale route from an intentionally empty photo set', () => {
  assert.equal(getGalleryState(false, 3), 'unavailable');
  assert.equal(getGalleryState(true, 0), 'empty');
  assert.equal(getGalleryState(true, 1), 'ready');
});

test('gallery index cannot render an invalid counter after photos change', () => {
  assert.equal(safeGalleryIndex(4, 2), 1);
  assert.equal(safeGalleryIndex(-1, 2), 0);
  assert.equal(safeGalleryIndex(0, 0), 0);
});
