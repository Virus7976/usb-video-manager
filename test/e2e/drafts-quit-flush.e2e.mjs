// Audit #12 — a quit landing inside the 600 ms draft debounce lost the last renames.
//
// The renderer debounces `saveDrafts` by 600 ms. It DID already flush on beforeunload — but through
// the ASYNC `drafts:save` invoke, fired while the process is being torn down, so there was no
// guarantee main handled it before exit. Typing a name and quitting straight away lost it.
//
// Hiding to the tray was never the problem (the window is hidden, not unloaded, and the app stays
// alive to service the async invoke). QUITTING was — which is why this drives a real quit and a
// real relaunch against the same APPDATA, rather than asserting on a spy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let appData;
after(async () => { /* the second launch owns cleanup */ });

test('#12 a rename typed just before quitting survives the restart', { skip: !RUN }, async () => {
  const first = await launchApp({ seed: { 'config.json': { firstRun: false } } });
  appData = first.appData;

  // Put a clip in the renderer's state and schedule a draft save the way typing does — then quit
  // IMMEDIATELY, well inside the 600 ms debounce. Before the fix this write never landed.
  await run(first.win, `
    state.scannedFiles = [{ name: 'GX010023.MP4', size: 12345, sourcePath: 'E:/DCIM/GX010023.MP4', subject: 'josiah-skatepark' }];
    scheduleDraftSave();
  `);
  const pending = await read(first.win, 'typeof draftSaveTimer');
  assert.notEqual(pending, 'undefined', 'a debounced save really is in flight');

  await first.app.close();   // a real quit — beforeunload runs, teardown races the write

  // Relaunch against the SAME store dir and ask main what it actually persisted.
  const second = await launchApp({ appData });
  const drafts = await read(second.win, 'window.api.getDrafts()');
  const keys = Object.keys(drafts || {});
  assert.equal(keys.length, 1, `the draft was written before exit (got ${JSON.stringify(drafts)})`);
  assert.equal(drafts[keys[0]].subject, 'josiah-skatepark', 'and it is the name that was typed');

  await second.close();
});

test('#12 quitting with nothing to save writes no junk', { skip: !RUN }, async () => {
  // The blocking flush runs on every teardown, so it must be a genuine no-op when there is no work —
  // otherwise every quit would touch the store for nothing.
  const a = await launchApp({ seed: { 'config.json': { firstRun: false } } });
  await run(a.win, 'state.scannedFiles = [];');
  await a.app.close();

  const b = await launchApp({ appData: a.appData });
  const drafts = await read(b.win, 'window.api.getDrafts()');
  assert.deepEqual(Object.keys(drafts || {}), [], 'no phantom drafts from an empty session');
  await b.close();
});
