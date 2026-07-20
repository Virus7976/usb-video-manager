// A bug I INTRODUCED this session, which recreates a complaint he had already made.
//
// The Home-screen "Faces waiting" card (2026-07-19bi) resumes the review with:
//     showFaceReviewGrid(pending, state.scannedFiles || [], 0);
// On the Home screen no card has been scanned, so `state.scannedFiles` is `[]`.
//
// `showFaceReviewGrid` builds `byKey` purely from that list, and the group-shot sort reads it:
//     const ca = byKey[a.clipKey]; const cb = byKey[b.clipKey];
//     const da = String((ca && (ca.date || ca.capturedAt)) || '');
// With an empty list both are `undefined`, every date is `''`, and the sort falls through to
// comparing raw `clipKey` strings — i.e. arbitrary order.
//
// The comment directly above that sort quotes the complaint it was written to fix: *"Scenes were left
// in the order the SCAN happened to finish them — which is async, so it looked random ('all the
// photos are out of order')."* **He said that to me earlier today.** My resume path silently opted
// out of the fix.
//
// The clips are not in memory on that screen, but their dates ARE on disk: the drafts store is keyed
// by exactly the clipKey forms these clusters carry. So the resume path rebuilds a minimal clip list
// from `getDrafts()` instead of passing an empty one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
// The Home card only renders when main REPORTS pending faces, and that count comes from the
// faces-pending STORE — not from anything the renderer can stub. My first version seeded only drafts,
// so the card never appeared, the click hit nothing, and all four tests failed for that reason rather
// than the one under test.
before(async () => {
  if (!RUN) return;
  app = await launchApp({
    seed: {
      'config.json': { firstRun: false },
      'faces-pending.json': [
        { descriptor: [0.1], descriptors: [[0.1]], thumb: '', clipKeys: ['a.mp4__1__1'], done: false, skipped: false, rejected: false },
      ],
      'drafts.json': {
        'a.mp4__1__1': { subject: '', description: '', date: '2026-03-03', ts: 1 },
        'b.mp4__2__2': { subject: '', description: '', date: '2026-01-01', ts: 1 },
        'c.mp4__3__3': { subject: '', description: '', date: '2026-02-02', ts: 1 },
      },
    },
  });
});
after(async () => { if (app) await app.close(); });

test('resuming from Home rebuilds clip context from the drafts store', { skip: !RUN }, async () => {
  // Three clips whose NAME order is the reverse of their DATE order, so a name-only sort and a
  // date-aware sort cannot possibly agree.
  await run(app.win, `
    window.__gotClipList = null;
    showFaceReviewGridStub = null;
    state.scannedFiles = [];
  `);

  // Capture what the resume path hands to the grid.
  await run(app.win, `
    __realShowGrid = showFaceReviewGrid;
    showFaceReviewGrid = function (clusters, clipList, n) { window.__gotClipList = (clipList || []).slice(); };
  `);
  await run(app.win, `
    __realLoadPending = loadPendingFaces;
    loadPendingFaces = function () { return Promise.resolve([
      { _i: 0, thumb: '', descriptor: [0.1], descriptors: [[0.1]], clipKeys: new Set(['a.mp4__1__1']), suggest: null, done: false, rejected: false, skipped: false },
    ]); };
  `);
  await run(app.win, `renderPendingWork();`);
  await new Promise((r) => setTimeout(r, 600));
  await run(app.win, `
    const btn = document.getElementById('pwFaces');
    if (btn) btn.click();
  `);
  await new Promise((r) => setTimeout(r, 600));

  const got = await read(app.win, `(window.__gotClipList || []).length`);
  await run(app.win, `showFaceReviewGrid = __realShowGrid; loadPendingFaces = __realLoadPending;`);
  assert.ok(got >= 3, `the grid received clip context rebuilt from drafts, not an empty list (got ${got})`);
});

test('the rebuilt clips carry the DATE the sort needs', { skip: !RUN }, async () => {
  // Names alone are not enough — the whole point of the sort is capture order.
  const dated = await read(app.win, `(window.__gotClipList || []).filter((c) => c && c.date).length`);
  assert.ok(dated >= 3, `every rebuilt clip has its date (got ${dated})`);
});

test('the rebuilt clips are keyed so byKey can find them', { skip: !RUN }, async () => {
  // byKey indexes clipKeyV2(c), clipKey(c) and sourcePath. A rebuilt clip that does not produce the
  // same key resolves to nothing and the cluster shows "0 clips" — silently.
  const ok = await read(app.win, `(() => {
    const list = window.__gotClipList || [];
    return list.some((c) => clipKeyV2(c) === 'a.mp4__1__1' || clipKey(c) === 'a.mp4__1');
  })()`);
  assert.equal(ok, true, 'a rebuilt clip regenerates the key its cluster refers to');
});

test('the normal path is untouched', { skip: !RUN }, async () => {
  // Guard the other direction: when a card HAS been scanned, the real clips must still be used —
  // they carry far more than the drafts store does.
  await run(app.win, `
    state.scannedFiles = [{ name: 'real.mp4', size: 9, mtimeMs: 9, date: '2026-05-05', sourcePath: 'C:\\\\x\\\\real.mp4' }];
    window.__gotClipList = null;
    __realShowGrid2 = showFaceReviewGrid;
    showFaceReviewGrid = function (clusters, clipList) { window.__gotClipList = (clipList || []).slice(); };
    __realLoadPending2 = loadPendingFaces;
    loadPendingFaces = function () { return Promise.resolve([{ _i: 0, thumb: '', descriptor: [0.1], descriptors: [[0.1]], clipKeys: new Set(['real.mp4__9__9']), suggest: null, done: false, rejected: false, skipped: false }]); };
  `);
  await run(app.win, `renderPendingWork();`);
  await new Promise((r) => setTimeout(r, 600));
  await run(app.win, `const b = document.getElementById('pwFaces'); if (b) b.click();`);
  await new Promise((r) => setTimeout(r, 600));
  const names = await read(app.win, `(window.__gotClipList || []).map((c) => c.name)`);
  await run(app.win, `showFaceReviewGrid = __realShowGrid2; loadPendingFaces = __realLoadPending2;`);
  assert.ok(Array.isArray(names) && names.includes('real.mp4'), `the scanned clip is used — got ${JSON.stringify(names)}`);
});
