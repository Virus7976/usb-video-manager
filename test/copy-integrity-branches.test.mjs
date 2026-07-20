// The integrity throw at the heart of every copy had NO test.
//
// Continuing the branch-coverage audit (2026-07-20a/b) into the copy machinery. `stageVerifiedCopy`
// is described in its own header as *"the one way footage is written in this app"* — stage, flush,
// FULL verify, rename — and its failure path carries the comment *"never leave a half-written clip
// behind under the real name."*
//
//     if (!(await fingerprintsMatch(src, tmp, { full: true }))) throw new Error('verify failed after copy');
//
// Zero tests reached that line. It is the guarantee that a truncated or corrupted copy is never
// presented as good — and it is the guarantee that everything downstream leans on, including the
// delete gate, which will happily wipe a card once a copy "verified".
//
// Also untested: the name-collision path where the existing file is a DIFFERENT clip. Its own comment
// records why it is there ("the old size-only test could collide two different files of equal size"),
// and getting it wrong overwrites one of his clips with another.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'uvd-copyint-'));
  const src = join(dir, 'GX010042.MP4');
  writeFileSync(src, 'ORIGINAL FOOTAGE');
  box = { dir, src, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

test('⚠ a copy that fails verification throws instead of reporting success', async () => {
  // Force the failure the way it happens in the wild — the bytes on disk not matching the source —
  // by making the verifier say no. Nothing else can produce it deterministically: a real truncation
  // needs the copy to be interrupted mid-write.
  try {
    const real = app.get('fingerprintsMatch');
    app.get('__realFpm = fingerprintsMatch');
    app.get('fingerprintsMatch = async function () { return false; };');
    const dest = join(box.dir, 'copy.MP4');
    let threw = null;
    try { await app.get('stageVerifiedCopy')(box.src, dest); }
    catch (e) { threw = e; }
    finally { app.get('fingerprintsMatch = __realFpm'); }
    assert.ok(threw, 'it throws rather than returning quietly');
    assert.match(String(threw.message), /verify failed after copy/, `and says why — got ${threw.message}`);
    assert.ok(typeof real === 'function', 'the real verifier was restored');
  } finally { box.cleanup(); }
});

test('⚠ and it leaves NOTHING behind under the real name', async () => {
  // The property the comment promises. A half-written clip sitting at the destination is worse than
  // no clip: it looks filed, and the delete gate would later compare a card against it.
  try {
    app.get('__realFpm2 = fingerprintsMatch');
    app.get('fingerprintsMatch = async function () { return false; };');
    const dest = join(box.dir, 'copy.MP4');
    try { await app.get('stageVerifiedCopy')(box.src, dest); } catch { /* expected */ }
    finally { app.get('fingerprintsMatch = __realFpm2'); }
    assert.equal(existsSync(dest), false, 'no file under the destination name');
    const leftovers = readdirSync(box.dir).filter((n) => n.includes('.part-'));
    assert.deepEqual(leftovers, [], `and no temp file left behind — got ${JSON.stringify(leftovers)}`);
  } finally { box.cleanup(); }
});

test('the source is untouched when a copy fails', async () => {
  // The one thing that must always be true after a failure.
  try {
    app.get('__realFpm3 = fingerprintsMatch');
    app.get('fingerprintsMatch = async function () { return false; };');
    try { await app.get('stageVerifiedCopy')(box.src, join(box.dir, 'copy.MP4')); } catch { /* expected */ }
    finally { app.get('fingerprintsMatch = __realFpm3'); }
    assert.equal(readFileSync(box.src, 'utf8'), 'ORIGINAL FOOTAGE', 'his footage is exactly as it was');
  } finally { box.cleanup(); }
});

test('a successful copy really does land, verified', async () => {
  // The opposite direction: the guard must not be so eager that nothing copies.
  try {
    const dest = join(box.dir, 'good-copy.MP4');
    await app.get('stageVerifiedCopy')(box.src, dest);
    assert.equal(existsSync(dest), true, 'the copy is there');
    assert.equal(readFileSync(dest, 'utf8'), 'ORIGINAL FOOTAGE', 'byte-identical');
    assert.deepEqual(readdirSync(box.dir).filter((n) => n.includes('.part-')), [], 'and no temp remains');
  } finally { box.cleanup(); }
});

test('⚠ a DIFFERENT clip with the same name is versioned, never overwritten', async () => {
  // The untested collision branch. Two distinct clips that happen to share a filename must both
  // survive — overwriting is silent, permanent, and exactly what `uniqueDest` exists to prevent.
  try {
    const targetDir = join(box.dir, 'Projects');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'GX010042.MP4'), 'A DIFFERENT CLIP ENTIRELY');
    const r = app.plain(await app.get('organizeMove')(box.src, targetDir, 'GX010042.MP4', { copy: true }));
    const landed = readdirSync(targetDir).sort();
    assert.equal(landed.length, 2, `both clips exist — got ${JSON.stringify(landed)}`);
    assert.equal(readFileSync(join(targetDir, 'GX010042.MP4'), 'utf8'), 'A DIFFERENT CLIP ENTIRELY',
      'the clip that was already there is untouched');
    assert.notEqual(r.action, 'skip-dup', `and ours was actually filed — got ${r.action}`);
    assert.equal(readFileSync(r.path, 'utf8'), 'ORIGINAL FOOTAGE', 'under a versioned name');
  } finally { box.cleanup(); }
});

test('an IDENTICAL clip with the same name is skipped, not duplicated', async () => {
  // The neighbour branch, and the reason the collision check has to compare content rather than
  // just names: an idempotent re-run must not litter his archive with copies.
  try {
    const targetDir = join(box.dir, 'Projects');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'GX010042.MP4'), 'ORIGINAL FOOTAGE');
    const r = app.plain(await app.get('organizeMove')(box.src, targetDir, 'GX010042.MP4', { copy: true }));
    assert.equal(r.action, 'skip-dup', `recognised as already filed — got ${r.action}`);
    assert.equal(readdirSync(targetDir).length, 1, 'no second copy created');
  } finally { box.cleanup(); }
});

test('⚠ same SIZE, differing ONLY where sampling never looks, still versions', async () => {
  // Why the collision check passes `full: true`. Sampling reads head / middle / tail (2 MB each) and
  // only kicks in above 6 MB, so a clip that differs anywhere else is identical as far as a sampled
  // hash can tell — it would be called a duplicate and never filed.
  //
  // My first version of this test flipped the LAST byte of a 16-byte file, which sampling reads
  // anyway, so removing `full: true` left it green. The fixture has to differ in a region sampling
  // genuinely skips: 7 MB total, byte flipped at 2.25 MB — past the head chunk (0–2 MB) and before
  // the middle chunk (2.5–4.5 MB).
  try {
    const targetDir = join(box.dir, 'Projects');
    mkdirSync(targetDir, { recursive: true });
    const SIZE = 7 * 1024 * 1024;
    const a = Buffer.alloc(SIZE, 0x41);
    const b = Buffer.alloc(SIZE, 0x41);
    b[Math.floor(2.25 * 1024 * 1024)] = 0x42;
    const big = join(box.dir, 'BIG.MP4');
    writeFileSync(big, a);
    writeFileSync(join(targetDir, 'BIG.MP4'), b);
    assert.equal(a.length, b.length, 'equal size');
    assert.notDeepEqual(a, b, 'but genuinely different content');
    const r = app.plain(await app.get('organizeMove')(big, targetDir, 'BIG.MP4', { copy: true }));
    assert.notEqual(r.action, 'skip-dup', `not treated as a duplicate — got ${r.action}`);
    assert.equal(readdirSync(targetDir).length, 2, `both clips kept — got ${JSON.stringify(readdirSync(targetDir))}`);
  } finally { box.cleanup(); }
});
