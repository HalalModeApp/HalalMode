/**
 * Synthetic simulation harness.
 *
 * Exists to answer one question with numbers rather than argument: does the v1
 * scoring and fairness work actually spread exposure, and what does it cost in
 * reciprocal quality?
 *
 * Everything is seeded, so a result can be reproduced and a regression is a
 * real change rather than a bad draw.
 */

import type { MatchingConfig } from './config';
import {
  allocate,
  verifyAllocation,
  type Capacity,
  type ScoredEdge,
} from './allocate';
import {
  adjustedUtility,
  appearanceLimit,
  type WindowContext,
} from './fairness';
import {
  directionalEstimate,
  reciprocalScore,
  NO_PAIR_HISTORY,
  type MemberSignals,
  type PairHistory,
} from './estimate';
import { planRotation, type RotationCandidate } from './rotation';

/** Small deterministic PRNG. Same seed, same population, every time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimMember extends MemberSignals {
  gender: 'male' | 'female';
  tier: 'free' | 'premium';
  /**
   * The member's true, hidden propensity to be picked. The estimator never sees
   * this — it only ever observes outcomes. A heavily skewed distribution is the
   * case the old random-within-band ranking handled worst.
   */
  trueAppeal: number;
  /**
   * Position on a single hidden compatibility axis. Two members close together
   * are a good stated-preference fit, which is what the compatibility term
   * measures in production.
   */
  trait: number;
  mutualMatches: number;
  /** Rounds this member finished with no mutual match. */
  zeroMatchRounds: number;
}

export interface SimOptions {
  seed: number;
  perGender: number;
  rounds: number;
  config: MatchingConfig;
  /**
   * `baseline` reproduces the previous behaviour: random ordering within the
   * eligible pool, no fairness term. `v1` uses the scored, bounded-fairness
   * path.
   */
  strategy: 'baseline' | 'v1';
  /** Share of members on the premium tier. */
  premiumShare?: number;
  /**
   * Members on the second side. Defaults to `perGender` for a balanced pool;
   * set it lower or higher to model an imbalanced one in either direction.
   */
  femaleCount?: number;
}

export interface SimMetrics {
  rounds: number;
  members: number;
  /** 0 = perfectly even exposure, 1 = one member takes everything. */
  exposureGini: number;
  /** Share of members who never got a mutual match across the whole run. */
  zeroMatchShare: number;
  /** Mean reciprocal score of the pairs actually shown. */
  meanReciprocalQuality: number;
  /** Mean introductions received per member per round. */
  meanSetSize: number;
  /** Share of shown pairs that became mutual. */
  mutualRate: number;
  /** Largest share of all exposure taken by any single member. */
  topExposureShare: number;
  /** Mean set size among members who were served at all that round. */
  meanServedSetSize: number;
  /** Longest run of consecutive rounds any member spent deferred. */
  maxConsecutiveDeferrals: number;
}

/**
 * Standard Gini coefficient over a non-negative distribution.
 *
 * Chosen over a bespoke concentration number because it is well understood and
 * comparable across runs — the brief asks for "a simple Gini or top-share".
 */
export function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 0;

  let weighted = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    weighted += (i + 1) * sorted[i]!;
  }
  const n = sorted.length;
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

function buildPopulation(options: SimOptions): SimMember[] {
  const random = mulberry32(options.seed);
  const premiumShare = options.premiumShare ?? 0.2;
  const members: SimMember[] = [];

  for (const gender of ['male', 'female'] as const) {
    const count =
      gender === 'female' ? options.femaleCount ?? options.perGender : options.perGender;
    for (let i = 0; i < count; i += 1) {
      // Squaring pushes most members low and a few high — the concentrated
      // distribution that makes exposure fairness hard.
      const trueAppeal = 0.1 + 0.85 * Math.pow(random(), 2);
      const trait = random();
      members.push({
        id: `${gender[0]}${i}`,
        trait,
        gender,
        tier: random() < premiumShare ? 'premium' : 'free',
        trueAppeal,
        timesShown: 0,
        timesKept: 0,
        roundsSinceLastMutual: 0,
        exposuresInWindow: 0,
        roundsSinceLastServed: 0,
        introductionsPerRound: 0,
        mutualMatches: 0,
        zeroMatchRounds: 0,
      });
    }
  }
  for (const member of members) {
    member.introductionsPerRound = introductionsFor(member);
  }
  return members;
}

function introductionsFor(member: SimMember): number {
  return member.tier === 'premium' ? 10 : 5;
}

function keepsFor(member: SimMember): number {
  return member.tier === 'premium' ? 3 : 1;
}

/**
 * Runs a full multi-round simulation and reports the metric set from the brief.
 *
 * Each round: build eligible edges, score them, allocate globally, then
 * simulate picks from each member's hidden propensity and settle mutuals.
 */
export function simulate(options: SimOptions): SimMetrics {
  const { config, rounds, strategy } = options;
  const members = buildPopulation(options);
  const byId = new Map(members.map((m) => [m.id, m]));
  const men = members.filter((m) => m.gender === 'male');
  const women = members.filter((m) => m.gender === 'female');

  const shownPairs = new Map<string, number>();
  let shownEdges = 0;
  let mutualEdges = 0;
  let qualitySum = 0;
  let setSizeSum = 0;
  let setSizeCount = 0;
  let servedSetSizeSum = 0;
  let servedCount = 0;
  let maxConsecutiveDeferrals = 0;

  for (let round = 0; round < rounds; round += 1) {
    const random = mulberry32(options.seed + round * 7919);
    const window: WindowContext = {
      roundsElapsed: (round % config.exposure_window_rounds) + 1,
    };

    const toCandidate = (member: SimMember): RotationCandidate => ({
      member,
      limit: appearanceLimit(member, introductionsFor(member), config, window),
    });
    const plan =
      strategy === 'v1'
        ? planRotation(
            men.map(toCandidate),
            women.map(toCandidate),
            config,
            options.seed + round
          )
        : null;
    const isServed = (id: string) => (plan ? plan.serving.has(id) : true);

    const edges: ScoredEdge[] = [];
    for (const m of men) {
      if (!isServed(m.id)) continue;
      for (const w of women) {
        if (!isServed(w.id)) continue;
        const key = m.id < w.id ? `${m.id}|${w.id}` : `${w.id}|${m.id}`;
        const seen = shownPairs.get(key) ?? 0;
        if (seen >= config.max_pair_appearances) continue;

        // Exercise the shipped estimator rather than raw keep rates.
        //
        // This distinction matters more than it looks. Scoring straight from
        // observed keep rates produces a death spiral: a member with a poor
        // rate drops under the score floor, is excluded from every round, and
        // so never gathers the data that might lift them back out. The
        // confidence blend is what prevents that — a thin record pulls the
        // estimate back toward stated compatibility instead of toward zero.
        const compat = 1 - Math.abs(m.trait - w.trait);
        const history: PairHistory =
          seen === 0
            ? NO_PAIR_HISTORY
            : { timesShown: seen, firstReciprocalScore: null, lastReciprocalScore: null };

        const forward = directionalEstimate(compat, w, history, config);
        const backward = directionalEstimate(compat, m, history, config);
        const reciprocal = reciprocalScore(forward, backward, config);
        const decay = Math.pow(config.repeat_decay, seen);

        const utility =
          strategy === 'v1'
            ? adjustedUtility(reciprocal, m, w, config, window) * decay
            : // Baseline: no scoring, no fairness — random order within the
              // eligible pool, which is what `(band_gap, random())` amounted to.
              random();

        edges.push({ a: m.id, b: w.id, reciprocal, utility });
      }
    }

    const capacities = new Map<string, Capacity>();
    for (const member of members) {
      const base = introductionsFor(member);
      const paced =
        strategy === 'v1' ? appearanceLimit(member, base, config, window) : base;
      capacities.set(member.id, {
        limit: plan ? plan.servedLimits.get(member.id) ?? paced : paced,
      });
    }

    const result = allocate({
      edges,
      capacities,
      config,
      seed: options.seed + round,
    });
    const verdict = verifyAllocation(result, capacities);
    if (!verdict.ok) {
      throw new Error(`allocation broke an invariant: ${verdict.reason}`);
    }

    // --- Record exposure -------------------------------------------------
    const setSizes = new Map<string, number>();
    for (const edge of result.assigned) {
      const a = byId.get(edge.a)!;
      const b = byId.get(edge.b)!;
      a.timesShown += 1;
      b.timesShown += 1;
      a.exposuresInWindow += 1;
      b.exposuresInWindow += 1;
      setSizes.set(edge.a, (setSizes.get(edge.a) ?? 0) + 1);
      setSizes.set(edge.b, (setSizes.get(edge.b) ?? 0) + 1);

      const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
      shownPairs.set(key, (shownPairs.get(key) ?? 0) + 1);
      shownEdges += 1;
      qualitySum += edge.reciprocal;
    }
    for (const member of members) {
      const received = setSizes.get(member.id) ?? 0;
      setSizeSum += received;
      setSizeCount += 1;
      if (received > 0) {
        servedSetSizeSum += received;
        servedCount += 1;
        member.roundsSinceLastServed = 0;
      } else {
        member.roundsSinceLastServed += 1;
        maxConsecutiveDeferrals = Math.max(
          maxConsecutiveDeferrals,
          member.roundsSinceLastServed
        );
      }
    }

    // --- Simulate picks --------------------------------------------------
    // Each member keeps their allowance, favouring the partners with the
    // highest hidden appeal — the behaviour the estimator is trying to predict.
    const picks = new Set<string>();
    const bySide = new Map<string, ScoredEdge[]>();
    for (const edge of result.assigned) {
      for (const id of [edge.a, edge.b]) {
        const list = bySide.get(id) ?? [];
        list.push(edge);
        bySide.set(id, list);
      }
    }

    for (const member of members) {
      const offered = bySide.get(member.id) ?? [];
      const ranked = [...offered].sort((left, right) => {
        const leftOther = byId.get(left.a === member.id ? left.b : left.a)!;
        const rightOther = byId.get(right.a === member.id ? right.b : right.a)!;
        // Noise keeps this from being a perfect ordering.
        return (
          rightOther.trueAppeal + random() * 0.3 - (leftOther.trueAppeal + random() * 0.3)
        );
      });
      for (const edge of ranked.slice(0, keepsFor(member))) {
        const other = edge.a === member.id ? edge.b : edge.a;
        picks.add(`${member.id}->${other}`);
        byId.get(other)!.timesKept += 1;
      }
    }

    // --- Settle mutuals --------------------------------------------------
    const matchedThisRound = new Set<string>();
    for (const edge of result.assigned) {
      if (picks.has(`${edge.a}->${edge.b}`) && picks.has(`${edge.b}->${edge.a}`)) {
        mutualEdges += 1;
        matchedThisRound.add(edge.a);
        matchedThisRound.add(edge.b);
        byId.get(edge.a)!.mutualMatches += 1;
        byId.get(edge.b)!.mutualMatches += 1;
      }
    }

    for (const member of members) {
      if (matchedThisRound.has(member.id)) {
        member.roundsSinceLastMutual = 0;
      } else {
        member.roundsSinceLastMutual += 1;
        member.zeroMatchRounds += 1;
      }
      // Roll the exposure window forward.
      if ((round + 1) % config.exposure_window_rounds === 0) {
        member.exposuresInWindow = 0;
      }
    }
  }

  const exposures = members.map((m) => m.timesShown);
  const totalExposure = exposures.reduce((sum, v) => sum + v, 0) || 1;

  return {
    rounds,
    members: members.length,
    exposureGini: gini(exposures),
    zeroMatchShare:
      members.filter((m) => m.mutualMatches === 0).length / members.length,
    meanReciprocalQuality: shownEdges > 0 ? qualitySum / shownEdges : 0,
    meanSetSize: setSizeCount > 0 ? setSizeSum / setSizeCount : 0,
    mutualRate: shownEdges > 0 ? mutualEdges / shownEdges : 0,
    topExposureShare: Math.max(...exposures) / totalExposure,
    meanServedSetSize: servedCount > 0 ? servedSetSizeSum / servedCount : 0,
    maxConsecutiveDeferrals,
  };
}
