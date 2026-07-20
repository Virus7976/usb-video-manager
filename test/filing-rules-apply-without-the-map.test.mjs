// His own filing rules did nothing unless he opened the destination map.
//
// Tier 1 item 2 — "auto-file on a rule with no ceremony". It turned out not to need a new feature:
// the rules exist, he has configured two real ones, and **the ladder that decides where a clip goes
// had never heard of them.**
//
// Measured from his config:
//   { name: "Calisthenics",                match: ["calisthenics","calisthetics"], byDay: true,  dest: … }
//   { name: "Lawn care (Gourgess Lawns)",  match: ["lawn","lawn-mowing","lawnmowing","lawn-care"], … }
//
// Route matching lived only in `07-organize-map.js`, so a rule applied when — and only when — he
// opened the map and let it place his clips. Every other path (the one-clip "File this clip now",
// Run without a map, and both new previews) fell straight through to `subject/date`. **He has 83
// lawn-mowing clips and a rule that says where they belong; without the map they landed in
// `lawnmowing/<date>` instead.** That is the "fully built but never fed" shape on a feature he
// explicitly set up.
//
// Fixed in `destinationParts`, which is now the single ladder every screen asks (2026-07-20aa) — so
// one change reaches the one-clip path, the batch Run and both previews at once. That is precisely
// what the extraction was for.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// His two real rules, shape-for-shape.
const HIS_RULES = [
  { id: 'r1', name: 'Calisthenics', kind: 'route', match: ['calisthenics', 'calisthetics'], byDay: true, dest: '2026/2026 - Social Media/Calisthenics' },
  { id: 'r2', name: 'Lawn care (Gourgess Lawns)', kind: 'route', match: ['lawn', 'lawn-mowing', 'lawnmowing', 'lawn-care'], byDay: false, dest: '2026/2026 - Client Work/Gourgess Lawns' },
  { id: 'r3', name: 'vlog', kind: 'descriptor', match: ['vlog'], byDay: true, dest: '2026/2026 - Personal/Vlog' },
];

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-rules-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.projectLedger = []; cfg.finalMeta = {};
  cfg.ai = cfg.ai || {};
  cfg.ai.routes = JSON.parse(JSON.stringify(HIS_RULES));
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const where = async (meta, extra = {}) => {
  const r = app.plain(await app.invoke('organize:previewDest', {
    items: [{ name: 'clip.mp4', sourcePath: join(box.dir, 'clip.mp4'), meta, ...extra }],
    folderLevels: ['category', 'project'],
  }));
  return r.dests[0].rel;
};

test('⚠⚠ a clip his rule claims goes where the RULE says, with no map involved', async () => {
  try {
    const rel = await where({ subject: 'lawnmowing', description: 'liam', date: '2026-05-16' });
    assert.equal(rel, '2026/2026 - Client Work/Gourgess Lawns',
      `his own rule decides — got ${rel}`);
  } finally { box.cleanup(); }
});

test('a byDay rule appends the shoot date', async () => {
  try {
    const rel = await where({ subject: 'calisthenics', description: 'pull-ups', date: '2026-06-01' });
    assert.equal(rel, '2026/2026 - Social Media/Calisthenics/2026-06-01', `dated under the project — got ${rel}`);
  } finally { box.cleanup(); }
});

test('a byDay rule with NO date still files into the project', async () => {
  // Never invent a date folder. The project is still the right answer.
  try {
    const rel = await where({ subject: 'calisthenics', description: 'pull-ups' });
    assert.equal(rel, '2026/2026 - Social Media/Calisthenics', `no date → no date folder — got ${rel}`);
  } finally { box.cleanup(); }
});

test('it matches on description and location too, not just subject', async () => {
  // The map's haystack is subject + location + description. Matching only the subject would drop
  // every clip whose rule word he typed into the description.
  try {
    const byDesc = await where({ subject: 'misc', description: 'lawn-care at the depot', date: '2026-05-16' });
    assert.equal(byDesc, '2026/2026 - Client Work/Gourgess Lawns', `matched on description — got ${byDesc}`);
    const byLoc = await where({ subject: 'misc', description: 'b-roll', location: 'lawn', date: '2026-05-16' });
    assert.equal(byLoc, '2026/2026 - Client Work/Gourgess Lawns', `matched on location — got ${byLoc}`);
  } finally { box.cleanup(); }
});

test('⚠ a real PROJECT rule beats a DESCRIPTOR rule', async () => {
  // The map's precedence: "vlog" is how he shoots, not what the project is. A clip matching both must
  // file into the project, or every client job ends up under Vlog.
  try {
    const rel = await where({ subject: 'vlog', description: 'lawn-mowing for gourgess', date: '2026-05-16' });
    assert.equal(rel, '2026/2026 - Client Work/Gourgess Lawns', `project wins — got ${rel}`);
  } finally { box.cleanup(); }
});

test('⚠ an explicit map placement STILL beats his rules', async () => {
  // The ladder's order must not change: what he did by hand, just now, outranks a standing rule.
  try {
    const rel = await where({ subject: 'lawnmowing', date: '2026-05-16' }, { rel: '2026 - Personal' });
    assert.equal(rel, '2026 - Personal', `his placement wins — got ${rel}`);
  } finally { box.cleanup(); }
});

test('⚠ a clip NO rule claims is unaffected', async () => {
  // The subject/date behaviour he chose (2026-07-19cd) must survive untouched for everything else.
  try {
    const rel = await where({ subject: 'timelapse', description: 'sunrise', date: '2026-05-11' });
    assert.equal(rel, 'timelapse/2026-05-11', `the normal ladder — got ${rel}`);
  } finally { box.cleanup(); }
});

test('with NO rules configured, nothing changes at all', async () => {
  // A fresh install has no routes. The ladder must behave exactly as before.
  try {
    app.get('config').ai.routes = [];
    const rel = await where({ subject: 'lawnmowing', description: 'liam', date: '2026-05-16' });
    assert.equal(rel, 'lawnmowing/2026-05-16', `unchanged — got ${rel}`);
  } finally { box.cleanup(); }
});

test('⚠⚠ FILING agrees with the preview — the rule is applied for real', async () => {
  // The preview is only worth anything if the run does the same thing. Same ladder, so this is a
  // regression guard on the property rather than a hope.
  try {
    const name = '2026-05-16_lawnmowing_liam_v1.mp4';
    writeFileSync(join(box.dir, name), 'FOOTAGE');
    const scan = await app.invoke('finalize:scan', { dir: box.dir });
    const items = Array.from(scan.files).map((f) => ({ ...f }));
    const s = await app.invoke('finalize:run', {
      dir: box.dir, items,
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
    });
    assert.equal(s.moved, 1, 'it filed');
    const rel = String((Array.from(s.filedRels || [])[0] || {}).rel || '');
    assert.equal(rel, '2026/2026 - Client Work/Gourgess Lawns', `⚠ filed by his rule — got ${rel}`);
  } finally { box.cleanup(); }
});
