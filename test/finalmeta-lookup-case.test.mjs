// A clip he had NAMED came back from the Organize scan as "no metadata".
//
// `finalize:scan` builds its lookup from the saved-metadata store:
//
//     for (const [k, v] of Object.entries(store)) { byName[k] = v; byStem[stemOf(k)] = v; }
//
// and then looks records up with a LOWERCASED filename:
//
//     const lc = f.name.toLowerCase();
//     let rec = byName[lc] || byStem[stemOf(lc)] || null;
//
// So the index could only ever match a record whose filename was already entirely lowercase.
// Records are written under `finalName(clip)` — the real filename — and his are GoPro clips that
// keep their capitals (`GX010042.MP4`). Every one of them missed.
//
// The failure is silent and it mimics a legitimate state: `matched: false` is exactly what a clip
// the AI never described looks like. So the screen said "0 with metadata" for footage he had spent
// real time naming, the fuzzy/filename ladder below quietly took over, and the rich record —
// people, observation, location, the route that decides WHERE it files — was never applied.
//
// ⚠ SCOPE, corrected after the fact: `finalMeta:save` writes `store[name.toLowerCase()]`, and every
// other reader and writer normalises the same way — his real store confirms it (1 entry, lowercase).
// So this was NOT reaching his data, and the paragraph above describes a latent inconsistency rather
// than an observed failure. It is still worth closing: an index that is looked up lowercased should
// be built lowercased, and a store written by an older version, edited by hand, or restored from a
// backup is not bound by today's write path. Keeping the test, downgrading the claim.
//
// Found while writing an end-to-end embed test, where I hand-seeded a key in a case the app itself
// never produces — which is exactly why it looked like a live bug for longer than it should have.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'uvd-case-'));
  // The three cases that matter: his GoPro name, a lowercase name, and a mixed one.
  for (const n of ['GX010042.MP4', 'quiet-clip.mp4', 'Sunset_Beach.MOV']) writeFileSync(join(dir, n), 'FOOTAGE');
  const cfg = app.get('config');
  cfg.finalMeta = {
    'GX010042.MP4': { subject: 'liam', description: 'skate park', people: ['Liam'], date: '2026-03-14', done: true, ts: 1 },
    'quiet-clip.mp4': { subject: 'vlog', description: 'kitchen chat', date: '2026-03-15', done: true, ts: 1 },
    'Sunset_Beach.MOV': { subject: 'family', description: 'golden hour', date: '2026-03-16', done: true, ts: 1 },
  };
  box = { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

test('a GoPro clip with capitals finds its saved record', async () => {
  try {
    const r = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
    const f = ((r && r.files) || []).find((x) => x.name === 'GX010042.MP4');
    assert.ok(f, 'the clip is listed');
    assert.equal(f.matched, true, 'and it is matched — this is the "N with metadata" count on screen');
    assert.equal(f.matchType, 'saved', `from the SAVED record, not the filename fallback — got ${f.matchType}`);
  } finally { box.cleanup(); }
});

test('the rich fields actually come through, not just a match flag', async () => {
  // A match that produced an empty record would still tick `matched` — and the fields below are
  // exactly what decides where the clip files and who is in it.
  try {
    const r = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
    const f = ((r && r.files) || []).find((x) => x.name === 'GX010042.MP4');
    assert.equal(f.meta.description, 'skate park', 'the description he wrote');
    assert.deepEqual(f.meta.people, ['Liam'], 'and the people on it');
  } finally { box.cleanup(); }
});

test('a mixed-case name matches too', async () => {
  try {
    const r = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
    const f = ((r && r.files) || []).find((x) => x.name === 'Sunset_Beach.MOV');
    assert.equal(f.matchType, 'saved', `mixed case is not a special case — got ${f.matchType}`);
  } finally { box.cleanup(); }
});

test('the all-lowercase case that always worked still works', async () => {
  // Guard the other direction: this is the only shape that matched before, and it must not regress.
  try {
    const r = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
    const f = ((r && r.files) || []).find((x) => x.name === 'quiet-clip.mp4');
    assert.equal(f.matchType, 'saved', `unchanged — got ${f.matchType}`);
  } finally { box.cleanup(); }
});

test('a clip with NO record is still honestly reported as unmatched', async () => {
  // The bug made named clips look unnamed. The fix must not make unnamed clips look named — that
  // would be worse, since an unnamed clip is supposed to file into a dated holding pen.
  try {
    writeFileSync(join(box.dir, 'NEVER_SEEN.MP4'), 'FOOTAGE');
    const r = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
    const f = ((r && r.files) || []).find((x) => x.name === 'NEVER_SEEN.MP4');
    assert.ok(f, 'it is listed — every clip is fileable');
    assert.notEqual(f.matchType, 'saved', `no saved record is invented for it — got ${f.matchType}`);
  } finally { box.cleanup(); }
});

test('the stem index is normalised too, not just the name index', async () => {
  // byStem is the fallback for a compressor that changed the extension. Fixing only byName would
  // leave the same bug one line down, which is how a half-fix survives a green suite.
  try {
    writeFileSync(join(box.dir, 'GX010042.mkv'), 'FOOTAGE');
    const r = await app.invoke('finalize:scan', box.dir, { includePhotos: false });
    const f = ((r && r.files) || []).find((x) => x.name === 'GX010042.mkv');
    assert.ok(f && f.matched, 'a re-encoded clip still finds the record written for its original');
  } finally { box.cleanup(); }
});
