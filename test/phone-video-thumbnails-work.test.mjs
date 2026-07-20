// ⚠⚠ A LIVE BUG, FOUND IN HIS ACTUAL LOG RATHER THAN IN THE CODE.
//
// `app.log` holds **3,648** consecutive lines, still arriving the day this was written:
//
//     WARN: [guard] poster:get refused a path outside every allowed root:
//       L:\Videos\02 - Projects\Compression\_Phone Video Temp\20260716_215526.mp4
//
// Every thumbnail request for a staged phone video was refused. He has been naming phone footage
// with NO preview images at all — and 7% of his 4,594 clips are named. A person cannot name footage
// they cannot see, so this is not a cosmetic guard message; it is plausibly part of why the naming
// step stalls.
//
// THE SHAPE, which is the one this codebase produces most often: `photosTempFolder` is a real config
// key, so it was pushed into allowedRoots. Its VIDEO twin is DERIVED in the renderer
// (`phoneStagingDests`: `<intake parent>/_Phone Video Temp`) and never stored anywhere, so nothing
// ever added it. Photos got thumbnails; videos did not. One had a config key and the other did not,
// and that was the entire difference.
//
// Worth recording how it was found: not by reading code, not by an audit — by reading the log file
// on his machine. 3,648 identical warnings is the app telling us something every few seconds, and
// nothing was listening.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base; let intake;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'uvd-thumb-'));
  // Mirrors his real layout: the intake folder sits under a Compression folder, and the phone
  // staging dirs are siblings of it.
  intake = join(base, 'Compression', '01 - Uncompressed');
  mkdirSync(intake, { recursive: true });
  mkdirSync(join(base, 'Compression', '_Phone Video Temp'), { recursive: true });
  mkdirSync(join(base, 'Compression', '04 - Photos Temp'), { recursive: true });
  app = loadMain();
  const cfg = app.get('config');
  cfg.intakeFolder = intake;
});
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

const allowed = (p) => app.get(`isPathAllowed(${JSON.stringify(p)})`);

test('⚠⚠ a staged PHONE VIDEO is allowed, so its thumbnail can load', () => {
  const clip = join(base, 'Compression', '_Phone Video Temp', '20260716_215526.mp4');
  assert.equal(allowed(clip), true,
    '⚠ this exact path was refused 3,648 times in his log — no thumbnails for phone footage');
});

test('the phone PHOTO staging folder is allowed too', () => {
  // It already worked via the photosTempFolder config key; this pins the derived path as well, so a
  // config that never set that key behaves the same as one that did.
  assert.equal(allowed(join(base, 'Compression', '04 - Photos Temp', 'IMG_0001.jpg')), true);
});

test('⚠ both staging folders are derived from the SAME base as the renderer uses', () => {
  // The renderer computes them from the intake folder's parent (phoneStagingDests). If main derived
  // them any other way the two would drift, and the guard would refuse a folder the app is actively
  // writing into — which is exactly the bug being fixed.
  const core = app.get('String(allowedRoots)');
  assert.match(core, /path\.dirname\(path\.resolve\(_intake\)\)/, 'derived from the intake parent');
  assert.match(core, /_Phone Video Temp/, 'the video staging folder');
  assert.match(core, /04 - Photos Temp/, 'and the photo one');
});

test('⚠⚠ the guard still REFUSES somewhere he never chose', () => {
  // The bound. Widening allowedRoots is only safe if it stays narrow — this guard exists because
  // three handlers take a renderer-supplied path and read the disk with it (#95). A fix that
  // allowed everything would be worse than the bug.
  for (const p of ['/etc/passwd', 'C:\\Windows\\System32\\config\\SAM', join(base, '..', 'elsewhere.mp4')]) {
    assert.equal(allowed(p), false, `⚠ ${p} must still be refused`);
  }
});

test('⚠ a SIBLING of the staging folder is not allowed', () => {
  // `startsWith` without a separator boundary would let "_Phone Video Temp Evil" pass as inside
  // "_Phone Video Temp". The guard already handles this; pinning it because the fix touches roots.
  assert.equal(allowed(join(base, 'Compression', '_Phone Video Temp Evil', 'x.mp4')), false);
});

test('with no intake folder set, nothing extra is allowed', () => {
  // A fresh install has no intakeFolder. Deriving from '' must not push the filesystem root as an
  // allowed path — that would turn the guard off entirely on exactly the machines least able to
  // notice.
  const cfg = app.get('config');
  const saved = cfg.intakeFolder;
  cfg.intakeFolder = '';
  try {
    assert.equal(allowed('/etc/passwd'), false, '⚠ an unset intake folder must not open the root');
    assert.equal(allowed(join(base, 'Compression', '_Phone Video Temp', 'a.mp4')), false,
      'and the derived paths are simply absent');
  } finally { cfg.intakeFolder = saved; }
});
