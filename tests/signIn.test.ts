import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/**
 * Signing in with Google or Apple.
 *
 * The whole design rests on one thing: the provider hands back the same `code`
 * on the same deep link the email link has always used, so `state/auth` adopts
 * the session in exactly one place. These tests guard that, because a second
 * place that adopted a session is how you end up signed in as nobody.
 */
test('both providers come back to the address the deep-link listener watches', () => {
  const api = read('src/api/auth.ts');
  const redirect = api.match(/REDIRECT_TO = '([^']+)'/u)?.[1];
  assert.equal(redirect, 'halalmode://auth');

  const screen = read('app/auth.tsx');
  assert.match(
    screen,
    /emailRedirectTo: 'halalmode:\/\/auth'/u,
    'the email link and the provider flow must land on the same route'
  );
});

test('the session is adopted in one place only', () => {
  const api = read('src/api/auth.ts');
  // `exchangeCodeForSession` is allowed here for the native flow, which gets
  // the URL handed back rather than routed through the deep link. Anything
  // that sets a session outright is not.
  assert.doesNotMatch(api, /setSession|signInWithIdToken/u);

  const state = read('src/state/auth.tsx');
  assert.match(state, /exchangeCodeForSession/u);
});

test('both providers are offered, and named in both languages', () => {
  const screen = read('app/auth.tsx');
  assert.match(screen, /testIds\.auth\.google/u);
  assert.match(screen, /testIds\.auth\.apple/u);
  // Android has no Apple accounts; the button is hidden rather than dead.
  assert.match(screen, /Platform\.OS === 'android' \? null/u);

  const catalog = read('src/i18n/catalog.ts');
  for (const key of ['auth.continueGoogle', 'auth.continueApple', 'auth.orEmail']) {
    const hits = catalog.split(`'${key}':`).length - 1;
    assert.equal(hits, 2, `${key} must be translated in both catalogs, found ${hits}`);
  }
});
