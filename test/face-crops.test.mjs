// Face crops live on DISK now, not as base64 inside people.json.
//
// They used to be data: URLs stored inline — ~70% of the file's bytes, growing every time a face was
// confirmed, with no ceiling. A realistic mature library (40 people × 15 faces) was ~5 MB of JSON that
// had to be parsed and held in memory in full the moment the People view opened.
//
// The ONLY thing that matters in a migration of someone's real face DB is that it cannot lose a face.
// These tests are mostly about that.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

let app; let userData;

before(() => {
  userData = mkdtempSync(join(tmpdir(), 'faces-'));
  app = loadMain({ userData });
});
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
});

// A 1x1 JPEG, base64. Small, but a real image payload.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJgA/9k=';
const desc = (seed) => Array.from({ length: 128 }, (_, i) => Math.sin(seed + i) * 0.4);

const facesDir = () => join(userData, 'USB SD Auto-Action', 'faces');
const peopleJson = () => join(userData, 'USB SD Auto-Action', 'people.json');

test('a saved face crop lands on disk, and people.json holds a file:// URL — not base64', async () => {
  const r = await app.invoke('people:save', { name: 'Jake', descriptors: [desc(1)], thumb: JPEG, confirmed: true });
  assert.equal(r.ok, true);

  const files = readdirSync(facesDir());
  assert.equal(files.length, 1, 'the crop is a real file');

  const raw = readFileSync(peopleJson(), 'utf8');
  assert.equal(raw.includes('data:image'), false, 'NO base64 goes into the store any more');
  assert.match(raw, /file:\/\//, 'it references the crop by URL');

  // And the URL actually resolves to the file we wrote.
  const detail = await app.invoke('people:detail', (await app.invoke('people:get'))[0].id);
  const p = fileURLToPath(detail.faces[0].t);
  assert.equal(existsSync(p), true, 'the reference is not dangling');
});

test('the store stays SMALL as faces accumulate — this is the whole point', async () => {
  // A REALISTIC crop (~12 KB of base64), not the 1x1 toy above. The 128-float descriptor is ~3.9 KB
  // of JSON and legitimately stays in the store — recognition needs it. The CROP is what had no
  // business being there, and it is the part that used to dominate and grow without bound.
  const bigCrop = `data:image/jpeg;base64,${Buffer.alloc(9000, 7).toString('base64')}`;
  const before = readFileSync(peopleJson(), 'utf8').length;
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await app.invoke('people:save', { name: 'Jake', descriptors: [desc(100 + i)], thumb: bigCrop, confirmed: true });
  }
  const after = readFileSync(peopleJson(), 'utf8').length;
  const perFace = (after - before) / 20;

  assert.ok(perFace < bigCrop.length,
    `each face now costs ${Math.round(perFace)}B of JSON — it used to cost that PLUS the ${bigCrop.length}B crop`);
  assert.equal(readFileSync(peopleJson(), 'utf8').includes('data:image'), false, 'and not one byte of base64 is in there');
});

test('a LEGACY person with inline base64 is migrated, and the face survives', async () => {
  // The migration that runs against the user's real, existing face DB. It must not lose anything.
  const store = app.get('config');
  store.ai.people = [{
    id: 'legacy1', name: 'Legacy', ts: Date.now(),
    thumb: JPEG,
    faces: [{ d: desc(7), t: JPEG, confirmed: true }, { d: desc(8), t: JPEG, confirmed: false }],
  }];

  const people = app.get('aiPeople')();          // triggers migratePerson + the write-back
  const p = people.find((x) => x.id === 'legacy1');

  assert.equal(p.faces.length, 2, 'BOTH faces survive');
  for (const f of p.faces) {
    assert.match(f.t, /^file:\/\//, 'each crop moved to a file');
    assert.equal(existsSync(fileURLToPath(f.t)), true, 'and the file is really there');
  }
  assert.match(p.thumb, /^file:\/\//, 'the cover moved too');
  assert.equal(p.faces[0].confirmed, true, 'confirmed state is preserved');
  assert.equal(p.faces[1].confirmed, false);
  assert.deepEqual(p.faces[0].d.length, 128, 'the descriptor — the thing recognition actually needs — is untouched');

  // The migration is WRITTEN BACK: otherwise we'd re-migrate on every load and the file would
  // never actually shrink.
  assert.equal(readFileSync(peopleJson(), 'utf8').includes('data:image'), false, 'the fat copy is gone from disk');
});

test('a crop that cannot be written is KEPT INLINE — a migration never loses a face', () => {
  // The decisive safety property. If the disk write fails for any reason (permissions, disk full,
  // AV lock), we must degrade to the old behaviour, NOT drop the crop on the floor.
  const saveFaceCrop = app.get('saveFaceCrop');
  assert.equal(typeof saveFaceCrop, 'function');

  // Not a data: URL → passed through untouched (already migrated, or empty).
  assert.equal(saveFaceCrop('file:///x/y.jpg'), 'file:///x/y.jpg');
  assert.equal(saveFaceCrop(''), '');
  assert.equal(saveFaceCrop(null), '');

  // And the source says so explicitly: the catch returns the input, it does not return ''.
  const src = String(saveFaceCrop);
  assert.match(src, /catch \{[\s\S]*return s;/, 'a failed write keeps the inline crop rather than losing it');
});

test('a still-inline legacy crop RENDERS — reading tolerates both forms forever', () => {
  // personThumbHTML just sets an <img src>, and the CSP allows `img-src 'self' file: data:`.
  // So a record that failed to migrate still displays exactly as it always did.
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(html, /img-src 'self' file: data:/, 'both forms are permitted by the CSP');
  const core = readFileSync(new URL('../src/mod/01-core.js', import.meta.url), 'utf8');
  assert.match(core, /function personThumbHTML\(thumb\) \{\s*return thumb \? `<img src="\$\{escapeAttr\(thumb\)\}"\/>`/,
    'the renderer sets the src verbatim — data: and file: both just work');
});

// --- garbage collection ------------------------------------------------------------------

test('deleting a person reclaims its crops', async () => {
  await app.invoke('people:save', { name: 'Temp', descriptors: [desc(500)], thumb: JPEG, confirmed: true });
  const temp = (await app.invoke('people:get')).find((p) => p.name === 'Temp');
  const before = readdirSync(facesDir()).length;

  await app.invoke('people:delete', temp.id);
  const after = readdirSync(facesDir()).length;
  assert.ok(after < before, 'the orphaned crop file is reclaimed, not leaked to disk forever');
});

test('the GC is reference-counted — it can never delete a crop that is still in use', async () => {
  // Sprinkling an unlink into each of delete/merge/removeFace/cap is how you eventually miss one.
  // This scans what the store ACTUALLY references, so a call site that forgets to think about it
  // still cannot cause a live crop to be deleted.
  await app.invoke('people:save', { name: 'Keeper', descriptors: [desc(900)], thumb: JPEG, confirmed: true });
  const keeper = (await app.invoke('people:get')).find((p) => p.name === 'Keeper');
  const detail = await app.invoke('people:detail', keeper.id);
  const live = detail.faces.map((f) => fileURLToPath(f.t));
  assert.ok(live.length > 0);

  app.get('gcFaceCrops')();

  for (const f of live) assert.equal(existsSync(f), true, 'every referenced crop survives the GC');
});
