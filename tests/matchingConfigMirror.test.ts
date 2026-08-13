import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  algorithmVersionForConfig,
  DEFAULT_MATCHING_CONFIG,
  MATCHER_V2_ALGORITHM_VERSION,
  MATCHER_V3_ALGORITHM_VERSION,
  resolveStoredConfig,
} from '../src/matching/config';

/**
 * The database and this module are two mirrors of one contract, and they have
 * drifted apart twice.
 *
 * Migration 0068 was written because `matching_config` sat empty for four
 * versions while the code carried the real defaults — the app behaved correctly
 * and the recorded configuration described none of it. The second drift was the
 * reverse: the stored configuration grew the graded scorer's keys, the mirror
 * here grew the allocator's, and neither learned the other's. Nothing failed,
 * because `resolveStoredConfig` only runs inside the edge function, and the
 * deployed copy predated both. It would have thrown on the first round after a
 * redeploy.
 *
 * Both were invisible to a passing test suite and to a clean migration run.
 * This is the check that would have caught either on the commit that caused it.
 */

// Anchored on the repo root rather than __dirname: the suite runs from a
// compiled copy under .test-build, which has no migrations beneath it.
const MIGRATIONS = path.join(process.cwd(), 'supabase', 'migrations');

/** The configuration the database would actually serve: the newest one written. */
function latestStoredConfig(): { file: string; params: Record<string, unknown> } {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const file of [...files].reverse()) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const start = sql.indexOf('$config$');
    if (start < 0) continue;
    const end = sql.indexOf('$config$', start + 8);
    assert.ok(end > start, `${file} opens a $config$ block without closing it`);
    return { file, params: JSON.parse(sql.slice(start + 8, end)) as Record<string, unknown> };
  }
  throw new Error('no migration writes a matching configuration');
}

test('the stored configuration and the code mirror hold exactly the same keys', () => {
  const { file, params } = latestStoredConfig();
  const stored = Object.keys(params).sort();
  const code = Object.keys(DEFAULT_MATCHING_CONFIG).sort();

  assert.deepEqual(
    stored.filter((k) => !code.includes(k)),
    [],
    `${file} stores keys this module does not declare — resolveStoredConfig would reject the live config`
  );
  assert.deepEqual(
    code.filter((k) => !stored.includes(k)),
    [],
    `this module declares keys ${file} does not store — those knobs cannot be tuned without a deploy`
  );
});

test('the edge function can read the stored configuration', () => {
  // The assertion that matters: this is the exact call generate-round makes on
  // every run, against the exact payload the database would hand it.
  const { params } = latestStoredConfig();
  assert.doesNotThrow(() => resolveStoredConfig(params));
});

test('the stored values are the ones the code would have chosen', () => {
  const { params } = latestStoredConfig();
  const resolved = resolveStoredConfig(params);

  // Not a requirement in general — the database is allowed to diverge, that is
  // the point of tuning it. But every divergence should be deliberate, so this
  // pins the ones that exist today and will fail loudly on an accidental one.
  assert.deepEqual(resolved, DEFAULT_MATCHING_CONFIG);
});

test('the two matcher labels are deterministic and reversible', () => {
  assert.equal(algorithmVersionForConfig({ allocator: 'greedy_global_v1' }), MATCHER_V2_ALGORITHM_VERSION);
  assert.equal(algorithmVersionForConfig({ allocator: 'anchored_maxmin_v1' }), MATCHER_V3_ALGORITHM_VERSION);
});
