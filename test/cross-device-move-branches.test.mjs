// The cross-device move — the ONLY path his machine ever takes — had no test.
//
// `moveFileCrossDevice` tries `rename` first and falls back on `EXDEV`:
//
//     try { await fsp.rename(src, dest); await flushDirEntry(...); return; }
//     catch (err) { if (err.code !== 'EXDEV') throw err; }
//     await stageVerifiedCopy(src, dest);
//     await fsp.unlink(src);
//
// `EXDEV` appears in zero tests, and it is not an edge case for him: his intake is `L:` and his
// Projects tree is on `C:`, so **every move he makes crosses a device boundary** and takes the
// fallback. The fast path — the only one under test — is the one he never uses.
//
// The ordering in those last two lines is the whole safety property: the source is deleted ONLY after
// a full verified copy has landed. If verification fails, `stageVerifiedCopy` throws and the `unlink`
// never runs. Get that backwards, or swallow the throw, and a failed move destroys the footage —
// which is the one outcome this app must never produce.
//
// Injecting EXDEV is the only way to reach it deterministically; a real two-device fixture is not
// something a temp dir can arrange.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'uvd-xdev-'));
  const src = join(dir, 'GX010042.MP4');
  writeFileSync(src, 'ORIGINAL FOOTAGE');
  box = { dir, src, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

// Make rename report EXDEV exactly where the OS would: on the SOURCE path only.
//
// My first version failed every rename, which broke the test for the wrong reason — `stageVerifiedCopy`
// finishes with its own `rename(tmp, dest)`, and that one is inside a single directory, so on a real
// cross-device move it succeeds. A blanket stub simulates a machine that cannot rename at all, which
// is not the situation being tested. The failure was the test catching my own fixture.
const withExdev = async (fn, srcPath) => {
  app.get('__realRename = fsp.rename');
  app.get(`__exdevSrc = ${JSON.stringify(srcPath)}`);
  app.get(`fsp.rename = async function (from, to) {
    if (String(from) === __exdevSrc) { const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e; }
    return __realRename(from, to);
  };`);
  try { return await fn(); } finally { app.get('fsp.rename = __realRename'); }
};

test('⚠ a cross-device move really moves the file', async () => {
  try {
    const dest = join(box.dir, 'moved.MP4');
    await withExdev(() => app.get('moveFileCrossDevice')(box.src, dest), box.src);
    assert.equal(existsSync(dest), true, 'it landed at the destination');
    assert.equal(readFileSync(dest, 'utf8'), 'ORIGINAL FOOTAGE', 'byte-identical');
    assert.equal(existsSync(box.src), false, 'and the source is gone — it was a MOVE');
  } finally { box.cleanup(); }
});

test('⚠⚠ a cross-device move whose copy FAILS VERIFICATION keeps the source', async () => {
  // The property that matters more than any other in this file. A move deletes the original; if the
  // copy cannot be proven good, deleting it destroys the only footage. The unlink must be unreachable
  // when the verify throws.
  try {
    const dest = join(box.dir, 'moved.MP4');
    let threw = null;
    app.get('__realFpmX = fingerprintsMatch');
    app.get('fingerprintsMatch = async function () { return false; };');
    try {
      await withExdev(() => app.get('moveFileCrossDevice')(box.src, dest), box.src);
    } catch (e) { threw = e; }
    finally { app.get('fingerprintsMatch = __realFpmX'); }

    assert.ok(threw, 'the move fails loudly rather than quietly losing the clip');
    assert.equal(existsSync(box.src), true, '⚠ HIS FOOTAGE SURVIVES');
    assert.equal(readFileSync(box.src, 'utf8'), 'ORIGINAL FOOTAGE', 'and is unchanged');
    assert.equal(existsSync(dest), false, 'with nothing half-written at the destination');
    assert.deepEqual(readdirSync(box.dir).filter((n) => n.includes('.part-')), [], 'and no temp left behind');
  } finally { box.cleanup(); }
});

test('the same-device fast path still works and is still a move', async () => {
  // Guard the branch that WAS covered: the fallback must not have replaced it.
  try {
    const dest = join(box.dir, 'renamed.MP4');
    await app.get('moveFileCrossDevice')(box.src, dest);
    assert.equal(existsSync(dest), true, 'landed');
    assert.equal(existsSync(box.src), false, 'source gone');
  } finally { box.cleanup(); }
});

test('a NON-EXDEV rename error is rethrown, not silently retried as a copy', async () => {
  // The `if (err.code !== 'EXDEV') throw err` line. A permission error must surface, not fall through
  // to a copy-and-delete that might half-succeed against a destination he cannot write.
  try {
    // Source-specific again, and for a sharper reason this time. A blanket stub also breaks the
    // rename INSIDE stageVerifiedCopy, so the fallback throws EACCES too — and the test passes
    // whether or not the rethrow exists. I proved that by replacing the guard with a bare
    // `catch { /* fall through */ }` and watching it stay green. Failing only the source rename lets
    // the fallback genuinely succeed, so a missing rethrow shows up as "no error at all".
    app.get('__realRename2 = fsp.rename');
    app.get(`__eaccesSrc = ${JSON.stringify(box.src)}`);
    app.get(`fsp.rename = async function (from, to) {
      if (String(from) === __eaccesSrc) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return __realRename2(from, to);
    };`);
    let threw = null;
    try { await app.get('moveFileCrossDevice')(box.src, join(box.dir, 'nope.MP4')); }
    catch (e) { threw = e; }
    finally { app.get('fsp.rename = __realRename2'); }
    assert.ok(threw, 'it throws rather than quietly copy-and-deleting past a permission error');
    assert.equal(threw.code, 'EACCES', `the original error, not a copy failure — got ${threw.code}`);
    assert.equal(existsSync(box.src), true, 'and the source is untouched');
    assert.equal(existsSync(join(box.dir, 'nope.MP4')), false, 'with nothing written at the destination');
  } finally { box.cleanup(); }
});

test('the fallback verifies with a FULL hash, not a sample', async () => {
  // It routes through stageVerifiedCopy precisely so a move and a copy can never drift in how
  // rigorously they check. Pinned on the source: a sampled verify before deleting the original is the
  // difference between checking the footage and pretending to, and no fixture here can tell a 2 MB
  // sample from a full read.
  const { readFileSync: rf } = await import('node:fs');
  const src = rf(join(process.cwd(), 'main-mod', '02-media.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const fn = src.slice(src.indexOf('async function moveFileCrossDevice'), src.indexOf('\n}', src.indexOf('async function moveFileCrossDevice')));
  assert.match(fn, /await stageVerifiedCopy\(src, dest\);\s*\n\s*await fsp\.unlink\(src\);/,
    'copy-then-verify strictly before the delete, with nothing between them');
});
