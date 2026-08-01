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

import type { MatchingConfig } from './config.ts';

/** One mutually eligible pair, already scored. */
export interface ScoredEdge {
  a: string;
  b: string;
  /** Geometric mean of both directional estimates. */
  reciprocal: number;
  /** Reciprocal score after repeat decay but before any fairness boost. */
  quality: number;
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

/**
 * Stable global ordering: raw-quality band, then fairness utility, then seed.
 *
 * Banding makes “comparable” explicit and preserves a total order. Fairness can
 * reorder edges within one narrow band, but can never promote an edge across a
 * stronger raw-quality band.
 */
export function compareEdges(seed: number, qualityBandWidth = 0.025) {
  return (left: ScoredEdge, right: ScoredEdge): number => {
    const leftBand = qualityBand(left.quality, qualityBandWidth);
    const rightBand = qualityBand(right.quality, qualityBandWidth);
    if (rightBand !== leftBand) return rightBand - leftBand;
    if (right.utility !== left.utility) return right.utility - left.utility;
    return tieBreak(seed, left.a, left.b) - tieBreak(seed, right.a, right.b);
  };
}

export function qualityBand(quality: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) throw new Error('Quality band width must be positive');
  return Math.floor(quality / width + 1e-9);
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

  const ordered = [...eligible].sort(compareEdges(seed, config.quality_band_width));

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
    qualityBandWidth: config.quality_band_width,
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
  qualityBandWidth: number;
  deadline: number;
  now: () => number;
}

/**
 * Bounded augmenting-path repair for members whose set came out short.
 *
 * An add-only second sweep cannot help after greedy assignment because
 * capacities only decrease. This repair looks for a length-three path that
 * replaces one assigned edge with two eligible, comparable-quality edges,
 * increasing coverage by one without allowing two weak edges to displace one
 * strong edge. Every replacement already cleared the reciprocal-score floor,
 * and the raw-quality band check preserves the fairness ordering invariant.
 *
 * Candidate fan-out and elapsed time are both bounded so a pathological pool
 * degrades predictably instead of stalling the round.
 */
function repairPass(input: RepairInput): { swaps: number; timedOut: boolean } {
  const {
    ordered,
    assigned,
    takenPairs,
    remaining,
    qualityBandWidth,
    deadline,
    now,
  } = input;
  let swaps = 0;
  let timedOut = false;
  const candidatesByMember = new Map<string, ScoredEdge[]>();
  for (const edge of ordered) {
    for (const id of [edge.a, edge.b]) {
      const list = candidatesByMember.get(id) ?? [];
      list.push(edge);
      candidatesByMember.set(id, list);
    }
  }
  const assignedByMember = new Map<string, Set<ScoredEdge>>();
  for (const edge of assigned) {
    for (const id of [edge.a, edge.b]) {
      const set = assignedByMember.get(id) ?? new Set<ScoredEdge>();
      set.add(edge);
      assignedByMember.set(id, set);
    }
  }

  for (const candidate of ordered) {
    if (now() > deadline) {
      timedOut = true;
      break;
    }
    if (takenPairs.has(pairKey(candidate.a, candidate.b))) continue;

    const roomA = remaining.get(candidate.a) ?? 0;
    const roomB = remaining.get(candidate.b) ?? 0;
    if ((roomA > 0) === (roomB > 0)) continue;

    const underfilled = roomA > 0 ? candidate.a : candidate.b;
    const full = roomA > 0 ? candidate.b : candidate.a;
    const incidentAssigned = [...(assignedByMember.get(full) ?? [])];

    let augmented = false;
    for (const displaced of incidentAssigned) {
      const displacedBand = qualityBand(displaced.quality, qualityBandWidth);
      if (qualityBand(candidate.quality, qualityBandWidth) !== displacedBand) continue;

      const displacedOther = displaced.a === full ? displaced.b : displaced.a;
      // Lists inherit the global utility order. A bounded prefix makes repair
      // cost predictable on high-degree graphs; the wall-clock deadline is the
      // final guard.
      const replacements = (candidatesByMember.get(displacedOther) ?? []).slice(0, 32);
      for (const replacement of replacements) {
        if (now() > deadline) return { swaps, timedOut: true };
        const replacementKey = pairKey(replacement.a, replacement.b);
        if (takenPairs.has(replacementKey)) continue;
        if (replacementKey === pairKey(candidate.a, candidate.b)) continue;

        const replacementOther =
          replacement.a === displacedOther ? replacement.b : replacement.a;
        if (replacementOther === underfilled || replacementOther === full) continue;
        if ((remaining.get(replacementOther) ?? 0) <= 0) continue;
        if (qualityBand(replacement.quality, qualityBandWidth) !== displacedBand) continue;
        if (candidate.quality + replacement.quality < displaced.quality) continue;
        if (candidate.utility + replacement.utility < displaced.utility) continue;

        removeAssigned(displaced, assigned, takenPairs, remaining, assignedByMember);
        addAssigned(candidate, assigned, takenPairs, remaining, assignedByMember);
        addAssigned(replacement, assigned, takenPairs, remaining, assignedByMember);
        swaps += 1;
        augmented = true;
        break;
      }
      if (augmented) break;
    }
  }

  return { swaps, timedOut };
}

function addAssigned(
  edge: ScoredEdge,
  assigned: ScoredEdge[],
  takenPairs: Set<string>,
  remaining: Map<string, number>,
  assignedByMember: Map<string, Set<ScoredEdge>>
): void {
  remaining.set(edge.a, (remaining.get(edge.a) ?? 0) - 1);
  remaining.set(edge.b, (remaining.get(edge.b) ?? 0) - 1);
  takenPairs.add(pairKey(edge.a, edge.b));
  assigned.push(edge);
  for (const id of [edge.a, edge.b]) {
    const set = assignedByMember.get(id) ?? new Set<ScoredEdge>();
    set.add(edge);
    assignedByMember.set(id, set);
  }
}

function removeAssigned(
  edge: ScoredEdge,
  assigned: ScoredEdge[],
  takenPairs: Set<string>,
  remaining: Map<string, number>,
  assignedByMember: Map<string, Set<ScoredEdge>>
): void {
  const index = assigned.indexOf(edge);
  if (index >= 0) assigned.splice(index, 1);
  remaining.set(edge.a, (remaining.get(edge.a) ?? 0) + 1);
  remaining.set(edge.b, (remaining.get(edge.b) ?? 0) + 1);
  takenPairs.delete(pairKey(edge.a, edge.b));
  assignedByMember.get(edge.a)?.delete(edge);
  assignedByMember.get(edge.b)?.delete(edge);
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
