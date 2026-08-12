import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { DEFAULT_MATCHING_CONFIG } from '../src/matching/config.ts';
import { planRound } from '../supabase/functions/generate-round/matching.ts';

/**
 * The round planner, on the data that killed it.
 *
 * A shadow run against 53 real members recorded its candidate snapshot — 660
 * possible pairings, 431 after filtering — and then stopped. No pairs, no
 * error, twice. Errors are recorded when they are thrown, so a blank error
 * means the process never got to throw one.
 *
 * The two database calls either side of it answer in about a second, and the
 * existing simulation runs 300 members through the allocator happily. What had
 * never been exercised was this function, on rows the database actually
 * produced. So that is what this does: the real 53 members and 431 edges,
 * captured from the run that died, replayed here where a hang is visible.
 */
// Resolved from the working directory rather than __dirname: the tests run
// from .test-build, where the fixtures do not follow.
const FIXTURES = resolve(process.cwd(), 'tests/fixtures');
const members = JSON.parse(readFileSync(resolve(FIXTURES, 'real-members.json'), 'utf8'));
const edges = JSON.parse(readFileSync(resolve(FIXTURES, 'real-edges.json'), 'utf8'));

const context = {
  seed: 20260812,
  evaluatedAt: '2026-08-12T02:30:00.000Z',
  fairnessWindow: {
    timeZone: 'Asia/Riyadh' as const,
    startsOn: '2026-08-12',
    endsOn: '2026-08-18',
    roundsElapsed: 1,
  },
};

test('the planner finishes on the data that stopped it in production', () => {
  const started = Date.now();
  const plan = planRound(edges, members, DEFAULT_MATCHING_CONFIG, context);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 10_000, `planning took ${elapsed}ms, which is not a plan, it is a hang`);
  assert.ok(plan.edges.length > 0, 'a pool of 53 with 431 candidate pairs must produce introductions');

  // Reciprocity is structural: if A is shown B, B is shown A. The planner
  // returns one row per pair, so this checks the pair is well formed rather
  // than counting both directions.
  for (const edge of plan.edges) {
    assert.notEqual(edge.a, edge.b, 'nobody is introduced to themselves');
  }

  const shown = new Map<string, number>();
  for (const edge of plan.edges) {
    shown.set(edge.a, (shown.get(edge.a) ?? 0) + 1);
    shown.set(edge.b, (shown.get(edge.b) ?? 0) + 1);
  }
  for (const [id, count] of shown) {
    assert.ok(count <= 5, `${id} was given ${count} introductions, above the free tier limit`);
  }
});
