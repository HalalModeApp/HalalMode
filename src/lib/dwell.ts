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
 * Picks the profile that was read most among those let go.
 *
 * A free member keeps one of five. The person they read for longest after the
 * one they kept is not a rejection — they are a casualty of the budget, and
 * recording that as an ordinary release throws away the strongest positive
 * signal a round produces.
 *
 * A lower bar than the pass, deliberately. A pass is an accusation of sorts and
 * needs the whole set read before "least" means anything; this only says the
 * member lingered, costs them nothing if it is wrong, and is never shown to
 * anyone. Two genuinely read profiles are enough for "most" to have content.
 *
 * A tie returns null for the same reason as the pass: if two were read equally,
 * neither is the one, and choosing by array order would be inventing it.
 */
export function inferSoftSelect(
  records: DwellRecord[],
  releasedIntroductionIds: Iterable<string>,
  thresholds: DwellThresholds = DWELL_THRESHOLDS
): string | null {
  const read = records.filter((r) => r.totalMs >= thresholds.minMeaningfulMs);
  if (read.length < 2) return null;

  const released = new Set(releasedIntroductionIds);
  const candidates = read.filter((r) => released.has(r.introductionId));
  if (!candidates.length) return null;

  let longest: DwellRecord | null = null;
  let tied = false;
  for (const record of candidates) {
    if (!longest || record.totalMs > longest.totalMs) {
      longest = record;
      tied = false;
    } else if (record.totalMs === longest.totalMs) {
      tied = true;
    }
  }
  return longest && !tied ? longest.introductionId : null;
}

/**
 * Accumulates time per profile across visits.
 *
 * Deliberately a plain object rather than a hook, so the arithmetic can be
 * tested without a renderer. The app going away is reported by the caller
 * through pause/resume rather than guessed at in here, because only the caller
 * can tell a backgrounded app from a member who is simply reading slowly.
 */
export class DwellLedger {
  private readonly totals = new Map<string, { totalMs: number; opens: number }>();
  private open: { introductionId: string; at: number } | null = null;
  private pausedOn: string | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Banks whatever the open profile has accrued. Returns which one it was. */
  private bank(): string | null {
    if (!this.open) return null;
    const { introductionId, at } = this.open;
    const entry = this.totals.get(introductionId) ?? { totalMs: 0, opens: 0 };
    this.totals.set(introductionId, {
      totalMs: entry.totalMs + Math.max(0, this.now() - at),
      opens: entry.opens,
    });
    this.open = null;
    return introductionId;
  }

  /**
   * Opening a second profile without closing the first closes it implicitly.
   *
   * The visit is counted here rather than on the way out, because a reading
   * still open when the app goes away is a reading that happened. Counting it on
   * close meant a profile the member was on when they took a call recorded time
   * spent but zero visits.
   */
  opened(introductionId: string): void {
    this.bank();
    this.pausedOn = null;
    const entry = this.totals.get(introductionId) ?? { totalMs: 0, opens: 0 };
    this.totals.set(introductionId, { ...entry, opens: entry.opens + 1 });
    this.open = { introductionId, at: this.now() };
  }

  closed(introductionId: string): void {
    if (this.open?.introductionId !== introductionId) return;
    this.bank();
    this.pausedOn = null;
  }

  /**
   * The app went away — a call, a notification, a phone put in a pocket.
   *
   * Nothing else notices this. Navigation is what closes a profile, and
   * backgrounding is not navigation, so without this the profile that happened
   * to be open keeps accruing time for as long as the app is gone. Since the
   * decision is "who was read least", an hour banked against one person moves
   * somebody else to the bottom of the set — the wrong person gets asked about.
   */
  pause(): void {
    this.pausedOn = this.bank();
  }

  resume(): void {
    if (!this.pausedOn) return;
    this.open = { introductionId: this.pausedOn, at: this.now() };
    this.pausedOn = null;
  }

  /** Closes any profile still open, so a reading in progress is not lost. */
  records(): DwellRecord[] {
    if (this.open) this.bank();
    this.pausedOn = null;
    return [...this.totals.entries()].map(([introductionId, entry]) => ({
      introductionId,
      ...entry,
    }));
  }

  clear(): void {
    this.totals.clear();
    this.open = null;
    this.pausedOn = null;
  }
}
