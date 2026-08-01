/**
 * Reciprocal matching configuration.
 *
 * These mirror `halal_mode_private.matching_config.params`. The database row is
 * the source of truth at runtime; this module supplies the shape, the defaults
 * used by tests and simulations, and one place to document what each value
 * does. Nothing here should be read directly by client code.
 *
 * See docs/RECIPROCAL_MATCHING_V1_DESIGN.md.
 */

export const ALGORITHM_VERSION = 'greedy_global_v1';

export interface MatchingConfig {
  // --- Estimation ---------------------------------------------------------
  /** Weight on how well the subject fits the viewer's stated preferences. */
  w_compat: number;
  /** Weight on how often the subject is kept when shown. */
  w_appeal: number;
  /** Weight on the pair's own history — decays with repeated appearances. */
  w_pair: number;
  /**
   * Qualified appearances at which the behavioural estimate is fully trusted.
   * Below it the estimate blends back toward stated compatibility, so a new
   * member starts neutral rather than penalised for having no history.
   */
  exposure_full_confidence: number;
  /** Probability clamp, so one direction cannot zero the geometric mean. */
  p_min: number;
  p_max: number;

  // --- Reciprocal score ---------------------------------------------------
  reciprocal_combiner: 'geometric' | 'arithmetic' | 'min';
  /** Extra penalty for lopsided pairs. Ships at 0 — see combine(). */
  imbalance_lambda: number;
  /** Hard floor. No exposure need can push an edge below this into a round. */
  min_reciprocal_score: number;

  // --- Fairness -----------------------------------------------------------
  exposure_boost_weight: number;
  no_match_boost_weight: number;
  /** Ceiling on the total fairness boost, as a fraction of the edge's score. */
  boost_cap: number;
  /**
   * Scales a member's own entitlement to set their fair share. 1.0 means "your
   * tier's allowance, pro rata through the window"; below 1.0 throttles sooner.
   */
  exposure_target_multiplier: number;
  exposure_window_rounds: number;
  /** Rounds without a mutual match at which the no-match boost is maximal. */
  no_match_rounds_full: number;

  // --- Repeat exposure ----------------------------------------------------
  repeat_decay: number;
  repeat_cooldown_days: number;
  max_pair_appearances: number;
  /** Abandon a pair once its estimate has fallen this far from first sight. */
  repeat_abandon_drop: number;

  // --- Rotation -----------------------------------------------------------
  /**
   * Whether an imbalanced pool serves a rotating cohort with full sets rather
   * than spreading thin. Gender-agnostic: the constrained side is whichever
   * has surplus capacity that round.
   */
  rotation_enabled: boolean;
  /**
   * Smallest set worth showing. Above this, mild imbalance is absorbed by
   * everyone getting a slightly smaller set; below it, members are deferred so
   * those who are served still have a real choice to make.
   */
  rotation_min_set_size: number;

  // --- Allocation ---------------------------------------------------------
  repair_time_budget_ms: number;
  allocator: string;

  // --- Guards -------------------------------------------------------------
  warn_round_latency_ms: number;
  fail_round_latency_ms: number;
  warn_edges_after_filter: number;
  fail_edges_after_filter: number;
  warn_peak_memory_bytes: number;
  fail_peak_memory_bytes: number;
  min_segment_sample: number;
}

/** Matches the seeded row in migration 0049. */
export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  w_compat: 0.55,
  w_appeal: 0.3,
  w_pair: 0.15,
  exposure_full_confidence: 15,
  p_min: 0.02,
  p_max: 0.98,

  reciprocal_combiner: 'geometric',
  imbalance_lambda: 0,
  min_reciprocal_score: 0.15,

  exposure_boost_weight: 0.3,
  no_match_boost_weight: 0.2,
  boost_cap: 0.25,
  exposure_target_multiplier: 1.0,
  exposure_window_rounds: 7,
  no_match_rounds_full: 8,

  repeat_decay: 0.7,
  repeat_cooldown_days: 14,
  max_pair_appearances: 3,
  repeat_abandon_drop: 0.35,

  rotation_enabled: true,
  rotation_min_set_size: 3,

  repair_time_budget_ms: 2000,
  allocator: ALGORITHM_VERSION,

  warn_round_latency_ms: 30_000,
  fail_round_latency_ms: 120_000,
  warn_edges_after_filter: 2_000_000,
  fail_edges_after_filter: 8_000_000,
  warn_peak_memory_bytes: 268_435_456,
  fail_peak_memory_bytes: 536_870_912,
  min_segment_sample: 30,
};

/**
 * Merges a database params blob over the defaults.
 *
 * Unknown keys are ignored and missing keys fall back, so adding a parameter
 * does not require a coordinated deploy of function and config row.
 */
export function resolveConfig(params: Partial<MatchingConfig> = {}): MatchingConfig {
  const merged: MatchingConfig = { ...DEFAULT_MATCHING_CONFIG };
  for (const key of Object.keys(DEFAULT_MATCHING_CONFIG) as (keyof MatchingConfig)[]) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      Reflect.set(merged, key, value);
    }
  }
  return merged;
}
