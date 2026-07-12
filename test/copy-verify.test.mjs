// Copy / verify / fingerprint data-integrity path — characterization tests.
//
// These lock in the CURRENT behavior of the copy→verify→delete pipeline against REAL,
// ffmpeg-generated footage. Where a test asserts something surprising (a same-size
// mid-file byte flip slipping past the SAMPLED fingerprint), that is the documented
// speed/safety trade-off of sampledFingerprint, and the assertion nails it down on
// purpose so a future change to the sampling scheme is caught here.
//
// Functions under test (all reached through the vm harness):
//   sampledFingerprint, fingerprintsMatch, copyFileVerified, moveFileCrossDevice,
//   organizeMove, uniqueDest, destNameFor, stemOf, pathKey, pathsEqual, isImagePath
//   + IPC channel verify:copies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync,
  existsSync, copyFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { loadMain } from './harness.mjs';
import { HAVE_FFMPEG } from './fixtures.mjs';

const CHUNK = 2 * 1024 * 1024;              // sampledFingerprint's sample size
const FF = { skip: HAVE_FFMPEG ? false : 'ffmpeg not available' };

// Incompressible REAL footage: qp0 x264 over a random-noise source defeats compression,
// so ~3s at 320x240 reliably clears CHUNK*3 (6 MB) and exercises the SAMPLED code path
// (testsrc footage compresses to a few hundred KB and never would).
function makeNoiseVideo(dir, name, { duration = 3 } = {}) {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `nullsrc=size=320x240:rate=25:duration=${duration}`,
    '-vf', 'geq=random(1)*255:128:128',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-qp', '0', out,
  ], { stdio: 'ignore' });
  return out;
}

let m;                 // shared bundle instance (pure fns, no per-test state)
let shed;              // shared throwaway dir
let big;               // one shared > 6 MB real clip (read-only in tests)
let bigSize = 0;

before(() => {
  m = loadMain();
  shed = mkdtempSync(join(tmpdir(), 'uvd-cv-'));
  if (HAVE_FFMPEG) {
    big = makeNoiseVideo(shed, 'big.mp4');
    bigSize = statSync(big).size;
  }
});
after(() => {
  try { m && m.dispose(); } catch { /* ignore */ }
  try { rmSync(shed, { recursive: true, force: true }); } catch { /* ignore */ }
});

// A fresh isolated dir per test.
function work(name) {
  const d = join(shed, name + '-' + crypto.randomBytes(4).toString('hex'));
  mkdirSync(d, { recursive: true });
  return d;
}
const fp = (...a) => m.call('sampledFingerprint', ...a);
const match = (...a) => m.call('fingerprintsMatch', ...a);

// ---------------------------------------------------------------------------
// sampledFingerprint — shape, boundaries, and the sampled-vs-full divergence
// ---------------------------------------------------------------------------

test('sampledFingerprint: size 0 does NOT throw and returns a stable hash', async () => {
  const d = work('sz0');
  const a = join(d, 'a'); const b = join(d, 'b');
  writeFileSync(a, ''); writeFileSync(b, '');
  const r = await fp(a);
  assert.equal(r.size, 0);
  assert.equal(typeof r.hash, 'string');
  assert.equal(r.hash.length, 64);                 // sha256 hex
  assert.equal(await match(a, b), true, 'two empty files fingerprint-match');
  // full path on an empty file is likewise a no-op read, not a throw
  const rf = await fp(a, { full: true });
  assert.equal(rf.size, 0);
  assert.equal(rf.hash, r.hash, 'empty file: full == sampled (both hash only "sz:0")');
});

test('sampledFingerprint: at exactly CHUNK*3 the sampled read covers the WHOLE file', async () => {
  // size <= CHUNK*3 takes the readAt(0,size) branch, so sampled == full here.
  const d = work('exact');
  const p = join(d, 'exact.bin');
  writeFileSync(p, crypto.randomBytes(CHUNK * 3));
  const s = await fp(p);
  const f = await fp(p, { full: true });
  assert.equal(s.size, CHUNK * 3);
  assert.equal(s.hash, f.hash, 'sampled hash equals full hash at the boundary');
});

test('sampledFingerprint: one-byte-over the boundary switches to true SAMPLING', async () => {
  // size = CHUNK*3 + 1 crosses into head/mid/tail sampling, so sampled != full
  // (the whole-file read no longer happens). Locks the boundary at CHUNK*3.
  const d = work('over');
  const p = join(d, 'over.bin');
  writeFileSync(p, crypto.randomBytes(CHUNK * 3 + 1));
  const s = await fp(p);
  const f = await fp(p, { full: true });
  assert.equal(s.size, CHUNK * 3 + 1);
  assert.notEqual(s.hash, f.hash, 'past the boundary the sampled hash diverges from full');
});

test('identical real clips fingerprint-match (sampled AND full)', FF, async () => {
  const d = work('ident');
  const copy = join(d, 'copy.mp4');
  copyFileSync(big, copy);
  const a = await fp(big); const b = await fp(copy);
  assert.equal(a.size, b.size);
  assert.equal(a.hash, b.hash);
  assert.equal(await match(big, copy), true);
  assert.equal(await match(big, copy, { full: true }), true);
});

test('DOCUMENTED TRADE-OFF: a mid-file byte flip that preserves size is caught by FULL but MISSED by SAMPLED', FF, async () => {
  assert.ok(bigSize > CHUNK * 3, 'fixture must exceed CHUNK*3 to exercise sampling');
  const d = work('midflip');
  const flip = join(d, 'flip.mp4');
  // Land the flip inside the gap the sampler never reads: after the head chunk,
  // before the middle chunk. [CHUNK, floor(size/2) - CHUNK/2)
  const gapStart = CHUNK;
  const gapEnd = Math.floor(bigSize / 2) - CHUNK / 2;
  assert.ok(gapEnd - gapStart > 2048, 'sampler gap must exist for this fixture size');
  const off = gapStart + 1024;
  const buf = readFileSync(big);
  buf[off] ^= 0xff;                                  // one flipped byte, size unchanged
  writeFileSync(flip, buf);

  assert.equal(statSync(flip).size, bigSize, 'flip preserves size');
  assert.equal(await match(big, flip), true, 'SAMPLED misses the mid-file corruption (by design)');
  assert.equal(await match(big, flip, { full: true }), false, 'FULL catches it');
});

test('a byte flip in the HEAD region is caught even by SAMPLED', FF, async () => {
  const d = work('headflip');
  const flip = join(d, 'hflip.mp4');
  const buf = readFileSync(big);
  buf[100] ^= 0xff;                                  // within [0, CHUNK) -> sampled reads it
  writeFileSync(flip, buf);
  assert.equal(await match(big, flip), false, 'head-region corruption fails the sampled check');
});

test('truncation is caught by sampled AND full (size is in the hash)', FF, async () => {
  const d = work('trunc');
  const trunc = join(d, 'trunc.mp4');
  writeFileSync(trunc, readFileSync(big).subarray(0, bigSize - 100));
  assert.equal(statSync(trunc).size, bigSize - 100);
  assert.equal(await match(big, trunc), false, 'sampled catches truncation via size');
  assert.equal(await match(big, trunc, { full: true }), false, 'full catches truncation');
});

test('fingerprintsMatch returns false (never throws) when a side is missing', FF, async () => {
  const d = work('missing');
  assert.equal(await match(big, join(d, 'nope.mp4')), false);
  assert.equal(await match(join(d, 'nope.mp4'), big), false);
});

// ---------------------------------------------------------------------------
// copyFileVerified — copy, skip, repair, and hard failure
// ---------------------------------------------------------------------------

test('copyFileVerified: fresh copy returns "copied" and the bytes land intact', FF, async () => {
  const d = work('cfv-fresh');
  const dest = join(d, 'sub', 'out.mp4');           // nested dir must be created
  assert.equal(await m.call('copyFileVerified', big, dest), 'copied');
  assert.equal(existsSync(dest), true);
  assert.equal(await match(big, dest, { full: true }), true);
});

test('copyFileVerified: a byte-identical dest is "skipped"', FF, async () => {
  const d = work('cfv-skip');
  const dest = join(d, 'out.mp4');
  copyFileSync(big, dest);
  assert.equal(await m.call('copyFileVerified', big, dest), 'skipped');
});

test('copyFileVerified: a corrupt/differing pre-existing dest is REPAIRED (not skipped)', FF, async () => {
  const d = work('cfv-repair');
  const dest = join(d, 'out.mp4');
  // Same name, different (short) content -> sampled mismatch -> must re-copy.
  writeFileSync(dest, readFileSync(big).subarray(0, bigSize - 500));
  assert.equal(await m.call('copyFileVerified', big, dest), 'copied');
  assert.equal(await match(big, dest, { full: true }), true, 'dest now matches the source exactly');
});

test('copyFileVerified: a write that cannot succeed throws (and leaves no good-looking dest)', FF, async () => {
  const d = work('cfv-fail');
  // dest is an existing directory: copyFile can never write it, every attempt fails,
  // and copyFileVerified surfaces the error rather than reporting success.
  const dest = join(d, 'iam-a-dir');
  mkdirSync(dest);
  await assert.rejects(m.call('copyFileVerified', big, dest));
});

// ---------------------------------------------------------------------------
// moveFileCrossDevice — same-device fast path (rename), source consumed
// ---------------------------------------------------------------------------

test('moveFileCrossDevice: same-device move renames src -> dest, source gone', FF, async () => {
  const d = work('move');
  const src = join(d, 'src.mp4');
  copyFileSync(big, src);
  const dest = join(d, 'dest.mp4');
  await m.call('moveFileCrossDevice', src, dest);
  assert.equal(existsSync(src), false, 'source is consumed');
  assert.equal(existsSync(dest), true);
  assert.equal(await match(big, dest, { full: true }), true);
});

// ---------------------------------------------------------------------------
// organizeMove — the four documented outcomes
// ---------------------------------------------------------------------------

test('organizeMove: target path == source path -> "in-place", nothing moves', FF, async () => {
  const d = work('om-inplace');
  const src = join(d, 'clip.mp4');
  copyFileSync(big, src);
  const r = m.plain(await m.call('organizeMove', src, d, 'clip.mp4'));
  assert.equal(r.action, 'in-place');
  assert.equal(existsSync(src), true);
});

test('organizeMove: identical file already at target -> "skip-dup", source left in place', FF, async () => {
  const srcDir = work('om-dup-src');
  const dstDir = work('om-dup-dst');
  const src = join(srcDir, 'clip.mp4');
  copyFileSync(big, src);
  copyFileSync(big, join(dstDir, 'clip.mp4'));       // identical content, same name
  const r = m.plain(await m.call('organizeMove', src, dstDir, 'clip.mp4'));
  assert.equal(r.action, 'skip-dup');
  assert.equal(existsSync(src), true, 'a true duplicate leaves the source untouched');
});

test('organizeMove: DIFFERENT file sharing the name -> versioned "moved", never overwritten', FF, async () => {
  const srcDir = work('om-ver-src');
  const dstDir = work('om-ver-dst');
  const src = join(srcDir, 'clip.mp4');
  copyFileSync(big, src);
  // A different clip already owns "clip.mp4" at the target.
  writeFileSync(join(dstDir, 'clip.mp4'), readFileSync(big).subarray(0, bigSize - 777));
  const r = m.plain(await m.call('organizeMove', src, dstDir, 'clip.mp4'));
  assert.equal(r.action, 'moved');
  assert.equal(r.path, join(dstDir, 'clip (1).mp4'), 'ours is versioned, the existing one is preserved');
  assert.equal(existsSync(r.path), true);
  assert.equal(existsSync(src), false, 'source consumed by the move');
  assert.equal(existsSync(join(dstDir, 'clip.mp4')), true, 'the pre-existing different clip survives');
});

test('organizeMove: empty target -> plain "moved"', FF, async () => {
  const srcDir = work('om-fresh-src');
  const dstDir = work('om-fresh-dst');
  const src = join(srcDir, 'clip.mp4');
  copyFileSync(big, src);
  const r = m.plain(await m.call('organizeMove', src, dstDir, 'clip.mp4'));
  assert.equal(r.action, 'moved');
  assert.equal(r.path, join(dstDir, 'clip.mp4'));
  assert.equal(existsSync(src), false);
});

// ---------------------------------------------------------------------------
// uniqueDest / destNameFor / stemOf — collisions & name handling (no ffmpeg)
// ---------------------------------------------------------------------------

test('uniqueDest: no collision returns the original path', async () => {
  const d = work('ud-none');
  assert.equal(await m.call('uniqueDest', d, 'a.mp4'), join(d, 'a.mp4'));
});

test('uniqueDest: collisions append " (n)" before the extension and climb', async () => {
  const d = work('ud-coll');
  writeFileSync(join(d, 'a.mp4'), 'x');
  assert.equal(await m.call('uniqueDest', d, 'a.mp4'), join(d, 'a (1).mp4'));
  writeFileSync(join(d, 'a (1).mp4'), 'x');
  assert.equal(await m.call('uniqueDest', d, 'a.mp4'), join(d, 'a (2).mp4'));
});

test('uniqueDest: only the LAST extension is treated as the extension', async () => {
  const d = work('ud-ext');
  writeFileSync(join(d, 'x.tar.gz'), 'x');
  assert.equal(await m.call('uniqueDest', d, 'x.tar.gz'), join(d, 'x.tar (1).gz'));
});

test('destNameFor: uses the sanitized newName + original extension', () => {
  assert.equal(m.call('destNameFor', { name: 'GX0100.MP4', ext: '.MP4', newName: 'my clip' }), 'my clip.MP4');
  // reserved/path characters are replaced with underscores
  assert.equal(m.call('destNameFor', { name: 'GX0100.MP4', ext: '.MP4', newName: 'a/b:c*d' }), 'a_b_c_d.MP4');
});

test('destNameFor: blank/absent newName falls back to the original base', () => {
  assert.equal(m.call('destNameFor', { name: 'GX0100.MP4', ext: '.MP4', newName: '' }), 'GX0100.MP4');
  assert.equal(m.call('destNameFor', { name: 'GX0100.MP4', ext: '.MP4' }), 'GX0100.MP4');
  assert.equal(m.call('destNameFor', { name: 'GX0100.MP4', ext: '.MP4', newName: '   ' }), 'GX0100.MP4');
});

test('stemOf strips a single trailing extension', () => {
  assert.equal(m.call('stemOf', 'clip.mp4'), 'clip');
  assert.equal(m.call('stemOf', 'a.tar.gz'), 'a.tar');
  assert.equal(m.call('stemOf', 'noext'), 'noext');
});

// ---------------------------------------------------------------------------
// pathsEqual / pathKey / isImagePath — filesystem-case awareness
// ---------------------------------------------------------------------------

test('pathsEqual normalizes . and redundant separators', () => {
  assert.equal(m.call('pathsEqual', '/a/b/c.mp4', '/a/./b/c.mp4'), true);
  assert.equal(m.call('pathsEqual', '/a/b/c.mp4', '/a/b/d.mp4'), false);
});

test('pathsEqual case-folds ONLY on case-insensitive platforms (case-sensitive on Linux)', () => {
  const ci = m.get('PATHS_CASE_INSENSITIVE');
  // On win32/darwin "Clip.MP4" == "clip.mp4"; on Linux they are distinct files.
  assert.equal(m.call('pathsEqual', '/x/Clip.MP4', '/x/clip.mp4'), ci);
  assert.equal(ci, process.platform === 'win32' || process.platform === 'darwin');
});

test('isImagePath recognizes image extensions case-insensitively', () => {
  assert.equal(m.call('isImagePath', '/x/y.JPG'), true);
  assert.equal(m.call('isImagePath', '/x/y.jpg'), true);
  assert.equal(m.call('isImagePath', '/x/y.mp4'), false);
});

// ---------------------------------------------------------------------------
// verify:copies IPC — matched / missing / mismatched pairs
// ---------------------------------------------------------------------------

test('verify:copies: reports ok / missing / no-record / size- and content-mismatch', FF, async () => {
  const d = work('vc');
  const good = join(d, 'good.mp4');
  copyFileSync(big, good);

  const shortCopy = join(d, 'short.mp4');
  writeFileSync(shortCopy, readFileSync(big).subarray(0, bigSize - 100));  // size mismatch

  const headFlip = join(d, 'headflip.mp4');
  const hb = readFileSync(big); hb[50] ^= 0xff; writeFileSync(headFlip, hb); // same size, sampled catches

  const res = m.plain(await m.invoke('verify:copies', [
    { source: big, dest: good },
    { source: big, dest: join(d, 'nope.mp4') },
    { source: big },
    { source: big, dest: shortCopy },
    { source: big, dest: headFlip },
  ]));

  assert.equal(res.length, 5);
  assert.equal(res[0].ok, true);
  assert.equal(res[1].ok, false); assert.equal(res[1].reason, 'copy missing');
  assert.equal(res[2].ok, false); assert.equal(res[2].reason, 'no copy on record');
  assert.equal(res[3].ok, false); assert.match(res[3].reason, /size mismatch/);
  assert.equal(res[4].ok, false); assert.equal(res[4].reason, 'content mismatch');
});

test('verify:copies catches a same-size mid-file flip in an UNSAMPLED gap (it is a delete gate)', FF, async () => {
  // Regression guard. verify:copies gates "safe to clear the card", so it must full-hash.
  // A sampled head/mid/tail hash reads ~6 MB of a 4 GB clip and cannot see a bit-flip in
  // the gap between samples: it used to report this corrupt copy as VERIFIED, after which
  // the user erases the only intact original.
  assert.ok(bigSize > CHUNK * 3);
  const d = work('vc-gap');
  const gapFlip = join(d, 'gapflip.mp4');
  const off = CHUNK + 1024;                          // inside the head->mid gap
  const gb = readFileSync(big); gb[off] ^= 0xff; writeFileSync(gapFlip, gb);
  assert.equal(statSync(gapFlip).size, bigSize, 'corruption preserves length');

  const res = m.plain(await m.invoke('verify:copies', [{ source: big, dest: gapFlip }]));
  assert.equal(res[0].ok, false, 'a corrupt copy must never pass the pre-delete gate');
  assert.equal(res[0].reason, 'content mismatch');
});

test('verify:copies still passes a byte-identical large copy', FF, async () => {
  const d = work('vc-good');
  const twin = join(d, 'twin.mp4');
  writeFileSync(twin, readFileSync(big));
  const res = m.plain(await m.invoke('verify:copies', [{ source: big, dest: twin }]));
  assert.equal(res[0].ok, true, 'a byte-identical copy must verify');
});
