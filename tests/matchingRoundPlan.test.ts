import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MATCHING_CONFIG, resolveConfig } from '../src/matching/config.ts';
import {
  liveFinalizationArgs,
  planRound,
  shadowFinalizationArgs,
  type CandidateEdgeRow,
  type MemberSignalRow,
} from '../supabase/functions/generate-round/matching.ts';
import type { MatchingPlanContext } from '../supabase/functions/generate-round/runContext.ts';

const NOW = Date.parse('2026-08-01T03:00:00.000Z');

const members: MemberSignalRow[] = [
  {
    user_id: '00000000-0000-4000-8000-000000000001',
    gender: 'male',
    tier: 'free',
    times_shown: 0,
    times_kept: 0,
    rounds_since_last_mutual: 0,
    rounds_since_last_served: 1,
    exposures_in_window: 0,
    introductions_per_round: 5,
  },
  {
    user_id: '00000000-0000-4000-8000-000000000002',
    gender: 'female',
    tier: 'free',
    times_shown: 0,
    times_kept: 0,
    rounds_since_last_mutual: 0,
    rounds_since_last_served: 1,
    exposures_in_window: 0,
    introductions_per_round: 5,
  },
];

function edge(score: number, overrides: Partial<CandidateEdgeRow> = {}): CandidateEdgeRow {
  return {
    user_low: members[0]!.user_id,
    user_high: members[1]!.user_id,
    compat_low_to_high: score,
    compat_high_to_low: score,
    pair_times_shown: 1,
    pair_first_score: 0.7,
    pair_last_score: 0.7,
    pair_cooldown_until: null,
    pair_retired_at: null,
    ...overrides,
  };
}

function plan(candidate: CandidateEdgeRow) {
  const context: MatchingPlanContext = {
    seed: 20260801,
    evaluatedAt: new Date(NOW).toISOString(),
    fairnessWindow: {
      timeZone: 'Asia/Riyadh',
      startsOn: '2026-07-26',
      endsOn: '2026-08-01',
      roundsElapsed: 7,
    },
  };
  return planRound(
    [candidate],
    members,
    DEFAULT_MATCHING_CONFIG,
    context,
    () => NOW
  );
}

test('plan excludes and proposes retirement at the exact repeat-abandon boundary', () => {
  const score = 0.7 - DEFAULT_MATCHING_CONFIG.repeat_abandon_drop;
  const result = plan(edge(score));

  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.retirementProposals, [{
    user_low: members[0]!.user_id,
    user_high: members[1]!.user_id,
    reason: 'score_collapse',
    current_score: score,
  }]);
});

test('plan retains a pair just inside the repeat-abandon boundary', () => {
  const score = 0.7 - DEFAULT_MATCHING_CONFIG.repeat_abandon_drop + 0.00001;
  const result = plan(edge(score));

  assert.equal(result.edges.length, 1);
  assert.deepEqual(result.retirementProposals, []);
});

test('retirement proposal shape is deterministic for a later live retry', () => {
  const candidate = edge(0.7 - DEFAULT_MATCHING_CONFIG.repeat_abandon_drop);
  const first = plan(candidate);
  const retry = plan(candidate);

  assert.deepEqual(retry, first);
  assert.deepEqual(Object.keys(first.retirementProposals[0] ?? {}).sort(), [
    'current_score',
    'reason',
    'user_high',
    'user_low',
  ]);
});

test('a later run consumes durable retirement state without proposing another write', () => {
  const result = plan(edge(0.7, {
    pair_times_shown: DEFAULT_MATCHING_CONFIG.max_pair_appearances,
    pair_retired_at: '2026-08-01T03:00:00.000Z',
  }));

  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.retirementProposals, []);
});

test('a repeat-exhausted candidate is excluded and proposes retirement', () => {
  const result = plan(edge(0.7, {
    pair_times_shown: DEFAULT_MATCHING_CONFIG.max_pair_appearances,
  }));

  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.retirementProposals, [{
    user_low: members[0]!.user_id,
    user_high: members[1]!.user_id,
    reason: 'repeat_limit',
    current_score: 0.7,
  }]);
});

test('only live finalization can carry durable retirement proposals', () => {
  const result = plan(edge(0.7 - DEFAULT_MATCHING_CONFIG.repeat_abandon_drop));
  const runId = '00000000-0000-4000-8000-000000000009';
  const live = liveFinalizationArgs(runId, result, '2026-08-02T03:00:00.000Z');
  const shadow = shadowFinalizationArgs(runId, result);

  assert.equal(live.p_retirements.length, 1);
  assert.equal(Object.hasOwn(shadow, 'p_retirements'), false);
  assert.equal(Object.hasOwn(shadow, 'p_outcomes'), false);
  assert.equal(Object.hasOwn(shadow, 'p_expires_at'), false);
});

test('a repeat arrives at the allocator already handicapped for having been shown', () => {
  // Novelty is not a rule in the allocator; it is priced in here, once per
  // showing. This is the only place that multiplication actually happens, so it
  // is the only place worth asserting it.
  const score = 0.7;
  const fresh = plan(edge(score, { pair_times_shown: 0, pair_first_score: null, pair_last_score: null }));
  const shownOnce = plan(edge(score, { pair_times_shown: 1 }));
  const shownTwice = plan(edge(score, { pair_times_shown: 2 }));

  const utilityOf = (result: ReturnType<typeof plan>) => result.edges[0]?.utility ?? 0;
  assert.ok(utilityOf(fresh) > 0, 'the fresh pair should be assigned');

  const decay = DEFAULT_MATCHING_CONFIG.repeat_decay;
  assert.ok(
    Math.abs(utilityOf(shownOnce) / utilityOf(fresh) - decay) < 0.02,
    `one showing should cost about ${decay}x, got ${utilityOf(shownOnce) / utilityOf(fresh)}`
  );
  assert.ok(
    utilityOf(shownTwice) < utilityOf(shownOnce),
    'and the handicap should compound with each further showing'
  );
});

test('Matcher V3 carries both directional estimates into first-choice allocation', () => {
  const ids = {
    m1: '00000000-0000-4000-8000-000000000011',
    m2: '00000000-0000-4000-8000-000000000012',
    f1: '00000000-0000-4000-8000-000000000013',
    f2: '00000000-0000-4000-8000-000000000014',
  };
  const member = (user_id: string, gender: 'male' | 'female'): MemberSignalRow => ({
    user_id,
    gender,
    tier: 'free',
    times_shown: 0,
    times_kept: 0,
    rounds_since_last_mutual: 0,
    rounds_since_last_served: 1,
    exposures_in_window: 0,
    introductions_per_round: 1,
  });
  const memberRows: MemberSignalRow[] = [
    member(ids.m1, 'male'),
    member(ids.m2, 'male'),
    member(ids.f1, 'female'),
    member(ids.f2, 'female'),
  ];
  const candidate = (
    user_low: string,
    user_high: string,
    compat_low_to_high: number,
    compat_high_to_low: number
  ): CandidateEdgeRow => ({
    user_low,
    user_high,
    compat_low_to_high,
    compat_high_to_low,
    pair_times_shown: 0,
    pair_first_score: null,
    pair_last_score: null,
    pair_cooldown_until: null,
    pair_retired_at: null,
  });
  const context: MatchingPlanContext = {
    seed: 77,
    evaluatedAt: new Date(NOW).toISOString(),
    fairnessWindow: {
      timeZone: 'Asia/Riyadh',
      startsOn: '2026-07-26',
      endsOn: '2026-08-01',
      roundsElapsed: 1,
    },
  };

  const result = planRound(
    [
      candidate(ids.m1, ids.f1, 0.8, 0.8),
      candidate(ids.m1, ids.f2, 0.7, 0.99),
      candidate(ids.m2, ids.f1, 0.99, 0.2),
      candidate(ids.m2, ids.f2, 0.4, 0.4),
    ],
    memberRows,
    resolveConfig({ allocator: 'anchored_maxmin_v1', rotation_min_set_size: 1 }),
    context,
    () => NOW
  );

  assert.ok(result.edges.some((edge) => edge.a === ids.m1 && edge.b === ids.f1));
  assert.ok(!result.edges.some((edge) => edge.a === ids.m1 && edge.b === ids.f2));
});
