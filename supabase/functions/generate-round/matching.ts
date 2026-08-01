/**
 * Round orchestration.
 *
 * Runs the pipeline end to end: pull the pool and candidate edges from
 * Postgres, estimate both directions, apply bounded fairness, plan rotation,
 * allocate globally, verify, and persist.
 *
 * Shadow mode is a difference of one branch at the very end. Everything before
 * it is a pure computation over data already fetched, so a shadow run cannot
 * create a match, consume a limit, move a marker or start a cooldown — it has
 * no code path that writes anywhere except `shadow_round_edges`.
 *
 * The estimation, allocation, fairness and rotation modules are shared verbatim
 * with the app's test suite rather than reimplemented here. That is deliberate:
 * those tests are only meaningful if this is the same code.
 */

import { resolveConfig, ALGORITHM_VERSION, type MatchingConfig } from '../../../src/matching/config.ts';
import {
  directionalEstimate,
  evaluatePairResurface,
  reciprocalScore,
  type MemberSignals,
  type PairHistory,
  type PairRetirementReason,
} from '../../../src/matching/estimate.ts';
import { adjustedUtility, appearanceLimit, type WindowContext } from '../../../src/matching/fairness.ts';
import { allocate, verifyAllocation, type Capacity, type ScoredEdge } from '../../../src/matching/allocate.ts';
import { planRotation, type RotationCandidate } from '../../../src/matching/rotation.ts';
import type { MatchingPlanContext } from './runContext.ts';

export interface CandidateEdgeRow {
  user_low: string;
  user_high: string;
  compat_low_to_high: number;
  compat_high_to_low: number;
  pair_times_shown: number;
  pair_first_score: number | null;
  pair_last_score: number | null;
  pair_cooldown_until: string | null;
  pair_retired_at: string | null;
  /** Absent from an older snapshot; treated as never passed. */
  pair_explicit_pass_count?: number;
}

export interface MemberSignalRow {
  user_id: string;
  gender: 'male' | 'female';
  tier: 'free' | 'premium';
  times_shown: number;
  times_kept: number;
  rounds_since_last_mutual: number;
  rounds_since_last_served: number;
  /** Absent from an older signals view; treated as no history. */
  one_sided_pick_rate?: number;
  exposures_in_window: number;
  introductions_per_round: number;
}

export interface RoundPlan {
  edges: { a: string; b: string; score: number; utility: number }[];
  retirementProposals: {
    user_low: string;
    user_high: string;
    reason: PairRetirementReason;
    current_score: number;
  }[];
  memberOutcomes: { user_id: string; outcome: 'served' | 'deferred' | 'no_candidate' }[];
  stageLatencies: Record<string, number>;
  edgesAfterFilter: number;
  eligibleMembers: number;
  deferredMembers: number;
  peakMemoryBytes: number;
  thresholdBreaches: string[];
}

export function liveFinalizationArgs(runId: string, plan: RoundPlan, expiresAt: string) {
  return {
    p_run_id: runId,
    p_edges: plan.edges,
    p_outcomes: plan.memberOutcomes,
    p_retirements: plan.retirementProposals,
    p_expires_at: expiresAt,
    p_stage_latencies: plan.stageLatencies,
    p_peak_memory_bytes: plan.peakMemoryBytes,
    p_threshold_breaches: plan.thresholdBreaches,
  };
}

/** Shadow has deliberately no live-state inputs, including no retirements. */
export function shadowFinalizationArgs(runId: string, plan: RoundPlan) {
  return {
    p_run_id: runId,
    p_edges: plan.edges,
    p_stage_latencies: plan.stageLatencies,
    p_peak_memory_bytes: plan.peakMemoryBytes,
    p_threshold_breaches: plan.thresholdBreaches,
  };
}

function toSignals(row: MemberSignalRow): MemberSignals {
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

function optionalInstant(value: string | null, field: string): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Candidate edge ${field} is invalid`);
  }
  return parsed;
}

/**
 * Computes a full round. Pure: takes fetched rows, returns a decision.
 *
 * Being pure is what makes shadow mode trustworthy — the caller chooses whether
 * to persist, and there is nothing here that could write regardless.
 */
export function planRound(
  edgeRows: CandidateEdgeRow[],
  memberRows: MemberSignalRow[],
  rawConfig: Partial<MatchingConfig>,
  context: MatchingPlanContext,
  now: () => number = () => Date.now(),
  initialStageLatencies: Record<string, number> = {}
): RoundPlan {
  const config = resolveConfig(rawConfig);
  const evaluationNow = new Date(context.evaluatedAt);
  if (Number.isNaN(evaluationNow.getTime())) {
    throw new Error('Matching plan evaluation time is invalid');
  }
  if (context.fairnessWindow.timeZone !== 'Asia/Riyadh'
      || !Number.isInteger(context.fairnessWindow.roundsElapsed)
      || context.fairnessWindow.roundsElapsed < 1
      || context.fairnessWindow.roundsElapsed > config.exposure_window_rounds) {
    throw new Error('Matching plan fairness window is invalid');
  }
  const stageLatencies: Record<string, number> = { ...initialStageLatencies };
  const mark = <T>(stage: string, fn: () => T): T => {
    const started = now();
    const value = fn();
    stageLatencies[stage] = now() - started;
    return value;
  };

  const window: WindowContext = { roundsElapsed: context.fairnessWindow.roundsElapsed };
  const signals = new Map(memberRows.map((row) => [row.user_id, toSignals(row)]));

  // --- Rotation: decide who is served at all this round --------------------
  const plan = mark('rotation', () => {
    const toCandidate = (row: MemberSignalRow): RotationCandidate => {
      const member = signals.get(row.user_id)!;
      return {
        member,
        limit: appearanceLimit(member, row.introductions_per_round, config, window),
      };
    };
    return planRotation(
      memberRows.filter((r) => r.gender === 'male').map(toCandidate),
      memberRows.filter((r) => r.gender === 'female').map(toCandidate),
      config,
      context.seed
    );
  });

  // --- Estimation and scoring ----------------------------------------------
  const scored = mark('estimate', () => {
    const out: ScoredEdge[] = [];
    const retirements: RoundPlan['retirementProposals'] = [];
    for (const row of edgeRows) {
      const low = signals.get(row.user_low);
      const high = signals.get(row.user_high);
      if (!low || !high) continue;

      const history: PairHistory = {
        timesShown: row.pair_times_shown,
        firstReciprocalScore: row.pair_first_score,
        lastReciprocalScore: row.pair_last_score,
        explicitPassCount: row.pair_explicit_pass_count ?? 0,
      };

      // Each direction is estimated against the *subject* of that direction.
      const lowPicksHigh = directionalEstimate(row.compat_low_to_high, high, history, config);
      const highPicksLow = directionalEstimate(row.compat_high_to_low, low, history, config);
      const reciprocal = reciprocalScore(lowPicksHigh, highPicksLow, config);

      const repeat = evaluatePairResurface(
        history,
        reciprocal,
        optionalInstant(row.pair_cooldown_until, 'pair_cooldown_until'),
        optionalInstant(row.pair_retired_at, 'pair_retired_at'),
        evaluationNow,
        config
      );
      if (!repeat.eligible) {
        if (repeat.retirementReason) {
          retirements.push({
            user_low: row.user_low,
            user_high: row.user_high,
            reason: repeat.retirementReason,
            current_score: Number(reciprocal.toFixed(5)),
          });
        }
        continue;
      }
      if (!plan.serving.has(row.user_low) || !plan.serving.has(row.user_high)) continue;

      const decay = Math.pow(config.repeat_decay, Math.max(0, row.pair_times_shown));
      out.push({
        a: row.user_low,
        b: row.user_high,
        reciprocal,
        quality: reciprocal * decay,
        utility: adjustedUtility(reciprocal, low, high, config, window) * decay,
      });
    }
    return { edges: out, retirements };
  });

  // --- Allocation -----------------------------------------------------------
  const capacities = new Map<string, Capacity>();
  for (const id of plan.serving) {
    const limit = plan.servedLimits.get(id);
    if (limit !== undefined && limit > 0) capacities.set(id, { limit });
  }

  const result = mark('allocate', () =>
    allocate({ edges: scored.edges, capacities, config, seed: context.seed, now })
  );

  const verdict = verifyAllocation(result, capacities);
  if (!verdict.ok) {
    // Reciprocity and capacity are structural promises. A round that breaks
    // one is discarded rather than repaired.
    throw new Error(`allocation failed verification: ${verdict.reason}`);
  }

  const thresholdBreaches: string[] = [];
  if (edgeRows.length >= config.fail_edges_after_filter) {
    thresholdBreaches.push('fail_edges_after_filter');
  } else if (edgeRows.length >= config.warn_edges_after_filter) {
    thresholdBreaches.push('warn_edges_after_filter');
  }

  const totalLatency = Object.values(stageLatencies).reduce((sum, ms) => sum + ms, 0);
  if (totalLatency >= config.fail_round_latency_ms) {
    thresholdBreaches.push('fail_round_latency_ms');
  } else if (totalLatency >= config.warn_round_latency_ms) {
    thresholdBreaches.push('warn_round_latency_ms');
  }

  // Roughly 24 bytes per edge held plus per-member bookkeeping. Reported so the
  // guard has something real to compare against rather than a guess.
  const peakMemoryBytes = scored.edges.length * 24 + memberRows.length * 256;
  if (peakMemoryBytes >= config.fail_peak_memory_bytes) {
    thresholdBreaches.push('fail_peak_memory_bytes');
  } else if (peakMemoryBytes >= config.warn_peak_memory_bytes) {
    thresholdBreaches.push('warn_peak_memory_bytes');
  }

  const assignedMembers = new Set<string>();
  for (const edge of result.assigned) {
    assignedMembers.add(edge.a);
    assignedMembers.add(edge.b);
  }
  const deferredMembers = new Set(plan.deferred);
  const memberOutcomes = memberRows.map((row) => ({
    user_id: row.user_id,
    outcome: deferredMembers.has(row.user_id)
      ? 'deferred' as const
      : assignedMembers.has(row.user_id)
        ? 'served' as const
        : 'no_candidate' as const,
  }));

  return {
    edges: result.assigned.map((edge) => ({
      a: edge.a,
      b: edge.b,
      score: Number(edge.reciprocal.toFixed(5)),
      utility: Number(edge.utility.toFixed(5)),
    })),
    retirementProposals: scored.retirements,
    memberOutcomes,
    stageLatencies,
    edgesAfterFilter: edgeRows.length,
    eligibleMembers: memberRows.length,
    deferredMembers: plan.deferred.length,
    peakMemoryBytes,
    thresholdBreaches,
  };
}

export { ALGORITHM_VERSION };
