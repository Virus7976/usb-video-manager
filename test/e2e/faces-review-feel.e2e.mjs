// The face-review screen felt broken at scale. Owner, mid-pass on a 4594-clip card with 4263 left:
// "if I click a face it shoots me up randomly to a random spot near the top of the list… every click
// takes forever to register… it all glitches… stuff shifts around… it doesn't auto close popups so
// if I forget to click off it brings me back to that popup after every click."
//
// One root cause under most of it: every click calls render(), which replaces `scroll.innerHTML`
// wholesale. Replacing the contents of a scrolled container resets scrollTop to 0, the browser then
// restores *something* as content reflows, and a `scrollIntoView({behavior:'smooth'})` fired on top
// of that. At 4500 clips this is the difference between a usable pass and an unusable one.
//
// SCOPE OF THIS TEST, stated honestly: these assert against the LIVE renderer's own function source
// (the house pattern in faces-review-sections.e2e.mjs) — they pin that the fixes are present and
// cannot be silently reverted. They do NOT prove the felt behaviour; that needs a real review grid
// with seeded clusters, and ultimately the owner's own eyes on a real card. Treat green here as
// "the fix is still wired", not "the screen feels right".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
let src;
before(async () => {
  if (!RUN) return;
  app = await launchApp({ seed: { 'config.json': { firstRun: false } } });
  src = await read(app.win, 'String(showFaceReviewGrid)');
});
after(async () => { if (app) await app.close(); });

test('render() preserves scroll position across the innerHTML rebuild', { skip: !RUN }, async () => {
  assert.match(src, /const keepTop = scroll\.scrollTop/, 'position captured before the rebuild');
  assert.match(src, /scroll\.scrollTop = keepTop/, 'and restored after it');
});

test('the popup no longer smooth-scrolls on every click', { skip: !RUN }, async () => {
  // `block:'nearest'` already no-ops when the element is visible — but `behavior:'smooth'` animated
  // even that no-op, which is what read as being thrown somewhere random.
  // Match the CALL, not the word: Function.prototype.toString() includes comments, and the comment
  // explaining this fix necessarily says "smooth" — the same trap faces-review-sections.e2e.mjs
  // documents. Asserting on the bare word made this test fail against correct code.
  assert.equal(/scrollIntoView\([^)]*smooth/.test(src), false, 'no smooth scrollIntoView left in the review grid');
  assert.match(src, /getBoundingClientRect/, 'it only scrolls when the popup is genuinely off-screen');
});

test('naming a face closes the popup', { skip: !RUN }, async () => {
  // Every naming path (suggestion chip, typed name, Enter, confirm-all) funnels through assign(),
  // so the close belongs there once rather than at four call sites.
  assert.match(src, /for \(const s of faceScenes\) s\._sel = null;\s*\n\s*render\(\);/,
    'assign() clears the scene selection before re-rendering');
});

test('suggestion chips are ranked by use, not store order', { skip: !RUN }, async () => {
  assert.match(src, /function rankedNames\(\)/, 'a ranking function exists');
  assert.equal(/names\.slice\(0, 8\)/.test(src), false, 'the raw insertion-order slice is gone');
  assert.match(src, /rankedNames\(\)\.slice\(0, 8\)/, '"who is this?" chips are ranked');
  assert.match(src, /const others = rankedNames\(\)/, 'the CORRECTION chips are ranked too');
  assert.match(src, /recentNames/, 'session recency feeds the ranking');
});

test('a selection-only click does not write the faces store', { skip: !RUN }, async () => {
  // render() called schedulePendingSave() unconditionally, so opening or closing the naming popup —
  // which only toggles `s._sel`, a field _serializePending deliberately drops — queued a full
  // re-serialize and disk write of the whole faces store for ZERO net change. With hundreds of
  // clusters that is real main-thread work on every click, and it is part of why the screen felt
  // like "every click takes forever to register". Audit #67 coalesced these during a SCAN; this is
  // the same cost during the REVIEW, which that fix never covered.
  assert.match(src, /function render\(opts\)/, 'render takes a persist flag');
  assert.match(src, /const persist = !opts \|\| opts\.persist !== false/, 'defaulting to persist');
  assert.match(src, /if \(persist\) \{ schedulePendingSave\(clusters\); saveFaceScenesNow\(\); \}/,
    'the store write is gated');
  // Both selection-only paths must opt out, and nothing else may.
  const optOuts = src.match(/render\(\{ persist: false \}\)/g) || [];
  assert.equal(optOuts.length, 2, 'exactly the two selection-only renders skip the write');
});


test('renaming a person onto a taken name offers a MERGE, not a duplicate', { skip: !RUN }, async () => {
  // Main refuses the rename and reports `name-exists`; the renderer must turn that into an
  // actionable choice rather than a silent no-op. Merging combines the two enrolment sets, which is
  // what actually fixes the split — but it deletes the source record, so it is confirmed, never
  // automatic. Declining must put the input back so the field matches reality.
  const src = await read(app.win, 'String(showPeopleManager)');
  assert.match(src, /reason === 'name-exists'/, 'the refusal is handled, not ignored');
  assert.match(src, /mergePerson\(\{ fromId: selId, intoId: r\.existingId \}\)/, 'and offers the merge that fixes it');
  assert.match(src, /nameInp\.value = old/, 'declining restores the field');
});

test('the compress dialog is usable again after a CANCELLED or partly-failed run', { skip: !RUN }, async () => {
  // The throw path put the dialog back so the run could be retried; the RESOLVED path never did —
  // and "resolved" covers a cancelled run and a run with per-file failures, which are exactly the
  // cases where you want to retry the remainder. Cancel a 50-clip run at clip 3 and the checkboxes,
  // preset picker, output picker and Compress button were all dead, so the only way to continue was
  // to close and reopen, losing the selection and preset.
  //
  // The re-enable belongs in the `finally` — a dialog left disabled after the run has ENDED is never
  // right, whichever way it ended. Unhiding Run stays conditional on there being work left.
  const src = await read(app.win, 'String(openCompress)');
  // Slice to the END of the finally block, not a fixed window — a generous window runs straight past
  // it into the `if (err)` branch, which DOES re-enable, and the assertion then passes for the wrong
  // reason. (Caught exactly that on the first run of this test.)
  const start = src.indexOf('} finally {');
  assert.ok(start > 0, 'the run has a finally');
  const fin = src.slice(start, src.indexOf('\n    }', start));
  assert.match(fin, /disabled = false/,
    'the inputs are re-enabled in the FINALLY, so a cancelled or partly-failed run leaves a usable dialog');
  assert.equal(/disabled = false/.test(src.slice(src.indexOf('if (err) {'))), false,
    'and it is no longer ONLY in the error branch');
});
