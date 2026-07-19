// copyFileVerified is the COPY primitive behind the NAS mirror, project-tree copy, and phone backup.
// Two bugs (audit T1 #2/#3): (a) if dest existed but was a DIFFERENT file it overwrote it (destroying
// a good unrelated backup — basenames collide after a per-scan _v# reset); (b) it wrote directly to
// the final name, so a crash mid-copy left a truncated file under the real name. Fixed: version on
// collision (never clobber) + route through atomic stageVerifiedCopy (.part -> verify -> rename).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'cvcol-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const CV = (src, dest, opts) => app.call('copyFileVerified', src, dest, opts || {});
function mk(name, bytes) { const f = join(dir, name); writeFileSync(f, bytes); return f; }

test('a fresh copy lands verified, with no leftover .part temp', async () => {
  const src = mk('src1.bin', 'hello-world-payload');
  const out = join(dir, 'out', 'a.bin'); mkdirSync(join(dir, 'out'), { recursive: true });
  const r = await CV(src, out);
  assert.equal(r, 'copied');
  assert.equal(readFileSync(out, 'utf8'), 'hello-world-payload');
  const leftover = readdirSync(join(dir, 'out')).filter((n) => n.includes('.part'));
  assert.equal(leftover.length, 0, 'atomic staging left no .part temp behind');
});

test('an identical dest is skipped, not re-copied', async () => {
  const src = mk('src2.bin', 'same-bytes');
  const out = join(dir, 'out2', 'b.bin'); mkdirSync(join(dir, 'out2'), { recursive: true });
  await CV(src, out);
  const r = await CV(src, out);
  assert.equal(r, 'skipped', 'byte-identical dest is a no-op');
});

test('a truncated/differing pre-existing dest is REPAIRED atomically (overwritten with the full file)', async () => {
  // Same file, prior copy left short -> must be repaired to match source (the resume case). Content
  // alone can't distinguish this from a cross-clip name collision; repair is the intended default.
  const outDir = join(dir, 'nas'); mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, 'clip.mp4');
  writeFileSync(dest, 'SHORT');                               // a truncated prior copy
  const src = mk('src3.mp4', 'FULL-CORRECT-CONTENT-PAYLOAD'); // the good source
  const r = await CV(src, dest);
  assert.equal(r, 'copied');
  assert.equal(readFileSync(dest, 'utf8'), 'FULL-CORRECT-CONTENT-PAYLOAD', 'dest repaired to match source');
  assert.equal(readdirSync(outDir).filter((n) => n.includes('.part')).length, 0, 'no .part temp left behind');
});
