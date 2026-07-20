// Two refusal branches of the DELETE GATE had no test at all.
//
// `verifyCopyPair` is the check that stands between his footage and the one irreversible act in the
// app. It has already failed OPEN once: `dest === source` passed identity, size and hash, so the gate
// reported success and deleted the only copy. Every branch it grew afterwards exists because some
// version of "that is not a copy" got through.
//
// Auditing which branches a test actually PRODUCES — the blind-guard sweep from 2026-07-20a — found
// two with nothing exercising them:
//
//     'the copy on record is the same file as the source (a link, not a copy)'   ← 0 tests
//     'source missing'                                                            ← 0 tests
//
// The link branch is the interesting one. `pathsEqual` compares path SPELLING, so it cannot see a
// hardlink, a symlink, a junction, a `subst`ed drive letter or a `\\?\` prefix — all of which reach
// one file by two names. Every check below it then agrees the "copy" is perfect, because it IS the
// file: same size, same bytes, same hash. Deleting the source destroys both names' only content.
//
// This is not hypothetical on his setup: the intake folder is a mapped drive (`L:`), and mapped or
// substituted paths are exactly how one volume acquires two spellings.
//
// A guard nothing exercises is a guard nobody has checked. These now have cases that produce the
// state, not just assertions that the string exists.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, linkSync, symlinkSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let verify;
before(() => { app = loadMain(); verify = app.get('verifyCopyPair'); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'uvd-gate-'));
  const src = join(dir, 'GX010042.MP4');
  writeFileSync(src, 'REAL FOOTAGE THAT MUST SURVIVE');
  box = { dir, src, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

const check = async (src, dst) => app.plain(await verify(src, dst));

test('⚠ a HARDLINK is refused — it is one file with two names', async () => {
  try {
    const link = join(box.dir, 'looks-like-a-copy.MP4');
    linkSync(box.src, link);
    // Prove the fixture really is the pathological case, or the test proves nothing.
    assert.equal(statSync(link).ino, statSync(box.src).ino, 'the fixture really is a hardlink');
    const r = await check(box.src, link);
    assert.equal(r.ok, false, `refused — got ${JSON.stringify(r)}`);
    assert.match(r.reason, /link, not a copy/, `and says why — got ${r.reason}`);
  } finally { box.cleanup(); }
});

test('⚠ a SYMLINK is refused too', async () => {
  // stat() follows the symlink, so it reports the TARGET's inode — which is what makes this pass
  // every content check and what the inode comparison is there to catch.
  try {
    const link = join(box.dir, 'shortcut.MP4');
    symlinkSync(box.src, link);
    const r = await check(box.src, link);
    assert.equal(r.ok, false, `refused — got ${JSON.stringify(r)}`);
    assert.match(r.reason, /link, not a copy/, `and says why — got ${r.reason}`);
  } finally { box.cleanup(); }
});

test('a hardlink passes every OTHER check — which is why this branch exists', async () => {
  // The point of the guard, demonstrated rather than asserted: size, bytes and hash all agree,
  // because it is the same file. Anything short of an inode comparison would wave it through.
  try {
    const link = join(box.dir, 'looks-like-a-copy.MP4');
    linkSync(box.src, link);
    const a = statSync(box.src); const b = statSync(link);
    assert.equal(a.size, b.size, 'same size');
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(box.src, 'utf8'), readFileSync(link, 'utf8'), 'same bytes');
    assert.notEqual(box.src, link, 'and yet the paths differ, so pathsEqual cannot see it');
  } finally { box.cleanup(); }
});

test('⚠ a MISSING SOURCE is refused', async () => {
  // The other untested branch. If the source has already gone, there is nothing to verify and
  // nothing to delete — and answering `ok` would let a later step act on a stale record.
  try {
    const dst = join(box.dir, 'copy.MP4');
    writeFileSync(dst, 'REAL FOOTAGE THAT MUST SURVIVE');
    unlinkSync(box.src);
    const r = await check(box.src, dst);
    assert.equal(r.ok, false, `refused — got ${JSON.stringify(r)}`);
    assert.match(r.reason, /source missing/, `and says why — got ${r.reason}`);
  } finally { box.cleanup(); }
});

test('the inode comparison is device-qualified (pinned, not exercised)', async () => {
  // ⚠ HONEST LIMIT. Inode numbers are only unique WITHIN a volume, so two unrelated files on two
  // different devices can share one — `ss.dev === ds.dev` is what stops that being read as a link.
  // I cannot produce that state in a temp dir, and I proved the gap by breaking it: dropping the
  // device check left every test here green.
  //
  // The failure direction is the SAFE one for a delete gate (it would refuse a genuine copy rather
  // than accept a fake one), which is why this is pinned on the source rather than chased with a
  // second filesystem. Deleting the card is the one act that cannot be undone; refusing too much
  // costs him a re-run, accepting too much costs him the footage.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(process.cwd(), 'main-mod', '09-ipc-boot.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(src, /ss\.ino && ss\.ino === ds\.ino && ss\.dev === ds\.dev/,
    'the inode match is qualified by the device');
});

test('a GENUINE copy still passes — the gate must not just refuse everything', async () => {
  // The direction that matters just as much: a gate that says no to everything is a gate he routes
  // around. Two real files, same bytes, different inodes.
  try {
    const dst = join(box.dir, 'real-copy.MP4');
    writeFileSync(dst, 'REAL FOOTAGE THAT MUST SURVIVE');
    assert.notEqual(statSync(dst).ino, statSync(box.src).ino, 'genuinely two files');
    const r = await check(box.src, dst);
    assert.equal(r.ok, true, `accepted — got ${JSON.stringify(r)}`);
  } finally { box.cleanup(); }
});

test('a copy with the same size but different bytes is still refused', async () => {
  // Guard the neighbour: the inode branch must not short-circuit the content check for real files.
  try {
    const dst = join(box.dir, 'corrupt.MP4');
    writeFileSync(dst, 'REAL FOOTAGE THAT MUST SURVIVX');   // same length, one byte different
    assert.equal(statSync(dst).size, statSync(box.src).size, 'same size, so only the hash can tell');
    const r = await check(box.src, dst);
    assert.equal(r.ok, false, `refused — got ${JSON.stringify(r)}`);
    assert.match(r.reason, /content mismatch/, `and says why — got ${r.reason}`);
  } finally { box.cleanup(); }
});
