// 310 clips in one folder is not "filed" — it is a second holding pen with a nicer name.
//
// MEASURED on his real library, not guessed. His Compressed folder holds 310 clips in final-name
// form (`2024-11-29_vlog_josiah-bedroom-timelapse_v1.mp4`). parseNamedClip reads those correctly, so
// every one of them arrives at the destination ladder with `subject: 'vlog'` — because that is the
// slot his naming convention puts a broad category in, not a per-shoot name.
//
// The `[subject]` rung therefore collapsed the ENTIRE backlog into a single flat `vlog/` directory,
// sitting beside his real project folders (`2026 - Client Work`, `2026 - Personal`,
// `2026 - Social Media`) and matching none of them. I proved it by filing 40 of his real filenames
// into a temp tree: 40/40 into one folder, and the project ledger learned exactly ONE entry from the
// whole run — so the app got no smarter for having filed his entire archive.
//
// Grouping by the shoot date underneath splits the same 40 into 7 real shoots and teaches the ledger
// 7 entries. The shoot is the unit he actually works in — he shoots in batches, and the date predicts
// the subject ~88% of the time, which is why the ledger keys on it.
//
// Jake chose this layout after being shown the measurement. It is his archive; the alternatives
// (mirroring his year-prefixed folder names, or asking per shoot) were real options, so this is NOT
// a default to change on a hunch later.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-shoot-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest;
  cfg.projectLedger = [];
  cfg.finalMeta = {};
  cfg.folderLevels = ['category', 'project'];   // his real config: fields his workflow never fills
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

// His real filenames, three shoots across two dates plus one on a third.
const REAL_NAMES = [
  '2024-11-29_vlog_josiah-bedroom-timelapse_v1.mp4',
  '2024-11-29_vlog_josiah-headshot-bedroom_v1.mp4',
  '2024-12-02_vlog_josiah-cleanroom-timelapse_v1.mp4',
  '2025-02-15_vlog_liam-skate-park_v1.mp4',
];

const fileThem = async (names) => {
  for (const n of names) writeFileSync(join(box.dir, n), 'FOOTAGE');
  const r = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
  const items = ((r && r.files) || []).map((f) => ({ ...f }));
  return app.invoke('finalize:run', {
    dir: box.dir, items,
    options: { embed: false, csv: false, organize: true, nas: false, copy: true },
    organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
  });
};

// `String(...)` and a real array: values coming back across the vm boundary are proxies, so a bare
// deepEqual against a literal fails with "same structure but not reference-equal" — which reads like
// a behaviour failure and is not one.
const relsOf = (s) => Array.from(s.filedRels || []).map((x) => String(x.rel));

test('clips sharing a subject are split by their shoot date', async () => {
  try {
    const s = await fileThem(REAL_NAMES);
    assert.equal(s.moved, 4, `all four filed — ${JSON.stringify(s.errors)}`);
    const rels = relsOf(s);
    assert.deepEqual([...new Set(rels)].sort(), ['vlog/2024-11-29', 'vlog/2024-12-02', 'vlog/2025-02-15'],
      `three shoots, not one folder — got ${JSON.stringify(rels)}`);
  } finally { box.cleanup(); }
});

test('the same shoot stays together', async () => {
  // The point is grouping, not scattering: two clips from one day belong in one folder.
  try {
    const s = await fileThem(REAL_NAMES);
    const same = relsOf(s).filter((r) => r === 'vlog/2024-11-29');
    assert.equal(same.length, 2, `both 2024-11-29 clips share a folder — got ${JSON.stringify(relsOf(s))}`);
  } finally { box.cleanup(); }
});

test('the subject still leads — this is a subfolder, not a replacement', async () => {
  // Filing by date ALONE would throw away the one grouping his filenames actually carry.
  try {
    const s = await fileThem(REAL_NAMES);
    for (const r of relsOf(s)) assert.match(r, /^vlog\//, `subject first — got ${r}`);
  } finally { box.cleanup(); }
});

test('the ledger learns one entry per shoot, not one for the whole archive', async () => {
  // The measured failure: filing 40 real clips taught the ledger ONE entry, so the app got no
  // smarter for having filed his entire backlog. The ledger is what makes a later import from the
  // same shoot offer the same project.
  try {
    await fileThem(REAL_NAMES);
    const led = app.plain(app.get('config').projectLedger) || [];
    assert.equal(led.length, 3, `one per shoot — got ${led.length}: ${JSON.stringify(led.map((p) => p.rel))}`);
  } finally { box.cleanup(); }
});

test('a subject with NO date keeps the old flat behaviour', async () => {
  // Never invent a folder called `undated` inside the subject. A clip with a subject and no date is
  // better off in the subject folder than in a bucket that looks like a real shoot.
  try {
    const n = 'plainname.mp4';
    writeFileSync(join(box.dir, n), 'FOOTAGE');
    app.get('config').finalMeta = { 'plainname.mp4': { subject: 'timelapse', description: '', done: true, ts: 1 } };
    const r = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
    const items = ((r && r.files) || []).filter((f) => f.name === n).map((f) => ({ ...f, meta: { subject: 'timelapse' } }));
    const s = await app.invoke('finalize:run', {
      dir: box.dir, items,
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
    });
    // The file's mtime ALWAYS supplies a date here, so no runtime input can reach the no-date branch
    // — I verified that by breaking it (`[subj, dayPart || 'undated']`) and watching every test stay
    // green. The behavioural assertion below is therefore weak by nature, so the contract is pinned
    // on the source as well: the subject rung must not invent a bucket.
    for (const rel of relsOf(s)) assert.doesNotMatch(rel, /undated/, `no invented bucket — got ${rel}`);
    const { readFileSync } = await import('node:fs');
    // The ladder now lives in `destinationParts` (2026-07-20aa), extracted so a preview can ask the
    // same question without filing anything. Behaviour is unchanged; this assertion follows it there.
    const src = readFileSync(join(process.cwd(), 'main-mod', '09-ipc-boot.js'), 'utf8').replace(/\/\/.*$/gm, '');
    const at = src.indexOf('const subj = safeFolderName');
    assert.ok(at > -1, 'found the subject rung');
    const rung = src.slice(at, src.indexOf('const dayPart = await dayFrom();', at));
    assert.ok(rung.length > 0, 'and sliced it');
    assert.doesNotMatch(rung, /undated/, 'the subject rung never falls back to a named bucket');
    assert.match(src.slice(at), /return dayPart \? \[subj, dayPart\] : \[subj\];/, 'no date means the plain subject folder');
  } finally { box.cleanup(); }
});

test('a clip with no subject at all still goes to the dated holding pen', async () => {
  // Guard the other direction: this rung is for clips that HAVE a subject. One with nothing to go on
  // must still land in `<date>/_unsorted`, which is the honest label for "you sort this later".
  try {
    const n = 'NEVERSEEN.MP4';
    writeFileSync(join(box.dir, n), 'FOOTAGE');
    const when = new Date('2026-04-11T09:00:00Z');
    utimesSync(join(box.dir, n), when, when);
    const s = await app.invoke('finalize:run', {
      dir: box.dir, items: [{ name: n, sourcePath: join(box.dir, n) }],
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
    });
    assert.match(relsOf(s)[0] || '', /_unsorted/, `unchanged — got ${JSON.stringify(relsOf(s))}`);
  } finally { box.cleanup(); }
});

test('an explicit map placement still wins over all of this', async () => {
  // The ladder is a FALLBACK. If he placed a clip on the destination map, that is the answer.
  try {
    const n = '2024-11-29_vlog_josiah-headshot-bedroom_v1.mp4';
    writeFileSync(join(box.dir, n), 'FOOTAGE');
    const s = await app.invoke('finalize:run', {
      dir: box.dir,
      items: [{ name: n, sourcePath: join(box.dir, n), rel: '2026 - Client Work', meta: { subject: 'vlog', date: '2024-11-29' } }],
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
    });
    assert.deepEqual(relsOf(s), ['2026 - Client Work'], `his choice, untouched — got ${JSON.stringify(relsOf(s))}`);
  } finally { box.cleanup(); }
});
