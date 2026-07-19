// Audit #67 — the faces-pending store was re-serialized and fsync'd on a 700 ms debounce DURING a scan.
//
// `writeJsonAtomic` uses writeSync + fsyncSync, so every one of those saves blocks the MAIN process —
// previews and copy progress stall with it. A save fires after each clip, so a 250-clip scan pays it
// 250 times. Measured 2026-07-18 on a realistic post-#66 store (crops already externalised, but the
// 128-float descriptors are still inline): 250 clusters = 3.1 MB, ~13 ms just to serialise, before
// the synchronous write.
//
// The fix coalesces far harder while scanning and flushes when the scan ends. It is safe HERE
// because faces-pending is DERIVED data — the worst case after a crash is re-scanning some clips,
// not lost footage and not lost names.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

test('#67 saves coalesce far harder while a scan is running', { skip: !RUN }, async () => {
  await run(app.win, 'faceScanActive = false;');
  const idle = await read(app.win, 'PENDING_SAVE_MS()');
  await run(app.win, 'faceScanActive = true;');
  const scanning = await read(app.win, 'PENDING_SAVE_MS()');
  await run(app.win, 'faceScanActive = false;');

  assert.equal(idle, 700, 'interactive edits still save promptly');
  assert.ok(scanning >= 5000, `a scan coalesces much harder (got ${scanning}ms)`);
  assert.ok(scanning > idle, 'and strictly harder than idle');
});

test('#67 the review grid stays responsive to edits — the idle path is untouched', { skip: !RUN }, async () => {
  // The dangerous direction: applying the coarse interval everywhere would make the review grid feel
  // like it loses work, because a user edit would sit unsaved for 8 seconds.
  assert.equal(await read(app.win, 'faceScanActive'), false, 'not scanning by default');
  assert.equal(await read(app.win, 'PENDING_SAVE_MS()'), 700);
});

test('#67 the scan flushes on exit, so nothing is left unsaved', { skip: !RUN }, async () => {
  // With an 8 s debounce a write can still be pending when the scan ends. The finally must flush,
  // or coarsening the interval would turn a performance fix into data loss.
  const src = await read(app.win, 'String(scanFacesForClips)');
  assert.match(src, /faceScanActive = false;/, 'scan mode is left');
  assert.match(src, /savePendingNow\(/, 'and the pending review is flushed on the way out');
});

test('#67 the saver actually consults the interval (not a stale 700 literal)', { skip: !RUN }, async () => {
  const src = await read(app.win, 'String(schedulePendingSave)');
  assert.match(src, /PENDING_SAVE_MS\(\)/, 'the debounce is computed per save');
  assert.equal(/, 700\)/.test(src), false, 'the hardcoded 700 is gone');
});
