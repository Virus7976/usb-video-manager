// #57: an iPhone Live Photo is a HEIC/JPG still + a same-named .MOV motion clip. The .MOV was
// classified as a real video and pushed into the Tdarr intake, flooding the archive/compress queue
// with 2-3s clips beside every picture. It's now classified as a PHOTO (rides to Photos Temp).
// #9-boot: AI config defaults now include learnFromAnalysis/faceInterval/faceMaxFrames.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'livephoto-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('#57 a .MOV paired with a same-name still is a Live Photo (kind=photo); a lone .MOV is a video', async () => {
  writeFileSync(join(dir, 'IMG_0001.HEIC'), 'still');
  writeFileSync(join(dir, 'IMG_0001.MOV'), 'motion');   // Live Photo sidecar
  writeFileSync(join(dir, 'realclip.mov'), 'video');     // an ordinary video, no still
  writeFileSync(join(dir, 'photo.jpg'), 'jpg');
  const files = await app.call('walkForVideos', dir);
  const byName = {}; for (const f of files) byName[f.name.toLowerCase()] = f.kind;
  assert.equal(byName['img_0001.mov'], 'photo', 'Live Photo .MOV classified as photo');
  assert.equal(byName['realclip.mov'], 'video', 'a real video stays a video');
  assert.equal(byName['img_0001.heic'], 'photo');
  assert.equal(byName['photo.jpg'], 'photo');
});

test('#9-boot AI defaults include learnFromAnalysis / faceInterval / faceMaxFrames', () => {
  // Fresh defaults are what a new install seeds; the values exist rather than only appearing via clamps.
  const ai = app.get('config').ai || {};
  assert.equal(ai.learnFromAnalysis, true);
  assert.equal(ai.faceInterval, 2);
  assert.equal(ai.faceMaxFrames, 24);
});
