// The undo safety net destroyed itself exactly when it was needed. Found by auditing ERROR paths
// specifically — the branches that only run when something goes wrong, which are the least exercised
// code in an app handling footage that cannot be re-shot.
//
//   1. ⚠⚠ `organize:undo` cleared `config.lastOrganize` UNCONDITIONALLY, after a loop whose every
//      per-clip failure was a silent `catch { failed += 1; }`. Sequence: file 200 clips, realise it is
//      wrong, hit Undo — Resolve or Explorer holds a preview handle on clip 4, so it throws EPERM.
//      Clips 1-3 move back, 4 fails, 5-200 continue, and then the WHOLE record is erased. There is no
//      second attempt: `organize:undoInfo` returns {ok:false}, the Undo menu item and the post-Apply
//      "Undo" toast both go dead, and the clips still sitting in his Projects tree have no recorded
//      origin anywhere. The `failed` count was returned, but the record was gone before the renderer
//      could react to it.
//
//   2. ⚠⚠ `finalize:run` did ALL its bookkeeping after the loop, so a throw partway meant clips
//      physically relocated with `config.lastOrganize` never written at all. The renderer catches the
//      rejection and shows "Failed: <msg>" — which reads as "the run didn't happen" while N clips
//      have in fact moved and cannot be moved back. 10-boot.js explicitly anticipates this rejection
//      ("a locked file on Windows throws EBUSY"), so the renderer was defended and main was not.
//
//   3. Undo left `${to}.xmp` orphaned — and that silently disarmed the empty-folder cleanup, because
//      the leftover sidecar makes `readdir(...).length` non-zero, so the dated folder survives and
//      the folder-reuse rule later adopts it.
//
//   4/5. `projects:move` and `compress:run` both returned ok:true on runs where every single item
//      failed — the same "success over total failure" shape already fixed twice elsewhere.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-undo-'));
  const src = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(src, { recursive: true });
  mkdirSync(join(dest, 'vlog', '2026-06-01'), { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest;
  box = { base, src, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

// Build a lastOrganize record by hand — the same shape finalize:run writes.
const seedRecord = (moves) => {
  const cfg = app.get('config');
  cfg.lastOrganize = { ts: Date.now(), moves };
};

test('⚠⚠ a FAILED undo keeps the record, so it can be retried', async () => {
  try {
    // Two clips filed. One is genuinely there; the other's filed copy is MISSING in a way that makes
    // moveFileCrossDevice throw — a directory sitting where the file should be.
    const okFrom = join(box.src, 'good.mp4');
    const okTo = join(box.dest, 'vlog', '2026-06-01', 'good.mp4');
    writeFileSync(okTo, 'FOOTAGE');
    // ⚠ The failure has to be REAL. My first fixture put a directory where the filed file should be —
    // but rename() moves a directory perfectly well on Linux, so `undone` came back 2 and the test
    // failed for the right reason. This blocks `ensureDir(dirname(m.from))` instead: a FILE sits
    // where the source folder would have to be created, so the restore genuinely throws (ENOTDIR).
    const blocked = join(box.src, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const badFrom = join(blocked, 'locked.mp4');
    const badTo = join(box.dest, 'vlog', '2026-06-01', 'locked.mp4');
    writeFileSync(badTo, 'FOOTAGE');

    seedRecord([{ from: okFrom, to: okTo }, { from: badFrom, to: badTo }]);
    const r = app.plain(await app.invoke('organize:undo'));

    assert.equal(r.undone, 1, 'the healthy clip came back');
    assert.ok(r.failed >= 1, `and the broken one is reported as failed — got ${r.failed}`);
    const lo = app.plain(app.get('config.lastOrganize'));
    assert.ok(lo && Array.isArray(lo.moves) && lo.moves.length === 1,
      `⚠ the record SURVIVES, holding only what is still filed — got ${JSON.stringify(lo)}`);
    assert.equal(lo.moves[0].to, badTo, 'and it is the one that failed');
    // The user-facing consequence: Undo is still offered.
    const info = app.plain(await app.invoke('organize:undoInfo'));
    assert.equal(info.ok, true, '⚠ Undo must still be reachable — this is the whole point');
    assert.equal(info.count, 1, 'and it offers exactly the stragglers');
  } finally { box.cleanup(); }
});

test('⚠ a fully successful undo still clears the record', async () => {
  // The other direction, and the reason this cannot just "never clear": leaving a satisfied record
  // behind would offer an Undo that moves nothing, forever.
  try {
    const from = join(box.src, 'a.mp4');
    const to = join(box.dest, 'vlog', '2026-06-01', 'a.mp4');
    writeFileSync(to, 'FOOTAGE');
    seedRecord([{ from, to }]);
    const r = app.plain(await app.invoke('organize:undo'));
    assert.equal(r.undone, 1);
    assert.equal(r.failed, 0);
    assert.equal(app.plain(app.get('config.lastOrganize')), null, 'nothing left to undo → record cleared');
    assert.equal(app.plain(await app.invoke('organize:undoInfo')).ok, false, 'and Undo is no longer offered');
  } finally { box.cleanup(); }
});

test('⚠ a clip whose filed copy is GONE does not keep the record alive forever', async () => {
  // The bound on the fix. If the filed file no longer exists there is nothing a retry could ever do,
  // so counting it as outstanding would make the record permanently un-clearable and Undo would
  // always be offered while always doing nothing.
  try {
    seedRecord([{ from: join(box.src, 'ghost.mp4'), to: join(box.dest, 'vlog', '2026-06-01', 'ghost.mp4') }]);
    const r = app.plain(await app.invoke('organize:undo'));
    assert.ok(r.failed >= 1, 'it is reported as failed');
    assert.equal(app.plain(app.get('config.lastOrganize')), null,
      '⚠ but the record clears — a vanished file is not a retryable straggler');
  } finally { box.cleanup(); }
});

test('⚠⚠ undo takes the XMP sidecar back with the clip', async () => {
  try {
    const from = join(box.src, 'b.mp4');
    const dir = join(box.dest, 'vlog', '2026-06-01');
    const to = join(dir, 'b.mp4');
    writeFileSync(to, 'FOOTAGE');
    writeFileSync(`${to}.xmp`, '<xmp/>');     // embedding failed, so the sidecar IS the metadata
    seedRecord([{ from, to }]);
    await app.invoke('organize:undo');
    assert.ok(existsSync(`${from}.xmp`), '⚠ the metadata came back with the clip');
    assert.ok(!existsSync(`${to}.xmp`), 'and is not left orphaned in the Projects tree');
  } finally { box.cleanup(); }
});

test('⚠⚠ and the emptied folder is therefore actually removed', async () => {
  // The second-order damage, which is worse than the orphan itself: a leftover .xmp makes the folder
  // non-empty, so the "take the empty folders back too" cleanup breaks out, the dated folder
  // survives, and the folder-reuse rule later hands unrelated clips to a directory that was never
  // meant to exist. It reproduces every time on the same footage, because the clips that fail to
  // embed (HEIC, odd codecs) fail repeatably.
  try {
    const from = join(box.src, 'c.mp4');
    const dir = join(box.dest, 'vlog', '2026-06-01');
    const to = join(dir, 'c.mp4');
    writeFileSync(to, 'FOOTAGE');
    writeFileSync(`${to}.xmp`, '<xmp/>');
    seedRecord([{ from, to }]);
    await app.invoke('organize:undo');
    assert.ok(!existsSync(dir), `⚠ the emptied dated folder is gone — it survived while the sidecar remained`);
  } finally { box.cleanup(); }
});

test('undoing a COPY removes the filed copy and its sidecar, keeping the original', async () => {
  // The copied branch is genuinely different: the original was never moved, so "undo" means delete
  // the copy — and the copy's sidecar with it, not move it over the original's.
  try {
    const from = join(box.src, 'd.mp4');
    writeFileSync(from, 'FOOTAGE');            // the original is still in place
    const to = join(box.dest, 'vlog', '2026-06-01', 'd.mp4');
    writeFileSync(to, 'FOOTAGE');
    writeFileSync(`${to}.xmp`, '<xmp/>');
    seedRecord([{ from, to, copied: true }]);
    await app.invoke('organize:undo');
    assert.ok(existsSync(from), 'the original is untouched');
    assert.ok(!existsSync(to), 'the copy is removed');
    assert.ok(!existsSync(`${to}.xmp`), 'and so is its sidecar');
  } finally { box.cleanup(); }
});

// --- the "success over total failure" pair, and the incremental undo record ---
const ipc = readFileSync(join(process.cwd(), 'main-mod', '09-ipc-boot.js'), 'utf8').replace(/\/\/.*$/gm, '');
const media = readFileSync(join(process.cwd(), 'main-mod', '02-media.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('⚠⚠ finalize:run writes the undo record AS IT GOES, not only at the end', () => {
  // A throw partway used to mean footage relocated with no undo record at all.
  const inLoop = ipc.indexOf('if (!skipMove && metaLanded) filed.push(it.name);');
  assert.ok(inLoop > -1, 'found the end of the per-clip loop');
  const after = ipc.slice(inLoop, inLoop + 300);
  assert.match(after, /if \(undoable\.length\) \{ config\.lastOrganize = \{ ts: runTs, moves: undoable \}; saveConfig\(\); \}/,
    '⚠ the record is stamped inside the loop');
  // One stable timestamp, taken before anything moves — organize:undo passes it to reverseLastLedger,
  // which refuses to reverse a ledger delta older than the run.
  assert.match(ipc, /const runTs = Date\.now\(\);/, 'and the run has one stable timestamp');
  assert.doesNotMatch(ipc, /config\.lastOrganize = \{ ts: Date\.now\(\), moves: undoable \}/,
    'no site re-stamps it with a drifting Date.now()');
});

test('⚠ the progress emitter cannot abort a run that has already moved footage', () => {
  const at = ipc.indexOf('const emit = (index, name, phase)');
  assert.ok(at > -1, 'found the emitter');
  const body = ipc.slice(at, ipc.indexOf('\n  };', at));
  assert.match(body, /try \{ sender\.send\('finalize:progress'/, 'guarded like its five siblings');
});

test('⚠ projects:move reports failure when nothing landed', () => {
  const at = media.indexOf('const movedAny = results.some');
  assert.ok(at > -1, 'the outcome is computed, not asserted');
  const body = media.slice(at, media.indexOf('\n});', at));
  assert.match(body, /if \(errs\.length && !movedAny\) \{ res\.ok = false;/,
    '⚠ every clip failing is not a successful run');
});

test('⚠ compress:run reports failure when nothing encoded', () => {
  assert.match(ipc, /return \{ ok: !compressAborted && \(okCount > 0 \|\| failedCount === 0\)/,
    '⚠ "Compressed 0 clips · 12 failed ✓" was the third instance of this pattern');
  const boot = readFileSync(join(process.cwd(), 'src', 'mod', '10-boot.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(boot, /: `Nothing was compressed\$\{failed\.length \? ` — \$\{failed\.length\} failed` : ''\}`\);/,
    'and the toast agrees');
});
