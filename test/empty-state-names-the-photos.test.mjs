// "This folder has no video files" — over 203 photos sitting one tick away.
//
// MEASURED on his real setup (2026-07-20k): `01 - Uncompressed` holds **203 app-named .jpg stills**
// from 2016 and 2024 shoots. Photos are never compressed, so they never arrive in the
// `02 - Compressed` folder the Organize screen scans by default — and with "Include photos" unticked
// the empty state said:
//
//     This folder has no video files — choose another above.
//
// True, and useless. It cannot distinguish an empty folder from a folder full of his photos, so the
// advice it gives ("choose another") is the opposite of what would work ("tick the box"). I verified
// the payoff before building this: pointing a scan at that folder files **203/203 into 10 dated
// folders with 0 errors**. The work is one tick away and the screen was actively steering him off it.
//
// Deliberately NOT a default change — what the screen scans is his call, logged as QUESTIONS.md Q4.
// This only makes the existing situation legible: the scan now reports how many stills are present
// whether or not it lists them, and the empty state says which kind of empty it is.
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
  box = { dir: mkdtempSync(join(tmpdir(), 'uvd-empty-')), cleanup() { rmSync(this.dir, { recursive: true, force: true }); } };
});
const put = (...names) => { for (const n of names) writeFileSync(join(box.dir, n), 'BYTES'); };
const scan = (includePhotos) => app.invoke('finalize:scan', { dir: box.dir, includePhotos });

test('⚠ the scan counts photos even when it is NOT listing them', async () => {
  try {
    put('2016-01-02_vlog_kakwa-trip_v1.jpg', '2016-01-02_vlog_kakwa-trip_v2.jpg');
    const r = await scan(false);
    assert.equal(r.files.length, 0, 'none are listed — the toggle is off');
    assert.equal(r.photosHere, 2, `but the screen is told they exist — got ${r.photosHere}`);
  } finally { box.cleanup(); }
});

test('with the toggle ON the count still matches what is listed', async () => {
  try {
    put('a_v1.jpg', 'b_v1.jpg', 'c_v1.jpg');
    const r = await scan(true);
    assert.equal(r.files.length, 3, 'listed');
    assert.equal(r.photosHere, 3, 'and counted consistently');
  } finally { box.cleanup(); }
});

test('a genuinely empty folder reports zero, not a phantom', async () => {
  // The distinction the whole change exists to make. If this ever reported a non-zero count the
  // empty state would promise photos that are not there.
  try {
    const r = await scan(false);
    assert.equal(r.files.length, 0, 'nothing listed');
    assert.equal(r.photosHere, 0, `and nothing claimed — got ${r.photosHere}`);
  } finally { box.cleanup(); }
});

test('a folder with videos is unaffected', async () => {
  try {
    put('2026-03-14_vlog_kitchen_v1.mp4');
    const r = await scan(false);
    assert.equal(r.files.length, 1, 'the video lists as before');
    assert.equal(r.photosHere, 0, 'and no photos are claimed');
  } finally { box.cleanup(); }
});

// --- the renderer side ---
const ui = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('the empty state offers the tick instead of "choose another folder"', () => {
  assert.match(ui, /finScan && finScan\.photosHere/, 'it reads the count');
  assert.match(ui, /tick <b>Include photos<\/b>/, 'and names the control that would help');
});

test('the hint only appears when the photos are actually hidden', () => {
  // Three conditions, all necessary: no active search (the search empty-state has its own advice),
  // photos present, and the toggle currently OFF. Showing it with the toggle already on would be
  // advice he has already taken.
  const cond = ui.slice(ui.indexOf('const photoHint ='), ui.indexOf('li.innerHTML', ui.indexOf('const photoHint =')));
  assert.match(cond, /!q/, 'not while searching');
  assert.match(cond, /nPhotos/, 'only when photos exist');
  assert.match(cond, /!uiPrefs\.finalizePhotos/, 'and only when the toggle is off');
});

test('the original message survives for a truly empty folder', () => {
  // The fallback must still be there — a folder with nothing in it should still say so.
  assert.match(ui, /This folder has no video files — choose another above\./, 'unchanged fallback');
});

test('the count is stored on finScan so a re-render keeps the hint', () => {
  // finRenderList runs on search, filter and tick changes, not just after a scan. Reading the count
  // from the scan response alone would make the hint vanish the first time he types in the search box.
  assert.match(ui, /finScan\.photosHere = res\.photosHere \|\| 0;/, 'persisted with the scan result');
});
