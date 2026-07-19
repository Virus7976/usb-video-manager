// The destination-map "Apply — file clips" (projects:move) used to ALWAYS move, silently deleting the
// L: archive source and leaving the C: project tree as the only copy — violating "organize COPIES,
// never moves". It now honors a copy flag (default copy = safe). These tests pin: copy keeps the
// source, move removes it, a missing flag defaults to copy, and copies are recorded as undoable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'pmcopy-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

function src(name) { const p = join(dir, 'archive'); mkdirSync(p, { recursive: true }); const f = join(p, name); writeFileSync(f, `bytes-${name}`); return f; }
const toDir = () => { const p = join(dir, 'Projects', '2026 - Personal'); mkdirSync(p, { recursive: true }); return p; };

test('copy mode KEEPS the archive source (and files a copy)', async () => {
  const from = src('a.mp4'); const dest = toDir();
  const r = await app.invoke('projects:move', { moves: [{ from, toDir: dest, name: 'a.mp4' }], embed: false, copy: true });
  assert.equal(r.ok, true);
  assert.equal(existsSync(from), true, 'the L: archive original is UNTOUCHED');
  assert.equal(existsSync(join(dest, 'a.mp4')), true, 'a copy is filed into Projects');
});

test('a MISSING copy flag defaults to copy (never silently deletes the archive)', async () => {
  const from = src('b.mp4'); const dest = toDir();
  const r = await app.invoke('projects:move', { moves: [{ from, toDir: dest, name: 'b.mp4' }], embed: false });
  assert.equal(r.ok, true);
  assert.equal(existsSync(from), true, 'no flag => copy => original kept');
});

test('copy:false MOVES (removes the source) — explicit opt-out still works', async () => {
  const from = src('c.mp4'); const dest = toDir();
  const r = await app.invoke('projects:move', { moves: [{ from, toDir: dest, name: 'c.mp4' }], embed: false, copy: false });
  assert.equal(existsSync(from), false, 'explicit move removes the source');
  assert.equal(existsSync(join(dest, 'c.mp4')), true, 'and files it');
});

test('copied clips are recorded as undoable (copy mode had no undo before)', async () => {
  const from = src('d.mp4'); const dest = toDir();
  await app.invoke('projects:move', { moves: [{ from, toDir: dest, name: 'd.mp4' }], embed: false, copy: true });
  const lo = app.get('config').lastOrganize;
  assert.ok(lo && lo.moves && lo.moves.length === 1, 'an undo record exists for the copy');
  assert.equal(lo.moves[0].copied, true, 'flagged as a copy so undo removes the copy, not relocates it');
});
