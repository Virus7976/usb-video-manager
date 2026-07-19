// Audit #5 — two albums holding the same filename collided in the flat pull folder.
//
// A phone pull flattens every selected album into ONE destination. `IMG_0001.jpg` exists in Camera
// AND in WhatsApp AND in Downloads — extremely common. `adbPullToDest` built `path.join(dest, it.name)`
// with no collision handling, so the second item either:
//   • overwrote the first (different sizes → adb pull writes over it), or
//   • was treated as a completed RESUME and skipped (same size → `have.size === it.size`),
// leaving one irreplaceable photo silently missing and the other staged twice.
//
// Per PROMPT.md §8 the phone transports can't be driven in WSL, so the DECISION is extracted into a
// pure helper and tested directly — the branch, not the device.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('#5 a name claimed by a DIFFERENT item this run gets a fresh destination', async () => {
  const { dir, cleanup } = tempDir('coll-');
  const claimed = new Set();
  const a = await app.call('claimPullDest', dir, 'IMG_0001.jpg', claimed);
  const b = await app.call('claimPullDest', dir, 'IMG_0001.jpg', claimed);
  assert.equal(path.basename(a), 'IMG_0001.jpg', 'the first item keeps the real name');
  assert.notEqual(b, a, 'the second album\'s photo does NOT land on the first one');
  cleanup();
});

test('#5 a name NOT yet claimed this run is left alone — resume still works', async () => {
  // Critical: a file left by a PREVIOUS run must keep its exact path, or every resumed pull
  // re-downloads everything under new names and duplicates the whole card.
  const { dir, cleanup } = tempDir('coll-resume-');
  fs.writeFileSync(path.join(dir, 'IMG_0002.jpg'), 'from an earlier run');
  const p = await app.call('claimPullDest', dir, 'IMG_0002.jpg', new Set());
  assert.equal(p, path.join(dir, 'IMG_0002.jpg'), 'the resume path is untouched');
  cleanup();
});

test('#5 the claim is case-insensitive (Windows)', async () => {
  // IMG_0001.JPG and img_0001.jpg are ONE file on Windows — treating them as two would overwrite.
  const { dir, cleanup } = tempDir('coll-case-');
  const claimed = new Set();
  await app.call('claimPullDest', dir, 'IMG_0003.JPG', claimed);
  const b = await app.call('claimPullDest', dir, 'img_0003.jpg', claimed);
  assert.notEqual(path.basename(b).toLowerCase(), 'img_0003.jpg', 'the second is renamed, not collided');
  cleanup();
});

test('#5 three copies of the same name all survive', async () => {
  const { dir, cleanup } = tempDir('coll-three-');
  const claimed = new Set();
  const out = [];
  for (let i = 0; i < 3; i += 1) out.push(await app.call('claimPullDest', dir, 'IMG_0004.jpg', claimed));
  assert.equal(new Set(out).size, 3, 'Camera, WhatsApp and Downloads copies are all distinct');
  cleanup();
});

test('#5 the ADB pull actually uses the claim', async () => {
  // The helper is useless if the pull still joins the raw name — that was the bug.
  const src = fs.readFileSync(path.join(app.get('__dirname') || '.', 'main-mod/05-windows-phone.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function adbPullToDest('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /claimPullDest\(/, 'the pull routes through the claim');
  assert.equal(/const destFile = path\.join\(dest, it\.name\);/.test(body), false, 'the raw join is gone');
});
