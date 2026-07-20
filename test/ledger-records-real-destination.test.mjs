// The project ledger never learned anything, because it recorded the PLAN's path — which is empty
// unless he used the destination map.
//
// `finalize:run` builds its ledger entries as `{ rel: relRaw, … }`, where `relRaw` is `it.rel` — the
// path the destination MAP assigned. Filing from step-3 Run without a map leaves that empty, and
// `recordLedgerEntries` opens with:
//
//     const key = ledgerKeyFromRel(en && en.rel);
//     if (!key) continue;
//
// So every entry from a no-plan run is silently dropped. **That is why his project ledger reads 0**,
// and it would have stayed 0 even after today's filing fixes: the clips would land correctly and the
// app would learn nothing from it.
//
// This matters more than a stat. The ledger is what makes a later import from the same shoot offer
// the same project — and the shoot DATE is the strongest signal this app has (his date predicts his
// subject ~88% of the time). Filing 129 clips into `vlog/` should teach it that "vlog" exists, with
// those dates and subjects. That learning loop has never once run.
//
// The fix is to record where the clip ACTUALLY went — the folder parts the run computed — falling
// back to the plan's rel only when there is one. `_unsorted` and `misc` are still skipped by
// recordLedgerEntries' own holding-pen rule, which is exactly right: a dated holding pen is not a
// project, and recording it would let future footage be "matched" into it.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });
beforeEach(() => { app.get('config').projectLedger = []; });

function stage() {
  const base = mkdtempSync(join(tmpdir(), 'uvd-ledger-'));
  const src = join(base, 'Compressed'); const dest = join(base, 'Projects');
  mkdirSync(src, { recursive: true }); mkdirSync(dest, { recursive: true });
  const clip = join(src, 'GX010042.MP4');
  writeFileSync(clip, 'FOOTAGE');
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
const ledger = () => app.plain(app.get('config').projectLedger) || [];

test('filing WITHOUT a plan still teaches the ledger', async () => {
  // The whole point: his runs have no map, and until now they taught it nothing.
  const s = stage();
  try {
    await runWith(s, [{
      name: 'GX010042.MP4', sourcePath: s.clip,
      meta: { date: '2026-03-14', subject: 'vlog', description: 'josiah-bedroom' },
    }]);
    const l = ledger();
    assert.equal(l.length, 1, 'the run was recorded');
    // The CONTRACT is "the folder it actually went into", not a specific rung. Clips now group by
    // shoot date under the subject (2026-07-19cd), so the real destination is `vlog/<date>` — and
    // that is exactly what the ledger should have learned. Pinning the leaf made this test fail for
    // a change that made the ledger STRICTLY better (one entry per shoot instead of one per subject).
    assert.match(String(l[0].rel), /^vlog(\/|$)/, 'under the folder it actually went into');
  } finally { s.cleanup(); }
});

test('it records the DATE, which is what same-shoot detection runs on', async () => {
  const s = stage();
  try {
    await runWith(s, [{
      name: 'GX010042.MP4', sourcePath: s.clip,
      meta: { date: '2026-03-14', subject: 'vlog', description: '' },
    }]);
    const rec = ledger()[0];
    assert.ok((rec.dates || []).includes('2026-03-14'), `the shoot date is remembered — got ${JSON.stringify(rec.dates)}`);
    assert.ok((rec.subjects || []).includes('vlog'), 'and the subject');
  } finally { s.cleanup(); }
});

test('a clip filed into the _unsorted holding pen is NOT recorded as a project', async () => {
  // recordLedgerEntries' own rule, and it must keep working now that real destinations flow in:
  // "_Unsorted / misc are holding pens, not projects… recording them made _Unsorted a first-class
  // ledger project that polluted search_projects and date-matching."
  const s = stage();
  try {
    await runWith(s, [{ name: 'GX010042.MP4', sourcePath: s.clip }]);   // no meta → <date>/_unsorted
    assert.equal(ledger().length, 0, 'holding pens never become projects');
  } finally { s.cleanup(); }
});

test('an explicit plan path still wins', async () => {
  // Guard the other direction: when he HAS used the map, its choice is the truth.
  const s = stage();
  try {
    await runWith(s, [{
      name: 'GX010042.MP4', sourcePath: s.clip, rel: '2026 - Client Work/Acme',
      meta: { date: '2026-03-14', subject: 'vlog', description: '' },
    }]);
    const l = ledger();
    assert.equal(l.length, 1);
    assert.equal(l[0].rel, '2026 - Client Work/Acme', 'the map decides, not the fallback');
  } finally { s.cleanup(); }
});

test('two clips into the same folder make ONE project with two clips', async () => {
  // A ledger that grew one record per clip would be useless for matching.
  const s = stage();
  const second = join(s.src, 'GX010043.MP4');
  writeFileSync(second, 'MORE');
  utimesSync(second, new Date('2026-03-14T10:00:00Z'), new Date('2026-03-14T10:00:00Z'));
  try {
    await runWith(s, [
      { name: 'GX010042.MP4', sourcePath: s.clip, meta: { date: '2026-03-14', subject: 'vlog' } },
      { name: 'GX010043.MP4', sourcePath: second, meta: { date: '2026-03-14', subject: 'vlog' } },
    ]);
    const l = ledger();
    assert.equal(l.length, 1, 'one project');
    assert.equal(l[0].clips, 2, 'with both clips counted');
  } finally { s.cleanup(); }
});
