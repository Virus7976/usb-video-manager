// Audit #100 (remaining half) — the machine-managed stores were pretty-printed.
//
// `JSON.stringify(obj, null, 2)` costs 20-30% more bytes and CPU on every write, and these are the
// multi-MB ones (faces-pending, people, clip-observations) written on a debounce WHILE the user is
// clicking through a review. So the indentation was being paid for over and over, on the main
// thread, for files nobody opens by hand.
//
// config.json is the exception and stays indented: it is small, and it IS hand-edited when something
// needs unpicking. That distinction is the whole point — this is not "compact everything".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('#100 a sidecar store is written compact', async () => {
  // people.json is one of the big ones — a real person record, written the way the app writes it.
  await app.invoke('people:save', { name: 'Josiah', descriptors: [[0.1, 0.2]], thumb: '' });
  const raw = readFileSync(join(app.storeDir, 'people.json'), 'utf8');
  assert.ok(raw.length > 0, 'the store was written');
  assert.equal(/\n\s{2}"/.test(raw), false, 'no two-space indentation — this is the 20-30% saving');
  assert.deepEqual(JSON.parse(raw).length, 1, 'and it still parses to the same data');
});

test('#100 config.json stays readable, because it is the one a human opens', () => {
  const writeJsonAtomic = app.get('writeJsonAtomic');
  const target = join(app.storeDir, 'config.json');
  writeJsonAtomic(target, { intakeFolder: 'X:/intake', ai: { enabled: true } });
  const raw = readFileSync(target, 'utf8');
  assert.match(raw, /\n\s{2}"/, 'still indented');
  assert.equal(JSON.parse(raw).intakeFolder, 'X:/intake');
});

test('#100 compact and pretty round-trip to identical data', () => {
  const writeJsonAtomic = app.get('writeJsonAtomic');
  const payload = { a: [1, 2, { b: 'c' }], d: null, e: true, f: '' };
  const compact = join(app.storeDir, 'people.json');
  const pretty = join(app.storeDir, 'config.json');
  writeJsonAtomic(compact, payload);
  writeJsonAtomic(pretty, payload);
  assert.deepEqual(JSON.parse(readFileSync(compact, 'utf8')), JSON.parse(readFileSync(pretty, 'utf8')),
    'formatting is the only difference — never the data');
});
