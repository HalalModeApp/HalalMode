/**
 * Fairness — stage three of three, applied inside allocation rather than
 * reported afterwards.
 *
 * The whole design turns on one constraint: a fairness adjustment may reorder
 * comparable edges, but must never promote a weak edge past a strong one. That
 * is enforced by `boost_cap` here and by the hard `min_reciprocal_score` floor
 * in the allocator, not left to judgement.
 *
 * See docs/RECIPROCAL_MATCHING_V1_DESIGN.md §4.
 */

import { clamp, type MemberSignals } from './estimate';
import type { MatchingConfig } from './config';

/**
 * How much qualified exposure this member is still owed, as a fraction of the
 * per-window target. Zero once they have had their share.
 */
export function exposureNeed(member: MemberSignals, config: MatchingConfig): number {
  const target = Math.max(1, config.target_exposures_per_window);
  return clamp((target - member.exposuresInWindow) / target, 0, 1);
}

/**
 * How overdue a mutual match is, ramping to 1 at `no_match_rounds_full`.
 *
 * This is the term that shortens long empty stretches. It is bounded like the
 * others: waiting a long time improves a member's ordering, it does not buy
 * them an incompatible pair.
 */
export function noMatchNeed(member: MemberSignals, config: MatchingConfig): number {
  const full = Math.max(1, config.no_match_rounds_full);
  return clamp(member.roundsSinceLastMutual / full, 0, 1);
}

/**
 * Combined, capped boost for an edge. Symmetric in the two members — an edge
 * serves both of them, so both needs count equally.
 */
export function fairnessBoost(
  a: MemberSignals,
  b: MemberSignals,
  config: MatchingConfig
): number {
  const exposure = (exposureNeed(a, config) + exposureNeed(b, config)) / 2;
  const stale = (noMatchNeed(a, config) + noMatchNeed(b, config)) / 2;

  const raw =
    config.exposure_boost_weight * exposure + config.no_match_boost_weight * stale;

  return clamp(raw, 0, config.boost_cap);
}

/**
 * The value the allocator sorts on.
 *
 * With the default cap of 0.25 an edge can gain at most a quarter of its own
 * score: an edge at 0.40 reaches 0.50 at best, while an edge at 0.80 never
 * drops below 0.80. The orderings can therefore never cross.
 */
export function adjustedUtility(
  reciprocal: number,
  a: MemberSignals,
  b: MemberSignals,
  config: MatchingConfig
): number {
  return reciprocal * (1 + fairnessBoost(a, b, config));
}

/**
 * A rolling ceiling on how often one member may appear.
 *
 * Members who have had well beyond their share are tightened toward the base
 * set size so attention does not concentrate; members at or under their share
 * keep the full allowance. Never returns less than one — nobody is frozen out
 * of a round entirely.
 */
export function appearanceLimit(
  member: MemberSignals,
  baseLimit: number,
  config: MatchingConfig
): number {
  const target = Math.max(1, config.target_exposures_per_window);
  const overshoot = member.exposuresInWindow / target;
  if (overshoot <= 1) return baseLimit;

  // 1.5x their share halves the allowance; 2x or beyond floors it.
  const scale = clamp(1 - (overshoot - 1), 0.25, 1);
  return Math.max(1, Math.round(baseLimit * scale));
}
