// The delete gate — the one irreversible act in the app.
//
// Jake's hardest rule: deleting from the card is NEVER automated, and never happens to a file
// that isn't provably copied. `delete:source` used to take a bare array of paths and unlink
// whatever it was handed: the ENTIRE "only delete what's verified" gate lived in the renderer
// (09-phone-finalize.js). That put the irreversible operation behind a guard that any renderer
// bug could silently disarm — and this codebase has shipped plenty of renderer bugs.
//
// The gate now lives in the main process, next to the delete. These tests assert it holds even
// when the RENDERER LIES — i.e. they call the IPC handler directly with payloads a buggy or
// regressed renderer could plausibly send, and require the footage to survive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let app; let dir;

before(() => {
  app = loadMain();
  dir = mkdtempSync(join(tmpdir(), 'delgate-'));
});
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A "card" file and its "intake" copy. `mutate` corrupts the copy to break verification. */
function pair(name, { bytes = 'GOPRO-FOOTAGE-' + name, corruptCopy = null, noCopy = false } = {}) {
  const card = join(dir, 'card'); const intake = join(dir, 'intake');
  mkdirSync(card, { recursive: true }); mkdirSync(intake, { recursive: true });
  const source = join(card, name); const dest = join(intake, name);
  writeFileSync(source, bytes);
  if (!noCopy) writeFileSync(dest, corruptCopy === null ? bytes : corruptCopy);
  return { source, dest };
}

test('deletes a file whose copy is byte-identical', async () => {
  const p = pair('good.mp4');
  const [r] = await app.invoke('delete:source', [p]);
  assert.equal(r.ok, true, r.error);
  assert.equal(existsSync(p.source), false, 'the verified original is removed from the card');
  assert.equal(existsSync(p.dest), true, 'the copy is untouched');
});

test('REFUSES a bare path — the old contract proves nothing and must fail closed', async () => {
  // This is the exact payload the pre-fix renderer sent. If a stale bundle, a regressed call
  // site, or a replayed IPC message sends bare strings, the footage must survive.
  const p = pair('bare.mp4');
  const [r] = await app.invoke('delete:source', [p.source]);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /source, dest/, 'it says why it refused');
  assert.equal(existsSync(p.source), true, 'THE FILE IS STILL ON THE CARD');
});

test('REFUSES when the copy is corrupt, even though the renderer claimed it was verified', async () => {
  // Same size, different content — a renderer that mis-tracked _verified would happily ask
  // for this delete. The main process re-hashes and says no.
  const p = pair('corrupt.mp4', { bytes: 'AAAABBBBCCCC', corruptCopy: 'AAAAXXXXCCCC' });
  const [r] = await app.invoke('delete:source', [p]);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /content mismatch/);
  assert.equal(existsSync(p.source), true, 'THE FILE IS STILL ON THE CARD');
});

test('REFUSES when the copy is a different size', async () => {
  const p = pair('short.mp4', { bytes: 'FULL-LENGTH-FOOTAGE', corruptCopy: 'TRUNC' });
  const [r] = await app.invoke('delete:source', [p]);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /size mismatch/);
  assert.equal(existsSync(p.source), true, 'THE FILE IS STILL ON THE CARD');
});

test('REFUSES when the copy does not exist at all', async () => {
  const p = pair('nocopy.mp4', { noCopy: true });
  const [r] = await app.invoke('delete:source', [p]);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /copy missing/);
  assert.equal(existsSync(p.source), true, 'THE FILE IS STILL ON THE CARD');
});

test('REFUSES when dest is missing from the payload', async () => {
  const p = pair('nodest.mp4');
  const [r] = await app.invoke('delete:source', [{ source: p.source }]);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /no copy on record/);
  assert.equal(existsSync(p.source), true, 'THE FILE IS STILL ON THE CARD');
});

test('a bad file in the batch does not take the good ones with it, or vice versa', async () => {
  // Mixed batch: the verified one goes, the corrupt one stays. Per-file decisions, no
  // all-or-nothing that could be talked into deleting the lot.
  const good = pair('mix-good.mp4');
  const bad = pair('mix-bad.mp4', { bytes: '1234567890', corruptCopy: '1234XXXX90' });
  const res = await app.invoke('delete:source', [good, bad]);

  const byPath = Object.fromEntries(res.map((r) => [r.path, r]));
  assert.equal(byPath[good.source].ok, true);
  assert.equal(byPath[bad.source].refused, true);
  assert.equal(existsSync(good.source), false, 'the verified file was deleted');
  assert.equal(existsSync(bad.source), true, 'the unverifiable file SURVIVED');
});

test('junk payloads delete nothing', async () => {
  for (const payload of [null, undefined, 'C:/card/DCIM/x.mp4', [null], [{}], [{ dest: 'd' }], [42]]) {
    const res = await app.invoke('delete:source', payload);
    assert.ok(Array.isArray(res), `payload ${JSON.stringify(payload)} returns a list`);
    assert.equal(res.some((r) => r.ok), false, `nothing is deleted for ${JSON.stringify(payload)}`);
  }
});

test('the source of truth is shared: verify:copies and delete:source agree', async () => {
  // Both go through verifyCopyPair. If they ever diverge, the renderer could show "verified"
  // for a file the delete gate would refuse (or worse, the other way round).
  const good = pair('agree-good.mp4');
  const bad = pair('agree-bad.mp4', { bytes: 'ABCDEFGH', corruptCopy: 'ABCDXXXX' });

  const verdicts = await app.invoke('verify:copies', [good, bad]);
  assert.equal(verdicts.find((v) => v.source === good.source).ok, true);
  assert.equal(verdicts.find((v) => v.source === bad.source).ok, false);

  const deletes = await app.invoke('delete:source', [good, bad]);
  assert.equal(deletes.find((r) => r.path === good.source).ok, true);
  assert.equal(deletes.find((r) => r.path === bad.source).ok, false);
});

// --- the OTHER way footage can leave a card: organize MOVES files ---------------------
//
// finalize:run with organize:true calls organizeMove → moveFileCrossDevice → unlink(src).
// If the "Compressed" folder were pointed at the SD card, Run would strip the card — a card
// delete that never passed the delete confirm OR the gate above. It is now refused up front.
//
// NOTE: the positive path (an actual removable volume) is Windows-only — DETECTION_ENABLED is
// false off-Windows, so it CANNOT be exercised here. These tests cover the wiring and the
// off-Windows behaviour; the live refusal needs a real card on Windows to observe.

test('the removable-volume guard is wired into finalize:run BEFORE anything is moved', () => {
  const src = readFileSync(join(ROOT, 'main-mod', '09-ipc-boot.js'), 'utf8');
  const handler = src.indexOf("ipcMain.handle('finalize:run'");
  assert.ok(handler > 0);
  const guard = src.indexOf('isOnRemovableVolume', handler);
  const move = src.indexOf('organizeMove(', handler);
  assert.ok(guard > 0, 'finalize:run checks for a removable source');
  assert.ok(move > 0 && guard < move, 'the check happens BEFORE the first move, not after');
});

test('the removable guard fails closed when the volume query breaks', () => {
  // "Can't tell" must never mean "safe to move footage off it".
  const src = readFileSync(join(ROOT, 'main-mod', '04-routes-ledger.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function isOnRemovableVolume'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /catch\s*\{\s*return true/, 'a failed query returns true (treat as removable)');
});

test('off-Windows, nothing is treated as removable (dev/test is not broken by the guard)', async () => {
  const isOnRemovableVolume = app.get('isOnRemovableVolume');
  assert.equal(typeof isOnRemovableVolume, 'function', 'the guard is a real top-level function');
  assert.equal(await isOnRemovableVolume('/home/jake/Videos'), false);
  assert.equal(await isOnRemovableVolume(''), false);
  assert.equal(await isOnRemovableVolume(null), false);
});

test('no automated path can reach a source delete', () => {
  // The rule is "deleting from the card is NEVER automated". Structurally: delete:source has
  // exactly ONE renderer call site, and it hangs off an explicit click handler behind a
  // confirm. Nothing may programmatically click it.
  const modDir = join(ROOT, 'src', 'mod');
  const files = readdirSync(modDir).filter((f) => f.endsWith('.js'));
  const callers = [];
  for (const f of files) {
    const src = readFileSync(join(modDir, f), 'utf8');
    if (/window\.api\.deleteSource\s*\(/.test(src)) callers.push(f);
    assert.equal(/deleteConfirmBtn'\)\s*\.click\s*\(/.test(src), false, `${f} must never synthesise a click on the delete button`);
  }
  assert.deepEqual(callers, ['09-phone-finalize.js'], 'deleteSource has exactly one call site');
});
