import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canApplyProfileStatus,
  hasAuthPrincipalChanged,
  MEMBER_SIGN_OUT_SCOPE,
} from '../src/lib/authSessionScope';

test('member-facing sign out affects the current device only', () => {
  assert.equal(MEMBER_SIGN_OUT_SCOPE, 'local');
});

test('auth cache is retained only for the same authenticated member', () => {
  assert.equal(hasAuthPrincipalChanged('member_a', 'member_a'), false);
  assert.equal(hasAuthPrincipalChanged(null, null), false);
  assert.equal(hasAuthPrincipalChanged('member_a', 'member_b'), true);
  assert.equal(hasAuthPrincipalChanged('member_a', null), true);
  assert.equal(hasAuthPrincipalChanged(null, 'member_a'), true);
});

test('profile status only applies to the active member and newest request', () => {
  assert.equal(canApplyProfileStatus(4, 4, 'member_a', 'member_a'), true);
  assert.equal(canApplyProfileStatus(3, 4, 'member_a', 'member_a'), false);
  assert.equal(canApplyProfileStatus(4, 4, 'member_a', 'member_b'), false);
  assert.equal(canApplyProfileStatus(4, 4, 'member_a', null), false);
});
