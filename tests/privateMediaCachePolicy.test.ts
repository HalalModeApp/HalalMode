import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldClearPrivateMediaCache } from '../src/lib/privateMediaCachePolicy';

test('private image cache is retained for the current member only', () => {
  assert.equal(shouldClearPrivateMediaCache(null, 'member-a'), false);
  assert.equal(shouldClearPrivateMediaCache('member-a', 'member-a'), false);
  assert.equal(shouldClearPrivateMediaCache('member-a', 'member-b'), true);
  assert.equal(shouldClearPrivateMediaCache('member-a', null), true);
});
