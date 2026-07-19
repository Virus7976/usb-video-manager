// Gitea #11, acceptance criterion 3 — "projects:move: partial-failure safety (never lose originals)".
//
// The handler LOOKS right (per-clip try/catch, copy-by-default, embed failure recorded but not
// fatal) but nothing tested it, so the guarantee was a comment rather than a fact. These pin the
// behaviour the criterion asks for.
//
// Written expecting them to PASS: the point is to establish whether the criterion is already
// satisfied, not to assume a bug. A green first run is the answer, not a failure of the exercise —
// and it means #11 reduces to its AI rule-parsing half.
//
// What "never lose originals" means concretely here: one clip failing must not abort the batch, must
// not consume the clips that follow it, and must leave its OWN source exactly where it was so a
// retry (or the user) can still find it.
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
const file = (dir, name, body = 'footage') => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };

test('#11 a clip that fails does NOT abort the batch — later clips still file', async () => {
  const src = mk('pm-src-'); const dest = mk('pm-dest-');
  const a = file(src, 'a.mp4');
  const missing = path.join(src, 'does-not-exist.mp4');   // fails: no such source
  const c = file(src, 'c.mp4');

  const r = app.plain(await app.invoke('projects:move', {
    moves: [
      { from: a, toDir: dest, name: 'a.mp4' },
      { from: missing, toDir: dest, name: 'b.mp4' },
      { from: c, toDir: dest, name: 'c.mp4' },
    ],
    embed: false, copy: true,
  }));

  assert.equal(r.results.length, 3, 'every clip is reported, including the failure');
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[1].ok, false, 'the bad one is reported as failed, not silently dropped');
  assert.equal(r.results[2].ok, true, 'a failure mid-batch does not consume the clips after it');
  assert.ok(fs.existsSync(path.join(dest, 'a.mp4')), 'the first clip filed');
  assert.ok(fs.existsSync(path.join(dest, 'c.mp4')), 'the clip AFTER the failure filed');
});

test('#11 a failed clip leaves its own original untouched', async () => {
  // The failure mode that would matter: a clip that half-moves and is then lost from both places.
  const src = mk('pm-orig-'); const dest = mk('pm-orig-dest-');
  const a = file(src, 'keep.mp4', 'irreplaceable');
  // A destination that cannot be created (a FILE where the directory should be) forces the failure
  // after the source has been chosen but before anything is placed.
  const blocker = file(mk('pm-blocker-'), 'blocked');
  const r = app.plain(await app.invoke('projects:move', {
    moves: [{ from: a, toDir: path.join(blocker, 'sub'), name: 'keep.mp4' }],
    embed: false, copy: false,          // MOVE mode — the mode that could actually lose it
  }));
  assert.equal(r.results[0].ok, false, 'reported as failed');
  assert.ok(fs.existsSync(a), 'the original is still there');
  assert.equal(fs.readFileSync(a, 'utf8'), 'irreplaceable', 'and intact');
  assert.ok(!fs.existsSync(path.join(dest, 'keep.mp4')), 'nothing landed at the destination');
});

test('#11 copy mode never removes the source, even on the clips that succeed', async () => {
  // "Organize COPIES, never moves" is the app's most protective invariant; copy is the default and
  // a missing flag must resolve to it.
  const src = mk('pm-copy-'); const dest = mk('pm-copy-dest-');
  const a = file(src, 'orig.mp4');
  const r = app.plain(await app.invoke('projects:move', { moves: [{ from: a, toDir: dest, name: 'orig.mp4' }], embed: false }));
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[0].action, 'copied', 'defaults to COPY when the flag is absent');
  assert.ok(fs.existsSync(a), 'the source survives');
  assert.ok(fs.existsSync(path.join(dest, 'orig.mp4')), 'and the copy exists');
});

test('#11 a batch of only-failures still returns a well-formed result per clip', async () => {
  // The caller renders results[]; a thrown handler or a short array would leave the UI unable to say
  // which clips did not make it.
  const src = mk('pm-allbad-'); const dest = mk('pm-allbad-dest-');
  const r = app.plain(await app.invoke('projects:move', {
    moves: [
      { from: path.join(src, 'nope1.mp4'), toDir: dest, name: 'nope1.mp4' },
      { from: path.join(src, 'nope2.mp4'), toDir: dest, name: 'nope2.mp4' },
    ],
    embed: false, copy: true,
  }));
  assert.equal(r.results.length, 2);
  for (const one of r.results) {
    assert.equal(one.ok, false);
    assert.ok(one.from, 'each result names the clip it is about');
  }
});
