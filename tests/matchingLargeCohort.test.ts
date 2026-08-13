import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConfig, type MatchingConfig } from '../src/matching/config.ts';
import { directionalEstimate, type MemberSignals } from '../src/matching/estimate.ts';
import { simulate } from '../src/matching/simulate.ts';
import { planRound, type CandidateEdgeRow, type MemberSignalRow } from '../supabase/functions/generate-round/matching.ts';

/**
 * A launch-shaped, deterministic cohort.
 *
 * The checked-in replay fixture is intentionally small (53 profiles) because
 * it is a captured production failure, not a seed dataset. This generator
 * gives the planner a larger, privacy-safe input that matches the current
 * hosted fake pool (455 eligible profiles) without committing member data.
 * Each member has roughly forty opposite-side candidates, like the shortlist
 * produced by the set-based snapshot stage, rather than a quadratic graph.
 */
const COHORT_SIZE = 455;
const SHORTLIST_SIZE = 40;

function cohortMembers(): MemberSignalRow[] {
  return Array.from({ length: COHORT_SIZE }, (_, index) => ({
    user_id: `cohort-${String(index).padStart(4, '0')}`,
    gender: index % 2 === 0 ? 'male' : 'female',
    tier: index % 5 === 0 ? 'premium' : 'free',
    times_shown: index % 7 === 0 ? 7 : 0,
    times_kept: index % 11 === 0 ? 2 : 0,
    rounds_since_last_mutual: index % 13 === 0 ? 1 : 0,
    rounds_since_last_served: index % 17 === 0 ? 1 : 0,
    one_sided_pick_rate: index % 19 === 0 ? 0.35 : 0,
    exposures_in_window: index % 7 === 0 ? 7 : 0,
    introductions_per_round: index % 5 === 0 ? 10 : 5,
  }));
}

function score(seed: number): number {
  // A cheap integer mixer keeps the graph and scores stable across machines.
  let value = seed >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0x1_0000_0000;
}

function cohortEdges(members: MemberSignalRow[]): CandidateEdgeRow[] {
  const men = members.filter((member) => member.gender === 'male');
  const women = members.filter((member) => member.gender === 'female');
  const edges: CandidateEdgeRow[] = [];

  for (let menIndex = 0; menIndex < men.length; menIndex += 1) {
    const man = men[menIndex]!;
    const used = new Set<number>();
    for (let offset = 0; used.size < SHORTLIST_SIZE; offset += 1) {
      const womenIndex = (menIndex * 37 + offset * 17 + 11) % women.length;
      if (used.has(womenIndex)) continue;
      used.add(womenIndex);
      const woman = women[womenIndex]!;
      const forward = 0.62 + score(menIndex * 100_003 + womenIndex * 97) * 0.34;
      const backward = 0.62 + score(menIndex * 97 + womenIndex * 100_003) * 0.34;
      edges.push({
        user_low: man.user_id,
        user_high: woman.user_id,
        compat_low_to_high: Number(forward.toFixed(5)),
        compat_high_to_low: Number(backward.toFixed(5)),
        pair_times_shown: 0,
        pair_first_score: null,
        pair_last_score: null,
        pair_cooldown_until: null,
        pair_retired_at: null,
        pair_explicit_pass_count: 0,
        pair_soft_select_count: 0,
      });
    }
  }
  return edges;
}

const members = cohortMembers();
const edges = cohortEdges(members);
const context = {
  seed: 20260813,
  evaluatedAt: '2026-08-13T02:30:00.000Z',
  fairnessWindow: {
    timeZone: 'Asia/Riyadh' as const,
    startsOn: '2026-08-13',
    endsOn: '2026-08-19',
    roundsElapsed: 1,
  },
};

function memberSignals(row: MemberSignalRow): MemberSignals {
  return {
    id: row.user_id,
    timesShown: row.times_shown,
    timesKept: row.times_kept,
    roundsSinceLastMutual: row.rounds_since_last_mutual,
    roundsSinceLastServed: row.rounds_since_last_served,
    oneSidedPickRate: row.one_sided_pick_rate ?? 0,
    exposuresInWindow: row.exposures_in_window,
    introductionsPerRound: row.introductions_per_round,
  };
}

/** Count assigned edges that were predicted top choices in both directions. */
function predictedMutualTopRate(
  assigned: { a: string; b: string }[],
  candidateEdges: CandidateEdgeRow[],
  rows: MemberSignalRow[],
  config: MatchingConfig
): number {
  const signals = new Map(rows.map((row) => [row.user_id, memberSignals(row)]));
  const top = new Map<string, { other: string; value: number }>();
  for (const edge of candidateEdges) {
    const low = signals.get(edge.user_low);
    const high = signals.get(edge.user_high);
    if (!low || !high) continue;
    const forward = directionalEstimate(edge.compat_low_to_high, high, {
      timesShown: edge.pair_times_shown,
      firstReciprocalScore: edge.pair_first_score,
      lastReciprocalScore: edge.pair_last_score,
      explicitPassCount: edge.pair_explicit_pass_count ?? 0,
      softSelectCount: edge.pair_soft_select_count ?? 0,
    }, config);
    const backward = directionalEstimate(edge.compat_high_to_low, low, {
      timesShown: edge.pair_times_shown,
      firstReciprocalScore: edge.pair_first_score,
      lastReciprocalScore: edge.pair_last_score,
      explicitPassCount: edge.pair_explicit_pass_count ?? 0,
      softSelectCount: edge.pair_soft_select_count ?? 0,
    }, config);
    if (!top.has(edge.user_low) || top.get(edge.user_low)!.value < forward) {
      top.set(edge.user_low, { other: edge.user_high, value: forward });
    }
    if (!top.has(edge.user_high) || top.get(edge.user_high)!.value < backward) {
      top.set(edge.user_high, { other: edge.user_low, value: backward });
    }
  }

  let mutual = 0;
  for (const edge of assigned) {
    if (top.get(edge.a)?.other === edge.b && top.get(edge.b)?.other === edge.a) {
      mutual += 1;
    }
  }
  return assigned.length === 0 ? 0 : mutual / assigned.length;
}

function maxSetSize(plan: { edges: { a: string; b: string }[] }): number {
  const counts = new Map<string, number>();
  for (const edge of plan.edges) {
    counts.set(edge.a, (counts.get(edge.a) ?? 0) + 1);
    counts.set(edge.b, (counts.get(edge.b) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

test('the V2/V3 planners finish on a 455-profile shortlist cohort', () => {
  assert.equal(members.length, COHORT_SIZE);
  assert.equal(edges.length, 228 * SHORTLIST_SIZE);

  const runs = [
    ['V2', resolveConfig({ allocator: 'greedy_global_v1' })],
    ['V3', resolveConfig({ allocator: 'anchored_maxmin_v1' })],
  ] as const;
  const results = runs.map(([label, config]) => {
    const started = Date.now();
    const plan = planRound(edges, members, config, context);
    return {
      label,
      plan,
      config,
      elapsedMs: Date.now() - started,
      predictedMutualTopRate: predictedMutualTopRate(plan.edges, edges, members, config),
    };
  });

  for (const result of results) {
    assert.ok(result.elapsedMs < 10_000, `${result.label} took ${result.elapsedMs}ms`);
    assert.ok(result.plan.edges.length > 0, `${result.label} produced no introductions`);
    assert.ok(maxSetSize(result.plan) <= 10, `${result.label} exceeded the premium set limit`);
    assert.equal(result.plan.thresholdBreaches.includes('fail_round_latency_ms'), false);
  }

  // V3 is allowed to trade a little aggregate utility for first-choice anchors,
  // but it must not silently produce fewer edges or violate the same limits.
  assert.ok(results[1]!.plan.edges.length >= results[0]!.plan.edges.length - 2);
  assert.ok(results[1]!.predictedMutualTopRate >= results[0]!.predictedMutualTopRate - 0.05);
});

test('the legacy V1 baseline and V2 simulation both run on 454 profiles', () => {
  const common = {
    seed: 20260813,
    perGender: 227,
    rounds: 3,
    config: resolveConfig({ exploration_rate: 0 }),
    pickModel: 'mixed' as const,
  };
  const legacyV1 = simulate({ ...common, strategy: 'baseline' });
  const v2 = simulate({ ...common, strategy: 'v1' });

  assert.equal(legacyV1.members, 454);
  assert.equal(v2.members, 454);
  assert.ok(legacyV1.meanSetSize > 0, 'legacy V1 should still produce sets');
  assert.ok(v2.meanSetSize > 0, 'V2 should still produce sets');
  assert.ok(v2.meanSetSize >= legacyV1.meanSetSize - 0.05, 'V2 must not starve the larger cohort');
  assert.ok(v2.exposureGini < 0.3, `V2 exposure spread regressed: ${v2.exposureGini}`);
});
