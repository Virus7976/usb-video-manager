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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync, linkSync, symlinkSync } from 'node:fs';
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

// --- A FILE IS NOT A BACKUP OF ITSELF -----------------------------------------------------------
//
// The gate's one FAIL-OPEN, found by asking "what if dest points at the source?" — and it was worse
// than a refusal-to-delete: it deleted. `dest === source` sailed through every check. Stat the same
// file twice: same size. Hash it twice: same hash. "Verified." Then unlink it.
//
// The handler returned `{ ok: true, method: 'deleted' }` while destroying the only copy of the
// footage. Every OTHER failure in this app is recoverable. This one is not.

test('REFUSES when dest IS the source — a file is not a copy of itself', async () => {
  const card = join(dir, 'self'); mkdirSync(card, { recursive: true });
  const source = join(card, 'GX010042.MP4');
  writeFileSync(source, 'the only copy of this footage');

  const [r] = await app.invoke('delete:source', [{ source, dest: source }]);

  assert.equal(existsSync(source), true, 'THE ONLY COPY OF THE FOOTAGE WAS DELETED');
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /IS the source file/);
});

test('…and when dest is the same path written differently', async () => {
  // Windows paths are case-insensitive and slash-agnostic, so a string compare is not enough:
  // `E:\DCIM\GX01.MP4` and `e:/dcim/gx01.mp4` are the same file. pathsEqual() normalises both.
  const card = join(dir, 'case'); mkdirSync(card, { recursive: true });
  const source = join(card, 'GX010043.MP4');
  writeFileSync(source, 'footage');

  for (const dest of [source.replace(/\//g, '\\'), `${dirname(source)}/./${'GX010043.MP4'}`]) {
    // eslint-disable-next-line no-await-in-loop
    const [r] = await app.invoke('delete:source', [{ source, dest }]);
    assert.equal(r.ok, false, `deleted via ${dest}`);
    assert.equal(existsSync(source), true, `THE FOOTAGE WAS DELETED via ${dest}`);
  }
});

test('…and when dest is a HARDLINK to the source — same file, different name', async () => {
  // A hardlink is not a second copy: delete the source and the bytes stay, but there is still only
  // ONE file. pathsEqual cannot see this — the paths are genuinely different strings. The inode can.
  const d = join(dir, 'hard'); mkdirSync(d, { recursive: true });
  const source = join(d, 'GX010044.MP4');
  const dest = join(d, 'link.MP4');
  writeFileSync(source, 'footage');
  linkSync(source, dest);

  const [r] = await app.invoke('delete:source', [{ source, dest }]);
  assert.equal(r.ok, false, 'a hardlink is not a backup');
  assert.equal(r.refused, true);
  assert.match(r.error, /same file as the source/);
  assert.equal(existsSync(source), true);
});

test('…and when dest is a SYMLINK back to the source', async () => {
  // stat() follows the symlink, so size and hash match perfectly. Only the inode gives it away.
  const d = join(dir, 'sym'); mkdirSync(d, { recursive: true });
  const source = join(d, 'GX010045.MP4');
  const dest = join(d, 'pointer.MP4');
  writeFileSync(source, 'footage');
  symlinkSync(source, dest);

  const [r] = await app.invoke('delete:source', [{ source, dest }]);
  assert.equal(r.ok, false, 'a symlink to the source is not a backup of it');
  assert.equal(existsSync(source), true);
});

test('a REAL copy that happens to sit beside the source still deletes — the guard is not paranoid', () => {
  // The check must catch identity, not merely proximity: a genuine second copy in the same folder is
  // still a genuine copy. If this fails, the guard is refusing legitimate work.
  return (async () => {
    const d = join(dir, 'beside'); mkdirSync(d, { recursive: true });
    const source = join(d, 'GX010046.MP4');
    const dest = join(d, 'GX010046-copy.MP4');
    writeFileSync(source, 'footage');
    writeFileSync(dest, 'footage');

    const [r] = await app.invoke('delete:source', [{ source, dest }]);
    assert.equal(r.ok, true, r.error);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(dest), true);
  })();
});

test('an identity pair in a batch does not take the honest copies down with it', async () => {
  const good = pair('batch-good.mp4');
  const d = join(dir, 'batchself'); mkdirSync(d, { recursive: true });
  const self = join(d, 'batch-self.mp4');
  writeFileSync(self, 'x');

  const rs = await app.invoke('delete:source', [{ source: self, dest: self }, good]);

  assert.equal(rs[0].ok, false, 'the identity pair is refused');
  assert.equal(existsSync(self), true);
  assert.equal(rs[1].ok, true, 'and the genuinely-copied file still deletes');
  assert.equal(existsSync(good.source), false);
});

// --- A COPY ON THE SAME CARD IS NOT A COPY OFF THE CARD -----------------------------------------

test('REFUSES when the only "copy" is on the same card as the original', async () => {
  // uniqueDest() never overwrites, so pointing the intake folder at the card itself produces a
  // genuine, byte-identical second file — which passes identity, size AND hash. The gate would delete
  // the original, report success, and leave him with exactly one copy: on the card he is about to
  // wipe. The entire point of the delete step is that the footage is safe SOMEWHERE ELSE.
  //
  // Detection is Windows-only (a drive letter), so stub it the way the other suites stub fetch.
  const g = app.get('globalThis');
  const realCheck = g.isOnRemovableVolume;
  g.isOnRemovableVolume = async (p) => String(p).startsWith('E:');
  try {
    const r = await app.invoke('verify:copies', [{ source: 'E:/DCIM/GX010042.MP4', dest: 'E:/intake/GX010042.MP4' }]);
    assert.equal(r[0].ok, false, 'a copy on the same card must never count as a backup');
    assert.match(r[0].reason, /same card/);
  } finally { g.isOnRemovableVolume = realCheck; }
});

test('…but a copy on a DIFFERENT volume is a real backup and still deletes', async () => {
  // The guard must catch "same card", not "card involved at all" — copying E: -> L: is the whole
  // normal flow, and refusing it would break the app.
  const g = app.get('globalThis');
  const realCheck = g.isOnRemovableVolume;
  g.isOnRemovableVolume = async (p) => String(p).startsWith('E:');
  try {
    const p = pair('offcard.mp4');   // real files, different dirs, same (non-removable) volume in test
    const [r] = await app.invoke('delete:source', [p]);
    assert.equal(r.ok, true, r.error);
    assert.equal(existsSync(p.source), false);
    assert.equal(existsSync(p.dest), true, 'the copy survives');
  } finally { g.isOnRemovableVolume = realCheck; }
});

// --- THE HASH ITSELF: correct, and not a memory hog ---------------------------------------------
//
// Everything above rests on the full-file hash being right. It was correct but ruinous: a single
// Buffer.alloc(size) — the WHOLE FILE in one buffer. Measured on a 900 MB clip: RSS 43 MB -> 987 MB,
// and verifyCopyPair hashes the source and the copy IN PARALLEL, so ~1.9 GB of RAM per clip, on every
// copy and every delete. GoPro chapters run to 4 GB, which is at Buffer's ceiling and would throw.
// Streamed in 2 MB chunks it is +18 MB, and the digest is byte-identical (verified), so nothing that
// already stored a fingerprint needs to change.

test('the full hash reads the WHOLE file, across chunk boundaries', async () => {
  // Bigger than CHUNK*3 (6 MB), so it exercises the multi-chunk loop rather than the single-read path.
  const d = join(dir, 'big'); mkdirSync(d, { recursive: true });
  const src = join(d, 'big.mp4');
  const dst = join(d, 'big-copy.mp4');
  const bytes = Buffer.alloc(7 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
  writeFileSync(src, bytes);
  writeFileSync(dst, bytes);

  const [okPair] = await app.invoke('verify:copies', [{ source: src, dest: dst }]);
  assert.equal(okPair.ok, true, okPair.reason);

  // Corrupt ONE byte, mid-file, exactly ON a 2 MB chunk boundary — the byte a chunking bug drops.
  const corrupted = Buffer.from(bytes);
  corrupted[2 * 1024 * 1024] ^= 0xff;
  writeFileSync(dst, corrupted);

  const [bad] = await app.invoke('verify:copies', [{ source: src, dest: dst }]);
  assert.equal(bad.ok, false, 'a single flipped byte on a chunk boundary must be caught');
  assert.match(bad.reason, /content mismatch/);

  // …and one at the very last byte, which an off-by-one in the loop bound would miss.
  const tail = Buffer.from(bytes);
  tail[tail.length - 1] ^= 0xff;
  writeFileSync(dst, tail);
  const [bad2] = await app.invoke('verify:copies', [{ source: src, dest: dst }]);
  assert.equal(bad2.ok, false, 'the final byte is hashed too');
});

test('the full hash does not allocate the whole file — it streams', () => {
  // The regression that would quietly return: `readAt(0, size)`. It is correct, and it is a ~1 GB
  // allocation per file, twice over, on the machine that is also holding a 5 GB model in VRAM.
  const src = readFileSync(join(ROOT, 'main-mod', '09-ipc-boot.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function sampledFingerprint('));
  // Strip comments first — the comment explaining the fix NAMES the old call, and a naive text search
  // happily matches the explanation instead of the code.
  const body = fn.slice(0, fn.indexOf('\n}\n')).replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/readAt\(0, size\)/.test(body), false, 'must not read the entire file into one buffer');
  assert.match(body, /for \(let pos = 0; pos < size; pos \+= CHUNK\)/, 'it streams in CHUNK-sized reads');
  assert.match(body, /while \(got < len\)/, 'and a short read never silently hashes less than it claims');
});
