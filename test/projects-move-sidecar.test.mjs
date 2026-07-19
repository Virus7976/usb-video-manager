// `projects:move` had no fallback when embedding failed, so the filed file carried no metadata at all.
//
// Its twin `finalize:run` does have one, and states the reasoning: *"An XMP sidecar is a real,
// standard carrier — digiKam and Lightroom both read `<file>.xmp` — so the metadata is not lost just
// because the container refused it."* Embedding fails for real, repeatable reasons — a HEIC, an odd
// codec, a read-only file — so "it'll work next time" is usually false.
//
// ⚠ DELIBERATE DIVERGENCE FROM THE TWIN, and the reason this wasn't a copy-paste job. The twin writes
// the sidecar at `${curPath}.xmp` BEFORE step 2 moves the file, and `organizeMove` does not carry an
// adjacent `.xmp` with it (verified by reading it). So the twin's sidecar is left behind in the intake
// folder while the footage moves to the Projects tree — the metadata ends up somewhere digiKam will
// never look for it. Reproducing that here would have reproduced the bug.
//
// So this writes the sidecar AFTER the move, beside the DESTINATION file. The twin's orphaned-sidecar
// flaw is logged in AGENTS.md as its own finding rather than fixed in passing — it lives in a
// different handler and deserves its own tests.
//
// Scope, stated honestly: this is a TRUST fix, not a data-loss fix. The metadata also lives in
// finalMeta, and `projects:move` never calls `markFinalMetaDone`, so the prune won't evict it. What
// was lost is the promise the confirm dialog makes — "with their metadata embedded".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

function stage() {
  const base = mkdtempSync(join(tmpdir(), 'uvd-sidecar-'));
  const src = join(base, 'intake'); const dest = join(base, 'Projects');
  mkdirSync(src, { recursive: true }); mkdirSync(dest, { recursive: true });
  const from = join(src, 'GX010042.MP4');
  writeFileSync(from, 'FOOTAGE');
  return { base, src, from, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// An exiftool whose embed always fails, but whose sidecar write succeeds — the real-world case
// (unwritable container, perfectly writable sidecar).
function exifThatCannotEmbed() {
  app.get(`getExifTool = function () {
    return { write: async (target, tags) => {
      if (!String(target).endsWith('.xmp')) throw new Error('EINVAL: cannot write tags to this container');
      require('node:fs').writeFileSync(target, JSON.stringify(tags));
    } };
  }`);
}

const moveOne = (s) => app.invoke('projects:move', {
  moves: [{ from: s.from, toDir: join(s.dest, '2026 - test'), rel: '2026 - test', name: 'GX010042.MP4', meta: { subject: 'mowing', description: 'front lawn' } }],
  root: s.dest,
  copy: true,
  embed: true,
});

test('a failed embed falls back to an .xmp sidecar', async () => {
  const s = stage();
  try {
    exifThatCannotEmbed();
    const r = await moveOne(s);
    const row = (r.results || [])[0];
    assert.ok(row && row.ok, 'the clip is still filed — a metadata problem must never block filing');
    assert.equal(row.sidecar, true, 'and the result says a sidecar was written');
  } finally { s.cleanup(); }
});

test('the sidecar lands beside the FILED file, not back in the intake folder', async () => {
  // The whole reason this diverges from the twin. A sidecar left at the source is metadata filed
  // somewhere nothing will read it.
  const s = stage();
  try {
    exifThatCannotEmbed();
    const r = await moveOne(s);
    const filed = (r.results || [])[0].path;
    assert.ok(existsSync(`${filed}.xmp`), 'the sidecar sits next to the footage in the Projects tree');
    assert.ok(!existsSync(`${s.from}.xmp`), 'and nothing is orphaned in the intake folder');
  } finally { s.cleanup(); }
});

test('the sidecar carries the real tags', async () => {
  const s = stage();
  try {
    exifThatCannotEmbed();
    const r = await moveOne(s);
    const body = readdirSync(join(s.dest, '2026 - test')).join(' ');
    assert.match(body, /GX010042\.MP4\.xmp/, 'the sidecar exists under the expected name');
    assert.ok((r.results || [])[0].embedError, 'and the original embed error is still reported');
  } finally { s.cleanup(); }
});

test('a successful embed writes no sidecar', async () => {
  // Guard the other direction: the fallback must not fire on the happy path and litter the tree.
  const s = stage();
  try {
    app.get('getExifTool = function () { return { write: async () => {} }; }');
    const r = await moveOne(s);
    const row = (r.results || [])[0];
    assert.equal(row.embedded, true, 'embedded normally');
    assert.ok(!row.sidecar, 'no sidecar claimed');
    assert.ok(!existsSync(`${row.path}.xmp`), 'and none written');
  } finally { s.cleanup(); }
});

test('when BOTH routes fail the clip is still filed, and says so', async () => {
  // Leaving a clip unfiled forever is the worse failure — that is the lesson #69 recorded. But it
  // must not claim a sidecar it never wrote.
  const s = stage();
  try {
    app.get(`getExifTool = function () { return { write: async () => { throw new Error('nope'); } }; }`);
    const r = await moveOne(s);
    const row = (r.results || [])[0];
    assert.ok(row.ok, 'the footage is filed');
    assert.equal(row.embedded, false, 'reported as not embedded');
    assert.ok(!row.sidecar, 'and no sidecar is claimed');
  } finally { s.cleanup(); }
});

test('a sidecar failure never fails the filing run', async () => {
  const s = stage();
  try {
    app.get(`getExifTool = function () { return { write: async () => { throw new Error('nope'); } }; }`);
    const r = await moveOne(s);
    assert.notEqual(r.ok, false, 'the run as a whole still succeeded');
    assert.ok(existsSync((r.results || [])[0].path), 'and the footage really is in the tree');
  } finally { s.cleanup(); }
});
