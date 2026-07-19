// Audit #15 — the same-card delete guard could be bypassed by a path that isn't spelled `X:\`.
//
// The delete gate's most important refusal is "the copy is on the same card as the original — that
// is not a backup". It was reached only via a DRIVE-LETTER comparison, and the removability probe
// behind it (`isOnRemovableVolume`) was letter-based too — with `if (!target) return false`, i.e. a
// path with no drive letter was declared NOT removable. That fails OPEN: a `\\?\Volume{GUID}\…`
// card reads as "not a card", the same-card guard never fires, and the gate can delete the original
// while the only remaining copy sits on the card about to be wiped.
//
// Note the inconsistency it fixes: the very next line already fails CLOSED ("can't list drives →
// don't move off it"). Unknown-because-no-letter and unknown-because-lookup-failed are the same
// kind of ignorance and must make the same call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// The removable-drive list as listRemovableDrives() returns it.
const DRIVES = [{ mountpoint: 'E:\\', raw: 'E:' }];
const classify = (p, drives = DRIVES) => app.call('classifyRemovable', p, drives);

test('#15 a lettered path is still resolved against the removable list', () => {
  assert.equal(classify('E:\\DCIM\\a.mp4'), true, 'E: is the card');
  assert.equal(classify('C:\\Users\\jake\\intake\\a.mp4'), false, 'C: is the internal disk');
  assert.equal(classify('\\\\?\\E:\\DCIM\\a.mp4'), true, 'the \\\\?\\ prefix does not hide the letter');
});

test('#15 a volume-GUID path fails CLOSED (this was the bypass)', () => {
  // We cannot identify this volume by letter — but it may very well BE the card. Guessing
  // "not removable" is what silently disabled the same-card guard.
  assert.equal(classify('\\\\?\\Volume{9f3a1b2c-0000-0000-0000-100000000000}\\DCIM\\a.mp4'), true);
});

test('#15 a UNC network share is NOT called removable (no false refusal)', () => {
  // Failing closed must not be blanket: `\\nas\share` is knowably not a local card, and calling it
  // one would refuse organizing onto the NAS with a nonsense "that folder is on a card" message.
  assert.equal(classify('\\\\nas\\share\\Compressed\\a.mp4'), false);
  assert.equal(classify('\\\\192.168.1.9\\media\\a.mp4'), false);
});

test('#15 an unidentifiable path fails CLOSED rather than open', () => {
  assert.equal(classify('Volume{abc}\\weird\\a.mp4'), true, 'unknown shape → assume it could be the card');
});

// ---------------------------------------------------------------------------
// The gate itself: a copy on the SAME VOLUME as the source must be refused even when neither path
// is spelled with a drive letter. st.dev is the volume identity the OS reports, so it sees through
// path spelling entirely.
// ---------------------------------------------------------------------------

const setRemovable = (v) => { app.get('globalThis').isOnRemovableVolume = async () => v; };

test('#15 a copy on the same removable volume is REFUSED (even with no drive letter)', async () => {
  const { dir, cleanup } = tempDir('gate-same-');
  const src = path.join(dir, 'a.mp4');
  const dst = path.join(dir, 'a_copy.mp4');       // a genuine, byte-identical second file
  fs.writeFileSync(src, 'footage');
  fs.writeFileSync(dst, 'footage');               // same size, same hash — passes every content check

  setRemovable(true);
  const v = app.plain(await app.call('verifyCopyPair', src, dst));
  assert.equal(v.ok, false, 'a byte-identical copy on the same card must NOT authorize a delete');
  assert.match(v.reason, /same card/i);
  cleanup();
});

test('#15 the same-volume refusal does NOT fire for a normal internal-disk copy', async () => {
  // The dangerous direction: this guard must not start refusing ordinary copies within one
  // internal disk, which is what every non-card workflow does.
  const { dir, cleanup } = tempDir('gate-fixed-');
  const src = path.join(dir, 'a.mp4');
  const dst = path.join(dir, 'a_copy.mp4');
  fs.writeFileSync(src, 'footage');
  fs.writeFileSync(dst, 'footage');

  setRemovable(false);
  const v = app.plain(await app.call('verifyCopyPair', src, dst));
  assert.equal(v.ok, true, `a verified copy on a fixed disk still authorizes the delete: ${v.reason}`);
  cleanup();
});

// /dev/shm is a genuinely different device from /tmp here, so this is a REAL cross-volume pair —
// no test-only hooks bolted into the delete gate to fake it.
const TWO_DEVICES = (() => {
  try { return fs.statSync('/tmp').dev !== fs.statSync('/dev/shm').dev; } catch { return false; }
})();

test('#15 a genuine copy on a DIFFERENT volume still verifies', { skip: !TWO_DEVICES }, async () => {
  // Sanity, and the whole point of the feature: footage copied OFF the card CAN be deleted from it.
  // If this ever fails, the guard has become an unconditional refusal and the app cannot clear a card.
  const { dir, cleanup } = tempDir('gate-card-');
  const offCard = fs.mkdtempSync('/dev/shm/gate-intake-');
  const src = path.join(dir, 'a.mp4');
  const dst = path.join(offCard, 'a.mp4');
  fs.writeFileSync(src, 'footage');
  fs.writeFileSync(dst, 'footage');

  setRemovable(true);   // the source really is a card — and the copy really is off it
  const v = app.plain(await app.call('verifyCopyPair', src, dst));
  assert.equal(v.ok, true, `a real off-card copy must still authorize the delete: ${v.reason}`);
  cleanup();
  try { fs.rmSync(offCard, { recursive: true, force: true }); } catch { /* ignore */ }
});
