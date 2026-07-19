// Audit #19 — the footage copy fsync'd the FILE but never the parent DIRECTORY.
//
// stageVerifiedCopy does: copy → flushToDisk(tmp) → full verify → rename(tmp, dest). The bytes are
// durable; the DIRECTORY ENTRY that names them is not. A power loss after the rename can leave the
// entry unwritten, so the file is gone even though its contents were safely on the platter — and
// `moveFileCrossDevice` deletes the source immediately after, so that is the only copy.
//
// `writeJsonAtomic` (main-mod/01-core.js) has fsync'd its directory since the store work. The
// FOOTAGE path — the irreplaceable thing — never got the same guarantee. Same shape as #16
// (organize had the free-space preflight, intake didn't) and #10 (main had storeReadFailed, the
// renderer loads didn't).
//
// What is testable here: that the mechanism EXISTS, is invoked after the rename, and is harmless.
// The durability property itself needs a power cut, so it is asserted structurally and documented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('#19 a directory-flush primitive exists', async () => {
  const { dir, cleanup } = tempDir('dirfsync-');
  await app.call('flushDirEntry', dir);   // must not throw on a real directory
  cleanup();
});

test('#19 it is best-effort — a bad path never throws', async () => {
  // This runs on the delete-gate-adjacent copy path. It must never be the reason a copy fails:
  // Windows cannot fsync a directory handle via Node at all, so throwing would break every copy there.
  await app.call('flushDirEntry', '/nonexistent/definitely/not/here');
  await app.call('flushDirEntry', '');
  await app.call('flushDirEntry', null);
});

test('#19 stageVerifiedCopy still produces a byte-correct file', async () => {
  // The guard against "hardened it into a regression": the copy must still work exactly as before.
  const { dir, cleanup } = tempDir('dirfsync-copy-');
  const src = path.join(dir, 'clip.mp4');
  const dest = path.join(dir, 'out', 'clip.mp4');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(src, 'irreplaceable footage bytes');

  await app.call('stageVerifiedCopy', src, dest);

  assert.equal(fs.readFileSync(dest, 'utf8'), 'irreplaceable footage bytes', 'the copy is byte-identical');
  assert.equal(fs.existsSync(src), true, 'staging never touches the source');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['clip.mp4'], 'and no .part temp is left behind');
  cleanup();
});

test('#19 the flush happens AFTER the rename, on the destination directory', () => {
  // Order is the whole point: fsync'ing the directory before the rename durably records a directory
  // that does not yet contain the file.
  const src = fs.readFileSync(path.join(ROOT, 'main-mod/02-media.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function stageVerifiedCopy('), src.indexOf('async function moveFileCrossDevice('));
  const renameAt = fn.indexOf('await fsp.rename(tmp, dest)');
  const flushAt = fn.indexOf('flushDirEntry(');
  assert.ok(renameAt > -1, 'the rename is still there');
  assert.ok(flushAt > renameAt, 'the directory flush follows the rename');
});

test('#19 the same-device move path flushes its directory too', () => {
  // moveFileCrossDevice's fast path is a bare rename, and it is the one that DELETES the source.
  const src = fs.readFileSync(path.join(ROOT, 'main-mod/02-media.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function moveFileCrossDevice('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /flushDirEntry\(/, 'the rename fast-path makes its entry durable as well');
});
