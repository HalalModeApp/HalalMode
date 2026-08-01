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
    exposuresInWindow: 0,
    introductionsPerRound: 5,
    ...overrides,
  };
}

/** Mid-window: a free member should have had 5 x 4 = 20 exposures by now. */
const window: WindowContext = { roundsElapsed: 4 };

function edge(a: string, b: string, reciprocal: number, utility = reciprocal): ScoredEdge {
  return { a, b, reciprocal, quality: reciprocal, utility };
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

test('the repair pass fills sets that greedy left short', () => {
  const edges = [
    edge('a', 'x', 0.9),
    edge('b', 'y', 0.85),
    edge('c', 'x', 0.8),
    edge('a', 'z', 0.7),
  ];
  const caps = capacities([
    ['a', 1],
    ['b', 1],
    ['c', 1],
    ['x', 1],
    ['y', 1],
    ['z', 1],
  ]);

  const result = allocate({ edges, capacities: caps, config, seed: 2 });
  assert.equal(result.assigned.length, 3);
  assert.equal(result.stats.repairSwaps, 1, 'the test must exercise a real repair');
  const involved = new Set(result.assigned.flatMap((e) => [e.a, e.b]));
  assert.ok(involved.has('c'), 'the under-served member should be repaired in');
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
