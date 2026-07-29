import assert from 'node:assert/strict';
import test from 'node:test';

import { authStoragePlatformFor } from '../src/lib/authStoragePolicy';

test('native authentication sessions select secure OS-backed storage', () => {
  assert.equal(authStoragePlatformFor('ios'), 'native');
  assert.equal(authStoragePlatformFor('android'), 'native');
});

test('only the browser build uses the web storage fallback', () => {
  assert.equal(authStoragePlatformFor('web'), 'web');
});
