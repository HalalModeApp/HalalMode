import assert from 'node:assert/strict';
import test from 'node:test';

import { isOnboardingDraftCurrent, onboardingDraftExpiresAt } from '../src/lib/onboardingDraftPolicy';

test('onboarding drafts expire instead of leaving personal data on a device indefinitely', () => {
  const now = 1_000;
  const expiresAt = onboardingDraftExpiresAt(now);
  assert.equal(isOnboardingDraftCurrent(expiresAt, now), true);
  assert.equal(isOnboardingDraftCurrent(expiresAt, expiresAt), false);
  assert.equal(isOnboardingDraftCurrent('never', now), false);
});
