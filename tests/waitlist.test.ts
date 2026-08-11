import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { AGE_RANGES } from '../src/lib/waitlistOptions';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/**
 * The waitlist is the one surface anybody on the internet can post to, so what
 * it accepts is written down twice — once in TypeScript for the buttons, once
 * in SQL as a constraint. Two copies of one list is exactly the shape that has
 * already drifted twice in this repo, so it gets a test rather than a comment.
 */
test('the age ranges offered match the ones the database accepts', () => {
  const migration = read('supabase/migrations/0093_waitlist.sql');
  const check = migration.match(/age_range in \(([^)]+)\)/u);
  const listed = check?.[1];
  assert.ok(listed, 'the table should constrain age_range to a fixed list');

  const fromSql = listed
    .split(',')
    .map((v) => v.trim().replace(/^'|'$/gu, ''))
    .filter(Boolean);

  assert.deepEqual(
    [...AGE_RANGES].sort(),
    [...new Set(fromSql)].sort(),
    'a range offered on the page and refused by the database is a dead button'
  );
});

test('the waitlist table is unreachable from the API', () => {
  const migration = read('supabase/migrations/0093_waitlist.sql');
  // Not an RLS policy: the table lives outside `public`, so PostgREST cannot
  // see it at all. That is a stronger guarantee than a policy, and the reason
  // this test checks the schema rather than the grants.
  assert.match(
    migration,
    /create table if not exists halal_mode_private\.waitlist/u,
    'the list of addresses must not live in a schema the API can reach'
  );
  assert.match(migration, /revoke all on halal_mode_private\.waitlist/u);
  assert.match(
    migration,
    /grant execute on function public\.join_waitlist\(text, text, text, text\) to anon/u,
    'joining has to work before anyone has an account'
  );
});

test('the summary reports counts and never an address', () => {
  const migration = read('supabase/migrations/0094_waitlist_summary.sql');
  assert.doesNotMatch(
    migration.replace(/^--.*$/gmu, ''),
    /select[\s\S]*?\bemail\b[\s\S]*?from halal_mode_private\.waitlist/u,
    'the summary must aggregate, never select the address column'
  );
  assert.match(
    migration,
    /grant execute on function public\.waitlist_summary_service\(\) to service_role/u
  );
});

test('the landing page reaches the server through the one open function', () => {
  const api = read('src/api/waitlist.ts');
  assert.match(api, /rpc\('join_waitlist'/u);
  // Lowercased and trimmed before it leaves, so the same person signing up from
  // two devices is one row rather than two.
  assert.match(api, /\.trim\(\)\.toLowerCase\(\)/u);

  const screen = read('app/join.tsx');
  assert.match(screen, /testIds\.join\.submit/u);
  assert.match(screen, /testIds\.join\.success/u);
});

test('the public page is reachable without an account', () => {
  const gate = read('src/state/auth.tsx');
  // It is the page a domain points at: a visitor who has never signed in must
  // land on it rather than be bounced to a sign-in screen for an app they have
  // not heard of yet.
  assert.match(gate, /rootSegment === 'join'/u);
  assert.match(gate, /if \(inJoin\) return;/u);
});

test('the waitlist speaks both languages', () => {
  const catalog = read('src/i18n/catalog.ts');
  for (const key of [
    'join.title', 'join.body', 'join.formTitle', 'join.email', 'join.city',
    'join.ageRange', 'join.submit', 'join.privacyNote',
    'join.successTitle', 'join.successBody',
  ]) {
    const hits = catalog.split(`'${key}':`).length - 1;
    assert.equal(hits, 2, `${key} must be translated in both catalogs, found ${hits}`);
  }
});
