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
