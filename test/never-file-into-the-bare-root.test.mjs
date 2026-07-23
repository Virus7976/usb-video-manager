// ⚠⚠ `projects:move` FILED CLIPS LOOSE INTO THE TOP OF HIS PROJECTS TREE.
//
// Its twin `finalize:run` refuses this outright — it has an explicit `skipMove` and an `unplanned`
// count for exactly this case. `projects:move`, which the destination map's "Apply — file clips"
// calls, had no equivalent. A move whose `rel` was empty resolved `toDir` to the projects root and
// filed there, returning `ok: true`. Reproduced with a real file:
//
//     moves: [{ from: clip, toDir: root, rel: '' }]
//     RESULT: {"ok":true,"results":[{"ok":true,"action":"copied","path":".../GX010042.MP4"}]}
//     ROOT CONTAINS: ["GX010042.MP4"]
//
// Loose clips in the root of a Projects tree are the shape that makes an archive feel unsafe: they
// are in no shoot, nothing groups them, and the next Organize does not count them as filed. This is
// PROMPT.md §5.4 — an invariant applied to one of two sibling paths and not the other.
//
// ⚠⚠⚠ AND A PROCESS NOTE, BECAUSE IT NEARLY BURIED THIS BUG. A previous iteration probed the same
// handler with `items: [...]`. The payload key is `moves`. So nothing was passed, nothing happened,
// and the empty result read as "the reported bug does not reproduce" — which was then written into
// AGENTS.md and HANDOFF.md as a correction striking out a *correct* audit finding. The audit was
// right; the probe was wrong; and a probe that exercises nothing looks exactly like a probe that
// exercises something safely. **A probe asserting an ABSENCE must first be shown to produce the
// PRESENCE** — check it can reproduce the bug before trusting it to disprove one.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let root; let srcDir; let clip;
before(() => { app = loadMain(); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  for (const d of [root, srcDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

beforeEach(() => {
  for (const d of [root, srcDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  root = mkdtempSync(join(tmpdir(), 'bare-root-'));
  srcDir = mkdtempSync(join(tmpdir(), 'bare-src-'));
  clip = join(srcDir, 'GX010042.MP4');
  writeFileSync(clip, 'x'.repeat(64));
  const cfg = app.get('config');
  cfg.projectsRoot = root;
  cfg.intakeFolder = srcDir;
});

const move = async (mv) => app.plain(await app.invoke('projects:move', { root, copy: true, moves: [mv] }));

test('⚠⚠ a clip with no destination is NOT filed into the bare Projects root', async () => {
  const r = await move({ from: clip, toDir: root, rel: '', name: 'GX010042.MP4' });
  assert.deepEqual(readdirSync(root), [],
    '⚠⚠ nothing may be written loose into the top of his Projects folder');
  assert.equal(r.results[0].ok, false, '⚠ and it must not be reported as filed');
  assert.equal(r.results[0].skipped, true, '⚠ it is a skip, with a reason');
});

test('⚠⚠ the skip says WHY, and says the clip was left alone', async () => {
  // "Never silently skip a clip": a skipped clip appears in the results with a reason he can act on.
  // And it must be explicit that the source is untouched — the one thing he would worry about.
  const r = await move({ from: clip, toDir: root, rel: '', name: 'GX010042.MP4' });
  assert.match(r.results[0].error, /destination/i, '⚠ names the real cause');
  assert.match(r.results[0].error, /left where it is/i, '⚠⚠ and states the source was not touched');
});

test('⚠ the SOURCE clip is still there afterwards', async () => {
  // The guard must skip, never consume. A "skip" that ate the source would be far worse than the bug.
  await move({ from: clip, toDir: root, rel: '', name: 'GX010042.MP4' });
  assert.deepEqual(readdirSync(srcDir), ['GX010042.MP4'], '⚠ the clip is untouched where it was');
});

test('⚠⚠ a REAL destination still files normally — the guard must not block ordinary filing', async () => {
  // The over-correction that would make this useless: refusing everything. This is the case that
  // must keep working, and it is why the guard compares the RESOLVED directory against the root
  // rather than merely checking whether `rel` is empty.
  const r = await move({ from: clip, toDir: join(root, 'Gourgess Lawns'), rel: 'Gourgess Lawns', name: 'GX010042.MP4' });
  assert.equal(r.results[0].ok, true, `⚠⚠ a normal file must still work — got ${r.results[0].error}`);
  assert.deepEqual(readdirSync(join(root, 'Gourgess Lawns')), ['GX010042.MP4'], 'and the clip is in its folder');
});

test('⚠ a rel of only separators is caught too, not just an empty string', async () => {
  // `'/'` and `'//'` survive a truthiness check and resolve straight back to the root.
  const r = await move({ from: clip, toDir: root, rel: '///', name: 'GX010042.MP4' });
  assert.deepEqual(readdirSync(root), [], '⚠ a whitespace/separator rel must not reach the root either');
  assert.equal(r.results[0].skipped, true);
});

test('⚠⚠ an unnormalised toDir still matches — path comparison, not string comparison', async () => {
  // ⚠ THE ROOT IS THE WRONG SIDE TO TEST. `projRoot` is already stripped of trailing separators by
  // the handler itself, so passing `root + '/'` proves nothing — a naive `toDir === projRoot` string
  // compare passes that too, and the first draft of this test was green against it. Verified by
  // breaking the guard down to a string compare and watching this test stay green.
  //
  // `toDir` is the side that arrives UNNORMALISED, straight from whatever the renderer built. These
  // are the same directory and only `path.resolve` knows it.
  for (const toDir of [`${root}/`, `${root}/.`, join(root, 'x', '..')]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await move({ from: clip, toDir, rel: '', name: 'GX010042.MP4' });
    assert.deepEqual(readdirSync(root), [], `⚠⚠ "${toDir}" is the root and must be refused`);
    assert.equal(r.results[0].skipped, true, `⚠⚠ "${toDir}" must be reported as skipped`);
  }
});
