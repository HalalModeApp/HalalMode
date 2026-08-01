/**
 * Serving rotation for imbalanced pools.
 *
 * In a reciprocal system the two sides must consume the same number of
 * introductions: if A is shown B then B is shown A, so
 *
 *     sum(side A set sizes) = sum(side B set sizes) = edge count
 *
 * That is an accounting identity, not a tuning parameter. When one side has
 * more capacity than the other, the larger side simply cannot all receive full
 * sets. With 500 men and 100 women capped at five, the ceiling is 500 edges and
 * the men can average at most one each.
 *
 * Left alone, a greedy allocator resolves that by concentrating: a lucky few
 * get full sets and most get nothing, with the winners picked by score, so
 * broadly the same members win every round. This module makes the choice
 * deliberate and fair instead — each round serves a cohort of the constrained
 * side with full sets, ordered by who has waited longest, and defers the rest.
 *
 * Nothing here knows which gender is which. The constrained side is whichever
 * has surplus capacity in that round, so a pool that starts with more men and
 * later has more women needs no code change — and a balanced pool degenerates
 * to "serve everyone" on its own.
 */

import type { MatchingConfig } from './config';
import type { MemberSignals } from './estimate';
import { tieBreak } from './allocate';

export interface RotationCandidate {
  member: MemberSignals;
  /** Introductions this member may receive this round. */
  limit: number;
}

export interface RotationPlan {
  /** Members who receive a set this round. */
  serving: Set<string>;
  /**
   * How many introductions each served member actually gets.
   *
   * When the pool is constrained this is capped at `rotation_min_set_size`
   * rather than the member's full allowance. Selection opportunities scale with
   * the number of *rounds* a member is served, not with set size — a free
   * member keeps one person per round however many they are shown. Serving
   * twice as many members with sets of three therefore produces far more
   * matches than serving half as many with sets of five.
   */
  servedLimits: Map<string, number>;
  /** Members deferred to a later round, longest-waiting first next time. */
  deferred: string[];
  /**
   * Which side had surplus capacity, or null when the pool is balanced enough
   * that nobody had to be deferred.
   */
  constrainedSide: 'a' | 'b' | null;
  /** Upper bound on edges this round: min(capacity A, capacity B). */
  edgeCeiling: number;
  /** Set size each member of the larger side would get if spread evenly. */
  thinSetSize: number;
}

function totalCapacity(side: RotationCandidate[]): number {
  return side.reduce((sum, candidate) => sum + Math.max(0, candidate.limit), 0);
}

/**
 * Ordering for who gets served first.
 *
 * Rounds since a member last received anything is the primary key, and it is
 * deliberately not exposure need: need is measured inside a rolling window and
 * resets when the window turns over, which would shuffle the queue and let a
 * long-deferred member lose their place. Waiting time only ever increases.
 */
function byWaiting(seed: number) {
  return (left: RotationCandidate, right: RotationCandidate): number => {
    const waited = right.member.roundsSinceLastServed - left.member.roundsSinceLastServed;
    if (waited !== 0) return waited;

    const stale = right.member.roundsSinceLastMutual - left.member.roundsSinceLastMutual;
    if (stale !== 0) return stale;

    return (
      tieBreak(seed, left.member.id, left.member.id) -
      tieBreak(seed, right.member.id, right.member.id)
    );
  };
}

/**
 * Decides who receives a set this round.
 *
 * Returns every member when the pool is balanced, or when spreading thinly
 * would still leave the larger side with a workable set — deferring people is
 * only worth it when the alternative is sets too small to choose from.
 */
export function planRotation(
  sideA: RotationCandidate[],
  sideB: RotationCandidate[],
  config: MatchingConfig,
  seed: number
): RotationPlan {
  const capacityA = totalCapacity(sideA);
  const capacityB = totalCapacity(sideB);
  const edgeCeiling = Math.min(capacityA, capacityB);

  const all = [...sideA, ...sideB];
  const everyone = new Set(all.map((candidate) => candidate.member.id));
  const fullLimits = new Map(
    all.map((candidate) => [candidate.member.id, Math.max(0, candidate.limit)])
  );

  const larger = capacityA > capacityB ? sideA : sideB;
  const smaller = capacityA > capacityB ? sideB : sideA;
  const constrainedSide: 'a' | 'b' = capacityA > capacityB ? 'a' : 'b';

  const thinSetSize = larger.length > 0 ? edgeCeiling / larger.length : 0;

  if (!config.rotation_enabled || capacityA === capacityB || larger.length === 0) {
    return {
      serving: everyone,
      servedLimits: fullLimits,
      deferred: [],
      constrainedSide: null,
      edgeCeiling,
      thinSetSize,
    };
  }

  // Mild imbalance: everyone still gets a set worth choosing from, so deferring
  // anybody would cost more than it gains.
  if (thinSetSize >= config.rotation_min_set_size) {
    return {
      serving: everyone,
      servedLimits: fullLimits,
      deferred: [],
      constrainedSide: null,
      edgeCeiling,
      thinSetSize,
    };
  }

  // Fill the available capacity with whoever has waited longest, giving each a
  // set of `rotation_min_set_size` rather than their full allowance so that as
  // many members as possible get a turn.
  const queue = [...larger].sort(byWaiting(seed));
  const serving = new Set(smaller.map((candidate) => candidate.member.id));
  const servedLimits = new Map<string, number>();
  for (const candidate of smaller) {
    servedLimits.set(candidate.member.id, Math.max(0, candidate.limit));
  }
  const deferred: string[] = [];

  let used = 0;
  for (const candidate of queue) {
    const share = Math.max(
      1,
      Math.min(Math.max(0, candidate.limit), config.rotation_min_set_size)
    );
    if (used + share <= edgeCeiling || used === 0) {
      serving.add(candidate.member.id);
      servedLimits.set(candidate.member.id, share);
      used += share;
    } else {
      deferred.push(candidate.member.id);
    }
  }

  return { serving, servedLimits, deferred, constrainedSide, edgeCeiling, thinSetSize };
}
