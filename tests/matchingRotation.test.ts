import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MATCHING_CONFIG, resolveConfig } from '../src/matching/config';
import { planRotation, type RotationCandidate } from '../src/matching/rotation';
import { simulate } from '../src/matching/simulate';
import type { MemberSignals } from '../src/matching/estimate';

const config = DEFAULT_MATCHING_CONFIG;

function candidate(
  id: string,
  limit = 5,
  overrides: Partial<MemberSignals> = {}
): RotationCandidate {
  return {
    limit,
    member: {
      id,
      timesShown: 0,
      timesKept: 0,
      roundsSinceLastMutual: 0,
      roundsSinceLastServed: 0,
      oneSidedPickRate: 0,
      exposuresInWindow: 0,
      introductionsPerRound: limit,
      ...overrides,
    },
  };
}

function side(prefix: string, count: number, limit = 5): RotationCandidate[] {
  return Array.from({ length: count }, (_, i) => candidate(`${prefix}${i}`, limit));
}

test('a balanced pool defers nobody', () => {
  const plan = planRotation(side('m', 50), side('w', 50), config, 1);
  assert.equal(plan.deferred.length, 0);
  assert.equal(plan.constrainedSide, null);
  assert.equal(plan.serving.size, 100);
});

test('mild imbalance is absorbed rather than deferring anyone', () => {
  // 60 vs 50 leaves the larger side averaging 4.2, still a real choice.
  const plan = planRotation(side('m', 60), side('w', 50), config, 1);
  assert.ok(plan.thinSetSize >= config.rotation_min_set_size);
  assert.equal(plan.deferred.length, 0);
});

test('severe imbalance defers the surplus side and serves the rest fully', () => {
  const plan = planRotation(side('m', 500), side('w', 100), config, 1);

  assert.equal(plan.constrainedSide, 'a');
  assert.equal(plan.edgeCeiling, 500, 'ceiling is the smaller side capacity');
  assert.ok(plan.deferred.length > 0, 'surplus members should be deferred');

  // Every member of the scarce side is served, at their full allowance.
  for (let i = 0; i < 100; i += 1) {
    assert.ok(plan.serving.has(`w${i}`), `w${i} should always be served`);
    assert.equal(plan.servedLimits.get(`w${i}`), 5);
  }
});

test('the constrained side is whichever has surplus — not a fixed gender', () => {
  const menHeavy = planRotation(side('m', 500), side('w', 100), config, 1);
  const womenHeavy = planRotation(side('m', 100), side('w', 500), config, 1);

  assert.equal(menHeavy.constrainedSide, 'a');
  assert.equal(womenHeavy.constrainedSide, 'b');

  // Mirrored pools should defer a mirrored number of members, so a pool that
  // flips from male-heavy to female-heavy needs no code change.
  assert.equal(menHeavy.deferred.length, womenHeavy.deferred.length);
  assert.equal(menHeavy.edgeCeiling, womenHeavy.edgeCeiling);
});

test('served sets are capped at the minimum worthwhile size, not the full allowance', () => {
  const plan = planRotation(side('m', 500), side('w', 100), config, 1);
  const servedMen = [...plan.serving].filter((id) => id.startsWith('m'));

  for (const id of servedMen) {
    assert.equal(
      plan.servedLimits.get(id),
      config.rotation_min_set_size,
      'a served member of the surplus side gets the minimum set, not five'
    );
  }

  // Capping at three rather than five means more members get a turn each round,
  // which is what actually drives match count — keeps are per round.
  assert.ok(
    servedMen.length > 100 / 5,
    'capping the set size should serve more members than full sets would'
  );
});

test('whoever has waited longest is served first', () => {
  const surplus = [
    candidate('m0', 5, { roundsSinceLastServed: 0 }),
    candidate('m1', 5, { roundsSinceLastServed: 9 }),
    candidate('m2', 5, { roundsSinceLastServed: 4 }),
  ];
  // One scarce member with a limit of 3 leaves room for exactly one served
  // member on the surplus side.
  const plan = planRotation(surplus, [candidate('w0', 3)], config, 1);

  assert.ok(plan.serving.has('m1'), 'the longest-waiting member goes first');
  assert.ok(plan.deferred.includes('m0'), 'the most recently served waits');
});

test('rotation can be turned off entirely', () => {
  const off = resolveConfig({ rotation_enabled: false });
  const plan = planRotation(side('m', 500), side('w', 100), off, 1);
  assert.equal(plan.deferred.length, 0);
  assert.equal(plan.constrainedSide, null);
});

test('planning is deterministic for a given seed', () => {
  const first = planRotation(side('m', 200), side('w', 40), config, 7);
  const second = planRotation(side('m', 200), side('w', 40), config, 7);
  assert.deepEqual(first.deferred, second.deferred);
});

// --- End to end, across the ratios the product expects to move through ------

test('rotation beats spreading thin on both set size and match outcomes', () => {
  const base = { seed: 20260801, perGender: 150, femaleCount: 30, rounds: 12 };
  const off = simulate({
    ...base,
    config: resolveConfig({ rotation_enabled: false }),
    strategy: 'v1',
  });
  const on = simulate({ ...base, config, strategy: 'v1' });

  assert.ok(
    on.meanServedSetSize > off.meanServedSetSize,
    `served sets should be larger: ${on.meanServedSetSize} vs ${off.meanServedSetSize}`
  );
  assert.ok(
    on.zeroMatchShare < off.zeroMatchShare,
    `fewer members should end unmatched: ${on.zeroMatchShare} vs ${off.zeroMatchShare}`
  );
});

test('the same defaults hold when the imbalance flips to the other side', () => {
  const base = { seed: 20260801, perGender: 150, rounds: 12 };
  const off = simulate({
    ...base,
    femaleCount: 750,
    config: resolveConfig({ rotation_enabled: false }),
    strategy: 'v1',
  });
  const on = simulate({ ...base, femaleCount: 750, config, strategy: 'v1' });

  assert.ok(on.meanServedSetSize > off.meanServedSetSize);
  assert.ok(on.zeroMatchShare < off.zeroMatchShare);
});

test('a one-to-one pool is unaffected by rotation being enabled', () => {
  const base = { seed: 20260801, perGender: 150, femaleCount: 150, rounds: 12 };
  const off = simulate({
    ...base,
    config: resolveConfig({ rotation_enabled: false }),
    strategy: 'v1',
  });
  const on = simulate({ ...base, config, strategy: 'v1' });

  assert.equal(on.meanSetSize, off.meanSetSize);
  assert.equal(on.zeroMatchShare, off.zeroMatchShare);
});

test('nobody is deferred indefinitely', () => {
  const run = simulate({
    seed: 4242,
    perGender: 300,
    femaleCount: 30,
    rounds: 20,
    config,
    strategy: 'v1',
  });

  // A 10:1 pool is the harshest case in the brief. Waiting must stay bounded:
  // the queue is ordered by waiting time, so turns come round.
  assert.ok(
    run.maxConsecutiveDeferrals < 20,
    `someone was never served: ${run.maxConsecutiveDeferrals} consecutive deferrals`
  );
});
