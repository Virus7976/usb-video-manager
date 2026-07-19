// Pending AI questions must be re-bound to clips whenever state.scannedFiles is REPLACED.
//
// The queue stores each question against a stable clipKey precisely because an index is not stable —
// src/mod/04-tasks-ai.js says so outright: "Persisted by clipKey (name__size), NEVER by clipIndex. An
// index is a position in state.scannedFiles — it does not survive a rescan, and restoring by index
// would silently re-attach 'is this a new category?' to a completely different clip."
//
// The CARD scan honours that: it calls restoreAiQuestions() after building scannedFiles. The PHONE
// entry (enterRenameWithPhoneFiles, used by both the fresh pull and the resume) replaces
// scannedFiles wholesale and never did — it restored drafts and nothing else.
//
// The harm is silent and lands on footage: analyze a card with "Ask me to confirm" on, go Home, then
// pull or resume phone media. The badge still shows the old questions, the review renders each row
// from state.scannedFiles[q.clipIndex] — now a PHONE clip — and pressing Apply writes those answers
// onto it. Wrong clip, wrong name, no error.
//
// Also covered: restoreAiQuestions() early-returned when the SAVED queue was empty, which left a
// stale in-memory queue intact. "Nothing saved" must mean "nothing pending", not "keep what you had".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

test('the phone entry re-binds the question queue, like the card scan does', { skip: !RUN }, async () => {
  const src = await read(app.win, 'String(enterRenameWithPhoneFiles)');
  assert.match(src, /restoreAiQuestions\(\)/,
    'replacing scannedFiles without re-resolving questions re-attaches them to whatever sits at the old index');
});

test('an empty saved queue CLEARS the in-memory one', { skip: !RUN }, async () => {
  await run(app.win, `
    state.scannedFiles = [{ name: 'a.mp4', size: 1, mtimeMs: 1, subject: '', description: '' }];
    aiQuestions = [{ id: 'stale', type: 'subject', clipIndex: 0, suggested: 'left over' }];
  `);
  await read(app.win, 'window.api.saveAiQueue([])');
  await read(app.win, 'restoreAiQuestions()');
  assert.equal(await read(app.win, 'aiQuestions.length'), 0,
    '"nothing saved" must mean "nothing pending", not "keep the stale queue"');
});

test('a question whose clip is no longer loaded is DROPPED, not re-pointed', { skip: !RUN }, async () => {
  // The core invariant: resolve by key, and if that clip is gone the question has nothing to ask about.
  await run(app.win, `state.scannedFiles = [{ name: 'kept.mp4', size: 10, mtimeMs: 5, subject: '', description: '' }];`);
  await read(app.win, `window.api.saveAiQueue([
    { type: 'subject', clipKey: 'kept.mp4__10__5', field: '', suggested: 'keep-me', rule: '' },
    { type: 'subject', clipKey: 'vanished.mp4__99__7', field: '', suggested: 'drop-me', rule: '' }
  ])`);
  await read(app.win, 'restoreAiQuestions()');
  const kept = await read(app.win, 'aiQuestions.map((q) => q.suggested)');
  assert.deepEqual(kept, ['keep-me'], 'the question about a clip that is not here is dropped');
});

test('a LEGACY-keyed question still resolves after the #8 key change', { skip: !RUN }, async () => {
  // aiQueue was the FIFTH clip-keyed store and the #8 migration missed it, so entries written before
  // today carry `name__size`. Resolving only the new form would silently drop every one of them.
  await run(app.win, `state.scannedFiles = [{ name: 'old.mp4', size: 42, mtimeMs: 77, subject: '', description: '' }];`);
  await read(app.win, `window.api.saveAiQueue([{ type: 'subject', clipKey: 'old.mp4__42', field: '', suggested: 'legacy', rule: '' }])`);
  await read(app.win, 'restoreAiQuestions()');
  assert.deepEqual(await read(app.win, 'aiQuestions.map((q) => q.suggested)'), ['legacy'],
    'a pre-migration question still finds its clip');
});

test('a restored question points at the clip it was ABOUT, not at its old position', { skip: !RUN }, async () => {
  // Same clip, different index after the rescan. Binding by index would answer the wrong clip.
  await run(app.win, `state.scannedFiles = [
    { name: 'first.mp4', size: 1, mtimeMs: 1, subject: '', description: '' },
    { name: 'target.mp4', size: 20, mtimeMs: 9, subject: '', description: '' }
  ];`);
  await read(app.win, `window.api.saveAiQueue([{ type: 'subject', clipKey: 'target.mp4__20__9', field: '', suggested: 'x', rule: '' }])`);
  await read(app.win, 'restoreAiQuestions()');
  const name = await read(app.win, 'state.scannedFiles[aiQuestions[0].clipIndex].name');
  assert.equal(name, 'target.mp4', 'resolved by key to the right clip');
});
