// The 4th face-scan durability defect: the "already scanned" flag never survived a scan started
// from the Organize/Finalize screen.
//
// `flushDraftSave()` -> `buildDraftMap()` walks ONLY `state.scannedFiles` (src/mod/01-core.js) and
// bails entirely when that array is empty. On Finalize the clips come from `finScan.files`, already
// renamed — so `clipKey` (`name__size`) no longer matches the source-scan key, the lookup misses,
// and the flag is written to nothing durable. Next session every clip re-scans: on a 4594-clip card
// that is hours of GPU time thrown away.
//
// `currentSelectedClips()` already READS `f.meta.facesScanned` — but nothing in the codebase ever
// wrote it, so that read was dead. This pins the durable channel it needs: finalMeta is keyed by
// FILE NAME (not the fingerprint), which is exactly what survives the rename, and `finalMeta:save`
// merges rather than replaces so writing the flag can't clobber a clip's real metadata.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('#4 finalMeta carries facesScanned across a save/read round-trip', async () => {
  await app.invoke('finalMeta:save', { 'clip-a.mp4': { subject: 'mowing', facesScanned: true } });
  const back = app.plain(await app.invoke('finalMeta:get'));
  assert.equal(back['clip-a.mp4'].facesScanned, true, 'the flag persists');
  assert.equal(back['clip-a.mp4'].subject, 'mowing', 'alongside the real metadata');
});

test('#4 writing the flag MERGES — it must not wipe metadata the analyze pass already produced', async () => {
  await app.invoke('finalMeta:save', { 'clip-b.mp4': { subject: 'skating', description: 'rail slide', people: ['Josiah'] } });
  // This is what the renderer does after scanning faces on a Finalize-screen clip: it re-saves the
  // clip's meta with the flag added. If save REPLACED instead of merging, an unlucky ordering here
  // would silently drop the description and people the AI just wrote.
  await app.invoke('finalMeta:save', { 'clip-b.mp4': { subject: 'skating', description: 'rail slide', people: ['Josiah'], facesScanned: true } });
  const back = app.plain(await app.invoke('finalMeta:get'));
  assert.equal(back['clip-b.mp4'].facesScanned, true);
  assert.equal(back['clip-b.mp4'].description, 'rail slide', 'description survived');
  assert.deepEqual(back['clip-b.mp4'].people, ['Josiah'], 'people survived');
});

test('#4 a clip never scanned has no flag, so it is not mistaken for done', async () => {
  await app.invoke('finalMeta:save', { 'clip-c.mp4': { subject: 'vlog' } });
  const back = app.plain(await app.invoke('finalMeta:get'));
  assert.ok(!back['clip-c.mp4'].facesScanned, 'absent, not accidentally truthy');
});
