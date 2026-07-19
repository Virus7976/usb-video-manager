// The #8 key migration DOUBLED the drafts store the first time it ran on real data.
//
// Observed on Jake's actual machine immediately after deploying: 4594 drafts became 9188, and 331
// typed names became 662 — every clip now carrying BOTH a legacy `name__size` entry and a new
// `name__size__mtime` one, with identical contents.
//
// It is the migration behaving exactly as designed, and the design was incomplete. "Rewrite-free"
// (`NEW entries are written under the V2 key, every READ falls back to the legacy one, nothing on
// disk is deleted or rewritten`) is safe in isolation — but `writeDrafts` MERGES into the existing
// store, so the first save after the migration went live added a second entry for every clip instead
// of replacing one. Reads still resolve correctly (V2 first, then legacy), so nothing was lost or
// mis-read; the store simply doubled.
//
// Why that matters rather than being cosmetic: it took the store to 9188 of DRAFTS_CAP 10000 — 92%
// full, 812 entries of headroom. The next card starts evicting. The named-first rule added earlier
// today means the 662 TYPED names are shed last and are safe, but flag-only entries (`facesScanned`)
// would churn, and a clip whose scanned-flag is evicted gets re-scanned — GPU time for nothing.
//
// The fix is a per-write SUPERSEDE, not the cleanup pass the notes rightly forbid: when we write a V2
// entry we drop the legacy twin it replaces. No sweep over the store, no rewrite of entries nobody
// touched — a legacy entry only disappears at the moment its V2 replacement is written.
//
// ⚠ THE ONE UNSAFE CASE, guarded explicitly: the legacy key is AMBIGUOUS — two clips with the same
// name and size share it. So a legacy entry may hold a name typed for a DIFFERENT clip. A V2 write
// therefore never removes a NAMED legacy entry unless the entry replacing it is also named. Losing a
// duplicate is housekeeping; losing a typed name is the thing this whole area exists to prevent.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

beforeEach(() => { app.get('config').renameDrafts = {}; });
const drafts = () => app.plain(app.get('config').renameDrafts) || {};

test('writing a V2 draft removes the legacy twin it replaces', async () => {
  app.get('config').renameDrafts = { 'GX010042.MP4__4096': { subject: 'mowing', description: 'front lawn', ts: 1 } };
  await app.invoke('drafts:save', {
    'GX010042.MP4__4096__1700000000000': { subject: 'mowing', description: 'front lawn' },
  });
  const d = drafts();
  assert.ok(d['GX010042.MP4__4096__1700000000000'], 'the V2 entry is there');
  assert.equal(d['GX010042.MP4__4096'], undefined, 'and the legacy duplicate is gone');
  assert.equal(Object.keys(d).length, 1, 'one entry per clip, not two');
});

test('the surviving entry keeps the typed name', async () => {
  app.get('config').renameDrafts = { 'A.MP4__10': { subject: 'skating', description: 'at the park', ts: 1 } };
  await app.invoke('drafts:save', { 'A.MP4__10__1700000000000': { subject: 'skating', description: 'at the park' } });
  const d = drafts();
  assert.equal(d['A.MP4__10__1700000000000'].subject, 'skating');
  assert.equal(d['A.MP4__10__1700000000000'].description, 'at the park');
});

test('a NAMED legacy entry is NOT dropped for an unnamed V2 one', async () => {
  // The ambiguity guard. The legacy key can't tell two same-name-same-size clips apart, so that entry
  // may hold a name typed for the other one. A flag-only write must never displace it.
  app.get('config').renameDrafts = { 'B.MP4__20': { subject: 'important name', description: '', ts: 1 } };
  await app.invoke('drafts:save', { 'B.MP4__20__1700000000000': { subject: '', description: '', facesScanned: true } });
  const d = drafts();
  assert.ok(d['B.MP4__20'], 'the typed name survives');
  assert.equal(d['B.MP4__20'].subject, 'important name');
});

test('an unnamed legacy entry IS superseded by a flag-only V2 write', async () => {
  // Nothing of the user's is in it, so keeping both is pure bloat — this is the case that produced
  // 8526 of the 9188 entries.
  app.get('config').renameDrafts = { 'C.MP4__30': { subject: '', description: '', facesScanned: true, ts: 1 } };
  await app.invoke('drafts:save', { 'C.MP4__30__1700000000000': { subject: '', description: '', facesScanned: true } });
  const d = drafts();
  assert.equal(d['C.MP4__30'], undefined, 'the empty legacy entry is gone');
  assert.equal(Object.keys(d).length, 1);
});

test('a different clip\'s legacy entry is untouched', async () => {
  app.get('config').renameDrafts = {
    'D.MP4__40': { subject: 'keep me', description: '', ts: 1 },
    'E.MP4__50': { subject: '', description: '', ts: 1 },
  };
  await app.invoke('drafts:save', { 'E.MP4__50__1700000000000': { subject: '', description: '' } });
  const d = drafts();
  assert.ok(d['D.MP4__40'], 'an unrelated clip keeps its entry');
  assert.equal(d['D.MP4__40'].subject, 'keep me');
});

test('a legacy-only save does not delete anything', async () => {
  // Saving under a legacy key (a clip with no usable mtime) must not remove itself.
  app.get('config').renameDrafts = {};
  await app.invoke('drafts:save', { 'F.MP4__60': { subject: 'legacy write', description: '' } });
  const d = drafts();
  assert.ok(d['F.MP4__60'], 'the legacy write survives');
});

test('this is a per-write supersede, NOT a sweep of the store', async () => {
  // The notes are explicit that #8 must stay rewrite-free: a cleanup pass over untouched entries is
  // exactly what must not happen. Entries nobody wrote to are left alone.
  // RECENT timestamps: `ts: 1` is 1970, and the 60-day age prune correctly sheds an unnamed entry
  // that old — which would fail this test for a reason that has nothing to do with the supersede.
  const now = Date.now();
  app.get('config').renameDrafts = {
    'G.MP4__70': { subject: 'untouched', description: '', ts: now },
    'H.MP4__80': { subject: '', description: '', ts: now },
  };
  await app.invoke('drafts:save', { 'Z.MP4__99__1700000000000': { subject: 'new', description: '' } });
  const d = drafts();
  assert.ok(d['G.MP4__70'], 'untouched legacy entries remain');
  assert.ok(d['H.MP4__80'], 'including unnamed ones');
});
