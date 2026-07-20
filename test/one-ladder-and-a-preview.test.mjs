// Tier 1 item 8 — "show where each clip WILL go before he commits."
//
// The blocker was structural, not visual. The destination ladder lived INLINE inside `finalize:run`,
// so any screen wanting to show a prediction had to reimplement it — and a second copy of a fallback
// ladder is the "two entry points that disagree" shape that has produced a confirmed bug on four
// separate days in this repo. A prediction computed by a different code path than the filing is worse
// than no prediction: it is a promise the app does not keep.
//
// So the ladder is extracted to `destinationParts` and asked over IPC. One implementation decides
// where a clip goes, whether or not anything is being moved.
//
// The extraction was proven behaviour-preserving by the existing suite: every destination test
// (`subject-groups-by-shoot-date`, `file-without-a-name`, `organize-plan`, `camera-id-is-not-a-subject`,
// `filed-badge-names-a-real-folder`) passes unchanged against the extracted version.
//
// ⚠ And the reachability test earned its keep twice in one iteration: it caught the new handler having
// no preload binding, then caught the new bridge having no CALLER — refusing to let me ship exactly
// the "fully built but never fed" shape that left `backfillLedgerFromTree` unreachable for months.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-preview-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.projectLedger = []; cfg.finalMeta = {}; cfg.folderLevels = ['category', 'project'];
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const preview = async (items) => app.plain(await app.invoke('organize:previewDest', { items, folderLevels: ['category', 'project'] }));

test('⚠ the preview says where a clip will go, without moving anything', async () => {
  try {
    const name = '2026-03-14_vlog_kitchen_v1.mp4';
    writeFileSync(join(box.dir, name), 'FOOTAGE');
    const r = await preview([{ name, sourcePath: join(box.dir, name), meta: { subject: 'vlog', date: '2026-03-14' } }]);
    assert.equal(r.ok, true, 'the preview ran');
    assert.equal(r.dests[0].rel, 'vlog/2026-03-14', `and named the folder — got ${r.dests[0].rel}`);
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(box.dest), [], '⚠ and NOTHING was filed — it is a question, not an action');
    assert.deepEqual(readdirSync(box.dir), [name], 'the source is untouched too');
  } finally { box.cleanup(); }
});

test('⚠⚠ the preview matches what filing ACTUALLY does', async () => {
  // The property that makes a prediction worth showing. If these can drift, the badge is a lie — and
  // the whole reason for extracting the ladder was to make drift impossible.
  try {
    const names = [
      '2026-03-14_vlog_kitchen_v1.mp4',      // subject + date
      '2026-05-16_lawnmowing_liam_v1.mp4',   // a different subject
      'NEVERSEEN.MP4',                       // nothing to go on → dated holding pen
    ];
    for (const n of names) writeFileSync(join(box.dir, n), 'FOOTAGE');
    const scan = await app.invoke('finalize:scan', { dir: box.dir });
    const items = Array.from(scan.files).map((f) => ({ ...f }));

    const predicted = await preview(items.map((f) => ({ name: f.name, sourcePath: f.sourcePath, meta: f.meta || {} })));
    const s = await app.invoke('finalize:run', {
      dir: box.dir, items,
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
    });

    const actual = {};
    for (const x of Array.from(s.filedRels || [])) actual[String(x.name)] = String(x.rel);
    for (const p of predicted.dests) {
      assert.equal(actual[p.name], p.rel,
        `⚠ "${p.name}": predicted "${p.rel}", filed to "${actual[p.name]}"`);
    }
    assert.equal(Object.keys(actual).length, 3, 'all three really filed');
  } finally { box.cleanup(); }
});

test('an explicit map placement is previewed as such', async () => {
  // The top rung. If he has placed a clip, the preview must show HIS choice, not the fallback.
  try {
    const name = '2026-03-14_vlog_kitchen_v1.mp4';
    writeFileSync(join(box.dir, name), 'FOOTAGE');
    const r = await preview([{ name, sourcePath: join(box.dir, name), rel: '2026 - Client Work', meta: { subject: 'vlog', date: '2026-03-14' } }]);
    assert.equal(r.dests[0].rel, '2026 - Client Work', `his placement wins — got ${r.dests[0].rel}`);
  } finally { box.cleanup(); }
});

test('the preview never returns an empty path', async () => {
  // An empty path means the bare ROOT of his Projects tree — the failure that once put 310 clips
  // loose in C:\...\2026. The ladder must always bottom out somewhere findable.
  try {
    const name = 'NOTHING_TO_GO_ON.MP4';
    writeFileSync(join(box.dir, name), 'FOOTAGE');
    const r = await preview([{ name, sourcePath: join(box.dir, name), meta: {} }]);
    assert.ok(r.dests[0].rel.length > 0, `always a folder — got ${JSON.stringify(r.dests[0])}`);
    assert.match(r.dests[0].rel, /_unsorted/, 'the honest holding pen');
  } finally { box.cleanup(); }
});

test('there is exactly ONE ladder', () => {
  // The structural point. If someone re-inlines a copy into finalize:run, the preview and the filing
  // can disagree again — which is the bug class this whole change exists to close.
  const src = readFileSync(join(process.cwd(), 'main-mod', '09-ipc-boot.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const decls = (src.match(/async function destinationParts\(/g) || []).length;
  assert.equal(decls, 1, 'declared once');
  const run = src.slice(src.indexOf("ipcMain.handle('finalize:run'"));
  assert.match(run, /await destinationParts\(/, 'and filing calls it rather than computing its own');
  assert.doesNotMatch(run.slice(0, run.indexOf('summary.filedRels')), /_unsorted'\]\.filter/,
    'no inline copy of the fallback survives in the run path');
});

// --- the renderer side ---
const ui = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('the rows ask for the preview, and render it', () => {
  assert.match(ui, /window\.api\.organizePreviewDest\(/, 'the bridge is actually called');
  assert.match(ui, /previewDestinations\(\);/, 'after a scan');
  assert.match(ui, /finWillFileBadge\(f\)/, 'and the answer reaches the row');
});

test('⚠ a stale answer cannot mislabel a row', () => {
  // A rescan can replace finScan.files while the preview is in flight. Closing over the old array
  // would put row 3's OLD destination on the NEW row 3 — a confident, wrong label.
  const fn = ui.slice(ui.indexOf('async function previewDestinations'), ui.indexOf('\n}', ui.indexOf('async function previewDestinations')));
  assert.ok(fn.length > 0, 'found previewDestinations');
  assert.match(fn, /for \(const f of \(\(finScan && finScan\.files\) \|\| \[\]\)\)/, 're-reads the live list when the answer arrives');
  assert.match(fn, /byName\[f\.name\]/, 'and matches by name rather than position');
});

test('a preview failure leaves the list exactly as it was', () => {
  const fn = ui.slice(ui.indexOf('async function previewDestinations'), ui.indexOf('\n}', ui.indexOf('async function previewDestinations')));
  assert.match(fn, /catch \{ return; \}/, 'advisory only — the list still works without it');
});
