// Tier 1 item 14 — "a what's-left counter that never lies". It lied about WHERE, and I caused it.
//
// Two days ago filing began reusing a folder whose name differs only in case or separators, so a
// `lawnmowing` clip lands in his existing `lawn-mowing/` rather than starting a near-duplicate
// (2026-07-19cg). Then `summary.filedRels` was fixed to report the folder `resolveFolderPath`
// actually chose rather than the one we asked for.
//
// **The ledger one line below kept the requested spelling.** And `finalize:scan` builds its
// "filed → <folder>" badge from the ledger's `clipNames`, so after a rescan every reused-folder clip
// was labelled with a directory **that does not exist on disk**. The count was right; the location
// was fiction. For a screen whose job is telling him what is left and where it went, a confidently
// wrong folder is worse than no folder — it is the "I have to re-check its work" failure this whole
// effort exists to remove.
//
// Found by probing the round trip (file → rescan) rather than by reading, which is the only way a
// two-writer disagreement shows up: each writer looks correct on its own.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-badge-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.projectLedger = []; cfg.finalMeta = {};
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const fileAll = async () => {
  const scan = await app.invoke('finalize:scan', { dir: box.dir });
  return app.invoke('finalize:run', {
    dir: box.dir, items: Array.from(scan.files).map((f) => ({ ...f })),
    options: { embed: false, csv: false, organize: true, nas: false, copy: true },
    organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
  });
};
const rescan = () => app.invoke('finalize:scan', { dir: box.dir });

test('⚠⚠ the filed badge names a folder that EXISTS, after a folder reuse', async () => {
  try {
    // His existing tree uses the hyphen; the clip is spelled without it.
    mkdirSync(join(box.dest, 'lawn-mowing'), { recursive: true });
    writeFileSync(join(box.dir, '2026-05-16_lawnmowing_liam_v1.mp4'), 'FOOTAGE');
    await fileAll();

    const f = Array.from((await rescan()).files)[0];
    assert.equal(f.filed, true, 'it is recognised as filed');
    const shown = String(f.filedIn || '');
    assert.ok(shown.length > 0, 'and the badge names a folder');
    assert.equal(existsSync(join(box.dest, ...shown.split('/'))), true,
      `⚠ the folder the badge names really exists — it said "${shown}"`);
  } finally { box.cleanup(); }
});

test('the badge and the run summary agree', async () => {
  // Two writers, one truth. They disagreed for two days precisely because nothing compared them.
  try {
    mkdirSync(join(box.dest, 'lawn-mowing'), { recursive: true });
    writeFileSync(join(box.dir, '2026-05-16_lawnmowing_liam_v1.mp4'), 'FOOTAGE');
    const s = await fileAll();
    const reported = String((Array.from(s.filedRels || [])[0] || {}).rel || '');
    const f = Array.from((await rescan()).files)[0];
    assert.equal(String(f.filedIn), reported,
      `the rescan badge matches what the run reported — badge "${f.filedIn}" vs run "${reported}"`);
  } finally { box.cleanup(); }
});

test('⚠ the ledger records the folder on DISK, not the one requested', async () => {
  // The ledger is also what "same shoot → same project" offers later. A phantom folder there would
  // start offering him a destination he does not have.
  try {
    mkdirSync(join(box.dest, 'lawn-mowing'), { recursive: true });
    writeFileSync(join(box.dir, '2026-05-16_lawnmowing_liam_v1.mp4'), 'FOOTAGE');
    await fileAll();
    const led = app.plain(app.get('config').projectLedger) || [];
    assert.equal(led.length, 1, 'one project learned');
    assert.match(String(led[0].rel), /^lawn-mowing\//, `his spelling, not ours — got ${led[0].rel}`);
    assert.equal(existsSync(join(box.dest, ...String(led[0].rel).split('/'))), true, 'and it exists');
  } finally { box.cleanup(); }
});

test('the counts themselves stay honest', async () => {
  // The rest of item 14: file two of three and the screen must say two.
  try {
    for (const n of ['2026-03-14_vlog_a_v1.mp4', '2026-03-14_vlog_b_v1.mp4', '2026-04-02_vlog_c_v1.mp4']) {
      writeFileSync(join(box.dir, n), 'FOOTAGE');
    }
    const scan = await app.invoke('finalize:scan', { dir: box.dir });
    const items = Array.from(scan.files).filter((f) => f.name !== '2026-04-02_vlog_c_v1.mp4').map((f) => ({ ...f }));
    await app.invoke('finalize:run', {
      dir: box.dir, items,
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
    });
    const after = await rescan();
    assert.equal(after.files.length, 3, 'all three still listed — filing COPIES');
    assert.equal(after.filedCount, 2, `two filed — got ${after.filedCount}`);
    const left = Array.from(after.files).filter((f) => !f.filed).map((f) => f.name);
    assert.deepEqual(left, ['2026-04-02_vlog_c_v1.mp4'], `and the right one is left — got ${JSON.stringify(left)}`);
  } finally { box.cleanup(); }
});

test('a clip filed with NO reuse is unaffected', async () => {
  // Guard the ordinary path: when nothing is reused, requested and resolved are the same and the
  // badge must still be right.
  try {
    writeFileSync(join(box.dir, '2026-03-14_vlog_a_v1.mp4'), 'FOOTAGE');
    await fileAll();
    const f = Array.from((await rescan()).files)[0];
    assert.match(String(f.filedIn), /^vlog\//, `plain case unchanged — got ${f.filedIn}`);
    assert.equal(existsSync(join(box.dest, ...String(f.filedIn).split('/'))), true, 'and it exists');
  } finally { box.cleanup(); }
});
