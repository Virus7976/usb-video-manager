// `phone:distribute` embedded the AI's record into the SOURCE photo — and for the card flow that
// source is the file ON THE CARD, before any copy of it existed.
//
// The loop, and its own comment:
//     // The source is a working staging copy (Photos Temp / a pulled temp), NEVER the phone
//     // original, so this respects "organize copies, never the archive original"
//     await getExifTool().write(j.src, tags, ['-overwrite_original']);
//
// True of the PHONE caller — `phone:pull` has already pulled the stills to Photos Temp. False of the
// CARD caller: `distributeFlowPhotos` builds its jobs with `src: p.sourcePath`
// (src/mod/09-phone-finalize.js), and for a GoPro/SD scan that path is on the card. Second-caller
// drift, with the comment documenting the first caller's world.
//
// This is the project's one hard rule pointed the wrong way: the card is read-only until copies
// provably exist elsewhere. A clip in the identical position is never written to — embedding for
// video happens later, on the intake copy. A still gets `-overwrite_original` applied to the only
// copy in existence, on removable media.
//
// ⚠ THE FIX CANNOT SIMPLY EMBED THE DESTINATIONS INSTEAD. The collision guard a few lines below
// full-hashes `j.src` against `j.dest` to tell a genuine re-run from a name collision:
//     identical = await fingerprintsMatch(j.src, j.dest, { full: true });
//     if (!identical) j.dest = await uniqueDest(…);
// Embedding the copies but not the source would make every re-run see a mismatch and litter the
// backup with _v2/_v3. So the photo is STAGED off the card first, the staged copy is embedded, and
// every job copies from there — src and dest stay byte-identical, exactly as before.
//
// The results still report the ORIGINAL card path, because the renderer matches on it
// (`landed.has(p.sourcePath)`) to decide which photos may later be cleared off the card. Reporting a
// staging path there would break that match — safely (nothing gets deleted), but it would break it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

function stage({ removable }) {
  const base = mkdtempSync(join(tmpdir(), 'uvd-photo-'));
  const card = join(base, 'DCIM'); const dest = join(base, 'PhotosTemp');
  mkdirSync(card, { recursive: true }); mkdirSync(dest, { recursive: true });
  const photo = join(card, 'GOPR0042.JPG');
  writeFileSync(photo, 'JPEGBYTES');
  app.get(`isOnRemovableVolume = function () { return Promise.resolve(${removable ? 'true' : 'false'}); }`);
  // Record every path exiftool is asked to write, and actually mutate it so byte-equality is real.
  app.get(`__embedded = [];`);
  app.get(`getExifTool = function () {
    return { write: async (target) => {
      __embedded.push(String(target));
      require('node:fs').appendFileSync(String(target), 'XMP');
    } };
  }`);
  return { base, card, photo, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const embedded = () => app.plain(app.get('__embedded')) || [];

// The handler destructures `{ jobs }` from the payload — passing the array bare made it return
// early with no `results`, so test 1 "passed" while nothing ran at all.
const distribute = (s) => app.invoke('phone:distribute', {
  jobs: [{ src: s.photo, dest: join(s.dest, 'mowing.JPG'), meta: { subject: 'mowing', description: 'front lawn' } }],
});

test('a photo on the CARD is never written to', async () => {
  const s = stage({ removable: true });
  try {
    const r = await distribute(s);
    assert.ok(r.ok, `the backup still succeeded: ${r.error || ''}`);
    assert.ok(!embedded().includes(s.photo), 'exiftool was never pointed at the card original');
    assert.equal(readFileSync(s.photo, 'utf8'), 'JPEGBYTES', 'and the card file is byte-for-byte untouched');
  } finally { s.cleanup(); }
});

test('the copy still carries the embedded record', async () => {
  // Staging must not mean losing the metadata — that was the whole point of embedding at all.
  const s = stage({ removable: true });
  try {
    const r = await distribute(s);
    const landed = r.results[0].dest;
    assert.ok(existsSync(landed), 'the photo was backed up');
    assert.match(readFileSync(landed, 'utf8'), /XMP/, 'and it carries the AI record');
  } finally { s.cleanup(); }
});

test('the result reports the ORIGINAL card path, not the staging path', async () => {
  // The renderer matches results back to clips with `landed.has(p.sourcePath)` to decide which
  // photos may later be cleared off the card. A staging path there breaks that match.
  const s = stage({ removable: true });
  try {
    const r = await distribute(s);
    assert.equal(r.results[0].src, s.photo, 'the caller can still match this result to its clip');
  } finally { s.cleanup(); }
});

test('a re-run is still recognised as a re-run, not a collision', async () => {
  // src and dest must stay byte-identical or the full-hash guard versions every retry into _v2/_v3.
  const s = stage({ removable: true });
  try {
    const first = await distribute(s);
    const landedOnce = first.results[0].dest;
    const second = await distribute(s);
    assert.equal(second.results[0].dest, landedOnce, 'the same destination, not a _v2 duplicate');
  } finally { s.cleanup(); }
});

test('a NON-removable source is still embedded in place', async () => {
  // The phone flow already stages to Photos Temp, so embedding its source once is correct and
  // cheaper. This fix must not change that path.
  const s = stage({ removable: false });
  try {
    await distribute(s);
    assert.ok(embedded().includes(s.photo), 'the staging copy is embedded directly, as before');
  } finally { s.cleanup(); }
});

test('an embed failure never blocks the backup', async () => {
  const s = stage({ removable: true });
  try {
    app.get(`getExifTool = function () { return { write: async () => { throw new Error('nope'); } }; }`);
    const r = await distribute(s);
    assert.ok(r.ok, 'the photo is still backed up');
    assert.ok(existsSync(r.results[0].dest), 'and really landed');
  } finally { s.cleanup(); }
});
