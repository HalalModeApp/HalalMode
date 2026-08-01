import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDailyRoundStatus } from '../src/lib/dailyRoundState';

test('accepts only the documented privacy-safe daily round statuses', () => {
  assert.equal(normalizeDailyRoundStatus('ready'), 'ready');
  assert.equal(normalizeDailyRoundStatus('profile_not_ready'), 'profile_not_ready');
  assert.equal(normalizeDailyRoundStatus('no_suitable_introductions'), 'no_suitable_introductions');
  assert.equal(normalizeDailyRoundStatus('matching_inputs_unavailable'), 'matching_inputs_unavailable');
  assert.equal(normalizeDailyRoundStatus('awaiting_turn'), 'awaiting_turn');
  assert.equal(normalizeDailyRoundStatus('at_match_capacity'), 'at_match_capacity');
  assert.equal(normalizeDailyRoundStatus('legal_consent_required'), 'legal_consent_required');
});

test('unknown server reasons fall back to the least revealing empty state', () => {
  assert.equal(normalizeDailyRoundStatus('filtered_by_distance'), 'no_suitable_introductions');
  assert.equal(normalizeDailyRoundStatus({ count: 4 }), 'no_suitable_introductions');
  assert.equal(normalizeDailyRoundStatus(null), 'no_suitable_introductions');
});
