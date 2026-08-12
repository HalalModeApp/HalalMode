import assert from 'node:assert/strict';
import test from 'node:test';

import { fajrInstant, nextFajrAfter, FAJR_ANGLE } from '../src/lib/prayerTimes.ts';

/**
 * Dawn, calculated rather than fetched.
 *
 * Every member now gets their round at their own Fajr, which means computing it
 * for any coordinates on Earth, every day, without a network call. These
 * expectations were taken from the Umm al-Qura prayer-time API the app used for
 * Madinah — the same method, same source — so the calculation is pinned to the
 * thing it replaced rather than to itself.
 *
 * Two minutes of tolerance. The published tables round to the minute and differ
 * slightly between sources; nothing in this product can tell the difference
 * between dawn and dawn plus ninety seconds.
 */
const TOLERANCE_MINUTES = 2;

const CASES = [
  // Expected instants taken from the Umm al-Qura API the app used for Madinah.
  // Written in full rather than as a clock time, because east of Greenwich the
  // dawn of a local date falls on the previous UTC day — Tokyo's 03:21 on the
  // 13th is 18:21Z on the 12th. A clock-only expectation hides that, and hiding
  // it is how you ship a round that opens twenty-four hours late.
  { name: 'Madinah', lat: 24.4672, lon: 39.6111, on: [2026, 8, 13], expected: '2026-08-13T01:32Z' },
  { name: 'Madinah in winter', lat: 24.4672, lon: 39.6111, on: [2026, 11, 21], expected: '2026-11-21T02:20Z' },
  { name: 'London', lat: 51.5072, lon: -0.1276, on: [2026, 8, 13], expected: '2026-08-13T02:11Z' },
  { name: 'London in winter', lat: 51.5072, lon: -0.1276, on: [2026, 11, 21], expected: '2026-11-21T05:27Z' },
  { name: 'Tokyo', lat: 35.6762, lon: 139.6503, on: [2026, 8, 13], expected: '2026-08-12T18:21Z' },
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194, on: [2026, 8, 13], expected: '2026-08-13T11:43Z' },
  // Southern hemisphere, where the seasons run the other way.
  { name: 'Jakarta', lat: -6.2088, lon: 106.8456, on: [2026, 11, 21], expected: '2026-11-20T21:09Z' },
];

for (const item of CASES) {
  test(`Fajr for ${item.name}`, () => {
    const [year, month, day] = item.on as [number, number, number];
    const instant = fajrInstant(item.lat, item.lon, { year, month, day });
    assert.ok(instant, 'a temperate latitude always has a dawn');

    const driftMinutes = Math.abs(instant.getTime() - Date.parse(item.expected)) / 60_000;
    assert.ok(
      driftMinutes <= TOLERANCE_MINUTES,
      `${item.name}: expected ${item.expected}, got ${instant.toISOString()} (${driftMinutes.toFixed(1)}m out)`
    );
  });
}

test('the method is the one the app already used', () => {
  assert.equal(FAJR_ANGLE, 18.5, 'Umm al-Qura places Fajr at 18.5 degrees');
});

test('the far north has no dawn in midsummer, and says so', () => {
  // Tromsø in June: the sun never dips 18.5 degrees below the horizon, so there
  // is no true Fajr. Returning null is the honest answer; inventing a time
  // would put somebody's round at a moment that does not exist.
  const instant = fajrInstant(69.6492, 18.9553, { year: 2026, month: 6, day: 21 });
  assert.equal(instant, null);
});

test('the next dawn is always in the future', () => {
  const after = new Date('2026-08-13T05:00:00Z');
  const next = nextFajrAfter(51.5072, -0.1276, after);
  assert.ok(next, 'London always has a dawn');
  assert.ok(next.getTime() > after.getTime(), 'a round must open after it is planned');
  // London's Fajr is early; the next one after 05:00Z is tomorrow's.
  assert.ok(
    next.getTime() - after.getTime() < 26 * 3_600_000,
    'and within a day, not a week'
  );
});

test('two members in different places get different dawns', () => {
  const date = { year: 2026, month: 8, day: 13 };
  const tokyo = fajrInstant(35.6762, 139.6503, date);
  const sanFrancisco = fajrInstant(37.7749, -122.4194, date);
  assert.ok(tokyo && sanFrancisco);

  // The whole point of the change: these two are in each other's sets and see
  // them most of a day apart, each at their own dawn.
  const hoursApart = Math.abs(tokyo.getTime() - sanFrancisco.getTime()) / 3_600_000;
  assert.ok(hoursApart > 6, `expected a real gap, got ${hoursApart.toFixed(1)} hours`);
});
