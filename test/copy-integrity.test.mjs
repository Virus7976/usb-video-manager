// The card → intake copy is the ONE copy of the footage. It was the only copy path in the app that
// used none of the verify-before-trust primitives, and it could corrupt the archive three ways:
//
//  1. It wrote straight to the FINAL path, so a partial copy wore the real filename.
//  2. Cancelling called rs.destroy(), which emits neither 'end' nor 'error' — so pipe() never called
//     ws.end(), 'finish' never fired, and THE PROMISE NEVER SETTLED. copy:start's await hung forever,
//     which made its own `if (aborted) unlink(destPath)` cleanup unreachable dead code. The truncated
//     clip stayed in intake under its final name; Tdarr compressed it; it was filed into Projects;
//     and the delete gate (which compares card↔intake) cleared the card anyway.
//  3. It verified nothing — a flaky read or a mid-copy ENOSPC produced a short file that looked done.
//
// It now stages to <dest>.part → datasync → FULL-file fingerprint against the card → rename. So a
// file at `dest` is always a complete, verified copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'copyint-')); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A big, incompressible source file so a copy takes long enough to cancel mid-flight. */
function card(name, bytes = 8 * 1024 * 1024) {
  const d = join(dir, 'card'); mkdirSync(d, { recursive: true });
  const p = join(d, name);
  writeFileSync(p, randomBytes(bytes));
  return p;
}
const intake = () => { const d = join(dir, `intake-${Math.random().toString(36).slice(2, 8)}`); mkdirSync(d, { recursive: true }); return d; };

test('a completed copy is byte-identical and lands under its final name', async () => {
  const copyFileWithProgress = app.get('copyFileWithProgress');
  const src = card('good.mp4', 2 * 1024 * 1024);
  const out = intake();
  const dest = join(out, 'good.mp4');

  let seen = 0;
  await copyFileWithProgress(src, dest, (n) => { seen += n; }, {});

  assert.equal(seen, statSync(src).size, 'progress reported every byte');
  assert.deepEqual(readFileSync(dest), readFileSync(src), 'the copy is byte-identical');
  assert.deepEqual(readdirSync(out), ['good.mp4'], 'and no .part is left behind');
});

test('CANCELLING settles the promise — it used to hang forever', async () => {
  // This is the bug that wedged everything downstream: copy:start's await never returned, so
  // copyTask.active stayed true (every later copy refused with "A copy is already running") and the
  // renderer's copyInProgress latch stuck true for the rest of the session.
  const copyFileWithProgress = app.get('copyFileWithProgress');
  const src = card('cancelme.mp4');
  const out = intake();
  const dest = join(out, 'cancelme.mp4');

  const token = {};
  let copied = 0;
  const p = copyFileWithProgress(src, dest, (n) => {
    copied += n;
    if (copied > 64 * 1024 && token.destroy) token.destroy();   // yank it mid-flight
  }, token);

  const settled = await Promise.race([
    p.then(() => 'resolved', (e) => `rejected:${e.message}`),
    new Promise((r) => setTimeout(() => r('HUNG'), 4000)),
  ]);

  assert.notEqual(settled, 'HUNG', 'the promise SETTLES — this is the whole bug');
  assert.equal(settled, 'rejected:aborted', 'and it rejects as an abort, so the caller can clean up');
});

test('a CANCELLED copy leaves NO file in intake — not even a plausible truncated one', async () => {
  // The corruption path: a truncated clip under the real filename gets compressed by Tdarr and filed
  // into the archive, while the delete gate happily clears the card.
  const copyFileWithProgress = app.get('copyFileWithProgress');
  const src = card('partial.mp4');
  const out = intake();
  const dest = join(out, 'partial.mp4');

  const token = {};
  let copied = 0;
  await copyFileWithProgress(src, dest, (n) => {
    copied += n;
    if (copied > 64 * 1024 && token.destroy) token.destroy();
  }, token).catch(() => {});

  assert.equal(existsSync(dest), false, 'NO truncated file wearing the real name');
  assert.deepEqual(readdirSync(out), [], 'and the .part staging file is cleaned up too');
});

test('a copy whose bytes do not match the card is REFUSED, and nothing is left behind', async () => {
  // Simulates a flaky card read / silent corruption: the source is swapped underneath us so the
  // fingerprint cannot match. The old code had no verification at all and would have accepted it.
  const copyFileWithProgress = app.get('copyFileWithProgress');
  const src = card('flaky.mp4', 1024 * 1024);
  const out = intake();
  const dest = join(out, 'flaky.mp4');

  let done = false;
  const p = copyFileWithProgress(src, dest, () => {
    // Corrupt the SOURCE mid-copy so the post-copy fingerprint of src != what we wrote.
    if (!done) { done = true; writeFileSync(src, randomBytes(1024 * 1024)); }
  }, {});

  await assert.rejects(p, /did not match the card|refusing to trust/i, 'a copy that does not match is refused');
  assert.equal(existsSync(dest), false, 'and the unverifiable bytes never reach the final name');
  assert.deepEqual(readdirSync(out), [], 'no .part left behind either');
});

test('the staging file is never mistaken for footage', () => {
  // .part is not a video extension, so even if one somehow survived, listVideosShallow would not
  // pick it up and it could not be organized into the archive.
  const VIDEO_EXTS = app.get('VIDEO_EXTS');
  assert.ok(VIDEO_EXTS && typeof VIDEO_EXTS.has === 'function');
  assert.equal(VIDEO_EXTS.has('.part'), false);
});

// --- compress staging --------------------------------------------------------------------

test('a partial ENCODE can never masquerade as a finished clip', () => {
  // ffmpeg used to write straight to <out>/<base>.mp4, and the rm-the-partial cleanup only ran when
  // ffmpeg exited cleanly with a non-zero code. A crash, a power cut, or just quitting mid-encode
  // left a plausible truncated .mp4 — and skipExisting (default ON) then accepted it as done,
  // reported ok, and organized it into Projects. It could end up the ONLY surviving copy.
  const src = readFileSync(new URL('../main-mod/09-ipc-boot.js', import.meta.url), 'utf8');
  const h = src.slice(src.indexOf("ipcMain.handle('compress:run'"));
  const body = h.slice(0, h.indexOf('\n});'));

  assert.match(body, /const partDir = path\.join\(out, '\.partial'\)/, 'the encode is staged');
  assert.match(body, /buildCompressArgs\(src, partPath, s\)/, 'ffmpeg writes to the staging path, NOT the final one');
  assert.match(body, /await fsp\.rename\(partPath, outPath\)/, 'and it is only promoted after ffmpeg exits 0');

  // The staging path keeps the .mp4 extension (ffmpeg picks its muxer from it) — the DIRECTORY is
  // what hides it, and listVideosShallow only lists FILES at the top level.
  assert.match(body, /path\.join\(partDir, path\.basename\(outPath\)\)/);

  const media = readFileSync(new URL('../main-mod/02-media.js', import.meta.url), 'utf8');
  const scan = media.slice(media.indexOf('async function listVideosShallow'));
  assert.match(scan.slice(0, scan.indexOf('\n}')), /if \(!e\.isFile\(\)\) continue;/,
    'the Organize scan lists files only — a .partial DIRECTORY is invisible to it');
});

test('a failed organize move does NOT mark its metadata as filed', () => {
  // A clip whose move threw stayed where it was, but fell through to filed.push() — which marks its
  // metadata done and therefore prune-eligible. The clip AND its metadata were then disposable.
  const src = readFileSync(new URL('../main-mod/09-ipc-boot.js', import.meta.url), 'utf8');
  const h = src.slice(src.indexOf("ipcMain.handle('finalize:run'"));
  const body = h.slice(0, h.indexOf('\n});'));
  // The move's catch block must `continue` — the embed-failure path above already did exactly this,
  // for exactly this reason; the move path just didn't.
  const move = body.slice(body.indexOf('const r = await organizeMove('));
  const catchBlock = move.slice(move.indexOf('} catch (err) {'), move.indexOf('// 3. Mirror to the NAS'));
  assert.ok(catchBlock.length > 0, 'the move has a catch block');
  assert.match(catchBlock, /summary\.errors\.push\(`Move /, 'it records the failure');
  assert.match(catchBlock, /\bcontinue;/, 'and SKIPS filed.push() — a clip that did not move is not "filed"');
});

test('finalize:run stops claiming success when it achieved nothing', () => {
  const src = readFileSync(new URL('../main-mod/09-ipc-boot.js', import.meta.url), 'utf8');
  assert.match(src, /if \(summary\.errors\.length && !didSomething\) \{\s*summary\.ok = false;/,
    'a run where everything failed reports failure — ok was hardcoded true and never reconsidered');
});

// --- the renderer keeps what actually landed ---------------------------------------------

test('a cancelled or failed copy still RECORDS the files that did copy', () => {
  // copy:start only pushes a file into `copied` after it has been fingerprint-verified. Both the
  // cancel and the failure paths used to just `return`, throwing that list away — so clips that were
  // safely on disk were forgotten: not clearable from the card, and re-copied next run as " (1)"
  // duplicates sitting beside the originals.
  const flow = readFileSync(new URL('../src/mod/09-phone-finalize.js', import.meta.url), 'utf8');
  assert.match(flow, /const keepPartial = \(why\) =>/, 'there is one place that keeps partial progress');
  assert.match(flow, /window\.api\.recordCopied\(done\.map/, 'and it records them durably');

  const run = flow.slice(flow.indexOf('async function runCopy('));
  const body = run.slice(0, run.indexOf('\n}\n'));
  assert.match(body, /if \(res && res\.cancelled\) \{\s*keepPartial\('cancel'\)/, 'the cancel path keeps them');
  assert.match(body, /if \(!res \|\| !res\.ok\) \{\s*keepPartial\('failure'\)/, 'the failure path keeps them');
});
