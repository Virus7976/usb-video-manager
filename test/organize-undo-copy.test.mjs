// Two organize-path fixes found by audit (2026-07-17):
//  - Finding 1: a skipMove (unplanned-under-a-plan) clip was pushed to `filed` and marked done, so
//    its finalMeta became prune-eligible even though the clip was never filed. After eviction the
//    clip is filtered out (needs meta) and can never be organized again. It must NOT be marked done.
//  - Finding 4: organize:undo of a COPIED clip relocated the copy beside the still-present original
//    (a stray duplicate) instead of removing it. Undo of a copy must REMOVE the copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'undocopy-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('undo of a COPIED clip removes the copy and leaves the original untouched', async () => {
  const proj = join(dir, 'Projects', '2026 - Personal'); mkdirSync(proj, { recursive: true });
  const origDir = join(dir, 'Compressed'); mkdirSync(origDir, { recursive: true });
  const from = join(origDir, 'clip.mp4'); writeFileSync(from, 'original-bytes');       // the source (copy mode leaves it)
  const to = join(proj, 'clip.mp4'); writeFileSync(to, 'original-bytes');               // the filed COPY
  app.get('config').lastOrganize = { ts: 1, moves: [{ from, to, copied: true }] };

  const r = await app.invoke('organize:undo');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.undone, 1);
  assert.equal(existsSync(to), false, 'the filed copy is removed');
  assert.equal(existsSync(from), true, 'the original is untouched');
  // The bug produced a versioned duplicate next to the source — there must be none.
  assert.equal(existsSync(join(origDir, 'clip_v1.mp4')), false, 'no stray duplicate beside the original');
});

test('undo of a MOVED clip still restores it (no regression)', async () => {
  const proj = join(dir, 'Projects2'); mkdirSync(proj, { recursive: true });
  const origDir = join(dir, 'Compressed2'); mkdirSync(origDir, { recursive: true });
  const from = join(origDir, 'moved.mp4');
  const to = join(proj, 'moved.mp4'); writeFileSync(to, 'moved-bytes');   // filed; original slot empty (it was moved)
  app.get('config').lastOrganize = { ts: 1, moves: [{ from, to, copied: false }] };

  const r = await app.invoke('organize:undo');
  assert.equal(r.undone, 1);
  assert.equal(existsSync(from), true, 'the clip is moved back to its original slot');
  assert.equal(existsSync(to), false, 'and is gone from the Projects tree');
});

import { mkdtempSync as mk2 } from 'node:fs';
test('Finding 1: a skipMove (unplanned) clip is NOT marked done, so its metadata survives', async () => {
  const d = mk2(join(tmpdir(), 'skipmove-'));
  const comp = join(d, 'Compressed'); mkdirSync(comp, { recursive: true });
  const proj = join(d, 'Projects'); mkdirSync(proj, { recursive: true });
  const movedSrc = join(comp, 'moved.mp4'); writeFileSync(movedSrc, 'a');
  const skipSrc = join(comp, 'skip.mp4'); writeFileSync(skipSrc, 'b');
  // Seed finalMeta for both clips (keyed by name, lowercased).
  await app.invoke('finalMeta:save', { 'moved.mp4': { subject: 'skiing' }, 'skip.mp4': { subject: 'vlog' } });

  // usingPlan is true because moved.mp4 carries a rel; skip.mp4 has none → skipMove.
  const r = await app.invoke('finalize:run', {
    dir: comp, organizeDest: proj,
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [
      { name: 'moved.mp4', sourcePath: movedSrc, meta: { subject: 'skiing' }, rel: '2026 - Personal/Ski' },
      { name: 'skip.mp4', sourcePath: skipSrc, meta: { subject: 'vlog' } },
    ],
  });
  assert.equal(r.moved, 1, 'the planned clip files');
  assert.equal(r.unplanned, 1, 'the unplanned clip is reported, not filed');

  const store = app.get('config').finalMeta || {};
  assert.equal(store['moved.mp4'] && store['moved.mp4'].done, true, 'filed clip → metadata marked done');
  assert.notEqual(store['skip.mp4'] && store['skip.mp4'].done, true, 'UNFILED clip → metadata must NOT be marked done (kept for a later run)');
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});
