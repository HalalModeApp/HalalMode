import assert from 'node:assert/strict';
import test from 'node:test';

import { deviceLocationFromReverseGeocode } from '../src/lib/deviceLocation';
import { profilePatchToRow } from '../src/lib/profilePatch';

test('device reverse geocoding resolves a city without typed location input', () => {
  assert.deepEqual(
    deviceLocationFromReverseGeocode(
      { city: null, subregion: 'Al Madinah', region: 'Madinah Region', country: 'Saudi Arabia' },
      { latitude: 24.4672, longitude: 39.6024 }
    ),
    { city: 'Al Madinah', country: 'Saudi Arabia', latitude: 24.4672, longitude: 39.6024 }
  );
});

test('device location rejects missing place labels and invalid coordinates', () => {
  assert.equal(
    deviceLocationFromReverseGeocode({ city: 'Madinah', country: 'Saudi Arabia' }, { latitude: 91, longitude: 39 }),
    null
  );
  assert.equal(
    deviceLocationFromReverseGeocode({ country: 'Saudi Arabia' }, { latitude: 24, longitude: 39 }),
    null
  );
});

test('general profile updates cannot serialize city or country', () => {
  assert.deepEqual(
    profilePatchToRow({ city: 'Typed city', country: 'Typed country', firstName: 'Amina' }),
    { first_name: 'Amina' }
  );
});
