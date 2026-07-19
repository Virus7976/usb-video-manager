// Audit #8 slice 3 — tagging a person must survive BOTH key forms across the IPC boundary.
//
// A face cluster carries `clipKeys`: the set of clips that face appears in. Confirming a name sends
// those keys to main (`clips:tagPerson`), which matches them against the draft and finalMeta stores.
//
// Drafts are now keyed `name__size__mtime` (slice 1) while clusters saved before that carry the
// legacy `name__size`. Main matched keys by EXACT string, so a legacy cluster would match nothing:
// confirming a face would report success and tag zero clips — silently, because `tagged` is not
// surfaced anywhere the user looks.
//
// The rule, and why it is not just "compare the stem": the legacy key IS a prefix of the new one, so
// stem-matching would work — but it would also re-introduce the exact collision slice 1 removed,
// letting a tag meant for one clip land on its identically-named twin. So: match exactly when both
// keys carry an mtime, and fall back to the stem ONLY when one of them genuinely lacks it, where no
// better information exists and that is already today's behaviour.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const V1 = 'GX010042.MP4__4096';
const V2A = 'GX010042.MP4__4096__1700000000000';
const V2B = 'GX010042.MP4__4096__1700000999000';

test('#8 identical keys match', () => {
  assert.equal(app.call('clipKeyMatches', V2A, V2A), true);
  assert.equal(app.call('clipKeyMatches', V1, V1), true);
});

test('#8 a LEGACY key matches a new-key entry on the stem — old clusters still tag', () => {
  // This is the compatibility case: a cluster saved before the migration, tagging a draft written
  // after it. Without this, confirming that face tags nothing at all.
  assert.equal(app.call('clipKeyMatches', V1, V2A), true, 'legacy → v2');
  assert.equal(app.call('clipKeyMatches', V2A, V1), true, 'v2 → legacy');
});

test('#8 two DIFFERENT new keys never match — the collision stays fixed', () => {
  // Same name, same size, different shoots. Stem-matching these would undo slice 1: a person
  // confirmed on one card would be tagged onto unrelated footage from another.
  assert.equal(app.call('clipKeyMatches', V2A, V2B), false);
});

test('#8 unrelated clips never match', () => {
  assert.equal(app.call('clipKeyMatches', V2A, 'GX010099.MP4__50__1700000000000'), false);
  assert.equal(app.call('clipKeyMatches', V1, 'GX010099.MP4__50'), false);
  assert.equal(app.call('clipKeyMatches', V1, 'GX010042.MP4__9999'), false, 'same name, different size');
});

test('#8 junk keys are refused rather than matching everything', () => {
  for (const bad of ['', null, undefined]) {
    assert.equal(app.call('clipKeyMatches', bad, V2A), false, `refused: ${JSON.stringify(bad)}`);
    assert.equal(app.call('clipKeyMatches', V2A, bad), false, `refused: ${JSON.stringify(bad)}`);
  }
});

test('#8 clips:tagPerson tags a V2-keyed draft when sent a LEGACY cluster key', async () => {
  await app.invoke('drafts:save', { [V2A]: { subject: 'mowing', people: [] } });
  const r = app.plain(await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [V1] }));
  assert.equal(r.tagged, 1, 'the legacy cluster key found the migrated draft');
  const drafts = app.plain(await app.invoke('drafts:get'));
  assert.deepEqual(drafts[V2A].people, ['Josiah']);
});

test('#8 clips:tagPerson does NOT tag the collided twin', async () => {
  // Distinct fixture names: drafts:save MERGES into the store, so reusing V2A here would inherit the
  // tag from the previous test and mask what this one is actually asserting.
  const A = 'GX010777.MP4__4096__1700000000000';
  const B = 'GX010777.MP4__4096__1700000999000';
  await app.invoke('drafts:save', {
    [A]: { subject: 'mowing', people: [] },
    [B]: { subject: 'skating', people: [] },
  });
  const r = app.plain(await app.invoke('clips:tagPerson', { name: 'Beth', keys: [A] }));
  assert.equal(r.tagged, 1, 'exactly one clip tagged');
  const drafts = app.plain(await app.invoke('drafts:get'));
  assert.deepEqual(drafts[A].people, ['Beth']);
  assert.deepEqual(drafts[B].people, [], 'the identically-named clip from another card is untouched');
});
