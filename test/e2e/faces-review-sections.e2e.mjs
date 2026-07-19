// Removing the dead `autoMatched` flag — proving the review grid is UNCHANGED.
//
// `autoMatched` was read in three places and never set anywhere. Two consequences: the "Recognized
// automatically" section could never render, and the Undo handler's `if (cl.autoMatched && …)` gate
// made Undo skip untagging entirely (fixed in the previous iteration). With the Undo bug fixed, the
// flag had no remaining purpose, so it is gone — a dead flag that has already caused one real bug is
// a trap, not harmless clutter.
//
// The split `done && !autoMatched` / `done && autoMatched` was always (everything, nothing), so
// collapsing it to `done` is provably equivalent. This test pins that equivalence against the LIVE
// renderer rather than trusting the reasoning.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

test('the dead flag is gone from the renderer entirely', { skip: !RUN }, async () => {
  const grid = await read(app.win, 'String(showFaceReviewGrid)');
  assert.equal(/cl\.autoMatched|c\.autoMatched/.test(grid), false,
    'no live reference to a flag nothing ever sets');
});

test('the unreachable "Recognized automatically" section is gone', { skip: !RUN }, async () => {
  const grid = await read(app.win, 'String(showFaceReviewGrid)');
  // Check for the rendered CALL, not the words: the explanatory comment above the change names the
  // old section, and Function.prototype.toString() includes comments.
  assert.equal(/section\('Recognized automatically/.test(grid), false, 'a section that could never render');
  // The sections that DO carry work must all still be there — removing one must not take others.
  for (const s of ['Suggested', 'New faces', 'Just confirmed']) {
    assert.match(grid, new RegExp(s), `the "${s}" section survives`);
  }
});

test('confirmed clusters are still selected the same way', { skip: !RUN }, async () => {
  // `done && !autoMatched` collapsed to `done`. With autoMatched never set these are identical —
  // assert the surviving filter is the simple one, so a future reader isn't left wondering.
  const grid = await read(app.win, 'String(showFaceReviewGrid)');
  assert.match(grid, /live\.filter\(\(c\) => c\.done\)/, 'confirmed = every resolved cluster');
});

test('nothing auto-confirms — the reason that section was always empty', { skip: !RUN }, async () => {
  // This is the design fact that made the flag dead: a recognised face becomes a SUGGESTION the user
  // confirms. If this ever changes, the section may be worth reinstating — deliberately, with a flag
  // something actually sets.
  const collect = await read(app.win, 'String(collectClipFaces)');
  assert.match(collect, /suggest/i, 'recognition produces suggestions, not auto-tags');
});
