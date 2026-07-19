// The in-app changelog (Help → What's new…). The owner asked to see what's being done to his tool
// without reading a repo, so CHANGELOG.md — already written in his language — is the source rather
// than a second list that would drift out of date.
//
// The packaging half is what this guards. `changelog:get` reads CHANGELOG.md relative to __dirname,
// which resolves inside app.asar once packed — so the handler working in dev proves nothing about
// the shipped app. If CHANGELOG.md ever falls out of build.files, the dialog is empty for every
// user and nothing else fails. That is the regression this test exists to catch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('changelog:get returns the real CHANGELOG.md text', async () => {
  const r = await app.invoke('changelog:get');
  assert.equal(r.ok, true, 'readable');
  assert.match(r.text, /^# Changelog/m, 'it is the actual changelog, not a stub');
  assert.ok(r.text.length > 500, 'has real content');
});

test('CHANGELOG.md is listed in build.files, or the shipped app shows an empty dialog', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.ok(
    pkg.build.files.includes('CHANGELOG.md'),
    'CHANGELOG.md must stay in build.files — it is read from __dirname inside app.asar'
  );
});
