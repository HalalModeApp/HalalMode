import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MATCHING_CONFIG, resolveConfig } from '../src/matching/config';
import {
  allocate,
  compareEdges,
  pairKey,
  tieBreak,
  verifyAllocation,
  type Capacity,
  type ScoredEdge,
} from '../src/matching/allocate';
import {
  adjustedUtility,
  appearanceLimit,
  exposureNeed,
  fairnessBoost,
  noMatchNeed,
  type WindowContext,
} from '../src/matching/fairness';
import type { MemberSignals } from '../src/matching/estimate';

const config = DEFAULT_MATCHING_CONFIG;

function member(overrides: Partial<MemberSignals> = {}): MemberSignals {
  return {
    id: 'm',
    timesShown: 0,
    timesKept: 0,
    roundsSinceLastMutual: 0,
    roundsSinceLastServed: 0,
    oneSidedPickRate: 0,
    exposuresInWindow: 0,
    introductionsPerRound: 5,
    ...overrides,
  };
}

/** Mid-window: a free member should have had 5 x 4 = 20 exposures by now. */
const window: WindowContext = { roundsElapsed: 4 };

// Fresh by default: these exercise ordering and capacity, and a pool of edges
// nobody has been shown is the ordinary case. The freshness rule has its own
// tests below.
function scored(a: string, b: string, value: number, fresh = true): ScoredEdge {
  return { a, b, reciprocal: value, quality: value, utility: value, fresh };
}

function edge(
  a: string,
  b: string,
  reciprocal: number,
  utility = reciprocal,
  fresh = true
): ScoredEdge {
  return { a, b, reciprocal, quality: reciprocal, utility, fresh };
}

function capacities(entries: [string, number][]): Map<string, Capacity> {
  return new Map(entries.map(([id, limit]) => [id, { limit }]));
}

// --- Fairness bounds -------------------------------------------------------

test('the fairness boost can never exceed its cap', () => {
  const starved = member({ exposuresInWindow: 0, roundsSinceLastMutual: 999 });
  assert.equal(fairnessBoost(starved, starved, config, window), config.boost_cap);
});

test('fairness reorders comparable edges but cannot cross a real quality gap', () => {
  const starved = member({ exposuresInWindow: 0, roundsSinceLastMutual: 999 });
  const satisfied = member({ exposuresInWindow: 99, roundsSinceLastMutual: 0 });

  const boostedWeak = adjustedUtility(0.4, starved, starved, config, window);
  const unboostedStrong = adjustedUtility(0.8, satisfied, satisfied, config, window);

  assert.ok(boostedWeak <= 0.5 + 1e-9, 'a 0.40 edge cannot exceed 0.50 when boosted');
  assert.ok(
    unboostedStrong > boostedWeak,
    'no exposure need should let a weak edge outrank a clearly stronger one'
  );

  const ordered = [
    edge('weak', 'w', 0.64, adjustedUtility(0.64, starved, starved, config, window)),
    edge('strong', 's', 0.79, adjustedUtility(0.79, satisfied, satisfied, config, window)),
  ].sort(compareEdges(1, config.quality_band_width));
  assert.equal(ordered[0]?.a, 'strong', 'fairness cannot cross raw-quality bands');

  const comparable = [
    edge('need', 'n', 0.701, adjustedUtility(0.701, starved, starved, config, window)),
    edge('ahead', 'a', 0.724, adjustedUtility(0.724, satisfied, satisfied, config, window)),
  ].sort(compareEdges(1, config.quality_band_width));
  assert.equal(comparable[0]?.a, 'need', 'fairness may reorder edges inside one band');
});

test('exposure need is measured against pace, not an absolute total', () => {
  // A free member four rounds into the window is owed 20 exposures.
  assert.equal(exposureNeed(member({ exposuresInWindow: 0 }), config, window), 1);
  assert.equal(exposureNeed(member({ exposuresInWindow: 20 }), config, window), 0);
  assert.equal(exposureNeed(member({ exposuresInWindow: 999 }), config, window), 0);
  assert.equal(exposureNeed(member({ exposuresInWindow: 10 }), config, window), 0.5);
});

test('fair share follows each tier entitlement rather than one flat number', () => {
  const free = member({ introductionsPerRound: 5, exposuresInWindow: 20 });
  const premium = member({ introductionsPerRound: 10, exposuresInWindow: 20 });

  // Both have had 20 exposures, but the premium member is owed twice as many,
  // so only they are still behind.
  assert.equal(exposureNeed(free, config, window), 0);
  assert.equal(exposureNeed(premium, config, window), 0.5);
});

test('the no-match term saturates rather than growing without bound', () => {
  assert.equal(noMatchNeed(member({ roundsSinceLastMutual: 0 }), config), 0);
  assert.equal(noMatchNeed(member({ roundsSinceLastMutual: 8 }), config), 1);
  assert.equal(noMatchNeed(member({ roundsSinceLastMutual: 500 }), config), 1);
});

test('members ahead of pace get a tighter allowance, never zero', () => {
  const fair = member({ exposuresInWindow: 20 });
  const heavy = member({ exposuresInWindow: 60 });

  assert.equal(appearanceLimit(fair, 5, config, window), 5);
  const tightened = appearanceLimit(heavy, 5, config, window);
  assert.ok(tightened < 5, 'a heavily exposed member should be throttled');
  assert.ok(tightened >= 1, 'nobody is frozen out of a round entirely');
});

// --- Determinism -----------------------------------------------------------

test('tie-breaking is deterministic and order-independent', () => {
  assert.equal(tieBreak(7, 'alice', 'bob'), tieBreak(7, 'bob', 'alice'));
  assert.notEqual(tieBreak(7, 'alice', 'bob'), tieBreak(8, 'alice', 'bob'));
});

test('the same seed and inputs produce an identical round', () => {
  const edges = [
    edge('a', 'x', 0.5),
    edge('a', 'y', 0.5),
    edge('b', 'x', 0.5),
    edge('b', 'y', 0.5),
  ];
  const caps = capacities([
    ['a', 1],
    ['b', 1],
    ['x', 1],
    ['y', 1],
  ]);

  const first = allocate({ edges, capacities: caps, config, seed: 42 });
  const second = allocate({ edges, capacities: caps, config, seed: 42 });

  assert.deepEqual(
    first.assigned.map((e) => pairKey(e.a, e.b)),
    second.assigned.map((e) => pairKey(e.a, e.b))
  );
});

test('equal-utility edges sort by seeded hash, not input order', () => {
  const edges = [edge('a', 'x', 0.5), edge('b', 'y', 0.5)];
  const forward = [...edges].sort(compareEdges(11));
  const reversed = [...edges].reverse().sort(compareEdges(11));
  assert.deepEqual(forward, reversed);
});

// --- Core allocation invariants -------------------------------------------

test('capacity is never exceeded on either side', () => {
  const edges = [
    edge('a', 'x', 0.9),
    edge('a', 'y', 0.8),
    edge('a', 'z', 0.7),
    edge('b', 'x', 0.6),
  ];
  const caps = capacities([
    ['a', 2],
    ['b', 2],
    ['x', 1],
    ['y', 1],
    ['z', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 1 });
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });

  const counts = new Map<string, number>();
  for (const e of result.assigned) {
    counts.set(e.a, (counts.get(e.a) ?? 0) + 1);
    counts.set(e.b, (counts.get(e.b) ?? 0) + 1);
  }
  assert.ok((counts.get('a') ?? 0) <= 2);
  assert.ok((counts.get('x') ?? 0) <= 1);
});

test('the score floor holds even when both members are starving for exposure', () => {
  const edges = [edge('a', 'x', config.min_reciprocal_score - 0.01, 5)];
  const caps = capacities([
    ['a', 5],
    ['x', 5],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 1 });
  assert.equal(result.assigned.length, 0, 'an edge below the floor must never be shown');
  assert.equal(result.stats.rejectedBelowFloor, 1);
});

test('a thin pool yields a smaller set rather than weak filler', () => {
  // One member wants five introductions; only two qualified partners exist.
  const edges = [edge('a', 'x', 0.7), edge('a', 'y', 0.6)];
  const caps = capacities([
    ['a', 5],
    ['x', 5],
    ['y', 5],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 3 });
  assert.equal(result.assigned.length, 2);
  assert.equal(result.shortfalls.get('a'), 3, 'the shortfall is reported, not filled');
});

test('no pair is ever assigned twice in one round', () => {
  const edges = [edge('a', 'x', 0.9), edge('x', 'a', 0.9)];
  const caps = capacities([
    ['a', 5],
    ['x', 5],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 5 });
  assert.equal(result.assigned.length, 1);
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });
});

test('higher utility is preferred when capacity is contested', () => {
  const edges = [edge('a', 'x', 0.9), edge('a', 'y', 0.2)];
  const caps = capacities([
    ['a', 1],
    ['x', 1],
    ['y', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 9 });
  assert.equal(result.assigned.length, 1);
  assert.equal(result.assigned[0]?.b, 'x');
});

// --- Repair ----------------------------------------------------------------

test('the repair pass augments with edges in the displaced edge quality band', () => {
  const edges = [
    edge('a', 'x', 0.824),
    edge('c', 'x', 0.816),
    edge('a', 'z', 0.808),
  ];
  const caps = capacities([
    ['a', 1],
    ['c', 1],
    ['x', 1],
    ['z', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 2 });
  assert.equal(result.assigned.length, 2);
  assert.equal(result.stats.repairSwaps, 1, 'the test must exercise a real repair');
  const involved = new Set(result.assigned.flatMap((e) => [e.a, e.b]));
  assert.ok(involved.has('c'), 'the under-served member should be repaired in');
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });
});

test('repair cannot trade one strong edge for two weak lower-band edges', () => {
  const cappedWeakUtility = 0.4 * (1 + config.boost_cap);
  const edges = [
    edge('a', 'x', 0.8),
    edge('c', 'x', 0.4, cappedWeakUtility),
    edge('a', 'z', 0.4, cappedWeakUtility),
  ];
  const caps = capacities([
    ['a', 1],
    ['c', 1],
    ['x', 1],
    ['z', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 2 });

  assert.equal(result.stats.repairSwaps, 0);
  assert.deepEqual(result.assigned.map((assigned) => pairKey(assigned.a, assigned.b)), ['a|x']);
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });
});

test('repair respects its time budget instead of stalling a round', () => {
  const edges = Array.from({ length: 200 }, (_, i) => edge(`a${i}`, `b${i}`, 0.5));
  const caps = capacities(
    edges.flatMap((e) => [
      [e.a, 1] as [string, number],
      [e.b, 1] as [string, number],
    ])
  );

  // A clock that is already past the deadline on first read.
  let ticks = 0;
  const result = allocate({
    edges,
    capacities: caps,
    config: resolveConfig({ repair_time_budget_ms: 0 }),
    seed: 4,
    now: () => (ticks += 1_000_000),
  });

  assert.ok(result.stats.repairTimedOut, 'an exhausted budget must stop the pass');
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });
});

// --- Verification ----------------------------------------------------------

test('verification rejects a round that breaks capacity', () => {
  const caps = capacities([
    ['a', 1],
    ['x', 1],
    ['y', 1],
  ]);
  const broken = {
    assigned: [edge('a', 'x', 0.9), edge('a', 'y', 0.9)],
    shortfalls: new Map<string, number>(),
    stats: {
      consideredEdges: 2,
      assignedEdges: 2,
      rejectedBelowFloor: 0,
      repeatEdges: 0,
      anchoredMembers: 0,
      exploratorySlots: 0,
      compositionSwaps: 0,
      repairSwaps: 0,
      repairTimedOut: false,
    },
  };

  const verdict = verifyAllocation(broken, caps);
  assert.equal(verdict.ok, false);
});

test('verification rejects a self-pair', () => {
  const caps = capacities([['a', 5]]);
  const verdict = verifyAllocation(
    {
      assigned: [edge('a', 'a', 0.9)],
      shortfalls: new Map(),
      stats: {
        consideredEdges: 1,
        assignedEdges: 1,
        rejectedBelowFloor: 0,
        repeatEdges: 0,
        anchoredMembers: 0,
        exploratorySlots: 0,
        compositionSwaps: 0,
        repairSwaps: 0,
        repairTimedOut: false,
      },
    },
    caps
  );
  assert.equal(verdict.ok, false);
});

// --- Scenario: exposure concentration --------------------------------------

test('fairness spreads exposure without collapsing match quality', () => {
  // Twenty members a side. Every pair is eligible, but one man and one woman
  // are far more appealing, which is exactly the concentration the old
  // random-within-band ranking could not counteract.
  const men = Array.from({ length: 20 }, (_, i) => `m${i}`);
  const women = Array.from({ length: 20 }, (_, i) => `w${i}`);

  const signals = new Map<string, MemberSignals>();
  for (const id of [...men, ...women]) {
    const popular = id === 'm0' || id === 'w0';
    signals.set(
      id,
      member({
        id,
        timesShown: 40,
        timesKept: popular ? 34 : 8,
        exposuresInWindow: popular ? 40 : 2,
        roundsSinceLastMutual: popular ? 0 : 9,
        introductionsPerRound: 5,
      })
    );
  }

  const edges: ScoredEdge[] = [];
  for (const m of men) {
    for (const w of women) {
      const a = signals.get(m)!;
      const b = signals.get(w)!;
      const reciprocal = Math.sqrt(
        (a.timesKept / a.timesShown) * (b.timesKept / b.timesShown)
      );
      edges.push({
        a: m,
        b: w,
        reciprocal,
        fresh: true,
        quality: reciprocal,
        utility: adjustedUtility(reciprocal, a, b, config, window),
      });
    }
  }

  const caps = capacities([...men, ...women].map((id) => [id, 5]));
  const result = allocate({ edges, capacities: caps, config, seed: 77 });
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });

  const counts = new Map<string, number>();
  for (const e of result.assigned) {
    counts.set(e.a, (counts.get(e.a) ?? 0) + 1);
    counts.set(e.b, (counts.get(e.b) ?? 0) + 1);
  }

  const served = [...men, ...women].filter((id) => (counts.get(id) ?? 0) > 0);
  assert.equal(served.length, 40, 'every qualified member should get a genuine shot');

  const mean =
    result.assigned.reduce((sum, e) => sum + e.reciprocal, 0) / result.assigned.length;
  assert.ok(mean > 0.15, `mean reciprocal quality collapsed: ${mean}`);
});

// --- Anchored max-min ------------------------------------------------------

test('the anchor pass gives every member with an option at least one edge', () => {
  // Two hubs everyone wants, and a long tail of weaker but valid pairs. Plain
  // greedy fills the hubs first and leaves the tail with nothing.
  const config = resolveConfig({ allocator: 'anchored_maxmin_v1' });
  const edges: ScoredEdge[] = [];
  for (let i = 0; i < 12; i += 1) {
    edges.push(scored(`m${i}`, 'hubW', 0.9));
    edges.push(scored(`w${i}`, 'hubM', 0.9));
    edges.push(scored(`m${i}`, `w${i}`, 0.4));
  }
  const caps = capacities([
    ['hubW', 2] as [string, number],
    ['hubM', 2] as [string, number],
    ...Array.from({ length: 12 }, (_, i) => [`m${i}`, 2] as [string, number]),
    ...Array.from({ length: 12 }, (_, i) => [`w${i}`, 2] as [string, number]),
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 21 });
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });

  const served = new Set(result.assigned.flatMap((edge) => [edge.a, edge.b]));
  for (let i = 0; i < 12; i += 1) {
    assert.ok(served.has(`m${i}`), `m${i} received nothing`);
    assert.ok(served.has(`w${i}`), `w${i} received nothing`);
  }
  assert.ok(result.stats.anchoredMembers > 0, 'anchors should have been placed');
});

test('anchoring never breaks capacity or reciprocity', () => {
  const config = resolveConfig({ allocator: 'anchored_maxmin_v1' });
  const edges = [
    scored('a', 'x', 0.9),
    scored('a', 'y', 0.8),
    scored('b', 'x', 0.7),
    scored('b', 'y', 0.6),
  ];
  const caps = capacities([
    ['a', 1],
    ['b', 1],
    ['x', 1],
    ['y', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 5 });
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });
  assert.equal(result.assigned.length, 2, 'both sides pair off exactly once');
});

test('the anchor pass respects the score floor', () => {
  // A member whose only option is below the floor gets nothing, rather than the
  // guarantee overriding the one rule fairness may never cross.
  const config = resolveConfig({ allocator: 'anchored_maxmin_v1' });
  const edges = [scored('a', 'x', config.min_reciprocal_score - 0.01)];
  const caps = capacities([
    ['a', 5],
    ['x', 5],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 5 });
  assert.equal(result.assigned.length, 0);
  assert.equal(result.stats.anchoredMembers, 0);
});

test('the allocator choice is deterministic and reversible', () => {
  const edges = [scored('a', 'x', 0.6), scored('a', 'y', 0.5), scored('b', 'x', 0.4)];
  const caps = capacities([
    ['a', 2],
    ['b', 2],
    ['x', 2],
    ['y', 2],
  ]);
  const anchored = resolveConfig({ allocator: 'anchored_maxmin_v1' });

  const first = allocate({ edges, capacities: caps, config: anchored, seed: 3 });
  const second = allocate({ edges, capacities: caps, config: anchored, seed: 3 });
  assert.deepEqual(
    first.assigned.map((edge) => pairKey(edge.a, edge.b)),
    second.assigned.map((edge) => pairKey(edge.a, edge.b))
  );

  // Greedy remains the default, so switching allocator is a config change with
  // no residue in either direction.
  const greedy = allocate({ edges, capacities: caps, config: resolveConfig(), seed: 3 });
  assert.equal(greedy.stats.anchoredMembers, 0);
});

// --- Exploration -----------------------------------------------------------

test('exploration never touches a small set', () => {
  // Below the minimum slot there is no position to spare: every edge in the
  // set is one of the member's strongest.
  const config = resolveConfig({ exploration_rate: 1 });
  const edges = [scored('a', 'x', 0.9), scored('a', 'y', 0.8), scored('a', 'z', 0.7)];
  const caps = capacities([
    ['a', 3],
    ['x', 1],
    ['y', 1],
    ['z', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 4 });
  assert.equal(result.stats.exploratorySlots, 0);
});

test('exploration is off when the rate is zero', () => {
  const config = resolveConfig({ exploration_rate: 0 });
  const edges = Array.from({ length: 8 }, (_, i) => scored('a', `p${i}`, 0.9 - i * 0.05));
  const caps = capacities([
    ['a', 6],
    ...Array.from({ length: 8 }, (_, i) => [`p${i}`, 1] as [string, number]),
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 4 });
  assert.equal(result.stats.exploratorySlots, 0);
});

test('exploration keeps capacity and reciprocity intact', () => {
  const config = resolveConfig({ exploration_rate: 1, exploration_min_slot: 2 });
  const edges: ScoredEdge[] = [];
  for (let i = 0; i < 10; i += 1) {
    edges.push(scored('a', `p${i}`, 0.9 - i * 0.05));
    edges.push(scored('b', `p${i}`, 0.85 - i * 0.05));
  }
  const caps = capacities([
    ['a', 4],
    ['b', 4],
    ...Array.from({ length: 10 }, (_, i) => [`p${i}`, 2] as [string, number]),
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 9 });
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });
});

test('an exploratory swap still respects the score floor', () => {
  // The only alternative is below the floor, so the weakest edge is kept.
  const config = resolveConfig({ exploration_rate: 1, exploration_min_slot: 2 });
  const edges = [
    scored('a', 'x', 0.9),
    scored('a', 'y', 0.8),
    scored('a', 'z', config.min_reciprocal_score - 0.01),
  ];
  const caps = capacities([
    ['a', 3],
    ['x', 1],
    ['y', 1],
    ['z', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 4 });
  for (const edge of result.assigned) {
    assert.ok(
      edge.reciprocal >= config.min_reciprocal_score,
      'exploration must never place an edge below the floor'
    );
  }
});

test('exploration is deterministic for a given seed', () => {
  const config = resolveConfig({ exploration_rate: 0.5, exploration_min_slot: 2 });
  const edges = Array.from({ length: 10 }, (_, i) => scored('a', `p${i}`, 0.9 - i * 0.04));
  const caps = capacities([
    ['a', 5],
    ...Array.from({ length: 10 }, (_, i) => [`p${i}`, 1] as [string, number]),
  ]);

  const first = allocate({ edges, capacities: caps, config, seed: 31 });
  const second = allocate({ edges, capacities: caps, config, seed: 31 });
  assert.deepEqual(
    first.assigned.map((e) => pairKey(e.a, e.b)).sort(),
    second.assigned.map((e) => pairKey(e.a, e.b)).sort()
  );
  assert.equal(first.stats.exploratorySlots, second.stats.exploratorySlots);
});

// --- Composition -----------------------------------------------------------

function directional(a: string, b: string, forward: number, backward: number): ScoredEdge {
  const reciprocal = Math.sqrt(forward * backward);
  return { a, b, reciprocal, quality: reciprocal, utility: reciprocal, forward, backward, fresh: true };
}

test('Matcher V3 anchors a mutual first choice ahead of a stronger one-sided edge', () => {
  const config = resolveConfig({ allocator: 'anchored_maxmin_v1' });
  const edges = [
    // A is predicted to prefer B, while X is predicted to prefer Y. A-X is
    // globally stronger, but it is not either member's mutual first choice.
    directional('a', 'x', 0.7, 0.99),
    directional('a', 'b', 0.8, 0.8),
    directional('x', 'y', 1, 0.2),
  ];
  const caps = capacities([
    ['a', 1],
    ['b', 1],
    ['x', 1],
    ['y', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 44 });
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });
  assert.ok(
    result.assigned.some((edge) => pairKey(edge.a, edge.b) === pairKey('a', 'b')),
    'the mutual first-choice edge should survive the anchor pass'
  );
  assert.ok(
    !result.assigned.some((edge) => pairKey(edge.a, edge.b) === pairKey('a', 'x')),
    'the globally stronger but one-sided edge should not displace it'
  );
  assert.ok(result.stats.anchoredMembers >= 2);
});

test('composition leaves alone a member whose picks are returned', () => {
  const config = resolveConfig();
  const edges = [
    directional('a', 'x', 0.9, 0.2),
    directional('a', 'y', 0.9, 0.2),
    directional('a', 'z', 0.9, 0.2),
    directional('a', 'w', 0.5, 0.5),
  ];
  const caps = capacities([
    ['a', 4],
    ['x', 1],
    ['y', 1],
    ['z', 1],
    ['w', 1],
  ]);

  // No history of unreturned picks, so nothing is adjusted however lopsided
  // the set happens to be.
  const result = allocate({ edges, capacities: caps, config, seed: 6 });
  assert.equal(result.stats.compositionSwaps, 0);
});

test('a member who never gets picked back keeps some reaches, not all', () => {
  const config = resolveConfig();
  const edges = [
    directional('a', 'x', 0.9, 0.1),
    directional('a', 'y', 0.9, 0.1),
    directional('a', 'z', 0.9, 0.1),
    directional('a', 'p', 0.5, 0.5),
    directional('a', 'q', 0.5, 0.5),
  ];
  const caps = capacities([
    ['a', 3],
    ['x', 1],
    ['y', 1],
    ['z', 1],
    ['p', 1],
    ['q', 1],
  ]);

  const result = allocate({
    edges,
    capacities: caps,
    config,
    seed: 6,
    oneSidedRates: new Map([['a', 0.95]]),
  });
  assert.deepEqual(verifyAllocation(result, caps), { ok: true });

  const set = result.assigned.filter((e) => e.a === 'a' || e.b === 'a');
  const reaches = set.filter(
    (e) => (e.forward ?? 0) - (e.backward ?? 0) >= config.reach_gap_threshold
  );
  assert.ok(reaches.length <= config.max_reach_edges, 'excess reaches should be traded');
  assert.ok(reaches.length > 0, 'nobody is stopped from aiming high entirely');
});

test('composition never trades below the score floor', () => {
  const config = resolveConfig();
  const edges = [
    directional('a', 'x', 0.9, 0.1),
    directional('a', 'y', 0.9, 0.1),
    directional('a', 'z', 0.9, 0.1),
    // The only even alternative is beneath the floor, so no trade is available.
    directional('a', 'p', 0.05, 0.05),
  ];
  const caps = capacities([
    ['a', 3],
    ['x', 1],
    ['y', 1],
    ['z', 1],
    ['p', 1],
  ]);

  const result = allocate({
    edges,
    capacities: caps,
    config,
    seed: 6,
    oneSidedRates: new Map([['a', 1]]),
  });
  for (const edge of result.assigned) {
    assert.ok(edge.reciprocal >= config.min_reciprocal_score);
  }
});

test('a fresh member is never treated as over-reaching', () => {
  // No history means no bias. Someone new, or someone who has just changed
  // their profile, starts clean rather than carrying an old inference.
  const config = resolveConfig();
  const edges = [
    directional('a', 'x', 0.9, 0.1),
    directional('a', 'y', 0.9, 0.1),
    directional('a', 'z', 0.9, 0.1),
    directional('a', 'p', 0.5, 0.5),
  ];
  const caps = capacities([
    ['a', 3],
    ['x', 1],
    ['y', 1],
    ['z', 1],
    ['p', 1],
  ]);

  const result = allocate({
    edges,
    capacities: caps,
    config,
    seed: 6,
    oneSidedRates: new Map([['a', 0]]),
  });
  assert.equal(result.stats.compositionSwaps, 0);
});

test('edges without directional data are never counted as reaches', () => {
  // The estimator may not have supplied both directions. Absent evidence must
  // not be read as evidence of over-reaching.
  const config = resolveConfig();
  const edges = [scored('a', 'x', 0.9), scored('a', 'y', 0.9), scored('a', 'z', 0.9)];
  const caps = capacities([
    ['a', 3],
    ['x', 1],
    ['y', 1],
    ['z', 1],
  ]);

  const result = allocate({
    edges,
    capacities: caps,
    config,
    seed: 6,
    oneSidedRates: new Map([['a', 1]]),
  });
  assert.equal(result.stats.compositionSwaps, 0);
});

// --- Novelty against repetition ---------------------------------------------
//
// There is no freshness rule in the allocator. Novelty is priced into the score
// upstream: planRound multiplies a pair's quality and utility by repeat_decay
// once per showing, so a repeat arrives here already handicapped. These build
// that handicap by hand to pin where the balance actually falls.

// Both quality and utility carry the decay in production, and the comparator
// reads quality first — so a helper that decays only one of them would be
// testing something the allocator never sees.
function repeat(a: string, b: string, raw: number, showings: number): ScoredEdge {
  const decay = Math.pow(DEFAULT_MATCHING_CONFIG.repeat_decay, showings);
  return { a, b, reciprocal: raw, quality: raw * decay, utility: raw * decay, fresh: false };
}

function unseen(a: string, b: string, raw: number): ScoredEdge {
  return { a, b, reciprocal: raw, quality: raw, utility: raw, fresh: true };
}

test('a genuinely strong repeat still beats a weak fresh pair', () => {
  const config = resolveConfig();
  const strongRepeat = repeat('a', 'x', 0.9, 1);
  const weakFresh = unseen('a', 'y', 0.4);

  const result = allocate({
    edges: [strongRepeat, weakFresh],
    capacities: capacities([['a', 1], ['x', 1], ['y', 1]]),
    config,
    seed: 1,
  });

  // 0.9 x 0.7 = 0.63, comfortably above 0.4. Ranking on freshness outright
  // would hand this slot to the weaker pair, which helps nobody.
  assert.deepEqual(result.assigned.map((e) => e.b), ['x']);
  assert.equal(result.stats.repeatEdges, 1);
});

test('a middling repeat loses to a fresh pair it barely outscores', () => {
  const config = resolveConfig();
  const result = allocate({
    edges: [
      repeat('a', 'x', 0.5, 1),
      unseen('a', 'y', 0.4),
    ],
    capacities: capacities([['a', 1], ['x', 1], ['y', 1]]),
    config,
    seed: 1,
  });

  // 0.5 x 0.7 = 0.35, under 0.4. A repeat has to be about 1.4x better than the
  // fresh alternative to hold its slot, and about 2x after a second showing.
  assert.deepEqual(result.assigned.map((e) => e.b), ['y']);
  assert.equal(result.stats.repeatEdges, 0);
});

test('the handicap compounds, so a twice-shown pair has to be far better', () => {
  const config = resolveConfig();
  const result = allocate({
    edges: [
      repeat('a', 'x', 0.8, 2),
      unseen('a', 'y', 0.45),
    ],
    capacities: capacities([['a', 1], ['x', 1], ['y', 1]]),
    config,
    seed: 1,
  });

  // 0.8 x 0.49 = 0.39. Strong on paper, and still beaten by a fresher 0.45.
  assert.deepEqual(result.assigned.map((e) => e.b), ['y']);
});

test('repeats take the slots novelty leaves empty', () => {
  const config = resolveConfig();
  const result = allocate({
    edges: [
      repeat('a', 'x', 0.5, 1),
      unseen('a', 'y', 0.4),
    ],
    capacities: capacities([['a', 2], ['x', 1], ['y', 1]]),
    config,
    seed: 1,
  });

  assert.equal(result.assigned.length, 2, 'a thin round is filled rather than left short');
  assert.equal(result.assigned[0]?.b, 'y', 'but the fresh pair leads');
  assert.equal(result.stats.repeatEdges, 1);
});
