import assert from 'node:assert/strict';
import test from 'node:test';

import { supportsRemotePushRuntime } from '../src/lib/notificationRuntime';

test('remote push registration is not attempted in Expo Go', () => {
  assert.equal(supportsRemotePushRuntime('android', 'storeClient'), false);
  assert.equal(supportsRemotePushRuntime('ios', 'storeClient'), false);
});

test('remote push registration remains available only for native builds', () => {
  assert.equal(supportsRemotePushRuntime('android', 'standalone'), true);
  assert.equal(supportsRemotePushRuntime('ios', 'bare'), true);
  assert.equal(supportsRemotePushRuntime('web', 'standalone'), false);
});
