/**
 * Fairness — stage three of three, applied inside allocation rather than
 * reported afterwards.
 *
 * Two constraints shape everything here.
 *
 * **A fairness adjustment may reorder comparable edges, but must never promote
 * a weak edge past a strong one.** `boost_cap` bounds the adjustment, while the
 * allocator sorts raw-quality bands before adjusted utility. The hard
 * `min_reciprocal_score` floor independently rejects weak introductions.
 *
 * **Need is measured against pace, not against an absolute total.** An absolute
 * target is inert for most of a window: early on nobody has reached it, so
 * every member reports maximum need and the term stops discriminating between
 * them — which lets quality ranking concentrate exposure on popular members
 * unopposed. Comparing against the exposure a member *should* have by this
 * point in the window keeps the signal live from the first round.
 *
 * See docs/RECIPROCAL_MATCHING_V1_DESIGN.md §4.
 */

import { clamp, type MemberSignals } from './estimate.ts';
import type { MatchingConfig } from './config.ts';

/** Where the current fairness window has got to. */
export interface WindowContext {
  /** Rounds completed in this window, including the one being built. */
  roundsElapsed: number;
}

/**
 * The exposure a member should have accumulated by this point in the window,
 * pro rata against their own tier's entitlement.
 */
export function expectedExposure(
  member: MemberSignals,
  config: MatchingConfig,
  window: WindowContext
): number {
  const elapsed = clamp(window.roundsElapsed, 1, config.exposure_window_rounds);
  return member.introductionsPerRound * elapsed * config.exposure_target_multiplier;
}

/**
 * How far behind their own pace this member is, as a fraction of it. Zero once
 * they are level or ahead.
 */
export function exposureNeed(
  member: MemberSignals,
  config: MatchingConfig,
  window: WindowContext
): number {
  const expected = expectedExposure(member, config, window);
  if (expected <= 0) return 1;
  return clamp((expected - member.exposuresInWindow) / expected, 0, 1);
}

/**
 * How overdue a mutual match is, ramping to 1 at `no_match_rounds_full`.
 *
 * This is the term that shortens long empty stretches. Bounded like the others:
 * waiting a long time improves a member's ordering, it does not buy them an
 * incompatible pair.
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
  config: MatchingConfig,
  window: WindowContext
): number {
  const exposure =
    (exposureNeed(a, config, window) + exposureNeed(b, config, window)) / 2;
  const stale = (noMatchNeed(a, config) + noMatchNeed(b, config)) / 2;

  const raw =
    config.exposure_boost_weight * exposure + config.no_match_boost_weight * stale;

  return clamp(raw, 0, config.boost_cap);
}

/**
 * The value the allocator sorts on.
 *
 * With the default cap of 0.25 an edge can gain at most a quarter of its own
 * score. This bound alone does not prevent crossings, so the allocator applies
 * the quality-band rule before sorting on this value.
 */
export function adjustedUtility(
  reciprocal: number,
  a: MemberSignals,
  b: MemberSignals,
  config: MatchingConfig,
  window: WindowContext
): number {
  return reciprocal * (1 + fairnessBoost(a, b, config, window));
}

/**
 * A rolling ceiling on how often one member may appear this round.
 *
 * Members running ahead of their own pace are tightened so attention does not
 * concentrate; members at or behind pace keep their full allowance. Never
 * returns less than one — nobody is frozen out of a round entirely.
 */
export function appearanceLimit(
  member: MemberSignals,
  baseLimit: number,
  config: MatchingConfig,
  window: WindowContext
): number {
  const expected = expectedExposure(member, config, window);
  if (expected <= 0) return baseLimit;

  const pace = member.exposuresInWindow / expected;
  if (pace <= 1) return baseLimit;

  // 1.5x their pace halves the allowance; 2x or beyond floors it.
  const scale = clamp(1 - (pace - 1), 0.25, 1);
  return Math.max(1, Math.round(baseLimit * scale));
}
