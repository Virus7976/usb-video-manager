// `lawn-mowing` and `lawnmowing` were building two sibling trees for one subject.
//
// MEASURED by parsing all 513 of his real filenames: 9 distinct subjects, and two of them are the
// same thing spelled differently — `lawn-mowing` (68 clips) and `lawnmowing` (15). That is 83 clips,
// his second-biggest subject, split across two directories that sort apart in Explorer and that the
// project ledger learns as two unrelated projects.
//
// `resolveFolderPath` already had exactly the right instinct for this, one step narrower:
//
//     const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === want.toLowerCase());
//     if (hit) actual = hit.name;                  // his spelling wins over ours, always
//
// It asks the disk what a folder is REALLY called so `2026 - client work` lands in his existing
// `2026 - Client Work`. This widens the same rule from case to separators.
//
// The important property is what it does NOT do: it never invents or normalises a name. If no
// matching folder exists, the clip's own subject wins untouched — his vocabulary stays his. The only
// behaviour is "prefer a folder you already have over creating a near-duplicate beside it", which is
// why this needed no decision from him, unlike renaming his subjects (still not done, deliberately).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-reuse-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.projectLedger = []; cfg.finalMeta = {};
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const fileOne = async (name) => {
  writeFileSync(join(box.dir, name), 'FOOTAGE');
  const scan = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
  const items = Array.from((scan && scan.files) || []).filter((f) => f.name === name).map((f) => ({ ...f }));
  return app.invoke('finalize:run', {
    dir: box.dir, items,
    options: { embed: false, csv: false, organize: true, nas: false, copy: true },
    organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
  });
};
const topDirs = () => readdirSync(box.dest, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

test('a clip spelled without the hyphen joins the folder that already exists', async () => {
  try {
    mkdirSync(join(box.dest, 'lawn-mowing'), { recursive: true });
    const s = await fileOne('2026-05-16_lawnmowing_liam_v1.mp4');
    assert.deepEqual(topDirs(), ['lawn-mowing'], `no near-duplicate created — got ${JSON.stringify(topDirs())}`);
    // THE ONLY CASE WHERE THE REQUEST AND THE ANSWER DIFFER, so it is the only case that can catch a
    // report built from the request. Without this the reporting bug was invisible: every other test
    // here asks for the folder it ends up in.
    const rel = String((Array.from(s.filedRels || [])[0] || {}).rel || '');
    assert.match(rel, /^lawn-mowing\//, `the report names the folder it REALLY landed in — got ${rel}`);
  } finally { box.cleanup(); }
});

test('and the other way round — his existing spelling always wins', async () => {
  // The rule is "reuse what is there", not "prefer hyphens". If the folder on disk is the unhyphenated
  // one, that is the one that gets used.
  try {
    mkdirSync(join(box.dest, 'lawnmowing'), { recursive: true });
    await fileOne('2026-05-16_lawn-mowing_liam_v1.mp4');
    assert.deepEqual(topDirs(), ['lawnmowing'], `his spelling wins — got ${JSON.stringify(topDirs())}`);
  } finally { box.cleanup(); }
});

test('⚠ with NO existing folder, nothing is normalised', async () => {
  // The property that makes this safe to do without asking him: it never invents a name. A subject
  // that has no folder yet creates a folder called exactly what the clip says.
  //
  // Use the HYPHENATED spelling: its loose form (`lawnmowing`) differs from the name itself, so a
  // bug that wrote the normalised key instead of the real folder name is visible. My first version
  // used `lawnmowing`, whose loose form is identical — it could not have caught that, and breaking
  // the code proved it: the test stayed green with `actual = near ? near.name : lw`.
  try {
    await fileOne('2026-05-16_lawn-mowing_liam_v1.mp4');
    assert.deepEqual(topDirs(), ['lawn-mowing'], `the clip's own spelling, separators intact — got ${JSON.stringify(topDirs())}`);
  } finally { box.cleanup(); }
});

test('an EXACT folder is never stolen by a near match', async () => {
  // Ordering matters: the case-insensitive exact check must run first. With both spellings on disk,
  // a clip must land in its own, not in whichever the directory listing happened to yield first.
  try {
    // Create the NEAR match first so a naive directory scan meets it before the exact one — my first
    // version created them in the other order and the break ("run the loose match first") passed by
    // luck of readdir ordering. A test whose result depends on filesystem order is not a test.
    mkdirSync(join(box.dest, 'lawn-mowing'), { recursive: true });
    mkdirSync(join(box.dest, 'lawnmowing'), { recursive: true });
    const listed = readdirSync(box.dest).filter((n) => n.startsWith('lawn'));
    assert.equal(listed[0], 'lawn-mowing', `the decoy is listed first — got ${JSON.stringify(listed)}`);
    const s = await fileOne('2026-05-16_lawnmowing_liam_v1.mp4');
    // Assert on the DISK, and on the report, and require them to agree. Reading only the report hid
    // a real bug: `filedRels` was built from the requested folder rather than the resolved one, so it
    // stayed green while the clip landed in the decoy.
    const rel = String((Array.from(s.filedRels || [])[0] || {}).rel || '');
    const onDisk = readdirSync(join(box.dest, 'lawnmowing'), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    assert.ok(onDisk > 0, 'the clip really is under its own exact folder on disk');
    assert.match(rel, /^lawnmowing\//, `and the report agrees — got ${rel}`);
  } finally { box.cleanup(); }
});

test('case still wins too — the behaviour this widens', async () => {
  try {
    mkdirSync(join(box.dest, 'Lawn-Mowing'), { recursive: true });
    await fileOne('2026-05-16_lawn-mowing_liam_v1.mp4');
    assert.deepEqual(topDirs(), ['Lawn-Mowing'], `his capitalisation kept — got ${JSON.stringify(topDirs())}`);
  } finally { box.cleanup(); }
});

test('genuinely different subjects are NOT merged', async () => {
  // The damaging direction. `timelapse` and `lawn-mowing` differ by more than punctuation and must
  // stay apart — a rule that collapsed them would silently misfile his footage.
  try {
    mkdirSync(join(box.dest, 'timelapse'), { recursive: true });
    await fileOne('2026-05-16_lawn-mowing_liam_v1.mp4');
    assert.deepEqual(topDirs(), ['lawn-mowing', 'timelapse'], `both exist separately — got ${JSON.stringify(topDirs())}`);
  } finally { box.cleanup(); }
});

test('a file is never mistaken for a folder to reuse', async () => {
  // readdir returns files too. Matching one would resolve the destination onto a path that is not a
  // directory, and the move would fail on a name he happens to have used for a clip.
  try {
    writeFileSync(join(box.dest, 'lawnmowing'), 'not a folder');
    await fileOne('2026-05-16_lawn-mowing_liam_v1.mp4');
    assert.ok(topDirs().includes('lawn-mowing'), `filed into a real folder — got ${JSON.stringify(topDirs())}`);
  } finally { box.cleanup(); }
});

test('the whole 83-clip split collapses into one tree', async () => {
  // The measured outcome, end to end: both spellings across several shoots land under one subject.
  try {
    for (const n of [
      '2026-05-16_lawnmowing_liam_v1.mp4',
      '2026-06-01_lawn-mowing_dennis_v1.mp4',
      '2026-06-12_lawn-mowing_liam_v1.mp4',
    ]) {
      writeFileSync(join(box.dir, n), 'FOOTAGE');
    }
    const scan = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
    const s = await app.invoke('finalize:run', {
      dir: box.dir, items: Array.from((scan && scan.files) || []).map((f) => ({ ...f })),
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
    });
    assert.equal(s.moved, 3, 'all three filed');
    assert.equal(topDirs().length, 1, `one subject tree, not two — got ${JSON.stringify(topDirs())}`);
    // Still three separate shoots underneath — merging the subject must not merge the dates.
    const rels = new Set(Array.from(s.filedRels || []).map((x) => String(x.rel)));
    assert.equal(rels.size, 3, `three shoots preserved — got ${JSON.stringify([...rels])}`);
  } finally { box.cleanup(); }
});
