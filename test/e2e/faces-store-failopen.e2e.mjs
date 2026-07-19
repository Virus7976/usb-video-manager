// Audit #10 — a FAILED load of the face stores became an empty in-memory list that the next save
// wrote over the real one.
//
//   try { faceScenes = (await window.api.getFaceScenes()) || []; } catch { faceScenes = []; }
//   _scenesLoaded = true;                     // <- latched even though the load FAILED
//
// So one rejected IPC turned into "there are no group shots", and because the latch was set it never
// retried — the next saveFaceScenesNow() replaced every saved group shot with []. loadPendingFaces()
// had the identical `catch { list = []; }`.
//
// This is the SAME SHAPE as the 2026-07-09 store-read-failure data loss already in AGENTS.md
// (readJsonRetry returning null for both "absent" and "corrupt", so a truncated people.json read as a
// fresh install and the next save wrote [] over the user's face database). Main got a
// `storeReadFailed` latch that refuses to write; these two renderer-side loads never did.
//
// NOTE main's storeReadFailed already covers the CORRUPT-FILE case — this closes the remaining hole,
// an IPC-level failure, where main's store is perfectly healthy and would happily accept the wipe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

// Two real group shots already on record from earlier cards.
const SEEDED_SCENES = [
  { clipKey: 'a.mp4__100', name: 'a.mp4', img: 'file:///tmp/one.jpg', w: 1100, h: 620, faces: [{ descriptor: [0.1, 0.2], box: { x: 1, y: 2, width: 3, height: 4 } }, { descriptor: [0.3, 0.4], box: { x: 5, y: 6, width: 7, height: 8 } }] },
  { clipKey: 'b.mp4__200', name: 'b.mp4', img: 'file:///tmp/two.jpg', w: 1100, h: 620, faces: [{ descriptor: [0.5, 0.6], box: { x: 1, y: 2, width: 3, height: 4 } }, { descriptor: [0.7, 0.8], box: { x: 5, y: 6, width: 7, height: 8 } }] },
];
const SEEDED_PENDING = [
  { thumb: 'file:///tmp/f1.jpg', descriptor: [0.1, 0.2], descriptors: [], clipKeys: ['a.mp4__100'], suggest: null, rejected: false, done: false, skipped: false, assignedName: '' },
  { thumb: 'file:///tmp/f2.jpg', descriptor: [0.3, 0.4], descriptors: [], clipKeys: ['b.mp4__200'], suggest: null, rejected: false, done: false, skipped: false, assignedName: '' },
];

let app;
before(async () => {
  if (!RUN) return;
  app = await launchApp({
    seed: {
      'config.json': { firstRun: false },
      'face-scenes.json': SEEDED_SCENES,
      'faces-pending.json': SEEDED_PENDING,
    },
  });
});
after(async () => { if (app) await app.close(); });

test('#10 a failed SCENES load must not let the next save wipe the store', { skip: !RUN }, async () => {
  assert.equal((await read(app.win, 'window.api.getFaceScenes()')).length, 2, 'two group shots on record');

  // Reproduce the post-failure state exactly: the load threw, so the in-memory list is empty.
  // Before the fix the latch was set here too, and saving replaced both real scenes with [].
  await run(app.win, '_scenesLoaded = false; _scenesLoadFailed = true; faceScenes = [];');
  await run(app.win, 'saveFaceScenesNow();');
  await app.win.waitForTimeout(300);

  const after = await read(app.win, 'window.api.getFaceScenes()');
  assert.equal(after.length, 2, 'the real group shots survive — an empty session never overwrites them');
});

test('#10 a failed PENDING load must not let the next save wipe the store', { skip: !RUN }, async () => {
  assert.equal((await read(app.win, 'window.api.getPendingFaces()')).length, 2, 'two pending faces on record');

  await run(app.win, '_pendingLoadFailed = true;');
  await run(app.win, 'savePendingNow([]);');
  await app.win.waitForTimeout(300);

  const after = await read(app.win, 'window.api.getPendingFaces()');
  assert.equal(after.length, 2, 'unreviewed faces from other cards survive');
});

test('#10 a HEALTHY load still saves normally (the guard is not a blanket refusal)', { skip: !RUN }, async () => {
  // The dangerous direction: if this breaks, face review silently stops persisting anything.
  await run(app.win, `
    _scenesLoaded = true; _scenesLoadFailed = false;
    faceScenes = [${JSON.stringify(SEEDED_SCENES[0])}];
    saveFaceScenesNow();
  `);
  await app.win.waitForTimeout(300);
  const after = await read(app.win, 'window.api.getFaceScenes()');
  assert.equal(after.length, 1, 'a genuine save still writes through');
  assert.equal(after[0].clipKey, 'a.mp4__100');
});
