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

import type { MatchingConfig } from './config.ts';

/** The half of a member the estimator needs. All of it is server-side. */
export interface MemberSignals {
  id: string;
  /** Qualified appearances — `selection_scores.times_shown`. */
  timesShown: number;
  /** Times kept when shown — `selection_scores.times_kept`. */
  timesKept: number;
  /** From the `match_health` view. */
  roundsSinceLastMutual: number;
  /**
   * Rounds since this member last received any introductions at all.
   *
   * Distinct from exposure need, which is windowed and resets. Waiting time
   * only increases, so it can order a rotation queue without a member losing
   * their place when the window turns over.
   */
  roundsSinceLastServed: number;
  /**
   * Share of this member's own picks that were never returned, 0–1.
   *
   * Not a judgement about them and never shown to anyone. It is the one signal
   * that says "the people this member reaches for are consistently not reaching
   * back", which is the difference between a set that could produce a match and
   * one that reliably will not.
   *
   * Zero for a member with no history, and reset when their profile materially
   * changes — someone who improves their photos should not be held to what last
   * month's behaviour implied.
   */
  oneSidedPickRate: number;
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
  /**
   * Deliberate passes, counted only once each has expired. A pass still inside
   * its cooldown never reaches here at all — the pair is filtered out upstream.
   */
  explicitPassCount: number;
}

export const NO_PAIR_HISTORY: PairHistory = {
  timesShown: 0,
  firstReciprocalScore: null,
  lastReciprocalScore: null,
  explicitPassCount: 0,
};

export type PairRetirementReason = 'repeat_limit' | 'score_collapse';

export interface PairResurfaceDecision {
  eligible: boolean;
  /**
   * A durable state change proposed by the pure planner. The caller must only
   * persist this through the live atomic round RPC; shadow mode discards it.
   */
  retirementReason: PairRetirementReason | null;
}

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
 *
 * A deliberate pass is stronger evidence than an appearance that simply went
 * nowhere, so every pass costs the pair rank on top of the ordinary decay,
 * starting with the first and compounding after it.
 *
 * It is a lower rank, not a removal. They can still be shown and still be
 * chosen; they simply stop outranking people who were never turned down. A
 * second pass adds a cooldown on top of this, and only a member closes a pair
 * for good, by hiding someone.
 */
export function pairPrior(history: PairHistory, config: MatchingConfig): number {
  const decay = Math.pow(config.repeat_decay, Math.max(0, history.timesShown));
  const passes = Math.max(0, history.explicitPassCount);
  const passPenalty = Math.pow(config.repeat_pass_penalty, passes);
  return clamp(decay * passPenalty, 0, 1);
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
/**
 * How much patience a pair has earned, 0 to 1, from its reciprocal estimate.
 *
 * Repetition is a limited resource: every second showing of one pair is a first
 * showing somebody else does not get. Spending it where the estimate says a
 * mutual pick is plausible is simply where it buys the most, and a pair the
 * model rates barely above the floor has already had its best chance.
 *
 * Anchored at min_reciprocal_score, below which nobody is shown at all, and at
 * repeat_generous_score, which is what a genuinely promising pair looks like
 * rather than a theoretical 1.0 nobody reaches.
 *
 * Curved rather than linear, so the short waits and full allowances belong to
 * the top of the range rather than to everyone above average. A pair halfway up
 * earns a quarter of the patience, not half of it.
 */
export function repeatGenerosity(score: number, config: MatchingConfig): number {
  const low = config.min_reciprocal_score;
  const high = config.repeat_generous_score;
  if (high <= low) return 1;
  const position = clamp((score - low) / (high - low), 0, 1);
  return Math.pow(position, config.repeat_generosity_curve);
}

/** Showings this pair has earned, between the configured floor and ceiling. */
export function allowedAppearances(score: number, config: MatchingConfig): number {
  const span = config.max_pair_appearances - config.min_pair_appearances;
  return Math.round(config.min_pair_appearances + repeatGenerosity(score, config) * span);
}

/**
 * Days before this pair may be shown again. Inverted: a promising pair comes
 * back within days, an unlikely one waits weeks. The gap between them is the
 * point — a long wait on a weak pair frees the slot for somebody new.
 */
export function pairCooldownDays(score: number, config: MatchingConfig): number {
  const span = config.max_repeat_cooldown_days - config.min_repeat_cooldown_days;
  return Math.round(config.max_repeat_cooldown_days - repeatGenerosity(score, config) * span);
}

export function evaluatePairResurface(
  history: PairHistory,
  currentScore: number,
  cooldownUntil: Date | null,
  retiredAt: Date | null,
  now: Date,
  config: MatchingConfig
): PairResurfaceDecision {
  if (retiredAt) return { eligible: false, retirementReason: null };
  // The hard ceiling. Reached it and the pair is done, whatever the score says
  // — at some point the answer has been asked for often enough.
  if (history.timesShown >= config.max_pair_appearances) {
    return { eligible: false, retirementReason: 'repeat_limit' };
  }
  // The soft one, and deliberately not a retirement: the allowance moves with
  // the score, so a pair held back today because it looked unlikely can be
  // shown again if it later looks better. Writing that down as retired would
  // make a passing estimate permanent.
  if (history.timesShown >= allowedAppearances(currentScore, config)) {
    return { eligible: false, retirementReason: null };
  }
  if (cooldownUntil && cooldownUntil > now) {
    return { eligible: false, retirementReason: null };
  }

  const first = history.firstReciprocalScore;
  if (first !== null && first - currentScore >= config.repeat_abandon_drop) {
    return { eligible: false, retirementReason: 'score_collapse' };
  }
  if (currentScore < config.min_reciprocal_score) {
    return { eligible: false, retirementReason: null };
  }
  return { eligible: true, retirementReason: null };
}

/** Backward-compatible boolean form for simulations and focused policy tests. */
export function mayResurface(
  history: PairHistory,
  currentScore: number,
  cooldownUntil: Date | null,
  retiredAt: Date | null,
  now: Date,
  config: MatchingConfig
): boolean {
  return evaluatePairResurface(
    history,
    currentScore,
    cooldownUntil,
    retiredAt,
    now,
    config
  ).eligible;
}
