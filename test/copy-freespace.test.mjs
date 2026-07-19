// Audit #16 — the intake copy had no free-space preflight.
//
// `copy:start` already sums every file into `totalBytes` for the progress bar, but never compared it
// to the destination's free space. A 60 GB card into a 40 GB disk therefore ran happily until ENOSPC
// somewhere in the middle, leaving a half-imported card, a truncated clip, and a full system disk —
// the worst possible moment to find out. The ORGANIZE path has had this check for a while
// (main-mod/09-ipc-boot.js); intake, which is the very first step, did not.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let dirs = [];
beforeEach(() => { dirs = []; });
const mk = (prefix) => { const d = tempDir(prefix); dirs.push(d); return d.dir; };

function sourceFile(dir, name, bytes = 'footage') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

test('#16 a card bigger than the free space is refused BEFORE anything is written', async () => {
  const card = mk('cf-card-');
  const intake = mk('cf-intake-');
  const src = sourceFile(card, 'GX010023.MP4');

  // Declared size far beyond any real disk — the same number the progress bar already trusts.
  const r = await app.invoke('copy:start', {
    files: [{ sourcePath: src, name: 'GX010023.MP4', size: 9e15 }],
    intakeFolder: intake,
  });

  assert.equal(r.ok, false, 'the copy is refused, not started');
  assert.match(r.error, /not enough room/i);
  assert.match(r.error, /GB/, 'the message states the numbers so it is actionable');
  assert.deepEqual(fs.readdirSync(intake), [], 'and nothing was written — no half-imported card');
});

test('#16 a copy that fits still runs normally', async () => {
  // The dangerous direction: a preflight that mis-computes would refuse every real import.
  const card = mk('cf-card2-');
  const intake = mk('cf-intake2-');
  const src = sourceFile(card, 'GX010024.MP4', 'real footage bytes');

  const r = await app.invoke('copy:start', {
    files: [{ sourcePath: src, name: 'GX010024.MP4', size: 18 }],
    intakeFolder: intake,
  });

  assert.equal(r.ok, true, `a normal import must not be blocked: ${r.error || ''}`);
  assert.deepEqual(fs.readdirSync(intake), ['GX010024.MP4'], 'the clip really landed in intake');
});

test('#16 an unreadable destination volume does not block the copy', async () => {
  // If we genuinely cannot read the volume we must not refuse the import over it — same call the
  // organize preflight makes. A missing `size` counts as 0 rather than blocking.
  const card = mk('cf-card3-');
  const intake = mk('cf-intake3-');
  const src = sourceFile(card, 'GX010025.MP4', 'bytes');

  const r = await app.invoke('copy:start', {
    files: [{ sourcePath: src, name: 'GX010025.MP4' }],   // no size at all
    intakeFolder: intake,
  });

  assert.equal(r.ok, true, 'unknown sizes must not turn into a false refusal');
});
