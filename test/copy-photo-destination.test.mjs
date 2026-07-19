// Gitea #2 — photos copied off a CARD landed in the video intake.
//
// `copy:start` resolved ONE destination for the whole batch (`intakeFolder`), so a still from a
// GoPro or a phone card was written into `01 - Uncompressed` alongside the video. That folder is a
// watch-folder: Tdarr picks it up and tries to compress everything in it. Stills have their own
// home (`photosTempFolder`, "04 - Photos Temp") and the PHONE path already routes them there —
// `main-mod/05-windows-phone.js:230` and `src/mod/09-phone-finalize.js:403`. The card path simply
// never got the same treatment. Another sibling path missing a guard its twin already had.
//
// The scan already tells us which is which: walkForVideos tags every entry `kind: 'video' | 'photo'`
// and deliberately re-tags an iPhone Live Photo `.MOV` as a photo so the 2-3s motion clips ride with
// their stills instead of flooding the compress queue. That tag was being thrown away here.
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
const src = (dir, name, body = 'media-bytes') => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };

/** copy:start LOWER-CASES the extension when building the destination name (destNameFor), so assert
 *  on the returned destPath's directory rather than guessing the filename. */
const dirOf = (r, i = 0) => path.dirname(r.copied[i].destPath);
async function runCopy(files, intake, photos) {
  const cfg = app.get('config');
  if (photos) cfg.photosTempFolder = photos;
  return app.invoke('copy:start', { files, intakeFolder: intake });
}

test('#2 a PHOTO from a card lands in Photos Temp, not the video intake', async () => {
  const card = mk('cp-card-'); const intake = mk('cp-intake-'); const photos = mk('cp-photos-');
  const jpg = src(card, 'GOPR0001.JPG');
  const r = app.plain(await runCopy([{ sourcePath: jpg, name: 'GOPR0001.JPG', ext: '.jpg', size: fs.statSync(jpg).size, kind: 'photo' }], intake, photos));
  assert.equal(r.ok, true, 'the copy succeeded');
  assert.equal(dirOf(r), photos, 'the still is in Photos Temp');
  assert.equal(fs.readdirSync(intake).length, 0, 'and NOT in the intake Tdarr watches');
});

test('#2 a VIDEO still lands in the intake — the default path is unchanged', async () => {
  const card = mk('cp-card2-'); const intake = mk('cp-intake2-'); const photos = mk('cp-photos2-');
  const mp4 = src(card, 'GX010042.MP4');
  const r = app.plain(await runCopy([{ sourcePath: mp4, name: 'GX010042.MP4', ext: '.mp4', size: fs.statSync(mp4).size, kind: 'video' }], intake, photos));
  assert.equal(r.ok, true);
  assert.equal(dirOf(r), intake, 'video goes to the intake as before');
  assert.equal(fs.readdirSync(photos).length, 0, 'and not to Photos Temp');
});

test('#2 a MIXED card splits correctly in one copy', async () => {
  // The realistic case: a GoPro card carrying both. One batch, two destinations.
  const card = mk('cp-mix-'); const intake = mk('cp-mix-intake-'); const photos = mk('cp-mix-photos-');
  const mp4 = src(card, 'GX010050.MP4'); const jpg = src(card, 'GOPR0050.JPG');
  const r = app.plain(await runCopy([
    { sourcePath: mp4, name: 'GX010050.MP4', ext: '.mp4', size: fs.statSync(mp4).size, kind: 'video' },
    { sourcePath: jpg, name: 'GOPR0050.JPG', ext: '.jpg', size: fs.statSync(jpg).size, kind: 'photo' },
  ], intake, photos));
  assert.equal(r.ok, true);
  assert.equal(dirOf(r, 0), intake, 'video → intake');
  assert.equal(dirOf(r, 1), photos, 'photo → Photos Temp');
  assert.equal(fs.readdirSync(intake).length, 1, 'nothing extra in the intake');
  assert.equal(fs.readdirSync(photos).length, 1, 'nothing extra in Photos Temp');
});

test('#2 with NO photosTempFolder configured, photos fall back to the intake rather than vanishing', async () => {
  // Fail toward the old behaviour, never toward "copied nowhere". A still in the wrong folder is a
  // nuisance; a still the user believes was copied and cannot find is footage loss.
  const card = mk('cp-nocfg-'); const intake = mk('cp-nocfg-intake-');
  const cfg = app.get('config');
  cfg.photosTempFolder = '';
  const jpg = src(card, 'IMG_9.JPG');
  const r = app.plain(await app.invoke('copy:start', { files: [{ sourcePath: jpg, name: 'IMG_9.JPG', ext: '.jpg', size: fs.statSync(jpg).size, kind: 'photo' }], intakeFolder: intake }));
  assert.equal(r.ok, true);
  assert.equal(path.dirname(r.copied[0].destPath), intake, 'copied somewhere real');
});

test('#2 an untagged file (no kind) is treated as a video — old callers keep working', async () => {
  const card = mk('cp-untagged-'); const intake = mk('cp-untagged-intake-'); const photos = mk('cp-untagged-photos-');
  const f = src(card, 'LEGACY.MP4');
  const r = app.plain(await runCopy([{ sourcePath: f, name: 'LEGACY.MP4', ext: '.mp4', size: fs.statSync(f).size }], intake, photos));
  assert.equal(r.ok, true);
  assert.equal(dirOf(r), intake, 'no kind → intake, as before');
});
