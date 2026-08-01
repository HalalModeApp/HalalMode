const MADINAH_TIME_ZONE = 'Asia/Riyadh' as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MatchingRunContext {
  runId: string;
  seed: number;
  cycleDate: string;
  timeZone: typeof MADINAH_TIME_ZONE;
  windowStartsOn: string;
  windowEndsOn: string;
  roundsElapsedInWindow: number;
  evaluatedAt: string;
  poolMemberCount: number;
}

export interface MatchingPlanContext {
  seed: number;
  evaluatedAt: string;
  fairnessWindow: {
    timeZone: typeof MADINAH_TIME_ZONE;
    startsOn: string;
    endsOn: string;
    roundsElapsed: number;
  };
}

function finiteInteger(value: unknown, name: string, minimum: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Matching run context ${name} is invalid`);
  }
  return parsed;
}

function isoDate(value: unknown, name: string): string {
  const parsed = typeof value === 'string' && ISO_DATE.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : null;
  if (!parsed || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Matching run context ${name} is invalid`);
  }
  return value;
}

/** Validates the private run-start RPC payload before it can drive a round. */
export function parseMatchingRunContext(
  payload: unknown,
  expectedCycleDate: string
): MatchingRunContext {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Matching run context payload is invalid');
  }
  const row = payload as Record<string, unknown>;
  const runId = row['run_id'];
  if (typeof runId !== 'string' || !UUID.test(runId)) {
    throw new Error('Matching run context run_id is invalid');
  }
  const cycleDate = isoDate(row['cycle_date'], 'cycle_date');
  if (cycleDate !== expectedCycleDate) {
    throw new Error('Matching run context returned the wrong cycle');
  }
  if (row['time_zone'] !== MADINAH_TIME_ZONE) {
    throw new Error('Matching run context must use Asia/Riyadh');
  }
  const windowStartsOn = isoDate(row['window_starts_on'], 'window_starts_on');
  const windowEndsOn = isoDate(row['window_ends_on'], 'window_ends_on');
  if (windowStartsOn > cycleDate || cycleDate > windowEndsOn) {
    throw new Error('Matching run context cycle is outside its fairness window');
  }
  const evaluatedAt = row['evaluated_at'];
  if (typeof evaluatedAt !== 'string' || Number.isNaN(Date.parse(evaluatedAt))) {
    throw new Error('Matching run context evaluated_at is invalid');
  }

  return {
    runId,
    seed: finiteInteger(row['seed'], 'seed', 0),
    cycleDate,
    timeZone: MADINAH_TIME_ZONE,
    windowStartsOn,
    windowEndsOn,
    roundsElapsedInWindow: finiteInteger(
      row['rounds_elapsed_in_window'],
      'rounds_elapsed_in_window',
      1
    ),
    evaluatedAt,
    poolMemberCount: finiteInteger(row['pool_member_count'], 'pool_member_count', 0),
  };
}

/** Removes run identity so live and shadow can prove they used identical inputs. */
export function matchingPlanContext(context: MatchingRunContext): MatchingPlanContext {
  return {
    seed: context.seed,
    evaluatedAt: context.evaluatedAt,
    fairnessWindow: {
      timeZone: context.timeZone,
      startsOn: context.windowStartsOn,
      endsOn: context.windowEndsOn,
      roundsElapsed: context.roundsElapsedInWindow,
    },
  };
}

/** Stable tie-break seed; it does not determine fairness-window phase. */
export function matchingSeedForCycleDate(cycleDate: string): number {
  const validated = isoDate(cycleDate, 'cycle_date');
  return Number(validated.replaceAll('-', ''));
}

/**
 * A pre-finalize failure is safe to retry. Once finalization was attempted, a
 * network error is ambiguous: Postgres may have committed even if the caller
 * never received the response, so releasing the daily claim risks duplicates.
 */
export function isExplicitDatabaseRollback(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as Record<string, unknown>)['code'];
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

export function isRetriableLateMatchingVeto(error: unknown): boolean {
  if (!isExplicitDatabaseRollback(error)) return false;
  const row = error as Record<string, unknown>;
  return row['code'] === '40001'
    && typeof row['message'] === 'string'
    && row['message'].startsWith('MATCHING_LATE_VETO:');
}

export function shouldRetryMatchingRun(error: unknown, attempt: number): boolean {
  return attempt === 0 && isRetriableLateMatchingVeto(error);
}

/** Retry identical finalizer arguments once when the transport outcome is unknown. */
export function shouldRetryExactFinalization(error: unknown, attempt: number): boolean {
  return attempt === 0 && !isExplicitDatabaseRollback(error);
}

export function shouldReleaseCycleClaim(
  finalizationAttempted: boolean,
  explicitDatabaseRollback = false
): boolean {
  return !finalizationAttempted || explicitDatabaseRollback;
}
