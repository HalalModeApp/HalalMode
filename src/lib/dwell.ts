/**
 * Inferring a deliberate pass from how a whole set was read.
 *
 * The alternative was a second button on every face — "not now" beside "no,
 * really" — which turns a calm screen into an interrogation and gets answered
 * by mood as much as by meaning. Time spent reading is the one signal already
 * being produced honestly, because nobody is performing it.
 *
 * Two shapes qualify, and nothing else does:
 *
 *   every profile was read, and one was read least
 *   every profile but one was read, and that one was never opened
 *
 * Both mean the member worked through their whole set and left the same person
 * at the bottom of it. What they have in common is the comparison: the answer
 * is only legible because everyone else got attention. A member who read two of
 * five tells you nothing about the three they skipped, so no reading of a
 * partial set counts, however lopsided it looks.
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
   * Sets smaller than this are not judged at all. "Everyone but one" needs
   * enough people for the exception to mean something; in a set of two it is
   * just a coin landing.
   */
  minSetSize: number;
  /**
   * Below this a profile was not read — a mis-tap, or a screen opened and
   * immediately backed out of. Counted as never opened, which is what it
   * amounts to, rather than as the shortest read.
   */
  minMeaningfulMs: number;
}

export const DWELL_THRESHOLDS: DwellThresholds = {
  minSetSize: 3,
  minMeaningfulMs: 1_500,
};

/**
 * Picks at most one introduction worth asking about.
 *
 * Restricted to profiles the member let go: a pass is a stronger version of a
 * no, so it can only apply where a no was already given. Someone kept is not a
 * candidate however briefly their profile was open.
 */
export function inferPassCandidate(
  records: DwellRecord[],
  setIntroductionIds: readonly string[],
  releasedIntroductionIds: Iterable<string>,
  thresholds: DwellThresholds = DWELL_THRESHOLDS
): string | null {
  const set = [...new Set(setIntroductionIds)];
  if (set.length < thresholds.minSetSize) return null;

  const readMs = new Map(
    records
      .filter((r) => r.totalMs >= thresholds.minMeaningfulMs)
      .map((r) => [r.introductionId, r.totalMs] as const)
  );
  const unread = set.filter((id) => !readMs.has(id));

  let candidate: string | null = null;

  if (unread.length === 0) {
    // Everyone was read. The shortest is the answer, and it has to be the
    // shortest on its own — two people tied at the bottom single out neither,
    // and picking between them by array order would be inventing a decision.
    let shortest: { id: string; ms: number } | null = null;
    let tied = false;
    for (const id of set) {
      const ms = readMs.get(id)!;
      if (!shortest || ms < shortest.ms) {
        shortest = { id, ms };
        tied = false;
      } else if (ms === shortest.ms) {
        tied = true;
      }
    }
    if (!shortest || tied) return null;
    candidate = shortest.id;
  } else if (unread.length === 1) {
    // Everyone else was read and this one was never opened. Not being clicked
    // on while the rest of the set was is the clearer of the two answers.
    candidate = unread[0]!;
  } else {
    // Two or more left unopened. The member did not work through the set, so
    // there is nothing to compare and nobody was singled out.
    return null;
  }

  const released = new Set(releasedIntroductionIds);
  return released.has(candidate) ? candidate : null;
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
