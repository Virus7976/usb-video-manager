// Every number `finalize:run` reports, cross-checked against the filesystem.
//
// This axis has now produced two real bugs in three days, both of the same shape — **the summary said
// one thing and the disk said another**:
//
//   • `filedRels` reported the folder we REQUESTED, not the one `resolveFolderPath` actually used, so
//     the toast, the row badge and the ledger all named the wrong folder whenever an existing folder
//     was reused (2026-07-19cg).
//   • the run reported `ok` with `summary.errors` populated while exiftool was throwing on every
//     clip, so "Done" appeared over a run that embedded nothing (2026-07-19cb).
//
// The screen is built entirely from these counters. If they drift from the disk, the app is lying
// confidently — which is the exact failure this whole effort exists to remove, and which no amount of
// internal consistency can catch. So: file real files, then go and LOOK.
//
// The embed check reads the filed clip back with an INDEPENDENT exiftool instance. Asking the app's
// own reader whether the app's own writer worked is asking the suspect for an alibi.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const FIXTURE = join(process.cwd(), 'test', 'fixtures', 'tiny.mp4');

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-truth-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  const nas = join(base, 'NAS');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  mkdirSync(nas, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.projectLedger = []; cfg.finalMeta = {};
  box = { base, dir, dest, nas, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const walk = (root) => {
  const out = [];
  const rec = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(d, e.name), r); else out.push(r);
    }
  };
  rec(root, '');
  return out;
};
const videos = (root) => walk(root).filter((f) => /\.mp4$/i.test(f));

// Three clips across two shoots, as real mp4s so exiftool can genuinely write to them.
const NAMES = [
  '2026-03-14_vlog_kitchen-chat_v1.mp4',
  '2026-03-14_vlog_kitchen-wide_v1.mp4',
  '2026-04-02_timelapse_sunrise_v1.mp4',
];
const stage = () => { for (const n of NAMES) copyFileSync(FIXTURE, join(box.dir, n)); };

const runIt = async (options, extra = {}) => {
  const scan = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
  const items = Array.from((scan && scan.files) || []).map((f) => ({ ...f }));
  return app.invoke('finalize:run', {
    dir: box.dir, items, options,
    organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '', ...extra,
  });
};

test('`moved` equals the number of clips actually in the tree', async () => {
  try {
    stage();
    const s = await runIt({ embed: false, csv: false, organize: true, nas: false, copy: true });
    assert.equal(s.moved, videos(box.dest).length, `report ${s.moved} vs disk ${JSON.stringify(videos(box.dest))}`);
    assert.equal(s.moved, NAMES.length, 'and that is all of them');
  } finally { box.cleanup(); }
});

test('`filedRels` names a folder that exists, for every clip it lists', async () => {
  // The bug from 2026-07-19cg, generalised: every reported destination must be real.
  try {
    stage();
    const s = await runIt({ embed: false, csv: false, organize: true, nas: false, copy: true });
    const rels = Array.from(s.filedRels || []);
    assert.equal(rels.length, s.moved, `one entry per moved clip — ${rels.length} vs ${s.moved}`);
    for (const r of rels) {
      const dirPath = join(box.dest, String(r.rel).split('/').join('/'));
      assert.equal(existsSync(dirPath), true, `reported folder exists on disk: ${r.rel}`);
      assert.equal(existsSync(join(dirPath, String(r.name))), true, `and the clip is in it: ${r.rel}/${r.name}`);
    }
  } finally { box.cleanup(); }
});

test('⚠ `embedded` means the file really carries the record', async () => {
  // The counter that lied for months. Verified with a SEPARATE exiftool — the app's own reader shares
  // the singleton and the same assumptions.
  try {
    stage();
    app.get('config').finalMeta = {
      '2026-03-14_vlog_kitchen-chat_v1.mp4': { subject: 'vlog', description: 'kitchen chat', done: true, ts: 1 },
    };
    const s = await runIt({ embed: true, csv: false, organize: true, nas: false, copy: true });
    assert.equal((s.errors || []).length, 0, `no embed errors — got ${JSON.stringify(Array.from(s.errors || []))}`);

    const { ExifTool } = await import('exiftool-vendored');
    const et = new ExifTool({ taskTimeoutMillis: 600000, maxProcAgeMillis: 660000 });
    let carrying = 0;
    try {
      for (const rel of videos(box.dest)) {
        const t = await et.read(join(box.dest, rel));
        const raw = t && (t.Identifier || t['XMP-dc:Identifier']);
        const v = Array.isArray(raw) ? raw[0] : raw;
        if (typeof v === 'string' && v.startsWith('usbvd1:')) carrying += 1;
      }
    } finally { try { await et.end(); } catch { /* ignore */ } }

    const sidecars = walk(box.dest).filter((f) => /\.xmp$/i.test(f)).length;
    assert.equal(s.embedded, carrying + sidecars,
      `reported ${s.embedded} embedded; disk shows ${carrying} carrying a record + ${sidecars} sidecars`);
  } finally { box.cleanup(); }
});

test('`backedUp` equals what is really in the NAS folder', async () => {
  try {
    stage();
    const s = await runIt({ embed: false, csv: false, organize: true, nas: true, copy: true }, { nasPath: box.nas });
    assert.equal(s.backedUp, videos(box.nas).length,
      `report ${s.backedUp} vs NAS ${JSON.stringify(videos(box.nas))}`);
  } finally { box.cleanup(); }
});

test('⚠ `backedUp` counts copies MADE, not files looked at', async () => {
  // Into a clean NAS folder every copy succeeds, so the `=== 'copied'` guard is unexercised — I
  // proved that by deleting it and watching the test above stay green. A file already present on the
  // NAS returns a different verdict, and counting it again would inflate the number he uses to decide
  // whether his footage has a second copy. That number gates a card delete, so it must not drift.
  try {
    stage();
    const first = await runIt({ embed: false, csv: false, organize: true, nas: true, copy: true }, { nasPath: box.nas });
    assert.ok(first.backedUp > 0, `the first run really backs up — got ${first.backedUp}`);
    const onNas = videos(box.nas).length;
    const second = await runIt({ embed: false, csv: false, organize: true, nas: true, copy: true }, { nasPath: box.nas });
    assert.equal(videos(box.nas).length, onNas, 'the NAS gained nothing on the second pass');
    assert.equal(second.backedUp, 0,
      `so nothing is reported as backed up either — got ${second.backedUp}`);
  } finally { box.cleanup(); }
});

test('the counters never claim more clips than were handed in', async () => {
  // A double-count is how "moved 6" appears for a 3-clip run — plausible, and impossible to notice
  // without going to look.
  try {
    stage();
    const s = await runIt({ embed: true, csv: false, organize: true, nas: true, copy: true }, { nasPath: box.nas });
    for (const k of ['moved', 'embedded', 'backedUp', 'skipped', 'unplanned']) {
      assert.ok(s[k] <= NAMES.length, `${k} = ${s[k]} cannot exceed the ${NAMES.length} clips in the run`);
    }
    assert.equal(s.total, NAMES.length, 'and total is the run size');
  } finally { box.cleanup(); }
});

test('⚠ a run that reports ok with errors still says what failed', async () => {
  // `ok: true` is about the HANDLER completing, not about the work succeeding — that distinction is
  // what let a run with every clip failing still paint "Done". The contract worth pinning: any
  // failure is named in `errors`, so the renderer always has something honest to show.
  try {
    stage();
    // A destination the process cannot write to forces real move failures.
    const s = await runIt({ embed: false, csv: false, organize: true, nas: false, copy: true },
      { organizeDest: '/proc/uvd-cannot-write-here' });
    if (s.moved === 0) {
      assert.ok((s.errors || []).length > 0, 'a run that moved nothing explains why');
      assert.equal(videos(box.dest).length, 0, 'and the tree is genuinely empty');
    }
  } finally { box.cleanup(); }
});

test('re-running is idempotent — the second pass does not double the tree', async () => {
  // Filing COPIES, so a second run over the same folder must recognise its own work rather than
  // producing " (1)" duplicates. The counter and the disk must agree about that too.
  try {
    stage();
    const first = await runIt({ embed: false, csv: false, organize: true, nas: false, copy: true });
    const afterFirst = videos(box.dest).length;
    const second = await runIt({ embed: false, csv: false, organize: true, nas: false, copy: true });
    const afterSecond = videos(box.dest).length;
    assert.equal(afterFirst, first.moved, 'first run is honest');
    assert.equal(afterSecond, afterFirst,
      `no duplicates on re-run — ${JSON.stringify(videos(box.dest))}`);
    assert.equal(second.moved, 0, `and the second run reports it moved nothing new — got ${second.moved}`);
  } finally { box.cleanup(); }
});
