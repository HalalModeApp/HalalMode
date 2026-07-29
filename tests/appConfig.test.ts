import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type AppConfig = {
  expo?: {
    runtimeVersion?: { policy?: string };
    scheme?: string;
  };
};

test('native updates are tied to an explicitly versioned runtime', () => {
  const config = JSON.parse(readFileSync(resolve(process.cwd(), 'app.json'), 'utf8')) as AppConfig;
  assert.equal(config.expo?.runtimeVersion?.policy, 'appVersion');
  assert.equal(config.expo?.scheme, 'halalmode');
});
