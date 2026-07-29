import assert from 'node:assert/strict';
import test from 'node:test';

import {
  galleryImagePerformancePolicy,
  galleryListPerformancePolicy,
  galleryRetryKey,
} from '../src/lib/galleryPerformancePolicy';

test('gallery keeps a bounded photo window with room for a continuous swipe', () => {
  assert.equal(galleryListPerformancePolicy.initialNumToRender, 1);
  assert.equal(galleryListPerformancePolicy.maxToRenderPerBatch, 2);
  assert.equal(galleryListPerformancePolicy.windowSize, 3);
  assert.equal(galleryListPerformancePolicy.removeClippedSubviews, true);
});

test('gallery photos downscale to the viewport and avoid a persistent RAM cache', () => {
  assert.equal(galleryImagePerformancePolicy.cachePolicy, 'disk');
  assert.equal(galleryImagePerformancePolicy.allowDownscaling, true);
  assert.equal(galleryImagePerformancePolicy.enforceEarlyResizing, true);
});

test('gallery retry uses a new image identity without changing the private source', () => {
  assert.equal(galleryRetryKey('https://example.test/photo', 0), 'https://example.test/photo:0');
  assert.equal(galleryRetryKey('https://example.test/photo', 1), 'https://example.test/photo:1');
});
