/**
 * Does the allocator hold up when the pool is an awkward shape?
 *
 * Deliberately measures nothing that depends on guessing who fancies whom.
 * Every property here is checkable without a preference model:
 *
 *   reciprocity   if she is in his set he must be in hers
 *   capacity      nobody exceeds their own limit
 *   coverage      how many members get anything at all
 *   fairness      the gap between the most and least shown member
 *   termination   it finishes, on shapes that make greedy algorithms loop
 *
 * The shapes are the ones that actually break matchers in the wild: a pool
 * with far more men than women, a pool too small to have choices, shortlists
 * too thin to fill a set, and everyone chasing the same handful of people.
 */
import { createRequire } from 'node:module';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { resolveConfig } = require('../.test-build/src/matching/config.js');
const { allocate } = require('../.test-build/src/matching/allocate.js');

const SEED = 20260813;
const unit = (n) => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * @param shape.men            how many men
 * @param shape.women          how many women
 * @param shape.shortlist      candidates offered to each man
 * @param shape.concentration  0 = shortlists spread evenly, 1 = everyone is
 *                             pointed at the same few women
 */
function build({ men, women, shortlist, concentration = 0 }) {
  const capacities = new Map();
  const cap = (i) => (i % 5 === 0 ? 10 : 5);
  for (let i = 0; i < men; i += 1) capacities.set(`m${i}`, { limit: cap(i) });
  for (let i = 0; i < women; i += 1) capacities.set(`f${i}`, { limit: cap(i + men) });

  const edges = [];
  const hotspot = Math.max(1, Math.floor(women * 0.05));
  for (let man = 0; man < men; man += 1) {
    for (let offset = 0; offset < shortlist; offset += 1) {
      // Concentration pulls a share of every shortlist into the top 5% of women.
      const spread = (man * 37 + offset * 17 + 11) % women;
      const crowded = (man * 13 + offset * 7) % hotspot;
      const woman = unit(SEED + man * 31 + offset) < concentration ? crowded : spread;

      const forward = 0.52 + unit(SEED + man * 100003 + woman * 97) * 0.46;
      const backward = 0.52 + unit(SEED + man * 97 + woman * 100003) * 0.46;
      const reciprocal = Math.sqrt(forward * backward);
      edges.push({
        a: `m${man}`, b: `f${woman}`,
        reciprocal, quality: reciprocal, utility: reciprocal,
        fresh: true, forward, backward,
      });
    }
  }
  // Deduplicate: concentration can point two offsets at the same woman.
  const seen = new Set();
  const unique = edges.filter((e) => {
    const key = `${e.a}|${e.b}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { capacities, edges: unique };
}

function audit(assigned, capacities) {
  const setOf = new Map();
  for (const id of capacities.keys()) setOf.set(id, new Set());
  for (const edge of assigned) {
    setOf.get(edge.a)?.add(edge.b);
    setOf.get(edge.b)?.add(edge.a);
  }

  // Reciprocity: every appearance must be answered by the other side.
  let oneSided = 0;
  for (const [id, set] of setOf) {
    for (const other of set) if (!setOf.get(other)?.has(id)) oneSided += 1;
  }

  let overCapacity = 0;
  let served = 0;
  const sizes = [];
  for (const [id, set] of setOf) {
    if (set.size > (capacities.get(id)?.limit ?? 0)) overCapacity += 1;
    if (set.size > 0) served += 1;
    sizes.push(set.size);
  }
  sizes.sort((x, y) => x - y);

  return {
    servedPct: served / capacities.size,
    meanSet: sizes.reduce((s, v) => s + v, 0) / (sizes.length || 1),
    // The gap that decides whether anybody feels left out.
    leastShown: sizes[0] ?? 0,
    medianShown: sizes[Math.floor(sizes.length / 2)] ?? 0,
    mostShown: sizes[sizes.length - 1] ?? 0,
    emptyHanded: sizes.filter((s) => s === 0).length,
    oneSided,
    overCapacity,
  };
}

const SHAPES = [
  { name: 'balanced 2000',        men: 1000, women: 1000, shortlist: 40 },
  { name: 'lopsided 4:1',         men: 1600, women: 400,  shortlist: 40 },
  { name: 'severely lopsided 9:1', men: 1800, women: 200, shortlist: 40 },
  { name: 'tiny pool',            men: 10,   women: 10,   shortlist: 8 },
  { name: 'thin shortlists',      men: 1000, women: 1000, shortlist: 3 },
  { name: 'everyone wants the same few', men: 1000, women: 1000, shortlist: 40, concentration: 0.8 },
  { name: 'empty pool',           men: 0,    women: 0,    shortlist: 0 },
];

const results = [];
for (const shape of SHAPES) {
  for (const allocator of ['greedy_global_v1', 'stable_rounds_v1']) {
    const { capacities, edges } = build(shape);
    const config = resolveConfig({ allocator, exploration_rate: 0, repair_time_budget_ms: 0 });
    const started = performance.now();
    let result;
    let error = null;
    try {
      result = allocate({ edges, capacities, config, seed: SEED });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const ms = performance.now() - started;
    results.push({
      shape: shape.name,
      allocator: allocator === 'stable_rounds_v1' ? 'V4' : 'V2',
      ms: Math.round(ms),
      error,
      ...(result ? audit(result.assigned, capacities) : {}),
    });
  }
}

const pad = (v, n) => String(v).padStart(n);
console.log('shape                          matcher  served%  mean  least  med  most  empty  1-sided  over-cap  ms');
for (const r of results) {
  if (r.error) {
    console.log(`${r.shape.padEnd(30)} ${r.allocator.padEnd(7)}  THREW: ${r.error}`);
    continue;
  }
  console.log(
    r.shape.padEnd(30),
    r.allocator.padEnd(7),
    pad((r.servedPct * 100).toFixed(1), 7),
    pad(r.meanSet.toFixed(2), 5),
    pad(r.leastShown, 6),
    pad(r.medianShown, 4),
    pad(r.mostShown, 5),
    pad(r.emptyHanded, 6),
    pad(r.oneSided, 8),
    pad(r.overCapacity, 9),
    pad(r.ms, 5),
  );
}

const broken = results.filter((r) => r.error || r.oneSided > 0 || r.overCapacity > 0);
console.log(broken.length === 0
  ? '\nOK: no one-sided edges, no capacity violations, nothing threw.'
  : `\nFAILURES: ${broken.length}`);
if (broken.length > 0) process.exitCode = 1;
