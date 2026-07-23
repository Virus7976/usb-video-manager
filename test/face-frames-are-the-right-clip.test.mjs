// ⚠⚠ TWO CLIPS IN ONE FOLDER SHARED A FACE FRAME — and `faces:frames` would read any image on disk.
//
// Both live in the frame-extraction helpers behind face detection (`main-mod/08-finalize-feedback.js`),
// and they were never audited because the handler that showcases them (`faces:image`) has no caller.
// PROMPT.md §8h: an unreachable handler has never been audited from a live call site — but its
// HELPERS may well be live, and here they were.
//
// ── 1. THE CACHE TAG COULD NOT TELL TWO CLIPS APART ──────────────────────────────────────────────
//
//     const tag = Buffer.from(srcPath).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
//
// base64 is 4 characters per 3 bytes, so 20 characters is the first ~15 BYTES of the path. On his
// real layout that is `L:\Video\USB Au` — the filename never reaches the tag at all:
//
//     'L:\Video\USB Auto-Action\02 - Compressed\GX010042.MP4' -> TDpcVmlkZW9cVVNCIEF1
//     'L:\Video\USB Auto-Action\02 - Compressed\GX010099.MP4' -> TDpcVmlkZW9cVVNCIEF1   EQUAL
//
// `getFaceFrame` then does `if (await fsp.access(outPath)) { cache; return }` — so the SECOND clip
// gets handed the FIRST clip's frame. Faces detected there are written through `clips:tagPerson`
// into `finalMeta` AND `renameDrafts`: the wrong person's name, on the wrong footage, persisted.
// `getFaceFrames` (the live whole-clip scan) used `slice(0, 16)` for its own `fscan_` files — worse.
//
// It is reachable today: `getFaceFrames` falls back to `getFaceFrame` whenever
// `durationSec < interval` (default 2s), so every sub-2-second clip takes this path. His 458 pending
// faces are the one pipeline in this app that DOES complete, which is what makes corrupting it bad.
//
// ── 2. `faces:frames` HAD NO PATH GUARD ──────────────────────────────────────────────────────────
//
// Its `isImagePath` branch base64s the file straight back to the renderer. `poster:get` three files
// away refuses an unapproved path; this one did not. The renderer runs with `webSecurity: false`
// (deliberate — Chromium's file loader seeks HEVC over file://) while rendering filenames and
// AI-generated text the app does not control, so one XSS was arbitrary local image read. That is
// audit #95's threat model exactly, and this handler was simply missed by it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';
import { writeFileSync } from 'node:fs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const dirs = [];
const mk = (prefix) => { const d = tempDir(prefix); dirs.push(d); return d.dir; };

// The two paths from his real machine that collided. Kept verbatim: the bug is a property of THESE
// strings, and a shorter invented pair would not reproduce it.
const HIS = 'L:\\Video\\USB Auto-Action\\02 - Compressed\\';
const CLIP_A = `${HIS}GX010042.MP4`;
const CLIP_B = `${HIS}GX010099.MP4`;

test('⚠⚠ two clips in the same folder get DIFFERENT frame cache paths', () => {
  // The core defect, asserted on the tag builder itself so it cannot regress by a stray slice().
  const a = app.call('faceFrameTag', CLIP_A);
  const b = app.call('faceFrameTag', CLIP_B);
  assert.ok(a && b, 'the tag helper exists');
  assert.notEqual(a, b, `⚠⚠ two clips in one folder must not share a frame tag — both produced ${a}`);
});

test('⚠⚠ the tag depends on the FILENAME, not just the folder', () => {
  // The specific failure: a prefix-truncated encoding is stable across everything in a deep folder.
  // Deliberately uses a long shared prefix, because a short one hides the bug.
  const deep = 'C:\\Users\\jake\\Videos\\02 - Projects\\2026\\2026 - Client Work\\dennis-lawn\\';
  assert.notEqual(app.call('faceFrameTag', `${deep}A.MP4`), app.call('faceFrameTag', `${deep}B.MP4`),
    '⚠⚠ a long shared folder prefix must not swallow the filename');
});

test('⚠ the same clip still gets a STABLE tag — the cache must keep working', () => {
  // Guards the lazy fix (randomising the tag), which would make every scan re-extract every frame.
  assert.equal(app.call('faceFrameTag', CLIP_A), app.call('faceFrameTag', CLIP_A), 'stable across calls');
});

test('⚠ the tag is filesystem-safe', () => {
  // It becomes a filename. A raw path or base64 with `/` would create directories or fail to open.
  const tag = app.call('faceFrameTag', CLIP_A);
  assert.match(tag, /^[a-zA-Z0-9]+$/, `⚠ tag must be safe as a filename component — got ${tag}`);
});

// ⚠ THESE WRITE A REAL FILE. Asserting `ok === false` on a path that does not exist passes
// vacuously — the handler fails with "Could not read frames" whether or not a guard exists, so the
// first draft of these two tests was green against the unguarded code. The file has to be REAL and
// readable, so that the only thing standing between the renderer and its bytes is the guard.
const realImage = (dir, name) => {
  const p = path.join(dir, name);
  // A valid 1x1 PNG — small, and genuinely readable, which is the whole point.
  writeFileSync(p, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));
  return p;
};

test('⚠⚠ faces:frames REFUSES a REAL image under no allowed root', async () => {
  // The live arbitrary-read hole. This file exists and is readable; before the guard the handler
  // base64'd it straight back to the renderer.
  const outsider = mk('ff-outside-');
  const secret = realImage(outsider, 'private.png');
  const r = app.plain(await app.invoke('faces:frames', { sourcePath: secret }));
  assert.equal(r.ok, false, '⚠⚠ an unapproved path must be refused, not read');
  assert.ok(!(r.frames && r.frames.length), '⚠⚠ and no image data may come back');
});

test('⚠⚠ faces:frames refuses an unapproved VIDEO path too, not just images', async () => {
  // The image branch returns early, so a guard placed INSIDE it would leave the video path open.
  const outsider = mk('ff-outside-vid-');
  const r = app.plain(await app.invoke('faces:frames', { sourcePath: path.join(outsider, 'clip.mp4') }));
  assert.equal(r.ok, false, '⚠⚠ the guard must precede the isImagePath branch');
  assert.match(String(r.error || ''), /not allowed/i, '⚠ and it must say WHY, not fail generically');
});

test('⚠ a REAL image the user approved is still read', async () => {
  // The other half of audit #95: a pure allowlist would be secure and useless. Face scanning on the
  // folders he actually points the app at — including his 203 intake photos — must keep working.
  const intake = mk('ff-intake-');
  app.get('config').intakeFolder = intake;
  const photo = realImage(intake, 'IMG_0101.png');
  const r = app.plain(await app.invoke('faces:frames', { sourcePath: photo }));
  assert.equal(r.ok, true, `⚠ an approved photo must still be read — got ${r.error}`);
  assert.ok(r.frames && r.frames[0] && r.frames[0].startsWith('data:image/png;base64,'),
    '⚠ and come back as a usable data URL');
});
