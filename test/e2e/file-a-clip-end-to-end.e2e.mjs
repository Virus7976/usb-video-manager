// THE test this app has never had: does a clip actually get FILED, end to end, through the real UI?
//
// His project ledger reads 0 and his final-meta reads 1 after months of use. Two structural blockers
// were found and fixed today — unnamed clips could not be filed at all (2026-07-19bj), and the
// Organize screen defaulted to filing clips into the folder they were already in (2026-07-19bm) —
// and each was only found because the previous fix exposed it. That pattern is the reason for this
// test: rather than reason about whether a THIRD blocker exists, drive the real screen against real
// files and see whether a clip lands.
//
// This is the one property that matters for the whole toolness effort. Every other Tier 1 item is
// about making this easier or clearer; if this does not work, none of them are worth building.
//
// Real app, real main process, real files on disk, real button clicks. The only stub is
// `confirmDialog` — clicking through a modal adds nothing but flake, and the confirmation's own text
// is covered by its own test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read, run, waitFor } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let box;

// A Compressed folder with one clip in it, and an empty Projects tree to file into.
function makeWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'uvd-e2e-file-'));
  const compressed = join(base, 'Compressed');
  const projects = join(base, 'Projects');
  mkdirSync(compressed, { recursive: true });
  mkdirSync(projects, { recursive: true });
  const clip = join(compressed, 'GX010042.MP4');
  writeFileSync(clip, Buffer.alloc(2048, 7));
  const when = new Date('2026-05-02T09:00:00Z');
  utimesSync(clip, when, when);
  return { base, compressed, projects, clip };
}

before(async () => {
  if (!RUN) return;
  box = makeWorkspace();
  app = await launchApp({
    seed: {
      'config.json': {
        firstRun: false,
        finalizeSource: box.compressed,
        projectsRoot: box.projects,
        organizeDest: '',
        folderLevels: ['category', 'project'],
        nasBackup: { enabled: false, path: '' },
      },
    },
  });
});
after(async () => {
  if (app) await app.close();
  if (box) rmSync(box.base, { recursive: true, force: true });
});

test('a clip the AI never named goes from the Organize screen into the Projects tree', { skip: !RUN }, async () => {
  // Accept the confirmation; everything else is the real thing.
  await run(app.win, `confirmDialog = function () { return Promise.resolve(true); };`);

  await run(app.win, `openFinalize();`);
  // The scan is async — wait for the clip to appear rather than guessing a delay.
  // Bare `finScan`, NOT `window.finScan`: it is a top-level `let` in the bundle, so it lives in
  // script scope and is not a window property. A first version polled `window.finScan`, which is
  // permanently undefined — the wait never engaged and the test passed only because a temp-dir scan
  // is fast. A wait that cannot succeed is indistinguishable from no wait at all.
  // `waitFor`, not page.waitForFunction: the app's CSP forbids eval and Playwright's waitForFunction
  // uses eval internally, so it throws EvalError here no matter what you pass it (see harness.mjs).
  // Bare `finScan` too — it is a top-level `let` in script scope, never a window property.
  await waitFor(app.win, `typeof finScan !== 'undefined' && finScan.files && finScan.files.length > 0`,
    { what: 'the Organize scan to list the clip' });
  const found = await read(app.win, `(finScan.files || []).length`);
  assert.ok(found >= 1, `the Organize screen found the clip (got ${found})`);

  // It has no stored metadata, so it is one of the clips that until today could not be filed at all.
  const unnamed = await read(app.win, `(finScan.files || []).filter((f) => !f.matched).length`);
  assert.equal(unnamed, 1, 'and it is an unnamed clip');

  // Tick it, choose only "organize", and Run.
  await run(app.win, `
    finScan.files.forEach((f) => { f.selected = true; });
    document.getElementById('finOrganize').checked = true;
    document.getElementById('finEmbed').checked = false;
    document.getElementById('finCsv').checked = false;
    document.getElementById('finNas').checked = false;
    document.getElementById('finRunBtn').click();
  `);

  // Wait for the run to report a result rather than sleeping a fixed time.
  // No `.catch` swallow here either — if the run never reports, this test should FAIL rather than
  // quietly walk on and assert against a half-finished filesystem.
  await waitFor(app.win, `(() => { const el = document.getElementById('finStats'); return !!el && !el.classList.contains('hidden'); })()`,
    { timeout: 60000, what: 'the run to report its result' });

  // THE ASSERTION THAT MATTERS: the file is in the Projects tree.
  const landed = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else landed.push(p);
    }
  };
  walk(box.projects);
  assert.equal(landed.length, 1, `exactly one file was filed — found ${JSON.stringify(landed)}`);
  assert.match(landed[0], /GX010042\.MP4$/, 'and it is the clip');
  assert.match(landed[0], /2026-05-02/, 'filed under its own shoot date');
  assert.match(landed[0], /_unsorted/, 'in the _unsorted folder, marked as not yet named');
});

test('the original is still there — filing COPIES', { skip: !RUN }, async () => {
  // His standing rule: organize copies, never moves. The archive must survive.
  assert.ok(existsSync(box.clip), 'the source clip is untouched');
});

test('the run reported what it did', { skip: !RUN }, async () => {
  // A filed clip that the screen does not acknowledge is the same failure as not filing it.
  const txt = await read(app.win, `(document.getElementById('finStats') || {}).textContent || ''`);
  assert.match(String(txt), /1/, `the result mentions the one clip — got: ${txt}`);
});
