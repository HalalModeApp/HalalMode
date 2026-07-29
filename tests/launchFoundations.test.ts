import assert from 'node:assert/strict';
import test from 'node:test';

import { trackProductEvent } from '../src/lib/analytics';
import { defaultFeatureFlags, resolveFeatureFlags } from '../src/lib/featureFlags';
import { mapServerReleaseFlags } from '../src/lib/releaseFlagMapping';
import { getProfileReadiness } from '../src/lib/profileReadiness';

test('feature flags fail closed and ignore unknown values', () => {
  assert.deepEqual(resolveFeatureFlags(null), defaultFeatureFlags);
  assert.deepEqual(resolveFeatureFlags({ liveCalling: true, unknown: true, premiumPurchases: 'yes' }), {
    ...defaultFeatureFlags,
    liveCalling: true,
  });
});

test('analytics strips non-primitive and unsafe properties', () => {
  const unsafePayload = {
    round_size: 5,
    resumed: false,
    message: { private: true },
    'bad-key': 'discard',
  } as unknown as Record<string, string | number | boolean>;
  const event = trackProductEvent('daily_round_viewed', unsafePayload);
  assert.deepEqual(event.properties, { round_size: 5, resumed: false });
});

test('profile readiness names exactly what is missing', () => {
  assert.deepEqual(getProfileReadiness({ firstName: 'Amina', city: 'Madinah', country: 'Saudi Arabia', bio: 'A considered profile with enough detail to introduce myself.', photoCount: 1 }), { ready: true, missing: [] });
  assert.deepEqual(getProfileReadiness({}), { ready: false, missing: ['name', 'location', 'bio', 'photo'] });
});

test('server release flags map only known, enabled capabilities', () => {
  assert.deepEqual(
    mapServerReleaseFlags({ live_calling: true, premium_purchases: false, unknown_flag: true }),
    { ...defaultFeatureFlags, liveCalling: true }
  );
});
