/**
 * Estimation — stage one of three.
 *
 * Produces `P(A picks B)` and `P(B picks A)` for an eligible pair, then combines
 * them into a single reciprocal score. This module knows nothing about
 * allocation or fairness; it is pure and deterministic given its inputs.
 *
 * Nothing here is an attractiveness rating. `appeal` is a selection *rate*, used
 * only as one bounded input to a private prediction, and is never surfaced.
 *
 * See docs/RECIPROCAL_MATCHING_V1_DESIGN.md §4.
 */

import type { MatchingConfig } from './config';

/** The half of a member the estimator needs. All of it is server-side. */
export interface MemberSignals {
  id: string;
  /** Qualified appearances — `selection_scores.times_shown`. */
  timesShown: number;
  /** Times kept when shown — `selection_scores.times_kept`. */
  timesKept: number;
  /** From the `match_health` view. */
  roundsSinceLastMutual: number;
  /** Qualified exposures inside the current fairness window. */
  exposuresInWindow: number;
  /**
   * Introductions this member is entitled to each round — 5 free, 10 premium.
   *
   * Fairness is measured against a member's own entitlement rather than one
   * flat number. A single target cannot serve both tiers: set it to the free
   * allowance and premium members are throttled below what they pay for; set it
   * to the premium allowance and nobody is throttled at all.
   */
  introductionsPerRound: number;
}

/** Pair state from `halal_mode_private.pair_exposure`. */
export interface PairHistory {
  timesShown: number;
  firstReciprocalScore: number | null;
  lastReciprocalScore: number | null;
}

export const NO_PAIR_HISTORY: PairHistory = {
  timesShown: 0,
  firstReciprocalScore: null,
  lastReciprocalScore: null,
};

export function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * How often this member is kept when shown.
 *
 * Returns the neutral 0.5 until there is anything to average, so a member with
 * no history is never treated as unpopular — only as unknown. Confidence, not
 * this function, decides how much the value is trusted.
 */
export function appeal(member: MemberSignals): number {
  if (member.timesShown <= 0) return 0.5;
  return clamp(member.timesKept / member.timesShown, 0, 1);
}

/**
 * Confidence in the behavioural estimate for a subject, ramping linearly to 1
 * at `exposure_full_confidence` qualified appearances.
 */
export function confidence(member: MemberSignals, config: MatchingConfig): number {
  const threshold = Math.max(1, config.exposure_full_confidence);
  return clamp(member.timesShown / threshold, 0, 1);
}

/**
 * The pair's own prior, decaying with each appearance that did not produce a
 * mutual pick. Fresh pairs start at 1 and are neither rewarded nor punished.
 */
export function pairPrior(history: PairHistory, config: MatchingConfig): number {
  return clamp(Math.pow(config.repeat_decay, Math.max(0, history.timesShown)), 0, 1);
}

/**
 * P(viewer picks subject).
 *
 * `compat` is the directional compatibility of the subject against the viewer's
 * stated preferences, already normalised to [0,1] by the caller — it is
 * computed in SQL where the preference rows live and never leave the server.
 *
 * Viewer selectivity is deliberately absent. Members keep exactly one of five,
 * or up to three of ten, so a viewer's keep rate is a structural budget rather
 * than a preference signal. Modelling it honestly needs a choice model, which
 * is explicitly deferred.
 */
export function directionalEstimate(
  compat: number,
  subject: MemberSignals,
  history: PairHistory,
  config: MatchingConfig
): number {
  const compatibility = clamp(compat, 0, 1);

  const behavioural =
    config.w_compat * compatibility +
    config.w_appeal * appeal(subject) +
    config.w_pair * pairPrior(history, config);

  const c = confidence(subject, config);
  // Below the confidence threshold the estimate falls back toward stated
  // compatibility, which is the only evidence that exists for a new member.
  const blended = (1 - c) * compatibility + c * behavioural;

  return clamp(blended, config.p_min, config.p_max);
}

/**
 * Combines both directions into one reciprocal score.
 *
 * The geometric mean is the documented default because it punishes lopsided
 * pairs on its own: sqrt(0.9 × 0.1) = 0.30, where an arithmetic mean would say
 * 0.50. `imbalance_lambda` therefore ships at zero, and exists only so the
 * penalty can be raised if simulation shows lopsided pairs still surfacing.
 */
export function reciprocalScore(
  forward: number,
  backward: number,
  config: MatchingConfig
): number {
  let combined: number;
  switch (config.reciprocal_combiner) {
    case 'arithmetic':
      combined = (forward + backward) / 2;
      break;
    case 'min':
      combined = Math.min(forward, backward);
      break;
    case 'geometric':
    default:
      combined = Math.sqrt(Math.max(0, forward) * Math.max(0, backward));
      break;
  }

  if (config.imbalance_lambda > 0) {
    combined *= 1 - config.imbalance_lambda * Math.abs(forward - backward);
  }

  return clamp(combined, 0, 1);
}

/**
 * Whether a previously shown pair may be offered again.
 *
 * Not being picked is treated as situational. A pair returns only if it is
 * still under the repeat limit, past its cooldown, not retired, and its
 * estimate has not collapsed since the first showing.
 */
export function mayResurface(
  history: PairHistory,
  currentScore: number,
  cooldownUntil: Date | null,
  retiredAt: Date | null,
  now: Date,
  config: MatchingConfig
): boolean {
  if (retiredAt) return false;
  if (history.timesShown >= config.max_pair_appearances) return false;
  if (cooldownUntil && cooldownUntil > now) return false;
  if (currentScore < config.min_reciprocal_score) return false;

  const first = history.firstReciprocalScore;
  if (first !== null && first - currentScore >= config.repeat_abandon_drop) {
    // The estimate has kept falling across appearances. Stop trying.
    return false;
  }
  return true;
}
