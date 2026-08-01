import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MATCHING_CONFIG,
  resolveConfig,
  resolveStoredConfig,
  type MatchingConfig,
} from '../src/matching/config';
import {
  appeal,
  confidence,
  directionalEstimate,
  evaluatePairResurface,
  mayResurface,
  pairPrior,
  NO_PAIR_HISTORY,
  reciprocalScore,
  type MemberSignals,
  type PairHistory,
} from '../src/matching/estimate';

const config = DEFAULT_MATCHING_CONFIG;

function member(overrides: Partial<MemberSignals> = {}): MemberSignals {
  return {
    id: 'm',
    timesShown: 0,
    timesKept: 0,
    roundsSinceLastMutual: 0,
    roundsSinceLastServed: 0,
    oneSidedPickRate: 0,
    exposuresInWindow: 0,
    introductionsPerRound: 5,
    ...overrides,
  };
}

test('a member with no history is treated as unknown, not unpopular', () => {
  assert.equal(appeal(member()), 0.5);
  assert.equal(confidence(member(), config), 0);
});

test('cold start scores purely on stated compatibility', () => {
  const newcomer = member({ timesShown: 0 });
  // With zero confidence the behavioural terms carry no weight at all, so the
  // estimate must equal the compatibility input.
  assert.equal(directionalEstimate(0.8, newcomer, NO_PAIR_HISTORY, config), 0.8);
  assert.equal(directionalEstimate(0.3, newcomer, NO_PAIR_HISTORY, config), 0.3);
});

test('confidence ramps linearly and saturates at the configured threshold', () => {
  assert.equal(confidence(member({ timesShown: 0 }), config), 0);
  assert.equal(confidence(member({ timesShown: 15 }), config), 1);
  assert.equal(confidence(member({ timesShown: 30 }), config), 1);
  assert.ok(Math.abs(confidence(member({ timesShown: 5 }), config) - 1 / 3) < 1e-9);
});

test('the confidence threshold is configurable, not hardcoded', () => {
  const patient = resolveConfig({ exposure_full_confidence: 40 });
  assert.equal(confidence(member({ timesShown: 15 }), patient), 0.375);
});

test('invalid matching configuration fails closed', () => {
  assert.throws(
    () => resolveConfig({ w_compat: 0.8, w_appeal: 0.3, w_pair: 0.2 }),
    /sum to 1/
  );
  assert.throws(() => resolveConfig({ boost_cap: -0.1 }), /fairness/);
  assert.throws(() => resolveConfig({ quality_band_width: 0 }), /quality band/);
  assert.throws(() => resolveConfig({ imbalance_lambda: 2 }), /imbalance/);
  assert.throws(() => resolveConfig({ allocator: 'unknown' as MatchingConfig['allocator'] }), /allocator/);
  assert.throws(() => resolveConfig({ repeat_cooldown_days: -1 }), /Repeat/);
  assert.throws(() => resolveConfig({ p_min: 0.9, p_max: 0.2 }), /probability bounds/);
});

test('a recorded config cannot silently inherit code defaults', () => {
  assert.deepEqual(resolveStoredConfig({ ...DEFAULT_MATCHING_CONFIG }), DEFAULT_MATCHING_CONFIG);
  const { w_pair: _missing, ...partial } = DEFAULT_MATCHING_CONFIG;
  assert.throws(() => resolveStoredConfig(partial), /exactly every supported key/);
  assert.throws(
    () => resolveStoredConfig({ ...DEFAULT_MATCHING_CONFIG, future_key: 1 }),
    /exactly every supported key/
  );
});

test('behaviour displaces compatibility only as evidence accumulates', () => {
  const compat = 0.5;
  const liked = { timesKept: 9, roundsSinceLastMutual: 0, exposuresInWindow: 0 };

  const early = directionalEstimate(
    compat,
    member({ ...liked, timesShown: 10, timesKept: 9 }),
    NO_PAIR_HISTORY,
    config
  );
  const settled = directionalEstimate(
    compat,
    member({ ...liked, timesShown: 40, timesKept: 36 }),
    NO_PAIR_HISTORY,
    config
  );

  // Same 90% keep rate, more evidence — the estimate must move further from
  // the neutral compatibility baseline, not jump there immediately.
  assert.ok(settled > early, 'more evidence should weigh behaviour more heavily');
  assert.ok(early > compat, 'a strong keep rate should still lift the estimate');
});

test('the geometric mean punishes lopsided pairs', () => {
  const lopsided = reciprocalScore(0.9, 0.1, config);
  const balanced = reciprocalScore(0.5, 0.5, config);

  assert.ok(Math.abs(lopsided - 0.3) < 1e-9);
  assert.equal(balanced, 0.5);
  assert.ok(
    lopsided < balanced,
    'a one-sided pair must not outrank an evenly matched one of the same mean'
  );
});

test('the imbalance penalty is available but disabled by default', () => {
  assert.equal(config.imbalance_lambda, 0);

  const penalised = resolveConfig({ imbalance_lambda: 0.5 });
  assert.ok(reciprocalScore(0.9, 0.1, penalised) < reciprocalScore(0.9, 0.1, config));
});

test('estimates stay inside the probability clamp', () => {
  const strong = member({ timesShown: 100, timesKept: 100 });
  const weak = member({ timesShown: 100, timesKept: 0 });

  assert.ok(directionalEstimate(1, strong, NO_PAIR_HISTORY, config) <= config.p_max);
  assert.ok(directionalEstimate(0, weak, NO_PAIR_HISTORY, config) >= config.p_min);
});

test('not being picked is situational — a pair may return after cooldown', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  const history: PairHistory = {
    timesShown: 1,
    firstReciprocalScore: 0.6,
    lastReciprocalScore: 0.58,
    explicitPassCount: 0,
  };

  assert.equal(
    mayResurface(history, 0.58, new Date('2026-02-01T00:00:00Z'), null, now, config),
    true,
    'an expired cooldown should allow the pair back'
  );
  assert.equal(
    mayResurface(history, 0.58, new Date('2026-04-01T00:00:00Z'), null, now, config),
    false,
    'an active cooldown should hold the pair back'
  );
});

test('a pair stops resurfacing once it hits the repeat limit or is retired', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  const exhausted: PairHistory = {
    timesShown: config.max_pair_appearances,
    firstReciprocalScore: 0.6,
    lastReciprocalScore: 0.6,
    explicitPassCount: 0,
  };

  assert.equal(mayResurface(exhausted, 0.6, null, null, now, config), false);
  assert.equal(
    mayResurface(NO_PAIR_HISTORY, 0.6, null, new Date('2026-01-01T00:00:00Z'), now, config),
    false,
    'an explicitly retired pair never returns'
  );
});

test('a pair whose estimate keeps collapsing is abandoned', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  const fading: PairHistory = {
    timesShown: 1,
    firstReciprocalScore: 0.7,
    lastReciprocalScore: 0.3,
    explicitPassCount: 0,
  };

  // 0.7 -> 0.3 is a 0.4 drop, past the 0.35 abandon threshold.
  assert.equal(mayResurface(fading, 0.3, null, null, now, config), false);
  // A shallower decline is still worth another look.
  assert.equal(mayResurface(fading, 0.55, null, null, now, config), true);
});

test('the repeat-abandon boundary is inclusive and emits a durable retirement proposal', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  const first = 0.7;
  const history: PairHistory = {
    timesShown: 1,
    firstReciprocalScore: first,
    lastReciprocalScore: first,
    explicitPassCount: 0,
  };

  assert.deepEqual(
    evaluatePairResurface(
      history,
      first - config.repeat_abandon_drop,
      null,
      null,
      now,
      config
    ),
    { eligible: false, retirementReason: 'score_collapse' },
    'equality at repeat_abandon_drop must retire the pair'
  );

  assert.deepEqual(
    evaluatePairResurface(
      history,
      first - config.repeat_abandon_drop + 0.00001,
      null,
      null,
      now,
      config
    ),
    { eligible: true, retirementReason: null },
    'a score just inside the allowed drop remains eligible'
  );
});

test('repeat exhaustion proposes retirement while an already-retired pair proposes no second write', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  const exhausted: PairHistory = {
    timesShown: config.max_pair_appearances,
    firstReciprocalScore: 0.7,
    lastReciprocalScore: 0.7,
    explicitPassCount: 0,
  };

  assert.deepEqual(
    evaluatePairResurface(exhausted, 0.7, null, null, now, config),
    { eligible: false, retirementReason: 'repeat_limit' }
  );
  assert.deepEqual(
    evaluatePairResurface(
      exhausted,
      0.7,
      null,
      new Date('2026-02-01T00:00:00Z'),
      now,
      config
    ),
    { eligible: false, retirementReason: null },
    'a later run sees durable retired state and must not propose the write again'
  );
});

const passedPair = (explicitPassCount: number): PairHistory => ({
  timesShown: 1,
  firstReciprocalScore: null,
  lastReciprocalScore: null,
  explicitPassCount,
});

test('the first pass already costs the pair rank', () => {
  // One quick scroll past somebody is worth a nudge, not a disappearance. The
  // nudge is here; the disappearance does not arrive until the second pass.
  assert.equal(
    pairPrior(passedPair(1), config),
    pairPrior(passedPair(0), config) * config.repeat_pass_penalty
  );
});

test('a pass lowers rank without closing the pair', () => {
  for (const count of [1, 2, 3]) {
    const history = passedPair(count);
    assert.ok(pairPrior(history, config) > 0, `a pair passed ${count} times still scores above zero`);
    assert.equal(
      mayResurface(history, 0.6, null, null, new Date('2026-03-01T00:00:00Z'), config),
      true,
      'a passed pair is ranked down, never retired — only a member closes a pair'
    );
  }
});

test('the pass penalty compounds and stays inside the prior', () => {
  assert.equal(
    pairPrior(passedPair(3), config),
    pairPrior(passedPair(2), config) * config.repeat_pass_penalty
  );
  for (const count of [0, 1, 2, 5, 20]) {
    const value = pairPrior(passedPair(count), config);
    assert.ok(value > 0 && value <= 1, `prior stayed in range at ${count} passes`);
  }
});

test('the pass settings are configurable and fail closed', () => {
  assert.throws(() => resolveConfig({ repeat_pass_penalty: 0 }), /Explicit pass/);
  assert.throws(() => resolveConfig({ repeat_pass_penalty: 1.2 }), /Explicit pass/);
  assert.throws(() => resolveConfig({ explicit_pass_cooldown_days: 0 }), /Explicit pass/);
  // Banning on the very first pass is the behaviour this replaced, so the
  // configuration refuses to express it.
  assert.throws(() => resolveConfig({ explicit_pass_ban_after: 1 }), /Explicit pass/);

  // 1 is legal and means "a pass costs no rank", which somebody may want to
  // choose deliberately.
  assert.equal(resolveConfig({ repeat_pass_penalty: 1 }).repeat_pass_penalty, 1);
});

test('a pair below the score floor is never resurfaced', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  assert.equal(
    mayResurface(NO_PAIR_HISTORY, config.min_reciprocal_score - 0.01, null, null, now, config),
    false
  );
});
