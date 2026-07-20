// A project folder holding only photos was invisible to the two features that read his library.
//
// Sweeping the axis behind 2026-07-20l/m — "counts videos, silently omits stills" — turned up two
// more, both in code whose entire purpose is to LEARN from what he already has:
//
//   1. `backfillLedgerFromTree` listed videos and then skipped anything empty as *"a container
//      folder, not a project"*. A folder of stills is not a container; it is a shoot. The importer
//      that exists to build the ledger from an existing library would have omitted every photo shoot
//      he owns — and this matters now, because his 203 intake photos file into **10 dated folders**
//      (measured, 2026-07-20k). Ten real projects, silently dropped.
//
//   2. `ai:learnNames` mined his filenames for style examples, videos only. His photos carry the
//      SAME app naming scheme (`2016-01-02_vlog_kakwa-trip_v1.jpg`), so that discarded 203 genuine
//      examples of how he names things — on a store where the whole point is learning his style.
//
// Both are the same shape as the Home card and the Organize empty state: the code asks "how many
// videos?" when the question is "how much of his work is here?".
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-photoproj-'));
  const root = join(base, '2026');
  mkdirSync(root, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = root;
  cfg.projectLedger = [];
  box = { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});
const project = (name, ...files) => {
  const d = join(box.root, name);
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(join(d, f), 'BYTES');
  return d;
};
const ledger = () => app.plain(app.get('config').projectLedger) || [];

test('⚠ a folder of ONLY photos is learned as a project', async () => {
  try {
    project('2016-01-02 kakwa trip', '2016-01-02_vlog_kakwa-trip_v1.jpg', '2016-01-02_vlog_kakwa-trip_v2.jpg');
    const r = await app.invoke('ai:backfillLedger');
    assert.ok(r && r.ok, `the import ran — ${JSON.stringify(r)}`);
    const led = ledger();
    assert.equal(led.length, 1, `the photo shoot is a project — got ${JSON.stringify(led.map((p) => p.rel))}`);
    assert.equal(led[0].clips, 2, `and both stills counted — got ${led[0].clips}`);
  } finally { box.cleanup(); }
});

test('a MIXED folder counts both', async () => {
  try {
    project('mixed shoot', 'a_v1.mp4', 'b_v1.jpg', 'c_v1.jpg');
    await app.invoke('ai:backfillLedger');
    const led = ledger();
    assert.equal(led.length, 1, 'one project');
    assert.equal(led[0].clips, 3, `video and stills together — got ${led[0].clips}`);
  } finally { box.cleanup(); }
});

test('a video-only folder is unchanged', async () => {
  // Guard the path that already worked.
  try {
    project('video shoot', 'a_v1.mp4', 'b_v1.mp4');
    await app.invoke('ai:backfillLedger');
    const led = ledger();
    assert.equal(led.length, 1, 'still learned');
    assert.equal(led[0].clips, 2, 'with the right count');
  } finally { box.cleanup(); }
});

test('⚠ a genuinely EMPTY folder is still skipped as a container', async () => {
  // The heuristic must survive: a folder with no media in it is scaffolding, not a shoot. Widening
  // "what counts as footage" must not turn every parent directory into a project.
  try {
    mkdirSync(join(box.root, '2026 - Client Work'), { recursive: true });
    await app.invoke('ai:backfillLedger');
    assert.deepEqual(ledger(), [], `nothing learned from an empty container — got ${JSON.stringify(ledger())}`);
  } finally { box.cleanup(); }
});

test('a folder of NON-media files is also still skipped', async () => {
  // Notes, CSVs and project files are not footage either.
  try {
    project('paperwork', 'notes.txt', 'budget.csv');
    await app.invoke('ai:backfillLedger');
    assert.deepEqual(ledger(), [], `not a shoot — got ${JSON.stringify(ledger())}`);
  } finally { box.cleanup(); }
});

test('⚠ the name learner mines photo filenames too', async () => {
  // His stills follow the same scheme, so they are style examples like any clip.
  try {
    const dir = mkdtempSync(join(tmpdir(), 'uvd-learn-'));
    writeFileSync(join(dir, '2016-01-02_vlog_kakwa-trip_v1.jpg'), 'BYTES');
    const src = (await import('node:fs')).readFileSync(join(process.cwd(), 'main-mod', '07-naming-organize.js'), 'utf8').replace(/\/\/.*$/gm, '');
    const handler = src.slice(src.indexOf("ipcMain.handle('ai:learnNames'"), src.indexOf('currentFinalMeta()', src.indexOf("ipcMain.handle('ai:learnNames'")));
    assert.match(handler, /listImagesShallow\(dir\)/, 'stills are included in the example pool');
    assert.match(handler, /listVideosShallow\(dir\)/, 'alongside the clips, not instead of them');
    rmSync(dir, { recursive: true, force: true });
  } finally { box.cleanup(); }
});
