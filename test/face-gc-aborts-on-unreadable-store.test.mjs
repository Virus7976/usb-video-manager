// The face-crop GC's most important guard existed only as a comment and a code branch.
//
// `gcFaceCrops` is reference-counted: it scans the stores, builds a keep-set, and **deletes every
// file in `faces/` that nothing points at**. That is the right design — it cannot leak, and it
// cannot delete a live crop *provided the keep-set is complete*.
//
// The failure mode is therefore always the same: an INCOMPLETE keep-set deletes real work. The code
// carries two hard-won guards against it, and its comments record what each one cost:
//
//   1. `ensureStore` for all three lazy stores — missing `ai.people` once meant a scan over footage
//      with no faces in it "deleted EVERY enrolled crop".
//   2. an abort when any of those stores FAILED to read this launch — because a failed read leaves an
//      empty default in memory, and an empty store references nothing:
//
//        "saveStore already refuses to write those … but the GC had no matching guard, so the JSON
//         was protected while the crops it references were deleted."
//
// Guard 2 had **no test** — `storeReadFailed` appears in the face tests only inside a comment. So the
// exact scenario it was written for was unverified: `people.json` unreadable this launch (a crash
// mid-write, an antivirus lock), config falls back to `{}`, the keep-set comes back empty, and the GC
// cheerfully unlinks all 48 enrolled people's crops. The JSON survives — still pointing at files that
// no longer exist — so the dashboard shows broken images and the enrolment work is gone.
//
// This is his most laborious data: 226 "✓ Yes" face confirmations in his click log, none of it
// regenerable by re-scanning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMain } from './harness.mjs';

// Boot an app with `faces/` populated and the stores in a chosen state.
const boot = ({ peopleFile }) => {
  const app = loadMain();
  const facesDir = join(app.storeDir, 'faces');
  mkdirSync(facesDir, { recursive: true });
  const crops = ['liam.jpg', 'karis.jpg', 'josiah.jpg'].map((n) => {
    const p = join(facesDir, n);
    writeFileSync(p, 'CROP BYTES');
    return p;
  });
  if (peopleFile !== undefined) writeFileSync(join(app.storeDir, 'people.json'), peopleFile);
  return { app, facesDir, crops };
};
const remaining = (d) => readdirSync(d).sort();

test('⚠⚠ an unreadable people.json ABORTS the sweep — no crop is deleted', async () => {
  // The scenario the guard was written for, produced for real rather than simulated by setting a
  // flag: a truncated people.json, which latches storeReadFailed and leaves config.ai.people empty.
  const { app, facesDir } = boot({ peopleFile: '{"people": [{"id": "p1", "na' });
  try {
    app.get('ensureStore')('ai.people');
    assert.equal((app.plain(app.get('storeReadFailed')) || {})['ai.people'], true,
      'the fixture really did latch the read failure');

    app.get('gcFaceCrops')();

    assert.deepEqual(remaining(facesDir), ['josiah.jpg', 'karis.jpg', 'liam.jpg'],
      '⚠ every enrolled crop survives an unreadable store');
  } finally { app.dispose(); }
});

test('the abort covers facesPending and faceScenes too, not just people', async () => {
  // All three are reference stores. Any one of them reading empty makes the keep-set a lie.
  for (const [file, key] of [['faces-pending.json', 'ai.facesPending'], ['face-scenes.json', 'ai.faceScenes']]) {
    const app = loadMain();
    const facesDir = join(app.storeDir, 'faces');
    mkdirSync(facesDir, { recursive: true });
    writeFileSync(join(facesDir, 'liam.jpg'), 'CROP BYTES');
    writeFileSync(join(app.storeDir, file), '{"broken');
    try {
      app.get('ensureStore')(key);
      assert.equal((app.plain(app.get('storeReadFailed')) || {})[key], true, `${key} latched`);
      app.get('gcFaceCrops')();
      assert.deepEqual(remaining(facesDir), ['liam.jpg'], `${key} unreadable → nothing deleted`);
    } finally { app.dispose(); }
  }
});

test('⚠ with all stores healthy, a genuinely orphaned crop IS removed', async () => {
  // The opposite direction, and it matters: a GC that never deletes anything is a slow disk leak on
  // a store where face thumbnails are ~70% of the bytes. The guard must abort on FAILURE, not always.
  const { app, facesDir } = boot({ peopleFile: JSON.stringify([]) });
  try {
    app.get('ensureStore')('ai.people');
    assert.notEqual((app.plain(app.get('storeReadFailed')) || {})['ai.people'], true, 'healthy store');
    app.get('gcFaceCrops')();
    assert.deepEqual(remaining(facesDir), [], 'nothing references them, so they go');
  } finally { app.dispose(); }
});

test('⚠ a REFERENCED crop is never removed, even in a healthy sweep', async () => {
  // The core promise of reference counting, verified against a real file:// URL of the kind the
  // store actually holds.
  const app = loadMain();
  const facesDir = join(app.storeDir, 'faces');
  mkdirSync(facesDir, { recursive: true });
  const keepMe = join(facesDir, 'liam.jpg');
  writeFileSync(keepMe, 'CROP BYTES');
  writeFileSync(join(facesDir, 'orphan.jpg'), 'CROP BYTES');
  writeFileSync(join(app.storeDir, 'people.json'), JSON.stringify([
    { id: 'p1', name: 'Liam', thumb: pathToFileURL(keepMe).href, faces: [] },
  ]));
  try {
    app.get('ensureStore')('ai.people');
    app.get('gcFaceCrops')();
    assert.deepEqual(remaining(facesDir), ['liam.jpg'], 'the referenced crop stays, the orphan goes');
  } finally { app.dispose(); }
});

test('an IGNORED face keeps its crop', async () => {
  // faces:ignore moves a real crop into the ignored bin. Its comment records the bug: missing it here
  // "unlinked the crop and the Ignored view showed broken images with the crop gone for good".
  const app = loadMain();
  const facesDir = join(app.storeDir, 'faces');
  mkdirSync(facesDir, { recursive: true });
  const ignored = join(facesDir, 'someone.jpg');
  writeFileSync(ignored, 'CROP BYTES');
  writeFileSync(join(app.storeDir, 'people.json'), JSON.stringify([]));
  try {
    app.get('ensureStore')('ai.people');
    app.get('config').ai.ignored = [{ t: pathToFileURL(ignored).href }];
    app.get('gcFaceCrops')();
    assert.equal(existsSync(ignored), true, 'the ignored face keeps its crop');
  } finally { app.dispose(); }
});

test('a missing faces/ directory is a no-op, not a crash', async () => {
  // First run. The GC runs on every save path, so throwing here would break saving entirely — and it
  // is wrapped in a best-effort catch, which means a crash would be SILENT.
  const app = loadMain();
  try {
    rmSync(join(app.storeDir, 'faces'), { recursive: true, force: true });
    app.get('gcFaceCrops')();
    assert.ok(true, 'returned without throwing');
  } finally { app.dispose(); }
});
