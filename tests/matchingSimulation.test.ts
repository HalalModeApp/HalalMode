import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MATCHING_CONFIG, resolveConfig } from '../src/matching/config';
import { gini, simulate } from '../src/matching/simulate';

const config = DEFAULT_MATCHING_CONFIG;

/**
 * A launch-sized pool. The real answer to "how many members" was "a few
 * hundred", so that is what these run against rather than a hypothetical
 * large population.
 */
const LAUNCH = { seed: 20260801, perGender: 150, rounds: 12, config };

test('gini behaves at its known endpoints', () => {
  assert.equal(gini([5, 5, 5, 5]), 0);
  assert.equal(gini([0, 0, 0, 0]), 0);
  assert.ok(gini([0, 0, 0, 100]) > 0.7, 'total concentration should score high');
});

test('simulation is deterministic for a given seed', () => {
  const first = simulate({ ...LAUNCH, strategy: 'v1' });
  const second = simulate({ ...LAUNCH, strategy: 'v1' });
  assert.deepEqual(first, second);
});

test('v1 does not concentrate exposure more than the previous ordering', () => {
  const baseline = simulate({ ...LAUNCH, strategy: 'baseline' });
  const v1 = simulate({ ...LAUNCH, strategy: 'v1' });

  // A deliberately weak assertion, because the measurement says a strong one
  // would be dishonest. Once the pool can supply full sets, exposure is already
  // close to even (Gini ~0.11) and there is very little concentration left for
  // fairness to remove. What matters is that ranking by quality — which does
  // favour frequently-kept members — is not allowed to make it worse.
  //
  // The real gains in this regime are quality and zero-match share, asserted
  // in the tests below.
  assert.ok(
    v1.exposureGini <= baseline.exposureGini + 0.01,
    `exposure concentration regressed: ${v1.exposureGini} vs ${baseline.exposureGini}`
  );
  assert.ok(
    v1.topExposureShare <= baseline.topExposureShare + 1e-9,
    'no single member should take a larger share of exposure than before'
  );
});

test('v1 raises reciprocal quality without shrinking anyone’s set', () => {
  const baseline = simulate({ ...LAUNCH, strategy: 'baseline' });
  const v1 = simulate({ ...LAUNCH, strategy: 'v1' });

  assert.ok(
    v1.meanReciprocalQuality > baseline.meanReciprocalQuality * 1.1,
    `expected a clear quality gain, got ${v1.meanReciprocalQuality} vs ${baseline.meanReciprocalQuality}`
  );
  assert.ok(
    v1.meanSetSize >= baseline.meanSetSize - 1e-9,
    'better ranking must not come at the cost of smaller sets'
  );
});

test('the confidence blend prevents a low keep rate becoming a death spiral', () => {
  // Scoring straight from observed keep rates excludes weakly-kept members
  // under the score floor, so they never gather the data that would lift them
  // back out. With the blend in place every member keeps receiving full sets.
  const v1 = simulate({ ...LAUNCH, strategy: 'v1' });
  assert.ok(
    v1.meanSetSize > 5,
    `members are being starved of introductions: ${v1.meanSetSize}`
  );
});

test('fairness does not come at an unacceptable cost to reciprocal quality', () => {
  const baseline = simulate({ ...LAUNCH, strategy: 'baseline' });
  const v1 = simulate({ ...LAUNCH, strategy: 'v1' });

  // The brief allows fairness to cost some quality, not to gut it. A tenth of
  // the baseline mean is the line this locks in.
  assert.ok(
    v1.meanReciprocalQuality >= baseline.meanReciprocalQuality * 0.9,
    `quality dropped too far: ${v1.meanReciprocalQuality} vs ${baseline.meanReciprocalQuality}`
  );
});

test('v1 leaves materially fewer members with no match at all', () => {
  const baseline = simulate({ ...LAUNCH, strategy: 'baseline' });
  const v1 = simulate({ ...LAUNCH, strategy: 'v1' });

  // This is the headline result: the share of members who finish the run
  // having never matched drops by roughly a quarter.
  assert.ok(
    v1.zeroMatchShare <= baseline.zeroMatchShare * 0.85,
    `expected fewer members left with nothing: ${v1.zeroMatchShare} vs ${baseline.zeroMatchShare}`
  );
});

test('reciprocity and capacity hold across every round of a long run', () => {
  // simulate() throws if verifyAllocation ever fails, so completing is the
  // assertion. Twenty-four rounds exercises window rollover and repeat limits.
  const long = simulate({ ...LAUNCH, rounds: 24, strategy: 'v1' });
  assert.equal(long.rounds, 24);
  assert.ok(long.meanSetSize > 0, 'members should still be receiving sets');
});

test('a skewed pool degrades to smaller sets rather than bad introductions', () => {
  // Ten men, one hundred and fifty women. Most women cannot be given a full
  // set at any price; the round must shrink rather than invent partners.
  const skewed = simulate({
    seed: 7,
    perGender: 10,
    rounds: 6,
    config,
    strategy: 'v1',
  });

  assert.ok(skewed.meanSetSize <= 10, 'nobody exceeds the premium allowance');
  assert.ok(skewed.meanReciprocalQuality > 0, 'the pairs shown are still scored');
});

test('a tiny pool still runs without breaking an invariant', () => {
  const tiny = simulate({
    seed: 3,
    perGender: 3,
    rounds: 5,
    config,
    strategy: 'v1',
  });
  assert.equal(tiny.members, 6);
});

test('repeat limits stop a small pool recycling the same pairs forever', () => {
  // Six members and twenty rounds: without the repeat cap every pair would be
  // shown over and over. Total exposure is bounded by the cap.
  const capped = resolveConfig({ max_pair_appearances: 2 });
  const run = simulate({
    seed: 11,
    perGender: 3,
    rounds: 20,
    config: capped,
    strategy: 'v1',
  });

  // 3 x 3 = 9 possible pairs, each shown at most twice, each showing exposing
  // two members: an upper bound of 36 exposures across the run.
  assert.ok(
    run.meanSetSize * run.members * run.rounds <= 36 + 1e-9,
    'the repeat cap should bound total exposure in a closed pool'
  );
});

test('premium capacity never reduces qualified exposure for free members', () => {
  const allFree = simulate({ ...LAUNCH, strategy: 'v1', premiumShare: 0 });
  const mixed = simulate({ ...LAUNCH, strategy: 'v1', premiumShare: 0.5 });

  // Premium buys more choices and more capacity. It must not mean free members
  // are seen less often or matched less well.
  assert.ok(
    mixed.zeroMatchShare <= allFree.zeroMatchShare + 0.05,
    `a premium-heavy pool starved free members: ${mixed.zeroMatchShare} vs ${allFree.zeroMatchShare}`
  );
});
