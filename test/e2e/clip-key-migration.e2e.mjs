// Audit #8, slice 1 of 4 — the clip key collided, and drafts are the first store moved off it.
//
// `clipKey = name__size` is not unique. Two GoPro `GX010042.MP4` of identical size from different
// cards are the SAME key, so their drafts, people and AI observations bleed into each other — and
// renaming a clip changes its key, orphaning the draft that was just typed.
//
// The migration is deliberately rewrite-free, because these stores hold work that cannot be
// regenerated: NEW entries are written under `name__size__mtime`, every READ tries the new key then
// falls back to the legacy one, and nothing on disk is ever deleted or rewritten. That means a
// half-applied migration degrades to "reads the old entry", never to "loses it".
//
// Driven against the real renderer because these are renderer-side functions the vm harness (which
// loads main.js) cannot reach.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

test('#8 two clips with the SAME name and size get DIFFERENT keys', { skip: !RUN }, async () => {
  // The actual collision: same filename, same byte count, different cards. Before this they were one
  // key, so naming one named the other.
  const a = await read(app.win, `clipKeyV2({ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000 })`);
  const b = await read(app.win, `clipKeyV2({ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000999000 })`);
  assert.notEqual(a, b, 'different shoots are no longer the same clip');
  const legacyA = await read(app.win, `clipKey({ name: 'GX010042.MP4', size: 4096 })`);
  const legacyB = await read(app.win, `clipKey({ name: 'GX010042.MP4', size: 4096 })`);
  assert.equal(legacyA, legacyB, 'and the legacy key really did collide — this is what we fixed');
});

test('#8 a clip with no mtime falls back to the legacy key, not to a broken one', { skip: !RUN }, async () => {
  // A key containing `undefined` would be worse than a colliding one: it would vary by accident.
  for (const clip of ['{ name: "a.mp4", size: 10 }', '{ name: "a.mp4", size: 10, mtimeMs: 0 }', '{ name: "a.mp4", size: 10, mtimeMs: NaN }']) {
    const v2 = await read(app.win, `clipKeyV2(${clip})`);
    assert.equal(v2, 'a.mp4__10', `falls back cleanly for ${clip}`);
  }
});

test('#8 an EXISTING draft keyed the old way still resolves', { skip: !RUN }, async () => {
  // This is the whole safety property: everything already on Jake's disk keeps working with no
  // rewrite step. If this breaks, every draft he has ever typed is orphaned.
  const got = await read(app.win, `clipEntry({ 'GX010042.MP4__4096': { subject: 'mowing' } }, { name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000 })`);
  assert.equal(got.subject, 'mowing', 'legacy entry found via fallback');
});

test('#8 the NEW key wins when both are present', { skip: !RUN }, async () => {
  // During the transition a clip can have both. The new one is the more specific, so it must win —
  // otherwise a freshly typed name would be shadowed by a stale colliding entry.
  const got = await read(app.win, `clipEntry({
    'GX010042.MP4__4096': { subject: 'stale' },
    'GX010042.MP4__4096__1700000000000': { subject: 'fresh' }
  }, { name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000 })`);
  assert.equal(got.subject, 'fresh', 'the specific key wins over the colliding one');
});

test('#8 drafts are WRITTEN under the new key', { skip: !RUN }, async () => {
  await run(app.win, `
    state.scannedFiles = [{ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000, subject: 'mowing', description: '', selected: false }];
  `);
  const keys = await read(app.win, `Object.keys(buildDraftMap())`);
  assert.deepEqual(keys, ['GX010042.MP4__4096__1700000000000'], 'new entries carry the mtime');
});

test('#8 two same-name clips no longer share one draft entry', { skip: !RUN }, async () => {
  // The end-to-end version of the bug: name one clip, and the other must be untouched.
  await run(app.win, `
    state.scannedFiles = [
      { name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000, subject: 'mowing',  description: '', selected: false },
      { name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000999000, subject: 'skating', description: '', selected: false }
    ];
  `);
  const map = await read(app.win, `buildDraftMap()`);
  const subjects = Object.values(map).map((d) => d.subject).sort();
  assert.deepEqual(subjects, ['mowing', 'skating'], 'both survive as separate drafts');
  assert.equal(Object.keys(map).length, 2, 'two entries, not one overwriting the other');
});

test('#8 slice 2: observations read V2-then-legacy and write V2', { skip: !RUN }, async () => {
  await run(app.win, `clipObsCache = {
    'GX010042.MP4__4096': { obs: 'legacy observation', ts: 1 },
    'GX010099.MP4__50__1700000000000': { obs: 'v2 observation', ts: 2 }
  };`);
  const legacy = await read(app.win, `(clipObsFor({ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000 }) || {}).obs`);
  assert.equal(legacy, 'legacy observation', 'an observation written before the fix still resolves');
  const v2 = await read(app.win, `(clipObsFor({ name: 'GX010099.MP4', size: 50, mtimeMs: 1700000000000 }) || {}).obs`);
  assert.equal(v2, 'v2 observation', 'and new-key entries resolve directly');
});

test('#8 slice 2: two same-name clips keep SEPARATE observations', { skip: !RUN }, async () => {
  // The collision that mattered here: the AI's description of one shoot leaking onto another
  // card's identically-named clip, which then drives its name and its filing.
  await run(app.win, `clipObsCache = {};`);
  await run(app.win, `noteClipObs({ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000 }, 'mowing the front lawn');`);
  await run(app.win, `noteClipObs({ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000999000 }, 'skating at the park');`);
  const keys = await read(app.win, `Object.keys(clipObsCache).length`);
  assert.equal(keys, 2, 'two entries, not one overwriting the other');
  const a = await read(app.win, `clipObsFor({ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000 }).obs`);
  const b = await read(app.win, `clipObsFor({ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000999000 }).obs`);
  assert.equal(a, 'mowing the front lawn');
  assert.equal(b, 'skating at the park');
});
