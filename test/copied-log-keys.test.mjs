// Audit #8 final slice — copiedLog across the key migration.
//
// copiedLog answers "have I already copied this clip off the card, and where did it land?" Its own
// comment records why it exists: without it "the Delete step was a silent no-op and the only way to
// clear a card was to COPY THE WHOLE THING AGAIN".
//
// That makes it the one store in this migration sitting on the delete path, so it moved last and
// alone. The asymmetry that matters:
//
//   a key MISS  → the clip looks un-copied → the card can't be cleared → annoying, SAFE
//   a key BLEED → a different clip looks copied → the gate is asked about the wrong pair → NOT safe
//
// A `name__size` collision is exactly a bleed: two identically-sized GX010042.MP4 from different
// cards would share one entry, so copying one could mark the other as safely copied. The tests below
// pin the miss-is-safe direction explicitly rather than trusting it.
//
// (verifyCopyPair re-hashes at delete time and fails closed, so the gate itself is not at risk even
// if this were wrong — but "another layer would catch it" is not a reason to leave it wrong.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const dirs = [];
const mk = (p) => { const d = tempDir(p); dirs.push(d); return d.dir; };
/** A real destination file, because copied:get prunes entries whose dest has vanished. */
function dest(dir, name) { const p = path.join(dir, name); fs.writeFileSync(p, 'copied'); return p; }

test('#8 a LEGACY-keyed copy record is found when asked with the new key', async () => {
  // The upgrade case: the card was copied before the migration, the app now asks with the new key.
  // A miss here means "not copied yet" — so the Delete step would refuse to clear a card whose
  // footage IS safely on disk, and the only cure would be copying it all again.
  const d = mk('cl-legacy-');
  await app.invoke('copied:record', [{ key: 'GX010042.MP4__4096', source: 'E:/GX010042.MP4', dest: dest(d, 'a.mp4'), name: 'GX010042.MP4' }]);
  const log = app.plain(await app.invoke('copied:get', ['GX010042.MP4__4096__1700000000000']));
  assert.ok(log['GX010042.MP4__4096__1700000000000'], 'found, and keyed by what the caller ASKED for');
  assert.match(log['GX010042.MP4__4096__1700000000000'].dest, /a\.mp4$/);
});

test('#8 a NEW-keyed record is found when asked with the same new key', async () => {
  const d = mk('cl-v2-');
  const k = 'GX010055.MP4__4096__1700000000000';
  await app.invoke('copied:record', [{ key: k, source: 'E:/GX010055.MP4', dest: dest(d, 'b.mp4'), name: 'GX010055.MP4' }]);
  const log = app.plain(await app.invoke('copied:get', [k]));
  assert.ok(log[k], 'exact match still works');
});

test('#8 THE SAFETY PROPERTY: one card being copied never marks its collided twin as copied', async () => {
  // Same name, same size, different shoots. Before the migration these shared one entry, so copying
  // A made B look copied — and B is the one that would then be cleared off its card unverified.
  const d = mk('cl-twin-');
  const A = 'GX010077.MP4__4096__1700000000000';
  const B = 'GX010077.MP4__4096__1700000999000';
  await app.invoke('copied:record', [{ key: A, source: 'E:/A/GX010077.MP4', dest: dest(d, 'A.mp4'), name: 'GX010077.MP4' }]);
  const log = app.plain(await app.invoke('copied:get', [A, B]));
  assert.ok(log[A], 'the copied one is reported');
  assert.equal(log[B], undefined, 'the OTHER card is NOT reported as copied — this is the whole point');
});

test('#8 asking about an unknown clip returns nothing, not someone else\'s record', async () => {
  const d = mk('cl-unknown-');
  await app.invoke('copied:record', [{ key: 'GX010088.MP4__4096__1700000000000', source: 'E:/x', dest: dest(d, 'c.mp4'), name: 'x' }]);
  const log = app.plain(await app.invoke('copied:get', ['TOTALLY-OTHER.MP4__99__1700000000000']));
  assert.deepEqual(log, {}, 'a miss is empty — never a near-miss match');
});

test('#8 copied:forget clears a record whichever key form it is asked with', async () => {
  // Undo/re-copy paths call this. If forget misses, the app keeps believing a clip is copied when it
  // is not — the dangerous direction — so it must match as permissively as get does.
  const d = mk('cl-forget-');
  await app.invoke('copied:record', [{ key: 'GX010099.MP4__4096', source: 'E:/y', dest: dest(d, 'd.mp4'), name: 'y' }]);
  await app.invoke('copied:forget', ['GX010099.MP4__4096__1700000000000']);
  // Ask with the LEGACY key. Asking with the new key would pass even if forget did nothing, because
  // a broken get would miss the legacy record too — an empty result for two different reasons. This
  // is the only form that actually proves the record is gone.
  const log = app.plain(await app.invoke('copied:get', ['GX010099.MP4__4096']));
  assert.deepEqual(log, {}, 'the legacy record was forgotten via the new key');
});

test('#8 copied:forget does NOT clear the collided twin', async () => {
  const d = mk('cl-forget-twin-');
  const A = 'GX010111.MP4__4096__1700000000000';
  const B = 'GX010111.MP4__4096__1700000999000';
  await app.invoke('copied:record', [
    { key: A, source: 'E:/A', dest: dest(d, 'e.mp4'), name: 'n' },
    { key: B, source: 'E:/B', dest: dest(d, 'f.mp4'), name: 'n' },
  ]);
  await app.invoke('copied:forget', [A]);
  const log = app.plain(await app.invoke('copied:get', [A, B]));
  assert.equal(log[A], undefined, 'the requested one is gone');
  assert.ok(log[B], 'the other card still knows its footage is copied');
});
