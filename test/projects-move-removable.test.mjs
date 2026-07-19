// projects:move would MOVE files off a removable card; finalize:run refuses. Sibling-path gap 3.
//
// finalize:run guards this explicitly (main-mod/09-ipc-boot.js ~570): if the source folder is on a
// removable volume AND the run is a move, it refuses outright, because "Organizing MOVES files, so
// it would take them off the card — which is only ever allowed from the Delete step, after the
// copies are verified".
//
// projects:move — the OTHER filing path, the one the destination map's "Apply — file clips" calls —
// accepts `copy: false` and passes it straight to organizeMove with no removability test at all.
// isOnRemovableVolume appears nowhere in main-mod/02-media.js.
//
// Reachability is narrow: it needs Compressed pointed at a card AND "Keep the originals" unticked.
// But that is exactly the case the twin bothers to guard, and the consequence is the one the whole
// app is built to prevent — footage leaving a card without passing the hash-verified delete gate,
// which is the only door card deletes are ever allowed through.
//
// TESTED BY STUBBING, deliberately: isOnRemovableVolume is drive-letter based and
// DETECTION_ENABLED-gated, so on Linux it always returns false and a "real card" cannot be
// simulated. What matters — and what these assert — is that the CALL IS MADE and its answer is
// obeyed. Hoisted function declarations are assignable inside the vm context, which makes that
// testable without a card.
import { test, before, after, beforeEach } from 'node:test';
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
const file = (dir, name) => { const p = path.join(dir, name); fs.writeFileSync(p, 'footage'); return p; };

const sayRemovable = (yes) => app.get(`isOnRemovableVolume = function () { return Promise.resolve(${yes ? 'true' : 'false'}); }`);
beforeEach(() => sayRemovable(false));

test('MOVING off a removable card is refused, and nothing is touched', async () => {
  const card = mk('pmr-card-'); const dest = mk('pmr-dest-');
  const a = file(card, 'GX010042.MP4');
  sayRemovable(true);
  const r = app.plain(await app.invoke('projects:move', {
    moves: [{ from: a, toDir: dest, name: 'GX010042.MP4' }],
    embed: false, copy: false,
  }));
  assert.equal(r.ok, false, 'the whole batch is refused');
  assert.match(String(r.error), /removable card or USB drive/i, 'same sentence the other filing path uses');
  assert.ok(fs.existsSync(a), 'the clip is still on the card');
  assert.equal(fs.readdirSync(dest).length, 0, 'and nothing was written to the destination');
});

test('COPYING from a removable card is allowed — a copy takes nothing off it', async () => {
  // The twin makes exactly this distinction, and copy is the default. Refusing copies would break
  // the ordinary "import from a card" flow for no safety gain.
  const card = mk('pmr-copy-card-'); const dest = mk('pmr-copy-dest-');
  const a = file(card, 'GX010043.MP4');
  sayRemovable(true);
  const r = app.plain(await app.invoke('projects:move', {
    moves: [{ from: a, toDir: dest, name: 'GX010043.MP4' }],
    embed: false, copy: true,
  }));
  assert.equal(r.ok, true, 'a copy off a card is fine');
  assert.ok(fs.existsSync(a), 'the original stays on the card');
  assert.ok(fs.existsSync(path.join(dest, 'GX010043.MP4')), 'and the copy landed');
});

test('MOVING from an INTERNAL disk is unaffected', async () => {
  // The ordinary organize case must not become harder. This is the path most runs take.
  const src = mk('pmr-int-src-'); const dest = mk('pmr-int-dest-');
  const a = file(src, 'GX010044.MP4');
  sayRemovable(false);
  const r = app.plain(await app.invoke('projects:move', {
    moves: [{ from: a, toDir: dest, name: 'GX010044.MP4' }],
    embed: false, copy: false,
  }));
  assert.equal(r.ok, true, 'an internal move still works');
  assert.ok(fs.existsSync(path.join(dest, 'GX010044.MP4')));
  assert.ok(!fs.existsSync(a), 'and it really moved');
});

test('the check is only asked once per distinct source folder', async () => {
  // isOnRemovableVolume shells out to PowerShell on Windows. Asking per clip would add a process
  // spawn to every file in a 200-clip batch, which is how a guard becomes a reason to remove it.
  const card = mk('pmr-count-'); const dest = mk('pmr-count-dest-');
  const files = ['a.mp4', 'b.mp4', 'c.mp4'].map((n) => file(card, n));
  app.get('__removableCalls = 0');
  app.get('isOnRemovableVolume = function () { __removableCalls += 1; return Promise.resolve(false); }');
  await app.invoke('projects:move', {
    moves: files.map((f, i) => ({ from: f, toDir: dest, name: `${'abc'[i]}.mp4` })),
    embed: false, copy: false,
  });
  assert.equal(app.get('__removableCalls'), 1, 'three clips from one folder → one check');
});
