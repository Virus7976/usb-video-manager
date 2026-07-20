// The Home card was blind to 203 files, and would have given impossible advice about them.
//
// `pending:work` counted the intake folder with `listVideosShallow` — videos only. Measured on his
// real setup: `01 - Uncompressed` holds **203 app-named photos and ZERO videos**, so the card that
// exists to tell him what is outstanding reported **nothing at all** while 203 files sat there. That
// is the "he cannot see that he has unfinished work" item, on his largest untouched pile.
//
// The second half matters more than the first. Had I simply added photos to the same counter, the
// card would have said:
//
//     "203 in Uncompressed — compress them first"
//
// and **photos are never compressed.** Tdarr takes video only; a still will sit in that folder
// forever waiting for a step that will never come. That is advice which cannot be followed, which is
// worse than silence — it explains a pile rather than clearing it.
//
// Verified before building: those 203 photos file cleanly as they are (203/203 into 10 dated folders,
// 0 errors, 2026-07-20k). So the honest line is "ready to organize now", and the button should offer
// to do it.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const intake = mkdtempSync(join(tmpdir(), 'uvd-intake-'));
  const ready = mkdtempSync(join(tmpdir(), 'uvd-ready-'));
  const cfg = app.get('config');
  cfg.intakeFolder = intake;
  cfg.finalizeSource = ready;
  cfg.projectLedger = [];
  box = { intake, ready, cleanup() { rmSync(intake, { recursive: true, force: true }); rmSync(ready, { recursive: true, force: true }); } };
});
const put = (dir, ...names) => { for (const n of names) writeFileSync(join(dir, n), 'BYTES'); };

test('⚠ photos in the intake are counted, not ignored', async () => {
  try {
    put(box.intake, '2016-01-02_vlog_kakwa-trip_v1.jpg', '2016-01-02_vlog_kakwa-trip_v2.jpg');
    const w = await app.invoke('pending:work');
    assert.equal(w.uncompressedPhotos, 2, `the stills are seen — got ${w.uncompressedPhotos}`);
  } finally { box.cleanup(); }
});

test('⚠ they are counted SEPARATELY from videos', async () => {
  // The separation is the whole point: the two need opposite advice. A single number cannot say
  // "compress these" and "file those" at once.
  try {
    put(box.intake, 'clip_v1.mp4', 'still_v1.jpg', 'still_v2.jpg');
    const w = await app.invoke('pending:work');
    assert.equal(w.uncompressed, 1, `videos counted alone — got ${w.uncompressed}`);
    assert.equal(w.uncompressedPhotos, 2, `photos counted alone — got ${w.uncompressedPhotos}`);
  } finally { box.cleanup(); }
});

test('an intake with only videos reports no photos', async () => {
  try {
    put(box.intake, 'a_v1.mp4', 'b_v1.mp4');
    const w = await app.invoke('pending:work');
    assert.equal(w.uncompressedPhotos, 0, 'no phantom photos');
    assert.equal(w.uncompressed, 2, 'and the video count is unchanged');
  } finally { box.cleanup(); }
});

test('an empty intake reports zero for both', async () => {
  try {
    const w = await app.invoke('pending:work');
    assert.equal(w.uncompressed, 0, 'no videos');
    assert.equal(w.uncompressedPhotos, 0, 'no photos');
  } finally { box.cleanup(); }
});

// --- the renderer side ---
const ui = readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('⚠⚠ the photo line never says "compress"', () => {
  // The advice that can never be followed. This is the assertion I care about most in this file.
  const line = ui.slice(ui.indexOf('const photoLine ='), ui.indexOf('const sub =', ui.indexOf('const photoLine =')));
  assert.ok(line.length > 0, 'found the photo line');
  // Match the INSTRUCTION, not the word. "Uncompressed" is the folder's name and naming his folder is
  // correct — my first version banned /compress/i outright and failed on that, which is the test
  // being imprecise rather than the code being wrong.
  assert.doesNotMatch(line, /compress (them|it) first/i, `it must not tell him to compress a photo — got ${line}`);
  assert.match(line, /ready to organize now/, 'it says what is actually true of them');
});

test('the video line still DOES say compress — that advice is right for video', () => {
  // Guard the other direction: video in the intake genuinely is waiting on Tdarr.
  const line = ui.slice(ui.indexOf('if (uncompressed) {'), ui.indexOf('const photoLine ='));
  assert.match(line, /compress/i, 'unchanged for video');
});

test('the card appears when there are ONLY photos', () => {
  // His exact case: zero videos anywhere, 203 stills. Before this the card did not render at all.
  assert.match(ui, /if \(ready \|\| uncompressed \|\| uncPhotos\) \{/, 'photos alone are enough to show the card');
});

test('and the button offers to organize them', () => {
  // A card that reports work but whose button says "Open Organize" leaves him to find it himself.
  assert.match(ui, /const cta = \(ready \|\| uncPhotos\) \? `Organize \$\{ready \|\| uncPhotos\}`/,
    'the CTA counts photos when there are no ready clips');
});
