// FEATURES.md items 29 + 56, driven against the REAL app on a REAL folder tree.
//
// The source tests pin the vocabulary rules by seeding `config.projectLedger` directly. That proves
// the matching, and deliberately skips the half that can only be wrong on disk: whether reading his
// actual Projects folder produces those ledger records at all. That chain is
// `readProjectTree` → `listVideosShallow`/`listImagesShallow` → the `!clips.length` container skip →
// `saveStore('projectLedger')` — real fs, real recursion depth, real sidecar write — and then the
// vocabulary has to pick the result up on the very next call.
//
// So this test builds a tree shaped like his (`2026/<project>`, plus the scaffolding folders that
// earn a ledger record without being subjects), runs the menu action the user actually clicks, and
// asks the app the question that matters: does the AI's `dennis-lawn-mowing` now become the folder
// he made himself?
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let projectsRoot;

// A tree shaped like his: `02 - Projects/2026/<project>`. `listVideosShallow` only reads the
// extension and stat()s the file, so empty files are real enough — this test is about the TREE.
function buildTree() {
  const root = mkdtempSync(join(tmpdir(), 'uvd-projects-'));
  const put = (rel, files) => {
    const dir = join(root, ...rel.split('/'));
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), '');
  };
  // Two real shoots he filed by hand — the names are his vocabulary.
  put('2026/dennis-lawn', ['DJI_0041.MP4', 'DJI_0042.MP4', 'DJI_0043.MP4']);
  put('2026/gourgess-promo', ['C0012.MP4', 'C0013.MP4']);
  // A photo-only shoot. It is a real project, and a video-only listing sees it as an empty container
  // and skips it — the reason `listImagesShallow` is in that union.
  put('2026/kids-sports-day', ['IMG_0101.jpg', 'IMG_0102.jpg']);
  // Scaffolding that holds clips directly, so it earns a ledger record without being a subject.
  put('2026/_unsorted', ['CLIP_9001.MP4']);
  put('2026/2026-05-31', ['CLIP_9002.MP4']);
  put('2026/vlog', ['CLIP_9003.MP4']);
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

// The menu action itself — `learnFromProjectsTree`, the renderer function Edit → Filing &
// destinations → "Read my Projects folder…" is bound to. Driving the real function rather than
// `window.api.aiBackfillLedger` is the point: the wiring is what had never existed.
const runLearn = async (win) => {
  await win.evaluate(async () => {
    // eslint-disable-next-line no-undef
    await learnFromProjectsTree();
  });
};

test('⚠⚠ reading his real Projects folder finds the shoots he filed by hand', { skip: !RUN }, async () => {
  const empty = await read(app.win, 'window.api.ledgerGet().then(l => (l || []).length)');
  assert.equal(empty, 0, 'setup: the ledger starts empty, as his really does');

  await runLearn(app.win);

  // Read the ledger back through main, not from renderer state: the sidecar write is part of what is
  // under test. `projectLedger` is a SIDECAR store, and `saveConfig()` runs `stripStoresForWrite()`,
  // which deletes every key whose sidecar exists — so a save that forgets `saveStore()` discards the
  // whole import silently, at the next launch, after reading an entire library.
  const names = await read(app.win, 'window.api.ledgerGet().then(l => (l || []).map(p => p.name).sort())');
  assert.deepEqual(names, ['2026-05-31', '_unsorted', 'dennis-lawn', 'gourgess-promo', 'kids-sports-day', 'vlog'],
    '⚠ every folder holding clips earns a ledger record — the SUBJECT filter is applied later, not here');

  const toast = await read(app.win, "document.querySelector('.app-toast')?.textContent || ''");
  assert.match(toast, /Learned 6 new projects/, `⚠ and it reports what it really added — toast said: ${toast}`);
});

test('⚠⚠ his own folder name is now what a new clip snaps onto', { skip: !RUN }, async () => {
  // THE POINT OF ALL OF IT. The AI proposes `dennis-lawn-mowing` for a new clip of a job he already
  // has a folder for. Before this landed that became spelling #2, the two never grouped, and neither
  // group ever got big enough to file — which is how 4,594 clips produced 1 filed clip.
  const r = await read(app.win, "window.api.canonicalizeSubject('dennis-lawn-mowing')");
  assert.equal(r.ok, true);
  assert.equal(r.canonical, 'dennis-lawn', `⚠ should snap onto his own folder — got ${r.canonical}`);
  assert.equal(r.matched, true);
  assert.equal(r.knownCounts['dennis-lawn'], 3, '⚠ and the count he is shown is the real clip count');
});

test('⚠ a photo-only shoot is a project too', { skip: !RUN }, async () => {
  // A video-only listing sees a stills folder as an empty container and skips it. He has 203 intake
  // photos across 10 dated shoots, so that omission would silently drop every photo shoot he has.
  const r = await read(app.win, "window.api.canonicalizeSubject('kids-sports-day-relay')");
  assert.equal(r.canonical, 'kids-sports-day', '⚠ a stills-only folder must be learned as a subject');
});

test('⚠⚠ the scaffolding folders did NOT become subjects', { skip: !RUN }, async () => {
  // `_unsorted`, `2026-05-31` and `vlog` all hold clips directly and all earn a ledger record. None
  // is a subject: `_unsorted` is the destination ladder's own fallback, so learning it would feed the
  // app's failure back to him as his own vocabulary.
  const known = await read(app.win, "window.api.canonicalizeSubject('x').then(r => r.known)");
  assert.equal(known, 3, `⚠ exactly the three real shoots are known — got ${known}`);

  const vlog = await read(app.win, "window.api.canonicalizeSubject('bedtime-vlog')");
  assert.equal(vlog.matched, false, '⚠ a `vlog` folder must not swallow every vlog he shoots');
});

test('⚠ re-running says it learned nothing new, rather than claiming it worked again', { skip: !RUN }, async () => {
  // Never report success for something that did not happen. A second run over an unchanged tree adds
  // nothing, and reporting the ledger TOTAL again would read as fresh work — he would believe newly
  // added folders had been picked up when they had not.
  await runLearn(app.win);
  const toast = await read(app.win, "document.querySelector('.app-toast')?.textContent || ''");
  assert.match(toast, /Already up to date/, `⚠ an unchanged re-run must say so — toast said: ${toast}`);
  // 6 ledger records, of which only 3 are subjects — the two counts are deliberately different, and
  // this is the ledger one: what it read, not what it learned to snap onto.
  assert.match(toast, /6 projects known/, 'and still states what it does know');
});

test('⚠⚠ a folder added after the first run IS picked up', { skip: !RUN }, async () => {
  // The failure the permanent menu route exists for. The health-check nudge fired only while the
  // ledger was COMPLETELY empty, so the first run closed the door and every folder he added
  // afterwards stayed invisible. This is that exact scenario, end to end.
  mkdirSync(join(projectsRoot, '2026', 'curling-bonspiel'), { recursive: true });
  for (const f of ['A001.MP4', 'A002.MP4']) writeFileSync(join(projectsRoot, '2026', 'curling-bonspiel', f), '');

  await runLearn(app.win);

  const toast = await read(app.win, "document.querySelector('.app-toast')?.textContent || ''");
  assert.match(toast, /Learned 1 new project/, `⚠ the new folder must be found — toast said: ${toast}`);

  const r = await read(app.win, "window.api.canonicalizeSubject('curling-bonspiel-final')");
  assert.equal(r.canonical, 'curling-bonspiel',
    '⚠ and the vocabulary must see it immediately — the cache signature has to include the ledger');
});
