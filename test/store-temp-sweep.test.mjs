// #100: atomic-write temp files (<store>.<pid>.<n>.tmp) left by a crash between open and rename used
// to leak forever (cleanup only ran in the same-process catch). sweepStoreTemps() clears them at boot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('sweepStoreTemps removes orphaned .tmp files but keeps real stores', () => {
  const dir = app.get('STORE_DIR');
  mkdirSync(dir, { recursive: true });
  const orphan = join(dir, 'people.json.12345.7.tmp');
  const real = join(dir, 'people.json');
  writeFileSync(orphan, 'partial');
  writeFileSync(real, '[]');
  app.call('sweepStoreTemps');
  assert.equal(existsSync(orphan), false, 'the .tmp orphan is swept');
  assert.equal(existsSync(real), true, 'the real store is untouched');
});
