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
