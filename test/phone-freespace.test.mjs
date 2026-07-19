// Sweep finding (audit #16's sibling) — `phone:pull` had no free-space preflight.
//
// The preflight existed on exactly two write paths: organize (main-mod/09-ipc-boot.js) and, since
// audit #16, the intake copy. `phone:pull` empties an entire camera roll onto disk — routinely tens
// of GB — and just started writing. Running to ENOSPC there leaves a half-pulled phone, a truncated
// file, and a full system disk.
//
// Photos and videos go to DIFFERENT destinations (Photos Temp vs _Phone Video Temp), which can sit on
// different volumes. Summing everything against one disk would be wrong in both directions, so each
// destination is checked against the bytes actually headed there.
//
// The preflight runs BEFORE any device work, so it is testable here even though §8 rules out driving
// ADB/MTP in WSL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const HUGE = 9e15;   // larger than any real volume

test('a phone pull bigger than the disk is refused before anything is written', async () => {
  const { dir, cleanup } = tempDir('ph-fs-');
  const r = await app.invoke('phone:pull', {
    device: 'Pixel',
    photoDest: dir,
    videoDest: dir,
    items: [{ name: 'IMG_0001.jpg', kind: 'photo', size: HUGE, abs: '/x/IMG_0001.jpg', rel: '' }],
  });
  assert.equal(r.ok, false, 'refused, not started');
  assert.match(r.error, /not enough room/i);
  assert.match(r.error, /GB/, 'the numbers are stated so it is actionable');
  assert.deepEqual(fs.readdirSync(dir), [], 'and nothing was written');
  cleanup();
});

test('a pull that fits is not blocked', async () => {
  // The dangerous direction: a preflight that mis-computes refuses every pull, which is worse than
  // the ENOSPC it prevents. `sim` keeps this off any real transport.
  const { dir, cleanup } = tempDir('ph-fs-ok-');
  const src = path.join(dir, 'src.jpg');
  fs.writeFileSync(src, 'photo bytes');
  const r = await app.invoke('phone:pull', {
    device: 'Pixel', sim: true, photoDest: dir, videoDest: dir,
    items: [{ name: 'IMG_0002.jpg', kind: 'photo', size: 11, abs: src, rel: '' }],
  });
  assert.notEqual(r.ok, false, `a normal pull must not be blocked: ${r.error || ''}`);
  cleanup();
});

test('the VIDEO destination is checked against the video bytes, not the photo total', async () => {
  // Photos Temp and _Phone Video Temp can be on different volumes. A huge video set must be caught
  // even when the photo side is tiny.
  const a = tempDir('ph-photos-');
  const b = tempDir('ph-videos-');
  const r = await app.invoke('phone:pull', {
    device: 'Pixel',
    photoDest: a.dir,
    videoDest: b.dir,
    items: [
      { name: 'IMG_0003.jpg', kind: 'photo', size: 10, abs: '/x/a.jpg', rel: '' },
      { name: 'VID_0001.mp4', kind: 'video', size: HUGE, abs: '/x/v.mp4', rel: '' },
    ],
  });
  assert.equal(r.ok, false, 'the video destination is checked too');
  a.cleanup(); b.cleanup();
});

test('items with no declared size never cause a false refusal', async () => {
  // A missing size counts as 0, exactly like the other two preflights — unknown must not mean "block".
  const { dir, cleanup } = tempDir('ph-fs-nosize-');
  const src = path.join(dir, 'src2.jpg');
  fs.writeFileSync(src, 'bytes');
  const r = await app.invoke('phone:pull', {
    device: 'Pixel', sim: true, photoDest: dir, videoDest: dir,
    items: [{ name: 'IMG_0004.jpg', kind: 'photo', abs: src, rel: '' }],
  });
  assert.notEqual(r.ok, false, 'unknown sizes do not block the pull');
  cleanup();
});
