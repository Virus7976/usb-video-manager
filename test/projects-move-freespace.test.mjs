// projects:move had no free-space preflight; its twin finalize:run does. Found by sibling sweep.
//
// Both file clips into the Projects tree, both default to COPY, and the map's "Apply — file clips"
// (src/mod/07-organize-map.js) reaches THIS one. finalize:run refuses up front when the destination
// cannot hold the batch (main-mod/09-ipc-boot.js ~577), with a comment calling a mid-run ENOSPC "the
// worst possible time"; copy:start and phone:pull have the same guard. projects:move had none.
//
// Why it matters here specifically: Jake files onto C:, which is his TIGHT disk, from a much larger
// archive. Running out part-way leaves a half-filed shoot, a truncated file in the Projects tree,
// and a full system disk — and filling a system disk breaks the machine, not just the app. That is
// why the guard keeps 2 GB of headroom rather than checking for a bare fit.
//
// The check is ADVISORY, exactly like its twin: if the volume genuinely cannot be read it must not
// block a real import. Fail toward letting the user work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const dirs = [];
const mk = (p) => { const d = tempDir(p); dirs.push(d); return d.dir; };
const file = (dir, name, bytes = 'x') => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };

test('a batch that cannot fit is refused BEFORE anything is written', async () => {
  const src = mk('pmf-src-'); const dest = mk('pmf-dest-');
  const a = file(src, 'huge.mp4');
  // Declare an impossible size, the same trick the intake preflight test uses: no real disk has
  // 9 PB free, and the handler must trust the declared size rather than stat'ing every source twice.
  const r = app.plain(await app.invoke('projects:move', {
    moves: [{ from: a, toDir: dest, name: 'huge.mp4', size: 9e15 }],
    embed: false, copy: true,
  }));
  assert.equal(r.ok, false, 'refused');
  assert.match(String(r.error), /not enough room/i, 'and says why, in the same language as finalize:run');
  assert.equal(fs.readdirSync(dest).length, 0, 'nothing was written before the refusal');
  assert.ok(fs.existsSync(a), 'the source is untouched');
});

test('an ordinary batch still files — the guard is not a tax on real work', async () => {
  const src = mk('pmf-ok-src-'); const dest = mk('pmf-ok-dest-');
  const a = file(src, 'small.mp4', 'footage');
  const r = app.plain(await app.invoke('projects:move', {
    moves: [{ from: a, toDir: dest, name: 'small.mp4', size: fs.statSync(a).size }],
    embed: false, copy: true,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.results[0].ok, true);
  assert.ok(fs.existsSync(path.join(dest, 'small.mp4')));
});

test('a batch with NO declared sizes is not blocked — the check is advisory', async () => {
  // Callers that omit size must keep working. An advisory preflight that refuses on missing
  // information would turn a nicety into an outage.
  const src = mk('pmf-nosize-src-'); const dest = mk('pmf-nosize-dest-');
  const a = file(src, 'nosize.mp4', 'footage');
  const r = app.plain(await app.invoke('projects:move', {
    moves: [{ from: a, toDir: dest, name: 'nosize.mp4' }],
    embed: false, copy: true,
  }));
  assert.equal(r.ok, true, 'no declared size → no refusal');
  assert.ok(fs.existsSync(path.join(dest, 'nosize.mp4')));
});

test('MOVE mode is not blocked — a move within a volume needs no new space', async () => {
  // finalize:run only preflights when copyMode is on, for the same reason: a move consumes no
  // additional space on the destination volume. Refusing one on space grounds would be nonsense.
  const src = mk('pmf-move-src-'); const dest = mk('pmf-move-dest-');
  const a = file(src, 'moved.mp4', 'footage');
  const r = app.plain(await app.invoke('projects:move', {
    moves: [{ from: a, toDir: dest, name: 'moved.mp4', size: 9e15 }],
    embed: false, copy: false,
  }));
  assert.equal(r.ok, true, 'a move is never refused for space');
  assert.ok(fs.existsSync(path.join(dest, 'moved.mp4')));
});
