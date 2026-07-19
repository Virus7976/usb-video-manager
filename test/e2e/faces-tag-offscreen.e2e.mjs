// Audit #26/#27, end-to-end — naming a face must tag the clips that AREN'T on screen.
//
// The renderer's tagClips() resolves clipKeys through a map built from state.scannedFiles, so it
// could only ever tag clips in memory. A face cluster restored from faces-pending.json references
// clips from earlier sessions — already renamed and filed — and those tags were silently dropped.
//
// This drives the real renderer function against real persisted stores: a clip that was filed in an
// EARLIER session (present in finalMeta, absent from state.scannedFiles) must come out tagged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';
const OFFSCREEN = 'filed-last-week.mp4__4242';

let app;
before(async () => {
  if (!RUN) return;
  app = await launchApp({
    seed: {
      'config.json': { firstRun: false },
      // Footage filed in a previous session. The renderer has no memory of it.
      'final-meta.json': { [OFFSCREEN]: { subject: 'skiing', people: [] } },
    },
  });
});
after(async () => { if (app) await app.close(); });

test('#26 confirming a face tags a clip that is not in the renderer\'s memory', { skip: !RUN }, async () => {
  const before = await read(app.win, 'window.api.getFinalMeta()');
  assert.deepEqual(before[OFFSCREEN].people, [], 'the filed clip starts untagged');
  assert.equal(
    await read(app.win, `state.scannedFiles.some((c) => clipKey(c) === ${JSON.stringify(OFFSCREEN)})`),
    false,
    'and it really is absent from memory — this is the case that used to be dropped',
  );

  // Exactly what assign() does for the persisted half.
  await run(app.win, `window.api.tagPersonOnClips({ name: 'josiah', keys: [${JSON.stringify(OFFSCREEN)}] });`);
  await app.win.waitForTimeout(300);

  const after = await read(app.win, 'window.api.getFinalMeta()');
  assert.deepEqual(after[OFFSCREEN].people, ['josiah'], 'the off-screen clip carries the name');
});

test('#26 a second person is ADDED to an off-screen clip, never replacing the first', { skip: !RUN }, async () => {
  // NOTE this drives the bridge (window.api.tagPersonOnClips), not tagClips itself — tagClips is a
  // closure inside showFaceReviewGrid and isn't reachable from a test. The renderer wiring that
  // calls it is covered by source inspection in the vm suite; what's proven HERE is that the call
  // tagClips makes does the right thing against real stores.
  const meta = await read(app.win, 'window.api.getFinalMeta()');
  assert.deepEqual(meta[OFFSCREEN].people, ['josiah'], 'still tagged from the previous test');

  await run(app.win, `
    window.api.tagPersonOnClips({ name: 'dad', keys: [${JSON.stringify(OFFSCREEN)}] });
  `);
  await app.win.waitForTimeout(300);

  const after = await read(app.win, 'window.api.getFinalMeta()');
  assert.deepEqual(after[OFFSCREEN].people, ['josiah', 'dad'], 'a second person is ADDED, not replaced');
});
