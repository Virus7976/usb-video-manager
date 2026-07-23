// Reading his real Projects folder into the ledger, driven against the REAL app on a REAL tree.
//
// The ledger is what `ledgerMatch` / same-shoot recall score a new import against — the app's
// strongest placement signal, because he shoots in batches and the date predicts the subject ~88% of
// the time. `ai:backfillLedger` builds it from the tree, and the chain it walks can only be wrong on
// disk: `readProjectTree` → `listVideosShallow`/`listImagesShallow` → the `!clips.length` container
// skip → `saveStore('projectLedger')` (a SIDECAR store, so a `saveConfig()` that forgets `saveStore()`
// discards the whole import silently, at the next launch, after reading an entire library).
//
// ⚠ NOTE ON SCOPE. An earlier version of this file also asserted that the ledger fed the SUBJECT
// VOCABULARY. That was measured against his real tree and reverted — zero change in group count and
// two wrong canonicalisations, because a real Projects tree is workflow scaffolding (`V5`, `Day 1`,
// `In Progress`, `raw footage`) rather than a subject list. See
// `test/subjects-learn-from-his-folders.test.mjs` for the measurement and the pin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let projectsRoot;

// A tree shaped like his. `listVideosShallow` only reads the extension and stat()s the file, so
// empty files are real enough — this test is about the TREE.
function buildTree() {
  const root = mkdtempSync(join(tmpdir(), 'uvd-projects-'));
  const put = (rel, files) => {
    const dir = join(root, ...rel.split('/'));
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), '');
  };
  put('2026/dennis-lawn', ['DJI_0041.MP4', 'DJI_0042.MP4', 'DJI_0043.MP4']);
  put('2026/gourgess-promo', ['C0012.MP4', 'C0013.MP4']);
  // A photo-only shoot. A video-only listing sees it as an empty container and skips it — which is
  // why `listImagesShallow` is in that union. He has 203 intake photos across 10 dated shoots.
  put('2026/kids-sports-day', ['IMG_0101.jpg', 'IMG_0102.jpg']);
  // Holds no clips of its own — a container folder, which must NOT earn a record.
  mkdirSync(join(root, '2026', 'empty-container'), { recursive: true });
  return root;
}

before(async () => {
  if (!RUN) return;
  projectsRoot = buildTree();
  app = await launchApp({ seed: { 'config.json': { projectsRoot, projectLedger: [] } } });
});
after(async () => {
  if (app) await app.close();
  if (projectsRoot) { try { rmSync(projectsRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
});

// The menu action itself — the renderer function Edit → Filing & destinations → "Read my Projects
// folder…" is bound to. Driving the real function rather than `window.api.aiBackfillLedger` is the
// point: the wiring is what had never existed.
const runLearn = (win) => win.evaluate(async () => {
  // eslint-disable-next-line no-undef
  await learnFromProjectsTree();
});

test('⚠⚠ reading his real Projects folder finds the shoots he filed by hand', { skip: !RUN }, async () => {
  const empty = await read(app.win, 'window.api.ledgerGet().then(l => (l || []).length)');
  assert.equal(empty, 0, 'setup: the ledger starts empty, as his really does');

  await runLearn(app.win);

  // Read the ledger back through main, not from renderer state — the sidecar write is under test.
  const names = await read(app.win, 'window.api.ledgerGet().then(l => (l || []).map(p => p.name).sort())');
  assert.deepEqual(names, ['dennis-lawn', 'gourgess-promo', 'kids-sports-day'],
    '⚠ every folder holding clips earns a record — including the stills-only shoot');
  assert.ok(!names.includes('empty-container'), '⚠ and a folder with no clips is a container, not a project');

  const toast = await read(app.win, "document.querySelector('.app-toast')?.textContent || ''");
  assert.match(toast, /Learned 3 new projects/, `⚠ it reports what it really added — toast said: ${toast}`);
});

test('⚠ the clip counts are real, because placement scores against them', { skip: !RUN }, async () => {
  const counts = await read(app.win,
    'window.api.ledgerGet().then(l => Object.fromEntries((l||[]).map(p => [p.name, p.clips])))');
  assert.equal(counts['dennis-lawn'], 3);
  assert.equal(counts['kids-sports-day'], 2, '⚠ photos count as footage here');
});

test('⚠ re-running says it learned nothing new, rather than claiming it worked again', { skip: !RUN }, async () => {
  // Never report success for something that did not happen.
  await runLearn(app.win);
  const toast = await read(app.win, "document.querySelector('.app-toast')?.textContent || ''");
  assert.match(toast, /Already up to date/, `⚠ an unchanged re-run must say so — toast said: ${toast}`);
  assert.match(toast, /3 projects known/, 'and still states what it does know');
});

test('⚠⚠ a folder added after the first run IS picked up', { skip: !RUN }, async () => {
  // The failure the permanent menu route exists for. The health-check nudge fired only while the
  // ledger was COMPLETELY empty, so the first run closed the door and every folder added afterwards
  // stayed invisible to placement.
  mkdirSync(join(projectsRoot, '2026', 'curling-bonspiel'), { recursive: true });
  for (const f of ['A001.MP4', 'A002.MP4']) writeFileSync(join(projectsRoot, '2026', 'curling-bonspiel', f), '');

  await runLearn(app.win);

  const toast = await read(app.win, "document.querySelector('.app-toast')?.textContent || ''");
  assert.match(toast, /Learned 1 new project/, `⚠ the new folder must be found — toast said: ${toast}`);
  const names = await read(app.win, 'window.api.ledgerGet().then(l => (l || []).map(p => p.name))');
  assert.ok(names.includes('curling-bonspiel'), '⚠ and it is really in the ledger');
});
