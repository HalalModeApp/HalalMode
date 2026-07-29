import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeCompatibilityBreakdown } from '../src/lib/compatibilityBreakdown';

test('compatibility breakdown accepts only the privacy-preserving display contract', () => {
  assert.deepEqual(
    sanitizeCompatibilityBreakdown([
      { topic: 'values', verdict: 'aligned', hiddenScore: 93, exactPreference: 'private' },
      { topic: 'family_plans', verdict: 'discuss' },
    ]),
    [
      { topic: 'values', verdict: 'aligned' },
      { topic: 'family_plans', verdict: 'discuss' },
    ]
  );
});

test('compatibility breakdown drops invalid and duplicate items', () => {
  assert.deepEqual(
    sanitizeCompatibilityBreakdown([
      { topic: 'values', verdict: 'aligned' },
      { topic: 'values', verdict: 'discuss' },
      { topic: 'unknown', verdict: 'aligned' },
      { topic: 'location_and_relocation', verdict: 'not-a-verdict' },
      null,
    ]),
    [{ topic: 'values', verdict: 'aligned' }]
  );
});
