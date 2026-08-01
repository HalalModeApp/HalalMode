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
  /**
   * True when this pair has never been shown to each other.
   *
   * Ranked ahead of every repeat, whatever the scores say. A member who has
   * already seen somebody has already given their answer about them; showing a
   * new face instead is worth more than a slightly better score on a rerun,
   * even when the new face ranks lower. Repeats fill what is left over, which
   * is why a cooldown expiring makes a pair *eligible* rather than due.
   */
  fresh: boolean;
  /**
   * The two directional estimates: P(a picks b) and P(b picks a).
   *
   * The reciprocal score deliberately collapses these, but composition needs
   * them apart — an edge where one side wants the other far more is a reach,
   * and a set made entirely of reaches produces no matches at all.
   */
  forward?: number;
  backward?: number;
}

export interface Capacity {
  /** How many introductions this member may receive this round. */
  limit: number;
}

export interface AllocationInput {
  edges: ScoredEdge[];
  /**
   * One-sided pick rate per member, used only for composition. Absent means no
   * history, which is treated as no bias.
   */
  oneSidedRates?: Map<string, number>;
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
    /** Members given a best-available partner before the greedy fill. */
    anchoredMembers: number;
    /** Slots deliberately given to a lower-ranked edge to gather evidence. */
    exploratorySlots: number;
    /** Reaches swapped for a more even pair, for members whose picks go unreturned. */
    compositionSwaps: number;
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
    // Freshness outranks score outright, so greedy exhausts everyone nobody has
    // met before it reconsiders a single pair that has already been shown.
    if (left.fresh !== right.fresh) return left.fresh ? -1 : 1;
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

  // Give everyone their best available partner before anyone gets a second.
  const anchored = config.allocator === 'anchored_maxmin_v1'
    ? anchorPass({ ordered, assigned, takenPairs, remaining, seed })
    : 0;

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


  const explored = explorationPass({
    ordered,
    assigned,
    takenPairs,
    remaining,
    capacities,
    config,
    seed,
  });

  const repair = repairPass({
    ordered,
    assigned,
    takenPairs,
    remaining,
    qualityBandWidth: config.quality_band_width,
    deadline: now() + config.repair_time_budget_ms,
    now,
  });

  const composed = compositionPass({
    ordered,
    assigned,
    takenPairs,
    remaining,
    oneSidedRates: input.oneSidedRates ?? new Map(),
    config,
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
      anchoredMembers: anchored,
    exploratorySlots: explored,
    compositionSwaps: composed,
    repairSwaps: repair.swaps,
      repairTimedOut: repair.timedOut,
    },
  };
}

interface AnchorInput {
  ordered: ScoredEdge[];
  assigned: ScoredEdge[];
  takenPairs: Set<string>;
  remaining: Map<string, number>;
  seed: number;
}

/**
 * Anchor pass — one strong edge each, before anyone gets a second.
 *
 * Sorting globally and taking greedily maximises the *total* of the edge
 * weights, which is not the goal. The goal is that each member's set contains
 * someone likely to choose them back, and a sum can be maximised while leaving
 * individual members with nothing worth picking: three excellent edges for one
 * person and three mediocre ones for another beats an even split on total.
 *
 * So each member first claims their single best available partner, processed
 * most-constrained-first — a member with three options loses their best to
 * someone with thirty far more often than the reverse, so serving the
 * constrained first costs the flexible almost nothing.
 *
 * This is the tractable stand-in for maximising mutual first choices. Ranking
 * probabilities are set-dependent — B may be A's first choice in one set and
 * third in another — so scoring pairs independently and then allocating is
 * circular. Guaranteeing each member one high-reciprocity edge captures most of
 * the benefit without needing a choice model.
 *
 * Returns the number of anchors placed. The ordinary greedy fill runs
 * afterwards and takes the remaining capacity.
 */
function anchorPass(input: AnchorInput): number {
  const { ordered, assigned, takenPairs, remaining, seed } = input;

  // Best-first per member, following the already-sorted global order.
  const options = new Map<string, ScoredEdge[]>();
  for (const edge of ordered) {
    for (const id of [edge.a, edge.b]) {
      if ((remaining.get(id) ?? 0) <= 0) continue;
      const list = options.get(id);
      if (list) list.push(edge);
      else options.set(id, [edge]);
    }
  }

  const queue = [...options.keys()].sort((left, right) => {
    const byChoice = (options.get(left)?.length ?? 0) - (options.get(right)?.length ?? 0);
    if (byChoice !== 0) return byChoice;
    return tieBreak(seed, left, left) - tieBreak(seed, right, right);
  });

  let placed = 0;
  for (const id of queue) {
    if ((remaining.get(id) ?? 0) <= 0) continue;

    for (const edge of options.get(id) ?? []) {
      const key = pairKey(edge.a, edge.b);
      if (takenPairs.has(key)) continue;
      const roomA = remaining.get(edge.a) ?? 0;
      const roomB = remaining.get(edge.b) ?? 0;
      if (roomA <= 0 || roomB <= 0) continue;

      remaining.set(edge.a, roomA - 1);
      remaining.set(edge.b, roomB - 1);
      takenPairs.add(key);
      assigned.push(edge);
      placed += 1;
      break;
    }
  }

  return placed;
}

interface CompositionInput {
  ordered: ScoredEdge[];
  assigned: ScoredEdge[];
  takenPairs: Set<string>;
  remaining: Map<string, number>;
  oneSidedRates: Map<string, number>;
  config: MatchingConfig;
}

/** How lopsided this edge is from one member's side. */
function reachGap(edge: ScoredEdge, id: string): number {
  if (edge.forward === undefined || edge.backward === undefined) return 0;
  const wants = edge.a === id ? edge.forward : edge.backward;
  const wanted = edge.a === id ? edge.backward : edge.forward;
  return wants - wanted;
}

/**
 * Shifts the composition of a set for members whose picks are consistently
 * unreturned.
 *
 * Some members reach almost exclusively for people who will not reach back.
 * Round after round they choose, nothing comes of it, and nothing about the
 * experience tells them why — because it must not. A set made entirely of
 * reaches is one that reliably produces no match.
 *
 * So a few of the most lopsided edges are traded for more evenly matched ones.
 * Deliberately a few: `max_reach_edges` is never zero, so nobody is stopped
 * from aiming high — only from spending every slot doing it. Most members never
 * reach the threshold at all.
 *
 * This is the one part of the system that could become a ranking if it were
 * allowed to compound, so it does not: it is bounded per round, driven by a
 * signal that resets when a member changes their profile, and never surfaced
 * anywhere. Being shown people who might actually choose you back is a kindness
 * as long as nobody is told it is happening.
 */
function compositionPass(input: CompositionInput): number {
  const { ordered, assigned, takenPairs, remaining, oneSidedRates, config } = input;

  const setOf = new Map<string, ScoredEdge[]>();
  for (const edge of assigned) {
    for (const id of [edge.a, edge.b]) {
      const list = setOf.get(id);
      if (list) list.push(edge);
      else setOf.set(id, [edge]);
    }
  }

  let swaps = 0;
  for (const [id, set] of setOf) {
    if ((oneSidedRates.get(id) ?? 0) < config.reach_bias_floor) continue;

    const reaches = set
      .filter((edge) => reachGap(edge, id) >= config.reach_gap_threshold)
      .sort((left, right) => reachGap(right, id) - reachGap(left, id));
    if (reaches.length <= config.max_reach_edges) continue;

    // Trade only the excess, worst first, and only for something more even.
    for (const reach of reaches.slice(config.max_reach_edges)) {
      const replacement = ordered.find((candidate) => {
        if (candidate.a !== id && candidate.b !== id) return false;
        if (takenPairs.has(pairKey(candidate.a, candidate.b))) return false;
        if (candidate.reciprocal < config.min_reciprocal_score) return false;
        if (reachGap(candidate, id) >= config.reach_gap_threshold) return false;
        const other = candidate.a === id ? candidate.b : candidate.a;
        const freed = other === reach.a || other === reach.b ? 1 : 0;
        return (remaining.get(other) ?? 0) + freed > 0;
      });
      if (!replacement) continue;

      const index = assigned.indexOf(reach);
      if (index < 0) continue;
      assigned.splice(index, 1);
      takenPairs.delete(pairKey(reach.a, reach.b));
      remaining.set(reach.a, (remaining.get(reach.a) ?? 0) + 1);
      remaining.set(reach.b, (remaining.get(reach.b) ?? 0) + 1);

      if ((remaining.get(replacement.a) ?? 0) <= 0 || (remaining.get(replacement.b) ?? 0) <= 0) {
        assigned.push(reach);
        takenPairs.add(pairKey(reach.a, reach.b));
        remaining.set(reach.a, (remaining.get(reach.a) ?? 1) - 1);
        remaining.set(reach.b, (remaining.get(reach.b) ?? 1) - 1);
        continue;
      }

      assigned.push(replacement);
      takenPairs.add(pairKey(replacement.a, replacement.b));
      remaining.set(replacement.a, (remaining.get(replacement.a) ?? 1) - 1);
      remaining.set(replacement.b, (remaining.get(replacement.b) ?? 1) - 1);
      swaps += 1;
    }
  }

  return swaps;
}

interface ExplorationInput {
  ordered: ScoredEdge[];
  assigned: ScoredEdge[];
  takenPairs: Set<string>;
  remaining: Map<string, number>;
  capacities: Map<string, Capacity>;
  config: MatchingConfig;
  seed: number;
}

/**
 * Spends a small share of slots on edges the model did not rank highest.
 *
 * The matcher improves by watching what happens to the pairs it chose, which
 * means it only ever sees its own beliefs confirmed. If it is systematically
 * wrong about a kind of pair, nothing in a purely greedy round will ever tell
 * it so. Exploration is the only mechanism that can correct a mistaken model
 * rather than reinforce it.
 *
 * Three constraints keep the cost honest. It never touches a member's strongest
 * introduction — only positions from `exploration_min_slot` onward. The
 * substitute must still clear the score floor, so an experiment is never an
 * incompatible pair. And every swap frees both sides' capacity before spending
 * it again, so reciprocity and limits hold exactly as before.
 */
function explorationPass(input: ExplorationInput): number {
  const { ordered, assigned, takenPairs, remaining, capacities, config, seed } = input;
  if (config.exploration_rate <= 0) return 0;

  // Where each member's edges sit in their own set, best first.
  const setOf = new Map<string, ScoredEdge[]>();
  for (const edge of assigned) {
    for (const id of [edge.a, edge.b]) {
      const list = setOf.get(id);
      if (list) list.push(edge);
      else setOf.set(id, [edge]);
    }
  }

  let swapped = 0;
  for (const [id, set] of setOf) {
    if (set.length < config.exploration_min_slot) continue;

    // Deterministic per member and seed, so a run is reproducible.
    const draw = (tieBreak(seed, id, 'explore') % 10000) / 10000;
    if (draw >= config.exploration_rate) continue;

    // The weakest edge in their set is the one worth risking.
    const weakest = set[set.length - 1];
    if (!weakest) continue;

    const alternative = ordered.find((candidate) => {
      if (candidate.a !== id && candidate.b !== id) return false;
      if (takenPairs.has(pairKey(candidate.a, candidate.b))) return false;
      if (candidate.reciprocal < config.min_reciprocal_score) return false;
      const other = candidate.a === id ? candidate.b : candidate.a;
      // Capacity for the partner, counting the slot the swap is about to free.
      const freed = other === weakest.a || other === weakest.b ? 1 : 0;
      return (remaining.get(other) ?? 0) + freed > 0 && capacities.has(other);
    });
    if (!alternative) continue;

    const removeIndex = assigned.indexOf(weakest);
    if (removeIndex < 0) continue;
    assigned.splice(removeIndex, 1);
    takenPairs.delete(pairKey(weakest.a, weakest.b));
    remaining.set(weakest.a, (remaining.get(weakest.a) ?? 0) + 1);
    remaining.set(weakest.b, (remaining.get(weakest.b) ?? 0) + 1);

    if ((remaining.get(alternative.a) ?? 0) <= 0 || (remaining.get(alternative.b) ?? 0) <= 0) {
      // Putting it back is always safe: the capacity was just freed from it.
      assigned.push(weakest);
      takenPairs.add(pairKey(weakest.a, weakest.b));
      remaining.set(weakest.a, (remaining.get(weakest.a) ?? 1) - 1);
      remaining.set(weakest.b, (remaining.get(weakest.b) ?? 1) - 1);
      continue;
    }

    assigned.push(alternative);
    takenPairs.add(pairKey(alternative.a, alternative.b));
    remaining.set(alternative.a, (remaining.get(alternative.a) ?? 1) - 1);
    remaining.set(alternative.b, (remaining.get(alternative.b) ?? 1) - 1);
    swapped += 1;
  }

  return swapped;
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
        // Repair trades one edge for two, so it can raise the count while
        // quietly spending a first meeting to buy two reruns. Never worth it.
        if (displaced.fresh && !(candidate.fresh && replacement.fresh)) continue;

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
