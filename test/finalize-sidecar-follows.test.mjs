// `finalize:run`'s XMP sidecar was written beside the SOURCE and then abandoned there when the clip
// was filed.
//
// Step 1 embeds, and on failure falls back to a sidecar:
//     sidecar = `${curPath}.xmp`;
//     await et.write(sidecar, tags, ['-overwrite_original']);
//     metaLanded = true;
// Step 2 then moves or copies the footage into the Projects tree. `organizeMove` does not carry an
// adjacent `.xmp` along (verified by reading it), the `sidecar` variable is scoped to that catch
// block and never referenced again, and nothing else relocates it.
//
// So the footage lands in the Projects tree with no metadata, and the sidecar sits in the intake
// folder — a real, standard carrier filed exactly where nothing will look for it.
//
// AND IT IS EVENTUAL DATA LOSS, unlike the same-shaped gap in projects:move. `metaLanded = true` is
// what puts the clip into `filed`, so `markFinalMetaDone` flags its finalMeta record consumed — and
// `done` is the sole gate on that store's prune. The record is then age-evictable at 180 days and
// shed first under the hard cap, after which `finalize:run` filters the clip out entirely (`it.meta`
// required) and it can never be organized again. The AI's subject, description and people for that
// clip are gone, with the only surviving copy orphaned under a name nothing associates with it.
//
// Found while adding the sidecar fallback to projects:move (2026-07-19ar) — writing that one
// correctly is what exposed this one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

function stage() {
  const base = mkdtempSync(join(tmpdir(), 'uvd-fsc-'));
  const src = join(base, 'intake'); const dest = join(base, 'Projects');
  mkdirSync(src, { recursive: true }); mkdirSync(dest, { recursive: true });
  const from = join(src, 'GX010042.MP4');
  writeFileSync(from, 'FOOTAGE');
  return { base, src, from, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// Embedding into the container always fails; writing a sidecar always works.
function exifThatCannotEmbed() {
  app.get(`getExifTool = function () {
    return { write: async (target, tags) => {
      if (!String(target).endsWith('.xmp')) throw new Error('EINVAL: cannot write tags to this container');
      require('node:fs').writeFileSync(target, JSON.stringify(tags || {}));
    } };
  }`);
}

// The real payload shape: { items, options, dir } plus organizeDest/folderLevels at the top level.
// My first version invented `list`/`dest`/`organize`, so NOTHING ran and even the happy-path test
// failed at "filed" — a reminder to read the handler's destructuring before writing the fixture.
const run = (s, copy) => app.invoke('finalize:run', {
  items: [{
    name: 'GX010042.MP4',
    sourcePath: s.from,
    meta: { subject: 'mowing', description: 'front lawn', category: '2026 - test', project: 'shoot' },
  }],
  options: { organize: true, embed: true, copy },
  dir: s.src,
  organizeDest: s.dest,
  folderLevels: ['category'],
});
const filedPath = (s) => join(s.dest, '2026 - test', 'GX010042.MP4');

test('a COPIED clip gets its sidecar beside the filed copy', async () => {
  const s = stage();
  try {
    exifThatCannotEmbed();
    const r = await run(s, true);
    const filed = filedPath(s);
    assert.ok(existsSync(filed), 'the footage was filed');
    assert.ok(existsSync(`${filed}.xmp`), 'and its metadata travelled with it');
  } finally { s.cleanup(); }
});

test('a MOVED clip does not leave its sidecar behind', async () => {
  const s = stage();
  try {
    exifThatCannotEmbed();
    const r = await run(s, false);
    const filed = filedPath(s);
    assert.ok(existsSync(`${filed}.xmp`), 'the sidecar followed the footage');
    assert.ok(!existsSync(`${s.from}.xmp`), 'and nothing is orphaned in the intake folder');
  } finally { s.cleanup(); }
});

test('the clip is still reported as having landed its metadata', async () => {
  // metaLanded gates `filed`, which is what allows the finalMeta record to be pruned. That is only
  // legitimate while the metadata really is somewhere useful — which is the point of relocating it.
  const s = stage();
  try {
    exifThatCannotEmbed();
    const r = await run(s, true);
    assert.ok(r.ok, 'the run succeeded');
    assert.ok((r.sidecars || 0) >= 1, 'the sidecar is counted');
  } finally { s.cleanup(); }
});

test('a successful embed writes no sidecar at all', async () => {
  // Guard the other direction: the relocation must not invent a sidecar on the happy path.
  const s = stage();
  try {
    app.get('getExifTool = function () { return { write: async () => {} }; }');
    const r = await run(s, true);
    const filed = filedPath(s);
    assert.ok(existsSync(filed), 'filed');
    assert.ok(!existsSync(`${filed}.xmp`), 'no stray sidecar beside it');
    assert.ok(!existsSync(`${s.from}.xmp`), 'and none at the source either');
  } finally { s.cleanup(); }
});

test('a sidecar that cannot be relocated never fails the run', async () => {
  // The footage is filed by then. Same rule the whole finalize path follows: a metadata problem must
  // not become a filing problem.
  const s = stage();
  try {
    app.get(`getExifTool = function () { return { write: async () => { throw new Error('nope'); } }; }`);
    const r = await run(s, true);
    assert.ok(r.ok, 'the run still succeeded');
    assert.ok(existsSync(filedPath(s)), 'and the footage is filed');
  } finally { s.cleanup(); }
});
