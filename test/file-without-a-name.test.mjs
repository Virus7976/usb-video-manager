// THE reason the pipeline never completes: **a clip with no AI metadata cannot be filed at all.**
//
// `finalize:scan` marks each row `matched: !!rec || !!f.isPhoto` — true only when a stored record was
// found. The Organize screen then works exclusively from matched rows
// (`finMatched() = finScan.files.filter(f => f.matched)`, `finSelected()` filters that again), and
// `finalize:run` filters a third time: `items.filter((it) => it && it.meta)`.
//
// Three gates, same effect: **filing is gated on the AI having already described the clip.**
//
// On his real store that is 331 of 4594 clips — so **4263 clips, 93% of his footage, are structurally
// unfileable.** He has a project ledger of 0 and a final-meta of 1 after months of use, and this is
// why: he can only file the fraction he finished naming, and the rest simply is not offered.
//
// This is toolness items 5 and 9: *never require the AI to finish before filing*, and *"good enough"
// filing* — an unnamed clip goes to `<date>/_unsorted` rather than blocking the run. A dated folder on
// disk beats a card he never empties.
//
// DESIGN DECISIONS, each deliberate:
//  • An unnamed clip files by DATE, taken from the file's own mtime when there is no record. His
//    shoots are batches and the date is the signal that predicts the subject 88% of the time, so a
//    date folder is genuinely useful rather than a dumping ground.
//  • It lands in `_unsorted` UNDER that date, so it is obviously unfinished and easy to find later —
//    never loose in the Projects root (the "never dump to root" rule).
//  • It is NOT embedded and NOT marked done in finalMeta: there is nothing to embed, and marking it
//    consumed would let the prune evict a record that never existed. Filing must not pretend.
//  • A clip WITH metadata is unaffected — same destination, same embed, same everything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

function stage() {
  const base = mkdtempSync(join(tmpdir(), 'uvd-nofile-'));
  const src = join(base, 'Compressed'); const dest = join(base, 'Projects');
  mkdirSync(src, { recursive: true }); mkdirSync(dest, { recursive: true });
  const clip = join(src, 'GX010099.MP4');
  writeFileSync(clip, 'FOOTAGE');
  // A known shoot date on the file itself — 2026-03-14.
  const when = new Date('2026-03-14T10:00:00Z');
  utimesSync(clip, when, when);
  return { base, src, dest, clip, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const runWith = (s, items) => app.invoke('finalize:run', {
  items,
  options: { organize: true, embed: false, copy: true },
  dir: s.src,
  organizeDest: s.dest,
  folderLevels: ['category'],
});

test('a clip with NO metadata is still filed', async () => {
  const s = stage();
  try {
    const r = await runWith(s, [{ name: 'GX010099.MP4', sourcePath: s.clip }]);
    assert.equal(r.ok, true, `the run succeeded: ${r.error || ''}`);
    assert.equal(r.moved, 1, 'the unnamed clip was filed rather than silently dropped');
  } finally { s.cleanup(); }
});

test('it lands under its own DATE, in _unsorted', async () => {
  // Date from the file's mtime. His shoots are batches and the date predicts the subject 88% of the
  // time, so this is a useful folder, not a junk drawer.
  const s = stage();
  try {
    await runWith(s, [{ name: 'GX010099.MP4', sourcePath: s.clip }]);
    const landed = join(s.dest, '2026-03-14', '_unsorted', 'GX010099.MP4');
    assert.ok(existsSync(landed), `filed at <date>/_unsorted — expected ${landed}`);
  } finally { s.cleanup(); }
});

test('it is never dumped loose in the Projects root', async () => {
  // The standing rule. A clip in the root of his Projects tree is worse than one left on the card.
  const s = stage();
  try {
    await runWith(s, [{ name: 'GX010099.MP4', sourcePath: s.clip }]);
    assert.ok(!existsSync(join(s.dest, 'GX010099.MP4')), 'nothing loose in the root');
  } finally { s.cleanup(); }
});

test('an unnamed clip is NOT marked as consumed metadata', async () => {
  // markFinalMetaDone flags a record evictable. There is no record here, and pretending otherwise is
  // how a clip becomes un-organizable forever (2026-07-19ai).
  const s = stage();
  try {
    await runWith(s, [{ name: 'GX010099.MP4', sourcePath: s.clip }]);
    const store = app.plain(app.get('config').finalMeta) || {};
    assert.equal(store['gx010099.mp4'], undefined, 'no phantom record was created or consumed');
  } finally { s.cleanup(); }
});

test('a clip WITH metadata is unaffected', async () => {
  // Guard the other direction: the normal path must not change.
  const s = stage();
  try {
    const r = await runWith(s, [{
      name: 'GX010099.MP4',
      sourcePath: s.clip,
      meta: { subject: 'mowing', description: 'front lawn', category: '2026 - test' },
    }]);
    assert.equal(r.moved, 1);
    assert.ok(existsSync(join(s.dest, '2026 - test', 'GX010099.MP4')), 'named clips still file where they always did');
    assert.ok(!existsSync(join(s.dest, '2026-03-14')), 'and do not fall back to the date folder');
  } finally { s.cleanup(); }
});

test('a mixed batch files BOTH — the named and the unnamed', async () => {
  // The realistic case: 331 named and 4263 not. A run must not be all-or-nothing.
  const s = stage();
  const other = join(s.src, 'GX010100.MP4');
  writeFileSync(other, 'MORE');
  const when = new Date('2026-03-14T10:00:00Z');
  utimesSync(other, when, when);
  try {
    const r = await runWith(s, [
      { name: 'GX010099.MP4', sourcePath: s.clip, meta: { subject: 'mowing', category: '2026 - test' } },
      { name: 'GX010100.MP4', sourcePath: other },
    ]);
    assert.equal(r.moved, 2, 'both clips filed');
    assert.ok(existsSync(join(s.dest, '2026 - test', 'GX010099.MP4')), 'the named one by its category');
    assert.ok(existsSync(join(s.dest, '2026-03-14', '_unsorted', 'GX010100.MP4')), 'the unnamed one by date');
  } finally { s.cleanup(); }
});

test('the unnamed path does not mask a genuine failure', async () => {
  // A clip whose file is missing must still FAIL loudly. My first version of this test asserted
  // ok:true and was simply wrong — `didSomething` correctly reports ok:false when a run achieves
  // nothing and has errors, and letting the no-metadata path paper over that would trade one silent
  // failure for another.
  const s = stage();
  try {
    const r = await runWith(s, [{ name: 'GONE.MP4', sourcePath: join(s.src, 'MISSING.MP4') }]);
    assert.equal(r.ok, false, 'a run that filed nothing and errored says so');
    assert.ok((r.errors || []).length, 'and carries the reason');
  } finally { s.cleanup(); }
});

test('the Organize screen offers unmatched clips instead of hiding them', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const i = src.indexOf('function finMatched()');
  const fn = src.slice(i, src.indexOf('\n', src.indexOf('function finSelected()')));
  assert.ok(i > 0, 'found finMatched');
  assert.doesNotMatch(fn, /files\.filter\(\(f\) => f\.matched\)\s*;/,
    'it no longer hides every clip the AI has not described');
});

test('a clip with meta but NO folder fields still never lands in the root', async () => {
  // THE CASE MY OWN END-TO-END TEST MISSED, found by looking at his real Compressed folder.
  //
  // His 310 clips are already app-named — `2024-11-29_vlog_josiah-bedroom-timelapse_v1.mp4` — so
  // `parseNamedClip` matches them and produces `{date, subject, description}` with **category and
  // project empty**. His folderLevels are ['category','project'], so `subdirParts` returns NOTHING,
  // and the destination resolves to the bare root.
  //
  // That was harmless while the default destination was the Compressed folder the clips were already
  // in (an in-place no-op). The moment the destination became his real Projects tree (2026-07-19bm),
  // it meant **310 clips dumped loose into C:\...\2026\**. The date fallback must therefore key off
  // "we computed no folder", not off "this clip has no metadata at all".
  const s = stage();
  try {
    const r = await runWith(s, [{
      name: 'GX010099.MP4',
      sourcePath: s.clip,
      meta: { date: '2026-03-14', subject: 'vlog', description: 'josiah-bedroom', category: '', project: '' },
    }]);
    assert.equal(r.moved, 1, 'it was filed');
    assert.ok(!existsSync(join(s.dest, 'GX010099.MP4')), 'and NOT loose in the Projects root');
    assert.ok(existsSync(join(s.dest, '2026-03-14', '_unsorted', 'GX010099.MP4')),
      'it fell back to its own date, like any other clip we cannot place');
  } finally { s.cleanup(); }
});

test('the date fallback prefers the clip\'s OWN recorded date over the file mtime', async () => {
  // A parsed record carries the real shoot date; the mtime is only a last resort.
  const s = stage();
  try {
    await runWith(s, [{
      name: 'GX010099.MP4',
      sourcePath: s.clip,
      meta: { date: '2025-12-25', subject: 'vlog', description: '', category: '', project: '' },
    }]);
    assert.ok(existsSync(join(s.dest, '2025-12-25', '_unsorted', 'GX010099.MP4')),
      'filed under the date the record says, not the file timestamp');
  } finally { s.cleanup(); }
});
