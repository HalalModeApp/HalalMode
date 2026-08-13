/**
 * Three-way matcher benchmark.
 *
 * This is deliberately a benchmark, not production code. It runs each
 * matcher in a fresh Node process so an out-of-memory or timeout at a large
 * cohort becomes a recorded result instead of taking down the whole report.
 *
 * Run after `npm test` has emitted .test-build:
 *   node scripts/matching-benchmark.mjs
 *
 * The large runs exercise the allocation core on a shortlist-shaped graph.
 * The small end-to-end runs also exercise planRound, including estimation,
 * rotation, allocation, and structural verification. The candidate query and
 * finalization RPC are not simulated here; they are reported separately.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveConfig } = require('../.test-build/src/matching/config.js');
const { allocate, verifyAllocation } = require('../.test-build/src/matching/allocate.js');
const { planRound } = require('../.test-build/supabase/functions/generate-round/matching.js');

const SHORTLIST_SIZE = 40;
// Keep the no-argument run useful on a developer machine. The 25k/100k/200k
// stress points are explicit because they can take minutes and several GB of
// memory; the report records those runs separately.
const DEFAULT_SIZES = [455, 2_000, 5_000, 10_000];
const DEFAULT_SEED = 20260813;
const FAST = process.argv.includes('--fast');
const TRUTH_MODEL = parseFlag('--truth', 'independent');

function mix(seed) {
  let value = seed >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function unit(seed) {
  return mix(seed) / 0x1_0000_0000;
}

function textHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function memberCapacity(index) {
  return index % 5 === 0 ? 10 : 5;
}

function createMembers(count) {
  const men = Math.floor(count / 2);
  const women = count - men;
  const members = [];
  for (let index = 0; index < men; index += 1) {
    members.push({
      id: `m${index}`,
      gender: 'male',
      tier: index % 5 === 0 ? 'premium' : 'free',
      capacity: memberCapacity(index),
      trait: unit(DEFAULT_SEED + index * 7919),
      appeal: 0.1 + 0.85 * unit(DEFAULT_SEED + index * 104729),
    });
  }
  for (let index = 0; index < women; index += 1) {
    members.push({
      id: `f${index}`,
      gender: 'female',
      tier: index % 5 === 0 ? 'premium' : 'free',
      capacity: memberCapacity(index + men),
      trait: unit(DEFAULT_SEED + (index + men) * 7919),
      appeal: 0.1 + 0.85 * unit(DEFAULT_SEED + (index + men) * 104729),
    });
  }
  return { members, men, women };
}

function createEdges(count, shortlistSize = SHORTLIST_SIZE) {
  const { members, men, women } = createMembers(count);
  const edges = [];

  // The same sparse shape as the set-based snapshot: each member sees only a
  // bounded shortlist, not every opposite-side member. The stride is coprime
  // with the benchmark side sizes, so each shortlist contains unique people.
  for (let man = 0; man < men; man += 1) {
    for (let offset = 0; offset < shortlistSize; offset += 1) {
      const woman = (man * 37 + offset * 17 + 11) % women;
      const forward = 0.52 + unit(DEFAULT_SEED + man * 100003 + woman * 97) * 0.46;
      const backward = 0.52 + unit(DEFAULT_SEED + man * 97 + woman * 100003) * 0.46;
      edges.push({
        a: `m${man}`,
        b: `f${woman}`,
        reciprocal: Math.sqrt(forward * backward),
        quality: Math.sqrt(forward * backward),
        utility: Math.sqrt(forward * backward),
        fresh: true,
        forward,
        backward,
        // Independent hidden choice model. The matchers never see this.
        truthForward: hiddenPreference(members[man], members[men + woman], man, woman, 0, forward),
        truthBackward: hiddenPreference(members[men + woman], members[man], man, woman, 1, backward),
      });
    }
  }

  return { members, edges, men, women };
}

function hiddenPreference(viewer, subject, viewerIndex, subjectIndex, direction, estimated) {
  const compatibility = 1 - Math.abs(viewer.trait - subject.trait);
  const chemistry = unit(
    DEFAULT_SEED + direction * 1_000_003 + viewerIndex * 9_973 + subjectIndex * 79_429
  );
  // Independent enough to test ranking rather than simply restating the
  // matcher score, while still making stated fit matter to a real preference.
  const independent = 0.35 * subject.appeal + 0.25 * compatibility + 0.4 * chemistry;
  if (TRUTH_MODEL === 'perfect') return estimated;
  if (TRUTH_MODEL === 'aligned') return 0.85 * estimated + 0.15 * independent;
  if (TRUTH_MODEL === 'mixed') return 0.4 * estimated + 0.6 * independent;
  return independent;
}

function legacyAllocate(edges, members, seed) {
  const lists = new Map();
  const add = (id, edge, jitter) => {
    const list = lists.get(id);
    const row = { edge, jitter };
    if (list) list.push(row);
    else lists.set(id, [row]);
  };
  for (const edge of edges) {
    const jitter = unit(seed + textHash(`${edge.a}|${edge.b}`));
    add(edge.a, edge, jitter);
    add(edge.b, edge, jitter);
  }

  const selected = new Map();
  for (const member of members) {
    const list = lists.get(member.id) ?? [];
    list.sort((left, right) => left.jitter - right.jitter);
    const keep = new Set(list.slice(0, member.capacity).map((row) => row.edge));
    selected.set(member.id, keep);
  }

  return edges.filter((edge) => selected.get(edge.a)?.has(edge) && selected.get(edge.b)?.has(edge));
}

function allocationFor(algo, edges, members) {
  if (algo === 'v1') return { assigned: legacyAllocate(edges, members, DEFAULT_SEED), stats: null };
  const capacities = new Map(members.map((member) => [member.id, { limit: member.capacity }]));
  const config = resolveConfig({
    allocator: algo === 'v3' ? 'anchored_maxmin_v1' : 'greedy_global_v1',
    ...(FAST ? { exploration_rate: 0, repair_time_budget_ms: 0 } : {}),
    // Keep runtime guard warnings out of the benchmark result. The returned
    // metrics still include the measured timings and edge count.
    warn_round_latency_ms: 1_000_000_000,
    fail_round_latency_ms: 1_000_000_001,
    warn_edges_after_filter: 1_000_000_000,
    fail_edges_after_filter: 1_000_000_001,
    warn_peak_memory_bytes: 1_000_000_000_000,
    fail_peak_memory_bytes: 1_000_000_000_001,
  });
  const result = allocate({ edges, capacities, config, seed: DEFAULT_SEED });
  const verdict = verifyAllocation(result, capacities);
  if (!verdict.ok) throw new Error(`allocation invariant failed: ${verdict.reason}`);
  return { assigned: result.assigned, stats: result.stats };
}

function targetMetrics(assigned, members) {
  const byMember = new Map();
  const add = (id, edge) => {
    const list = byMember.get(id);
    if (list) list.push(edge);
    else byMember.set(id, [edge]);
  };
  for (const edge of assigned) {
    add(edge.a, edge);
    add(edge.b, edge);
  }

  const topEdge = new Map();
  const predictedTopEdge = new Map();
  const picked = new Map();
  for (const member of members) {
    const list = (byMember.get(member.id) ?? []).map((edge) => {
      const score = edge.a === member.id ? edge.truthForward : edge.truthBackward;
      return { edge, score };
    }).sort((left, right) => right.score - left.score);
    if (list[0]) topEdge.set(member.id, list[0].edge);
    const predicted = (byMember.get(member.id) ?? []).map((edge) => ({
      edge,
      score: edge.a === member.id ? edge.forward : edge.backward,
    })).sort((left, right) => right.score - left.score)[0];
    if (predicted) predictedTopEdge.set(member.id, predicted.edge);
    picked.set(member.id, new Set(list.slice(0, member.tier === 'premium' ? 3 : 1).map((row) => row.edge)));
  }

  let mutualTop = 0;
  let predictedMutualTop = 0;
  let mutualPicked = 0;
  let trueQuality = 0;
  const served = new Set();
  for (const edge of assigned) {
    served.add(edge.a);
    served.add(edge.b);
    trueQuality += Math.sqrt(edge.truthForward * edge.truthBackward);
    if (topEdge.get(edge.a) === edge && topEdge.get(edge.b) === edge) mutualTop += 1;
    if (predictedTopEdge.get(edge.a) === edge && predictedTopEdge.get(edge.b) === edge) predictedMutualTop += 1;
    if (picked.get(edge.a)?.has(edge) && picked.get(edge.b)?.has(edge)) mutualPicked += 1;
  }

  let fullSets = 0;
  let totalSetSize = 0;
  const membersWithMutualTop = new Set();
  for (const member of members) {
    const set = byMember.get(member.id) ?? [];
    totalSetSize += set.length;
    if (set.length >= member.capacity) fullSets += 1;
    const top = topEdge.get(member.id);
    if (top && topEdge.get(top.a === member.id ? top.b : top.a) === top) membersWithMutualTop.add(member.id);
  }

  return {
    assignedEdges: assigned.length,
    servedMembers: served.size,
    servedPct: served.size / members.length,
    fullSetPct: fullSets / members.length,
    meanSetSize: totalSetSize / members.length,
    mutualTopEdges: mutualTop,
    mutualTopRate: assigned.length ? mutualTop / assigned.length : 0,
    predictedMutualTopEdges: predictedMutualTop,
    predictedMutualTopRate: assigned.length ? predictedMutualTop / assigned.length : 0,
    membersWithMutualTopPct: members.length ? membersWithMutualTop.size / members.length : 0,
    mutualPickedEdges: mutualPicked,
    mutualPickedRate: assigned.length ? mutualPicked / assigned.length : 0,
    meanTrueReciprocal: assigned.length ? trueQuality / assigned.length : 0,
    capacityViolations: 0,
  };
}

function candidateMutualTopEdges(edges) {
  const topChoice = new Map();
  for (const edge of edges) {
    for (const [id, score] of [[edge.a, edge.forward], [edge.b, edge.backward]]) {
      const current = topChoice.get(id);
      if (!current || score > current.score || (score === current.score && `${edge.a}|${edge.b}` < `${current.edge.a}|${current.edge.b}`)) {
        topChoice.set(id, { edge, score });
      }
    }
  }
  return edges.filter((edge) => topChoice.get(edge.a)?.edge === edge && topChoice.get(edge.b)?.edge === edge);
}

function runWorker(algo, count, mode) {
  const started = performance.now();
  const graph = createEdges(count);
  const built = performance.now();
  let assigned;
  let allocatorStats = null;
  let planningMs = null;
  if (mode === 'e2e' && algo !== 'v1') {
    const memberRows = graph.members.map((member) => ({
      user_id: member.id,
      gender: member.gender,
      tier: member.tier,
      times_shown: 0,
      times_kept: 0,
      rounds_since_last_mutual: 0,
      rounds_since_last_served: 0,
      one_sided_pick_rate: 0,
      exposures_in_window: 0,
      introductions_per_round: member.capacity,
    }));
    const edgeRows = graph.edges.map((edge) => ({
      user_low: edge.a,
      user_high: edge.b,
      compat_low_to_high: edge.forward,
      compat_high_to_low: edge.backward,
      pair_times_shown: 0,
      pair_first_score: null,
      pair_last_score: null,
      pair_cooldown_until: null,
      pair_retired_at: null,
      pair_explicit_pass_count: 0,
      pair_soft_select_count: 0,
    }));
    const context = {
      seed: DEFAULT_SEED,
      evaluatedAt: '2026-08-13T02:30:00.000Z',
      fairnessWindow: {
        timeZone: 'Asia/Riyadh',
        startsOn: '2026-08-13',
        endsOn: '2026-08-19',
        roundsElapsed: 1,
      },
    };
    const planned = planRound(edgeRows, memberRows, resolveConfig({
      allocator: algo === 'v3' ? 'anchored_maxmin_v1' : 'greedy_global_v1',
      ...(FAST ? { exploration_rate: 0, repair_time_budget_ms: 0 } : {}),
      warn_round_latency_ms: 1_000_000_000,
      fail_round_latency_ms: 1_000_000_001,
      warn_edges_after_filter: 1_000_000_000,
      fail_edges_after_filter: 1_000_000_001,
      warn_peak_memory_bytes: 1_000_000_000_000,
      fail_peak_memory_bytes: 1_000_000_000_001,
    }), context);
    planningMs = performance.now() - built;
    const edgeLookup = new Map(graph.edges.map((edge) => [`${edge.a}|${edge.b}`, edge]));
    assigned = planned.edges.map((edge) => edgeLookup.get(`${edge.a}|${edge.b}`)).filter(Boolean);
  } else {
    const result = allocationFor(algo, graph.edges, graph.members);
    assigned = result.assigned;
    allocatorStats = result.stats;
  }
  const selected = performance.now();
  const metrics = targetMetrics(assigned, graph.members);
  const candidateMutualTop = candidateMutualTopEdges(graph.edges);
  const assignedGlobalMutualTop = assigned.filter((edge) => candidateMutualTop.includes(edge)).length;
  const finished = performance.now();
  return {
    matcher: algo,
    truthModel: TRUTH_MODEL,
    mode,
    members: count,
    shortlist: SHORTLIST_SIZE,
    candidateEdges: graph.edges.length,
    buildMs: Number((built - started).toFixed(1)),
    allocationMs: Number((selected - built - (planningMs ?? 0)).toFixed(1)),
    planningMs: planningMs === null ? undefined : Number(planningMs.toFixed(1)),
    totalMs: Number((finished - started).toFixed(1)),
    rssMb: Number((process.memoryUsage().rss / 1_048_576).toFixed(1)),
    ...metrics,
    candidatePredictedMutualTopEdges: candidateMutualTop.length,
    assignedGlobalPredictedMutualTopEdges: assignedGlobalMutualTop,
    allocatorStats,
  };
}

function parseFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv.includes('--worker')) {
  const algo = parseFlag('--matcher', 'v2');
  const count = Number(parseFlag('--members', '455'));
  const mode = parseFlag('--mode', 'core');
  try {
    process.stdout.write(`${JSON.stringify(runWorker(algo, count, mode))}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
} else {
  const requested = process.argv.includes('--members')
    ? [Number(parseFlag('--members', '455'))]
    : DEFAULT_SIZES;
  const requestedModes = process.argv.includes('--e2e-only')
    ? ['e2e']
    : process.argv.includes('--core-only')
      ? ['core']
      : ['core', 'e2e'];
  const results = [];
  const matchers = ['v1', 'v2', 'v3'];
  for (const mode of requestedModes) {
    for (const members of requested) {
      for (const matcher of matchers) {
        // The legacy path is SQL/PLpgSQL in production; the pure benchmark is
        // the fair allocation comparison. End-to-end planRound is only the
        // reciprocal V2/V3 path because V1 is not a TypeScript planner.
        if (mode === 'e2e' && matcher === 'v1') continue;
        const args = [
          '--max-old-space-size=4096',
          fileURLToPath(import.meta.url),
          '--worker',
          '--matcher', matcher,
          '--members', String(members),
          '--mode', mode,
          ...(process.argv.includes('--fast') ? ['--fast'] : []),
          '--truth', TRUTH_MODEL,
        ];
        try {
          const output = execFileSync(process.execPath, args, {
            encoding: 'utf8',
            timeout: 180_000,
            maxBuffer: 50 * 1024 * 1024,
            windowsHide: true,
          }).trim();
          results.push(JSON.parse(output));
        } catch (error) {
          results.push({
            matcher,
            mode,
            members,
            shortlist: SHORTLIST_SIZE,
            status: error?.killed ? 'timeout' : 'failed',
            error: String(error?.stderr ?? error?.message ?? error).slice(0, 500),
          });
        }
        process.stderr.write(`completed ${mode} ${matcher} ${members}\n`);
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
}
