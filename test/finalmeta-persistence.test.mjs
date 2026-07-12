// finalMeta — the ONLY carrier of the AI's work across the Tdarr gap.
//
// The workflow is deliberately split across sessions: copy to intake → let Tdarr compress →
// come back LATER (days, weeks, months) and organize the output folder. Everything the AI
// concluded — subject, description, people, tags, the visual observation, the confirmed
// same-shoot project — has to survive that gap.
//
// It didn't. finalMeta:save pruned entries older than 180 days and capped the store to the 5000
// most recent, on EVERY save. So coming back to a shoot seven months later, or after 5000 newer
// clips, silently found nothing: the app deleted the user's un-consumed work while he waited to
// use it. That is literally the reported "it will forget to remember things".
//
// An entry is now only evictable once finalize:run has actually FILED it (`done: true`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const DAY = 24 * 3600 * 1000;
const meta = (over = {}) => ({ subject: 'snow-walking', description: 'ridge-hike', people: ['jake'], ...over });

/** Read the live store out of the vm context. */
const store = () => app.get('config').finalMeta || {};
/** Age an entry by rewriting its ts, simulating the passage of time. */
function age(name, days) {
  const s = app.get('config').finalMeta;
  s[name.toLowerCase()].ts = Date.now() - days * DAY;
}

test('un-organized metadata survives well past the old 180-day expiry', async () => {
  await app.invoke('finalMeta:save', { 'old-shoot.mp4': meta() });
  age('old-shoot.mp4', 400);                       // came back to it over a year later

  // Any later save re-runs the prune — this is what used to quietly delete it.
  await app.invoke('finalMeta:save', { 'new-clip.mp4': meta({ subject: 'something-else' }) });

  const rec = store()['old-shoot.mp4'];
  assert.ok(rec, 'a 400-day-old UNFILED record is still there — it is unconsumed user work');
  assert.equal(rec.subject, 'snow-walking');
  assert.deepEqual(rec.people, ['jake'], 'the people the user confirmed are intact');
});

test('once a clip is FILED, its metadata becomes evictable again', async () => {
  await app.invoke('finalMeta:save', { 'filed.mp4': meta() });
  app.get('markFinalMetaDone')(['filed.mp4']);     // finalize:run consumed it
  assert.equal(store()['filed.mp4'].done, true);

  age('filed.mp4', 400);
  await app.invoke('finalMeta:save', { 'trigger.mp4': meta() });
  assert.equal(store()['filed.mp4'], undefined, 'a filed, long-expired record is pruned as before');
});

test('a pending shoot is NOT evicted to make room for newer clips', async () => {
  // The old cap kept "the 5000 most recent", so importing 5000 newer clips silently evicted an
  // older PENDING shoot. Pending work must outrank filed work when something has to go.
  const s = app.get('config').finalMeta;
  for (const k of Object.keys(s)) delete s[k];

  await app.invoke('finalMeta:save', { 'ancient-pending.mp4': meta({ subject: 'the-shoot-i-care-about' }) });
  age('ancient-pending.mp4', 900);                  // old AND unfiled

  // Bury it under a pile of newer, already-filed clips.
  const bulk = {};
  for (let i = 0; i < 400; i += 1) bulk[`bulk-${i}.mp4`] = meta({ subject: `bulk-${i}` });
  await app.invoke('finalMeta:save', bulk);
  app.get('markFinalMetaDone')(Object.keys(bulk));

  await app.invoke('finalMeta:save', { 'newest.mp4': meta() });   // re-runs the prune

  const rec = store()['ancient-pending.mp4'];
  assert.ok(rec, 'the pending shoot survived 400 newer FILED clips and 900 days');
  assert.equal(rec.subject, 'the-shoot-i-care-about');
  assert.equal(rec.done, undefined, 'and it is still marked as unconsumed work');
});

test('markFinalMetaDone only marks what it is given, and is idempotent', () => {
  const s = app.get('config').finalMeta;
  for (const k of Object.keys(s)) delete s[k];
  s['a.mp4'] = { ts: Date.now(), subject: 'a' };
  s['b.mp4'] = { ts: Date.now(), subject: 'b' };

  app.get('markFinalMetaDone')(['A.MP4']);         // keys are lower-cased
  assert.equal(s['a.mp4'].done, true);
  assert.equal(s['b.mp4'].done, undefined, 'an unrelated clip is untouched');

  app.get('markFinalMetaDone')(['a.mp4']);         // twice is harmless
  assert.equal(s['a.mp4'].done, true);
  app.get('markFinalMetaDone')(null);              // junk is harmless
  app.get('markFinalMetaDone')(['nope.mp4']);      // unknown is harmless
});

// --- the confirmed same-shoot project must reach Organize ------------------------------

test('the confirmed same-shoot project (ledgerRel) rides in finalMeta', async () => {
  // The app ASKS "Part of an existing project?", the user says yes, and it toasts "Will file N
  // clips into 'X' at the organize step". That answer lived only in renameDrafts — which are
  // DELETED right after the copy — so Organize never saw it and the clips fell into _Unsorted.
  await app.invoke('finalMeta:save', { 'clip.mp4': meta({ ledgerRel: 'Client/Alps-2026' }) });
  assert.equal(store()['clip.mp4'].ledgerRel, 'Client/Alps-2026', 'the promise is persisted');
});

test('the renderer writes ledgerRel out, and the destination map reads it back', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');

  // written into finalMeta at copy time…
  const flow = read('src/mod/09-phone-finalize.js');
  assert.match(flow, /rec\.ledgerRel = clip\._ledgerRel \|\| clip\.ledgerRel \|\| ''/, 'saveFlowFinalMeta persists it');
  // …and handed to the destination map when Organize runs later.
  assert.match(flow, /_ledgerRel: \(f\.meta && f\.meta\.ledgerRel\) \|\| ''/, 'the dest map is given it back');
  // …which is the field the map actually files on.
  assert.match(read('src/mod/07-organize-map.js'), /if \(c\._ledgerRel\)/, 'the map files on _ledgerRel');
});

// --- the file can describe itself ------------------------------------------------------

test('the embed carries a LOSSLESS record, not just the human-readable tags', () => {
  // Title merges subject+description and de-hyphenates; Description glues the observation on
  // after an em-dash. You cannot reconstruct the record from those. So we also stash the exact
  // thing, which is what lets readEmbeddedRecord give Organize a perfect answer with no guessing.
  const buildEmbedTags = app.get('buildEmbedTags');
  const tags = buildEmbedTags({
    subject: 'snow-walking', description: 'wide-ridge', location: 'chamonix',
    observation: 'a person walks a snowy ridge', people: ['jake'], tags: ['bts'], date: '2026-07-12',
  }, [], 'GX010023.MP4');

  const raw = tags['XMP-dc:Identifier'];
  assert.ok(typeof raw === 'string' && raw.startsWith('usbvd1:'), 'the record is tagged with our marker');
  const rec = JSON.parse(raw.slice('usbvd1:'.length));
  assert.equal(rec.subject, 'snow-walking', 'the subject round-trips EXACTLY — hyphens and all');
  assert.equal(rec.observation, 'a person walks a snowy ridge', 'the AI observation survives');
  assert.deepEqual(rec.people, ['jake']);
  assert.equal(rec.location, 'chamonix');

  // …and the human tags are still written for digiKam/Lightroom.
  assert.ok(tags['XMP-dc:Title'], 'human tags are unaffected');
  assert.ok(tags['XMP-iptcExt:PersonInImage'], 'people still land in the standard field');
});

test('a file with no record of ours yields nothing (we never mistake foreign metadata for ours)', async () => {
  const readEmbeddedRecord = app.get('readEmbeddedRecord');
  assert.equal(typeof readEmbeddedRecord, 'function');
  // A path that doesn't exist must degrade to null, not throw — finalize:scan runs this over
  // every unmatched file and must not blow up the whole scan on one bad read.
  assert.equal(await readEmbeddedRecord('/no/such/file.mp4'), null);
});

test('finalize:scan asks the FILE before it starts guessing from the filename', async () => {
  // Rung order matters: an exact embedded record must beat a token-overlap guess (which needs
  // only score >= 4 and CAN mis-attribute one shoot's metadata to another shoot's clip). And the
  // read must sit behind the store lookup so we only pay exiftool on a miss — precisely the
  // compressor-renamed case where it earns its cost.
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(ROOT, 'main-mod', '09-ipc-boot.js'), 'utf8');
  const scan = src.slice(src.indexOf("ipcMain.handle('finalize:scan'"));
  const body = scan.slice(0, scan.indexOf('\n});'));

  const iStore = body.indexOf('byName[lc]');
  const iEmbed = body.indexOf('readEmbeddedRecord');
  const iFuzzy = body.indexOf('bestScore >= 4');
  const iName = body.indexOf('parseNamedClip');

  assert.ok(iStore > 0 && iEmbed > 0 && iFuzzy > 0 && iName > 0, 'all four rungs are present');
  assert.ok(iStore < iEmbed, 'the free store lookup runs first — exiftool is only paid on a miss');
  assert.ok(iEmbed < iFuzzy, 'the file\'s OWN record beats a fuzzy filename guess');
  assert.ok(iFuzzy < iName, 'parsing the filename stays the last resort');
  assert.match(body, /if \(!rec && !f\.isPhoto\)/, 'the read is guarded to a store miss');
});
