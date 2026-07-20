// Filing COPIES, so the pile never visibly shrinks — and nothing says what is already done.
//
// After a successful run his 310 clips are still sitting in the Compressed folder (copy mode is the
// default, and keeping the L: archive is the whole point). `listVideosShallow` lists the top level,
// so the next time he opens Organize he sees **the same 310 rows**, with no indication that any of
// them have been filed. Doing the work does not make the pile smaller, and "Select all → Run" would
// re-file the lot.
//
// That is the difference between a tool and a thing you poke at: work you have completed should be
// visibly finished. It is toolness item 14 — *a "what's left" counter that never lies*.
//
// The project ledger already knows: `recordLedgerEntries` stores `clipNames` per project, and as of
// 2026-07-19bq it finally receives entries from his no-plan runs. So the answer to "has this clip been
// filed?" is available without any new bookkeeping — the store that was empty for months is now the
// one that makes progress visible.
//
// Deliberate: a filed clip is still LISTED (he may want to re-file after renaming it) but is not
// selected by default, so the obvious next action only touches what is genuinely left.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });
beforeEach(() => { app.get('config').projectLedger = []; });

function stage(names) {
  const base = mkdtempSync(join(tmpdir(), 'uvd-filed-'));
  const src = join(base, 'Compressed');
  mkdirSync(src, { recursive: true });
  for (const n of names) writeFileSync(join(src, n), 'FOOTAGE');
  return { base, src, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const ledgerWith = (rel, clipNames) => {
  app.get('config').projectLedger = [{
    id: 'p1', rel, name: rel, category: rel, dates: [], subjects: [], locations: [], people: [],
    samples: [], clips: clipNames.length, clipNames, summary: '', summaryClips: 0,
    firstSeen: 1, lastSeen: 1,
  }];
};

test('a clip already in the ledger is reported as filed', async () => {
  const s = stage(['2026-03-14_vlog_a_v1.mp4', '2026-03-14_vlog_b_v1.mp4']);
  try {
    ledgerWith('vlog', ['2026-03-14_vlog_a_v1.mp4']);
    const r = await app.invoke('finalize:scan', { dir: s.src });
    const byName = Object.fromEntries(r.files.map((f) => [f.name, f]));
    assert.equal(byName['2026-03-14_vlog_a_v1.mp4'].filed, true, 'the one he filed is marked');
    assert.ok(!byName['2026-03-14_vlog_b_v1.mp4'].filed, 'the one he has not is left alone');
  } finally { s.cleanup(); }
});

test('it says WHERE it was filed', async () => {
  // "Filed" on its own invites "…where?". The ledger knows, so answer it.
  const s = stage(['2026-03-14_vlog_a_v1.mp4']);
  try {
    ledgerWith('vlog', ['2026-03-14_vlog_a_v1.mp4']);
    const r = await app.invoke('finalize:scan', { dir: s.src });
    assert.equal(r.files[0].filedIn, 'vlog', 'the project it went into');
  } finally { s.cleanup(); }
});

test('the scan reports how many are left to do', async () => {
  // The counter that must never lie: this is the number that should shrink as he works.
  const s = stage(['a_v1.mp4', 'b_v1.mp4', 'c_v1.mp4']);
  try {
    ledgerWith('vlog', ['a_v1.mp4', 'b_v1.mp4']);
    const r = await app.invoke('finalize:scan', { dir: s.src });
    assert.equal(r.filedCount, 2, 'two already done');
    assert.equal(r.total - r.filedCount, 1, 'one left');
  } finally { s.cleanup(); }
});

test('an empty ledger means nothing is claimed as filed', async () => {
  // Guard the other direction: before he has filed anything, no row may claim otherwise.
  const s = stage(['a_v1.mp4', 'b_v1.mp4']);
  try {
    const r = await app.invoke('finalize:scan', { dir: s.src });
    assert.equal(r.filedCount, 0, 'nothing filed yet');
    assert.ok(r.files.every((f) => !f.filed), 'and no row says it was');
  } finally { s.cleanup(); }
});

test('a clip filed under one project is not confused with another', async () => {
  const s = stage(['shared_v1.mp4']);
  try {
    app.get('config').projectLedger = [
      { id: 'p1', rel: 'vlog', name: 'vlog', clipNames: ['other.mp4'], clips: 1, dates: [], subjects: [], locations: [], people: [], samples: [], firstSeen: 1, lastSeen: 1 },
      { id: 'p2', rel: 'lawn-mowing', name: 'lawn-mowing', clipNames: ['shared_v1.mp4'], clips: 1, dates: [], subjects: [], locations: [], people: [], samples: [], firstSeen: 1, lastSeen: 1 },
    ];
    const r = await app.invoke('finalize:scan', { dir: s.src });
    assert.equal(r.files[0].filedIn, 'lawn-mowing', 'the right project is named');
  } finally { s.cleanup(); }
});

test('a broken ledger never breaks the scan', async () => {
  const s = stage(['a_v1.mp4']);
  try {
    app.get('config').projectLedger = null;
    const r = await app.invoke('finalize:scan', { dir: s.src });
    assert.equal(r.ok, true, 'the scan still works');
    assert.equal(r.filedCount, 0);
  } finally { s.cleanup(); }
});
