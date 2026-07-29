import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeMembershipTier } from '../src/lib/membership';

test('membership normalizer upgrades the retired Plus local value', () => {
  assert.equal(normalizeMembershipTier('plus'), 'premium');
  assert.equal(normalizeMembershipTier('premium'), 'premium');
  assert.equal(normalizeMembershipTier('free'), 'free');
});

test('membership normalizer rejects unknown persisted values', () => {
  assert.equal(normalizeMembershipTier('gold'), null);
  assert.equal(normalizeMembershipTier(null), null);
});
