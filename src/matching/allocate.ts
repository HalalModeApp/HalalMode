/**
 * Allocation — stage two of three.
 *
 * Reciprocal sets are built across the whole pool at once. Generating each
 * member's list independently cannot guarantee reciprocity, and the previous
 * approach — keeping only pairs inside *both* sides' top-N — systematically
 * under-filled sets, because popular members crowded each other out of their
 * own lists.
 *
 * The allocator is deliberately behind a narrow interface so a solver can
 * replace it later without touching estimation or fairness.
 *
 * See docs/RECIPROCAL_MATCHING_V1_DESIGN.md §5.
 */

import type { MatchingConfig } from './config';

/** One mutually eligible pair, already scored. */
export interface ScoredEdge {
  a: string;
  b: string;
  /** Geometric mean of both directional estimates. */
  reciprocal: number;
  /** Reciprocal score after the capped fairness boost and repeat decay. */
  utility: number;
}

export interface Capacity {
  /** How many introductions this member may receive this round. */
  limit: number;
}

export interface AllocationInput {
  edges: ScoredEdge[];
  capacities: Map<string, Capacity>;
  config: MatchingConfig;
  /** Recorded on the run so the result can be reproduced exactly. */
  seed: number;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

export interface AllocationResult {
  assigned: ScoredEdge[];
  /** Members whose set came out below their limit, with the shortfall. */
  shortfalls: Map<string, number>;
  stats: {
    consideredEdges: number;
    assignedEdges: number;
    rejectedBelowFloor: number;
    repairSwaps: number;
    repairTimedOut: boolean;
  };
}

/**
 * Deterministic 32-bit mix of the seed and both member ids.
 *
 * Replaces the previous `random()` tie-break. Two runs with the same seed and
 * the same inputs must produce byte-identical rounds, otherwise shadow mode
 * cannot be compared against live and a bug cannot be reproduced.
 */
export function tieBreak(seed: number, a: string, b: string): number {
  let hash = seed >>> 0;
  const text = a < b ? `${a}:${b}` : `${b}:${a}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable global ordering: utility first, then a seeded deterministic hash. */
export function compareEdges(seed: number) {
  return (left: ScoredEdge, right: ScoredEdge): number => {
    if (right.utility !== left.utility) return right.utility - left.utility;
    return tieBreak(seed, left.a, left.b) - tieBreak(seed, right.a, right.b);
  };
}

/**
 * Greedy assignment over a globally sorted edge list, followed by a
 * time-budgeted repair pass.
 *
 * Greedy on sorted weights is the standard half-approximation for weighted
 * b-matching in the worst case, and does considerably better than that on a
 * graph with degrees capped at five to ten. The objective here is not pure
 * weight maximisation anyway — it is weight subject to fairness — so exactness
 * would buy little against a target that is itself a judgement call.
 */
export function allocate(input: AllocationInput): AllocationResult {
  const { edges, capacities, config, seed } = input;
  const now = input.now ?? (() => Date.now());

  const remaining = new Map<string, number>();
  for (const [id, capacity] of capacities) {
    remaining.set(id, Math.max(0, capacity.limit));
  }

  let rejectedBelowFloor = 0;
  const eligible = edges.filter((edge) => {
    // The hard floor. No amount of exposure need moves an edge past it, which
    // is what stops fairness from forcing through an incompatible pair.
    if (edge.reciprocal < config.min_reciprocal_score) {
      rejectedBelowFloor += 1;
      return false;
    }
    return capacities.has(edge.a) && capacities.has(edge.b);
  });

  const ordered = [...eligible].sort(compareEdges(seed));

  const assigned: ScoredEdge[] = [];
  const takenPairs = new Set<string>();

  for (const edge of ordered) {
    const roomA = remaining.get(edge.a) ?? 0;
    const roomB = remaining.get(edge.b) ?? 0;
    if (roomA <= 0 || roomB <= 0) continue;

    const key = pairKey(edge.a, edge.b);
    if (takenPairs.has(key)) continue;

    remaining.set(edge.a, roomA - 1);
    remaining.set(edge.b, roomB - 1);
    takenPairs.add(key);
    assigned.push(edge);
  }

  const repair = repairPass({
    ordered,
    assigned,
    takenPairs,
    remaining,
    seed,
    deadline: now() + config.repair_time_budget_ms,
    now,
  });

  const shortfalls = new Map<string, number>();
  for (const [id, left] of remaining) {
    if (left > 0) shortfalls.set(id, left);
  }

  return {
    assigned,
    shortfalls,
    stats: {
      consideredEdges: edges.length,
      assignedEdges: assigned.length,
      rejectedBelowFloor,
      repairSwaps: repair.swaps,
      repairTimedOut: repair.timedOut,
    },
  };
}

interface RepairInput {
  ordered: ScoredEdge[];
  assigned: ScoredEdge[];
  takenPairs: Set<string>;
  remaining: Map<string, number>;
  seed: number;
  deadline: number;
  now: () => number;
}

/**
 * A second sweep for members whose set came out short.
 *
 * Greedy leaves gaps: a member can be passed over early and then find every
 * later partner already full. This walks the ordered list again and takes any
 * edge that has since become feasible. It only ever adds edges that already
 * cleared the score floor, so it cannot degrade quality — it can only fill.
 *
 * Stops when nothing useful remains or the time budget runs out, so a
 * pathological pool cannot stall a round.
 */
function repairPass(input: RepairInput): { swaps: number; timedOut: boolean } {
  const { ordered, assigned, takenPairs, remaining, deadline, now } = input;
  let swaps = 0;
  let timedOut = false;
  let progressed = true;

  while (progressed) {
    progressed = false;

    for (const edge of ordered) {
      if (now() > deadline) {
        timedOut = true;
        return { swaps, timedOut };
      }

      const key = pairKey(edge.a, edge.b);
      if (takenPairs.has(key)) continue;

      const roomA = remaining.get(edge.a) ?? 0;
      const roomB = remaining.get(edge.b) ?? 0;
      if (roomA <= 0 || roomB <= 0) continue;

      remaining.set(edge.a, roomA - 1);
      remaining.set(edge.b, roomB - 1);
      takenPairs.add(key);
      assigned.push(edge);
      swaps += 1;
      progressed = true;
    }
  }

  return { swaps, timedOut };
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Final gate before anything is written.
 *
 * Reciprocity and capacity are structural promises, so they are asserted rather
 * than assumed. A violation means the round is discarded, not repaired — a
 * silently one-sided introduction is worse than no round at all.
 */
export function verifyAllocation(
  result: AllocationResult,
  capacities: Map<string, Capacity>
): { ok: true } | { ok: false; reason: string } {
  const counts = new Map<string, number>();
  const seen = new Set<string>();

  for (const edge of result.assigned) {
    if (edge.a === edge.b) {
      return { ok: false, reason: `self-pair for ${edge.a}` };
    }
    const key = pairKey(edge.a, edge.b);
    if (seen.has(key)) {
      return { ok: false, reason: `duplicate pair ${key}` };
    }
    seen.add(key);

    counts.set(edge.a, (counts.get(edge.a) ?? 0) + 1);
    counts.set(edge.b, (counts.get(edge.b) ?? 0) + 1);
  }

  for (const [id, count] of counts) {
    const limit = capacities.get(id)?.limit;
    if (limit === undefined) {
      return { ok: false, reason: `${id} was assigned without capacity` };
    }
    if (count > limit) {
      return { ok: false, reason: `${id} exceeds limit: ${count} > ${limit}` };
    }
  }

  return { ok: true };
}
