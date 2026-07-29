export const dailyRoundStatuses = [
  'ready',
  'profile_not_ready',
  'no_suitable_introductions',
  'matching_inputs_unavailable',
  'legal_consent_required',
] as const;

export type DailyRoundStatus = (typeof dailyRoundStatuses)[number];
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
