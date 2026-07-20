// TIER 2 #23 — the face review has no keyboard at all, so 458 pending faces is 458 mouse trips.
//
// The Tier 1 gate is met: a shoot can now go card→filed in one sitting (2026-07-19bn), so reducing
// per-item effort is finally worth doing — before that it would only have made the abandonment
// faster.
//
// This is the work he demonstrably DOES and abandons: 226 "✓ Yes" and 41 "✗ No" in his click log, and
// 458 clusters still waiting. Every one of those is a mouse journey to a small button. The whole
// review is one decision repeated hundreds of times, which is exactly the shape a keyboard is for.
//
// Design, kept deliberately small:
//   • One card is FOCUSED at a time, and it is visible (`.kb-focus`) — a keyboard mode with no
//     cursor is worse than none.
//   • Y or Enter confirms the suggestion · N rejects · S skips · arrows move.
//   • Focus follows the work: after a decision it lands on the next undecided card, so the common
//     case is "Y Y Y N Y" without ever moving the hand.
//   • Keys are IGNORED while typing — he corrects names in a text field right there, and stealing
//     "n" from a name would be maddening.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// Three clusters, each with a suggestion, opened in the review grid.
async function openReview(win) {
  await run(win, `
    // CLOSE ANY OPEN GRID FIRST. showFaceReviewGrid appends a new overlay; without this each test
    // stacked another one and \`document.querySelector\` found the PREVIOUS overlay's card, so a test
    // could fail while the behaviour was correct. Test isolation, not a product bug — verified by
    // driving the same sequence once in a clean window and watching the focus move as intended.
    document.querySelectorAll('.face-grid-overlay, .modal-overlay').forEach((el) => el.remove());
    window.__tagged = [];
    const mk = (i, name) => ({
      _i: i, thumb: '', descriptor: [i / 10], descriptors: [[i / 10]],
      clipKeys: new Set(['clip' + i + '__1']), suggest: { id: 'p' + i, name, dist: 0.2 },
      done: false, rejected: false, skipped: false,
    });
    showFaceReviewGrid([mk(0, 'Liam'), mk(1, 'Karis'), mk(2, 'Josiah')], [], 0);
  `);
  await new Promise((r) => setTimeout(r, 300));
}
const focusIdx = (win) => read(win, `(() => { const el = document.querySelector('.face-grid-card-item.kb-focus'); return el ? Number(el.dataset.i) : -1; })()`);
const press = (win, key) => run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));`);

test('the review opens with a visible keyboard focus', { skip: !RUN }, async () => {
  // A keyboard mode with no cursor is worse than no keyboard mode.
  await openReview(app.win);
  assert.equal(await focusIdx(app.win), 0, 'the first undecided card is focused');
});

test('arrow keys move the focus', { skip: !RUN }, async () => {
  await openReview(app.win);
  await press(app.win, 'ArrowDown');
  assert.equal(await focusIdx(app.win), 1, 'down moves on');
  await press(app.win, 'ArrowUp');
  assert.equal(await focusIdx(app.win), 0, 'and up comes back');
});

test('Y confirms the focused suggestion', { skip: !RUN }, async () => {
  await openReview(app.win);
  await press(app.win, 'y');
  await new Promise((r) => setTimeout(r, 250));
  const done = await read(app.win, `(() => { const c = window.__reviewClusters && window.__reviewClusters[0]; return !!(c && c.done); })()`);
  assert.equal(done, true, 'the first cluster is confirmed');
});

test('focus follows the work to the next undecided card', { skip: !RUN }, async () => {
  // The point of the whole thing: "Y Y Y" without touching the mouse.
  await openReview(app.win);
  await press(app.win, 'y');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(await focusIdx(app.win), 1, 'it moved on by itself');
});

test('N rejects without naming anyone', { skip: !RUN }, async () => {
  await openReview(app.win);
  await press(app.win, 'n');
  await new Promise((r) => setTimeout(r, 250));
  const st = await read(app.win, `(() => { const c = window.__reviewClusters && window.__reviewClusters[0]; return { done: !!(c && c.done), rejected: !!(c && c.rejected) }; })()`);
  assert.equal(st.rejected, true, 'marked as not-them');
  assert.equal(st.done, false, 'and nobody was tagged');
});

test('S skips a cluster entirely', { skip: !RUN }, async () => {
  await openReview(app.win);
  await press(app.win, 's');
  await new Promise((r) => setTimeout(r, 250));
  const skipped = await read(app.win, `(() => { const c = window.__reviewClusters && window.__reviewClusters[0]; return !!(c && c.skipped); })()`);
  assert.equal(skipped, true, 'skipped');
});

test('typing a name is NOT hijacked by the shortcuts', { skip: !RUN }, async () => {
  // He corrects names in a field on the card. Stealing "n" or "s" from a name would be maddening —
  // and this is the failure mode that makes people turn keyboard shortcuts off.
  await openReview(app.win);
  await run(app.win, `
    const inp = document.querySelector('.face-grid-card-item .fgc-input');
    inp.focus(); inp.value = 'Nan';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  `);
  await new Promise((r) => setTimeout(r, 200));
  const st = await read(app.win, `(() => { const c = window.__reviewClusters && window.__reviewClusters[0]; return { rejected: !!(c && c.rejected), skipped: !!(c && c.skipped) }; })()`);
  assert.equal(st.rejected, false, 'the "n" went into the name, not into a rejection');
  assert.equal(st.skipped, false);
});

test('confirming a MIDDLE card continues forward, not back to the top', { skip: !RUN }, async () => {
  // The case that distinguishes "focus follows the work" from "recompute from scratch". With every
  // card undecided and focus on the first, both land on the same next card — so my other tests could
  // not tell them apart and deleting the explicit advance left them green.
  //
  // Answering the SECOND card while the first is still unanswered is where they differ: following
  // the work continues to the third, a from-scratch recompute snaps back to the first. Continuing
  // forward is what makes a long review feel like progress.
  //
  // (Note the deliberate wrap: `nextUndecided` returns to the first unanswered card when nothing
  // follows, which is right — at the end of the list the next thing to do is whatever is left.)
  await openReview(app.win);
  await press(app.win, 'ArrowDown');
  assert.equal(await focusIdx(app.win), 1, 'focus is on the middle card');
  await press(app.win, 'y');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await focusIdx(app.win), 2, 'it continued forward rather than snapping back to the first');
});
