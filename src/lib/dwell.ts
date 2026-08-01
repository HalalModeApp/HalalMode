/**
 * Inferring a deliberate pass from how long a profile was read.
 *
 * The alternative was a second button on every face — "not now" beside "no,
 * really" — which turns a calm screen into an interrogation and gets answered
 * by mood as much as by meaning. Time spent reading is the one signal already
 * being produced honestly, because nobody is performing it.
 *
 * It is still only a guess, so nothing here decides anything on its own: the
 * member is asked once, before the round is submitted, and the answer they give
 * is what gets recorded. Everything below exists to make that question worth
 * asking — never to answer it.
 *
 * Timings never leave the device. What travels is the confirmed decision.
 */

export interface DwellRecord {
  /** The introduction, not the member — nothing here is keyed on a person. */
  introductionId: string;
  /** Total time on the profile across every visit this round. */
  totalMs: number;
  opens: number;
}

export interface DwellThresholds {
  /**
   * Profiles that must have been genuinely read before any comparison is drawn.
   * Below this there is no basis for "least" — one short look among two is not
   * evidence of anything.
   */
  minProfilesRead: number;
  /**
   * A candidate must have had at most this share of the median attention.
   * Someone who read everyone for roughly as long has not singled anybody out,
   * and should not be asked to.
   */
  maxShareOfMedian: number;
  /**
   * Above this, even the shortest look was a real look. Prevents a careful
   * member who reads everything closely from being asked about whoever they
   * happened to finish first.
   */
  fairLookMs: number;
  /**
   * Below this a profile was not read at all — a mis-tap, or a screen opened
   * and immediately backed out of. It counts neither toward the minimum nor as
   * a candidate, because it is indistinguishable from an accident.
   */
  minMeaningfulMs: number;
}

export const DWELL_THRESHOLDS: DwellThresholds = {
  minProfilesRead: 3,
  maxShareOfMedian: 0.5,
  fairLookMs: 20_000,
  minMeaningfulMs: 1_500,
};

/** Median of a non-empty list. Even lengths take the mean of the middle pair. */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Picks at most one introduction worth asking about.
 *
 * Restricted to profiles the member let go: a pass is a stronger version of a
 * no, so it can only apply where a no was already given. Someone kept is not a
 * candidate however briefly their profile was open.
 *
 * Returns null far more often than not, which is the intended behaviour — the
 * question should feel rare enough to be worth answering.
 */
export function inferPassCandidate(
  records: DwellRecord[],
  releasedIntroductionIds: Iterable<string>,
  thresholds: DwellThresholds = DWELL_THRESHOLDS
): string | null {
  const read = records.filter((r) => r.totalMs >= thresholds.minMeaningfulMs);
  if (read.length < thresholds.minProfilesRead) return null;

  const released = new Set(releasedIntroductionIds);
  const candidates = read.filter((r) => released.has(r.introductionId));
  if (!candidates.length) return null;

  // Compared against everything that was read, not just what was let go. The
  // question is whether this profile got less attention than the member's own
  // normal, and their normal includes whoever they chose.
  const middle = median(read.map((r) => r.totalMs));

  let shortest: DwellRecord | null = null;
  for (const record of candidates) {
    if (!shortest || record.totalMs < shortest.totalMs) shortest = record;
  }
  if (!shortest) return null;

  if (shortest.totalMs >= thresholds.fairLookMs) return null;
  if (shortest.totalMs > middle * thresholds.maxShareOfMedian) return null;

  // A tie is not a singling-out. If two profiles got equally little attention,
  // neither is *the* one, and picking by array order would be arbitrary.
  const tied = candidates.filter((r) => r.totalMs === shortest.totalMs);
  if (tied.length > 1) return null;

  return shortest.introductionId;
}

/**
 * Accumulates time per profile across visits.
 *
 * Deliberately a plain object rather than a hook so the arithmetic can be
 * tested without a renderer, and so a paused or backgrounded app is the
 * caller's problem to report rather than something guessed at in here.
 */
export class DwellLedger {
  private readonly totals = new Map<string, { totalMs: number; opens: number }>();
  private open: { introductionId: string; at: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Opening a second profile without closing the first closes it implicitly. */
  opened(introductionId: string): void {
    if (this.open) this.closed(this.open.introductionId);
    this.open = { introductionId, at: this.now() };
  }

  closed(introductionId: string): void {
    if (!this.open || this.open.introductionId !== introductionId) return;
    const elapsed = Math.max(0, this.now() - this.open.at);
    const entry = this.totals.get(introductionId) ?? { totalMs: 0, opens: 0 };
    this.totals.set(introductionId, {
      totalMs: entry.totalMs + elapsed,
      opens: entry.opens + 1,
    });
    this.open = null;
  }

  /** Closes any profile still open, so a reading in progress is not lost. */
  records(): DwellRecord[] {
    if (this.open) this.closed(this.open.introductionId);
    return [...this.totals.entries()].map(([introductionId, entry]) => ({
      introductionId,
      ...entry,
    }));
  }

  clear(): void {
    this.totals.clear();
    this.open = null;
  }
}
