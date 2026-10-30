// The version must be the same in the three places that use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../js/version.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('version is consistent across app, package.json and service worker', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('package.json')).version, APP_VERSION);
  assert.match(read('sw.js'), new RegExp(`const VERSION = 'clipcut-${APP_VERSION.replace(/\./g, '\\.')}'`));
});
