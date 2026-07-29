import assert from 'node:assert/strict';
import test from 'node:test';

import { hasAuthPrincipalChanged } from '../src/lib/authSessionScope';

test('auth cache is retained only for the same authenticated member', () => {
  assert.equal(hasAuthPrincipalChanged('member_a', 'member_a'), false);
  assert.equal(hasAuthPrincipalChanged(null, null), false);
  assert.equal(hasAuthPrincipalChanged('member_a', 'member_b'), true);
  assert.equal(hasAuthPrincipalChanged('member_a', null), true);
  assert.equal(hasAuthPrincipalChanged(null, 'member_a'), true);
});
