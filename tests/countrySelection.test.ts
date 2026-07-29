import assert from 'node:assert/strict';
import test from 'node:test';

import { toggleCountrySelection } from '../src/lib/countrySelection';

test('onboarding country choice always replaces an earlier country', () => {
  assert.deepEqual(toggleCountrySelection(['Saudi Arabia'], 'Lebanon', 'single'), ['Lebanon']);
  assert.deepEqual(toggleCountrySelection([], 'Peru', 'single'), ['Peru']);
});

test('private matching filters retain their independent multi-country behavior', () => {
  assert.deepEqual(
    toggleCountrySelection(['Saudi Arabia'], 'Lebanon', 'multiple'),
    ['Saudi Arabia', 'Lebanon']
  );
  assert.deepEqual(toggleCountrySelection(['Lebanon'], 'Lebanon', 'multiple'), []);
});
