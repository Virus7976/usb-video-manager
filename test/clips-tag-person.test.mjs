// Audit #26/#27 — confirming a face only tagged clips that happened to be IN MEMORY.
//
// `tagClips()` resolves a cluster's clipKeys through `byKey`, which is built from the renderer's
// `state.scannedFiles`. A cluster restored from faces-pending.json legitimately references clips
// from EARLIER sessions — already renamed, already filed — and those keys simply miss the lookup.
// So confirming a persisted face tagged ZERO of its other-session clips, silently. And #27: a
// first-time `assign()` never propagated at all (retag ran only on rename/merge/reassign), so a
// newly-named person was never written onto footage organized before they had a name.
//
// The renderer cannot fix this alone — the clips aren't in memory to fix. This is the missing
// backend half: tag by KEY, straight into the persisted stores.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// app.plain(): values crossing the vm boundary carry the SANDBOX's Object.prototype, so
// deepEqual fails on identity alone even when the structure matches (see AGENTS.md §7a).
const finalMeta = () => app.plain(app.get('config').finalMeta);
const drafts = () => app.plain(app.get('config').renameDrafts);
const tag = (name, keys) => app.invoke('clips:tagPerson', { name, keys });

beforeEach(() => {
  const cfg = app.get('config');
  // Two clips filed in an EARLIER session — exactly the state the renderer has no memory of.
  cfg.finalMeta = {
    'ski-run.mp4__100': { subject: 'skiing', people: ['dad'] },
    'ski-jump.mp4__200': { subject: 'skiing', people: [] },
    'unrelated.mp4__300': { subject: 'lawn', people: [] },
  };
  cfg.renameDrafts = { 'ski-run.mp4__100': { subject: 'skiing', people: [] } };
});

test('#26 tagging by key reaches clips that are not in memory', async () => {
  const r = await app.invoke('clips:tagPerson', { name: 'josiah', keys: ['ski-run.mp4__100', 'ski-jump.mp4__200'] });
  assert.equal(r.ok, true);
  assert.ok(r.tagged >= 2, `both filed clips were tagged (got ${r.tagged})`);

  assert.deepEqual(finalMeta()['ski-run.mp4__100'].people, ['dad', 'josiah'], 'added alongside the existing person');
  assert.deepEqual(finalMeta()['ski-jump.mp4__200'].people, ['josiah']);
  assert.deepEqual(finalMeta()['unrelated.mp4__300'].people, [], 'a clip outside the cluster is untouched');
});

test('#26 drafts are tagged too, so the name survives a re-open before filing', async () => {
  await tag('josiah', ['ski-run.mp4__100']);
  assert.deepEqual(drafts()['ski-run.mp4__100'].people, ['josiah']);
});

test('#26 tagging is idempotent — confirming the same face twice does not duplicate', async () => {
  await tag('josiah', ['ski-jump.mp4__200']);
  const r2 = await tag('josiah', ['ski-jump.mp4__200']);
  assert.deepEqual(finalMeta()['ski-jump.mp4__200'].people, ['josiah'], 'still exactly one entry');
  assert.equal(r2.tagged, 0, 'and it reports that nothing changed');
});

test('#26 a nameless or keyless call is refused rather than writing junk', async () => {
  assert.equal((await tag('', ['ski-run.mp4__100'])).ok, false);
  assert.equal((await tag('josiah', [])).ok, false);
  assert.deepEqual(finalMeta()['ski-run.mp4__100'].people, ['dad'], 'nothing was written');
});

test('#26 the renderer half is WIRED — tagClips forwards the cluster keys', async () => {
  // The handler above is useless if nothing calls it, and that was the entire bug: tagClips stopped
  // at the in-memory map. tagClips is a closure inside showFaceReviewGrid, so it can't be invoked
  // from a test — assert the wiring in source instead (the same approach face-scenes.test.mjs uses).
  const src = fs.readFileSync(path.join(ROOT, 'src/mod/08-people.js'), 'utf8');
  const fn = src.slice(src.indexOf('function tagClips('), src.indexOf('function untagClips('));
  assert.match(fn, /window\.api\.tagPersonOnClips\(\{ name, keys: \[\.\.\.cl\.clipKeys\] \}\)/,
    'tagClips must forward EVERY cluster key, not just the ones it resolved in memory');
});

test('#26 an unknown key is ignored, not created', async () => {
  // A cluster can reference a clip whose record has since been pruned. That must not resurrect a
  // half-empty record with nothing but a person in it.
  const r = await tag('josiah', ['never-seen.mp4__999']);
  assert.equal(r.tagged, 0);
  assert.equal(finalMeta()['never-seen.mp4__999'], undefined, 'no phantom record');
});
