export const dailyRoundStatuses = [
  'ready',
  'profile_not_ready',
  'no_suitable_introductions',
  'matching_inputs_unavailable',
  'awaiting_turn',
  // A set that exists and has not opened yet. Rounds open at each member's own
  // Fajr, so between being built and being seen there is a real, ordinary wait
  // that is not any kind of problem — unlike every other status here.
  'next_set_scheduled',
  'at_match_capacity',
  'filters_too_narrow',
  'legal_consent_required',
] as const;

export type DailyRoundStatus = (typeof dailyRoundStatuses)[number];

/**
 * Criteria the server may name as the costliest must-have. Anything else is
 * discarded rather than rendered, so a malformed response cannot put arbitrary
 * text in front of a member.
 */
export const mustHaveCriteria = [
  'age', 'height', 'build', 'distance', 'practice', 'timeline', 'children', 'sect',
] as const;

export type NarrowingCriterion = (typeof mustHaveCriteria)[number];

export function normalizeNarrowingCriterion(value: unknown): NarrowingCriterion | null {
  return typeof value === 'string'
    && (mustHaveCriteria as readonly string[]).includes(value)
    ? value as NarrowingCriterion
    : null;
}
export type DailyRoundEmptyReason = Exclude<DailyRoundStatus, 'ready'>;

/**
 * Treat an unknown server value as the least revealing empty state. This keeps
 * an older or malformed response from implying that another member exists or
 * that a particular private preference caused the empty round.
 */
export function normalizeDailyRoundStatus(value: unknown): DailyRoundStatus {
  return typeof value === 'string'
    && (dailyRoundStatuses as readonly string[]).includes(value)
    ? value as DailyRoundStatus
    : 'no_suitable_introductions';
}
