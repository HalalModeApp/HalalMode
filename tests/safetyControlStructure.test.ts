import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

test('every server-authorized relationship surface mounts the shared safety control', () => {
  const routes = [
    'app/(tabs)/daily.tsx',
    'app/introduction/[id].tsx',
    'app/gallery/[id].tsx',
    'app/match/[id].tsx',
    'app/connection/[id]/index.tsx',
    'app/connection/[id]/questions.tsx',
    'app/connection/[id]/answers.tsx',
    'app/connection/[id]/waiting.tsx',
    'app/connection/[id]/recap.tsx',
    'app/connection/[id]/chat.tsx',
  ];
  for (const route of routes) {
    assert.match(read(route), /<SafetyControl/u, `${route} must expose the shared safety entry point`);
  }
});

test('safety actions use only server-authorized relation identifiers', () => {
  const api = read('src/api/safety.ts');
  assert.match(api, /p_connection_id: connectionId/u);
  assert.match(api, /p_introduction_id: introductionId/u);
  assert.doesNotMatch(api, /p_(blocked|subject|member)_id/u);
});

test('hiding is offered on every relationship surface and is keyed the same way', () => {
  const api = read('src/api/safety.ts');
  // Hiding removes a person permanently and in both directions, so it needs the
  // same protection as blocking: the server derives who is hidden from a
  // relationship the caller is in, never from an id the client supplies.
  assert.match(api, /hide_connection_member[\s\S]*?p_connection_id: connectionId/u);
  assert.match(api, /hide_introduction_member[\s\S]*?p_introduction_id: introductionId/u);

  const control = read('src/components/safety/SafetyControl.tsx');
  assert.match(control, /testIds\.safety\.hide/u, 'the menu must offer hiding');
  assert.match(control, /testIds\.safety\.confirmHide/u, 'hiding must be confirmed, never one tap');
});

test('hiding is described as mutual and free of blame in both languages', () => {
  const catalog = read('src/i18n/catalog.ts');
  for (const key of [
    'safety.hide',
    'safety.hideTitle',
    'safety.hideBody',
    'safety.hideConfirm',
    'safety.hideSuccessTitle',
    'safety.hideSuccessBody',
  ]) {
    // Two occurrences: the English catalog and the Arabic one. A key present
    // once has been added to English and forgotten in Arabic.
    const hits = catalog.split(`'${key}':`).length - 1;
    assert.equal(hits, 2, `${key} must be translated in both catalogs, found ${hits}`);
  }
});
