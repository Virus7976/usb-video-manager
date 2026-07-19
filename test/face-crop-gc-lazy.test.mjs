// gcFaceCrops() could unlink EVERY enrolled face crop, because it GC'd against a store it hadn't
// loaded.
//
// The GC is reference-counted on purpose — its own comment says it "scans what the store ACTUALLY
// references and removes only files nothing points at, so it cannot delete a live crop no matter
// which call site forgot to think about it." That only holds if every reference store is actually in
// memory. It called `ensureStore` for two of the three lazy stores it scans:
//
//     ensureStore('ai.facesPending');   // pending clusters can reference crops too — never GC blind
//     ensureStore('ai.faceScenes');     // …and so do the group shots. Miss this and the GC deletes
//                                       // every scene frame the first time it runs
//
// …and never for `ai.people`, which is also lazy (LAZY_STORES, 01-core.js:195) and has no key in the
// config default. Unloaded, `config.ai.people` is `undefined` → `|| []` → the keep-set contains no
// person crop at all → every faces/*.jpg is unlinked. people.json survives, still pointing at files
// that no longer exist, so the People dashboard and the review grid render broken images forever.
//
// Reachable because `faces:saveScenes` calls the GC and only loads `ai.faceScenes`. On the renderer
// side `ai.people` is pulled in by `matchPerson`, which runs PER DETECTED FACE — so a scan over
// footage with no faces in it (b-roll, drone, product) never loads people, then fires
// saveFaceScenesNow() at the end of the scan.
//
// Worse, the same gap defeats the corrupt-file protection: when people.json fails to parse,
// `storeReadFailed` makes saveStore refuse to write it ("Writing it would destroy the face DB") —
// but the GC had no such guard and deleted the crops that quarantined file references.
//
// A crop is a frame from a specific source clip, and the card it came from has usually been cleared
// by then. It is hand-built enrolment work with no source to rebuild from.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMain } from './harness.mjs';

// Each test boots its own app: the bug is specifically about a store NOT having been loaded, so a
// shared instance from an earlier test would hide it.
function boot({ peopleJson } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'uvd-gc-'));
  const storeDir = join(base, 'USB SD Auto-Action');
  const facesDir = join(storeDir, 'faces');
  mkdirSync(facesDir, { recursive: true });

  const crop = join(facesDir, 'person-crop.jpg');
  writeFileSync(crop, 'JPEGDATA');
  const orphan = join(facesDir, 'orphan.jpg');
  writeFileSync(orphan, 'JPEGDATA');

  writeFileSync(join(storeDir, 'config.json'), JSON.stringify({ intakeFolder: '/x' }));
  writeFileSync(join(storeDir, 'people.json'), peopleJson !== undefined ? peopleJson : JSON.stringify([
    { id: 'p1', name: 'Jake', thumb: pathToFileURL(crop).href, faces: [{ d: [0.1], t: pathToFileURL(crop).href, confirmed: true }] },
  ]));

  const app = loadMain({ userData: base });
  return { app, crop, orphan, cleanup: () => { try { app.dispose(); } catch { /* ignore */ } rmSync(base, { recursive: true, force: true }); } };
}

test('a GC triggered without people loaded does not delete enrolled crops', async () => {
  // faces:saveScenes is the reachable trigger: it loads ai.faceScenes and nothing else.
  const b = boot();
  try {
    await b.app.invoke('faces:saveScenes', []);
    assert.ok(existsSync(b.crop), 'the enrolled person\'s face crop survived the GC');
  } finally { b.cleanup(); }
});

test('the GC still collects genuine orphans', async () => {
  // The fix must not turn the GC off — an unreferenced crop is still garbage.
  const b = boot();
  try {
    await b.app.invoke('faces:saveScenes', []);
    assert.ok(!existsSync(b.orphan), 'a crop nothing references is still removed');
  } finally { b.cleanup(); }
});

test('a people.json that FAILED to read blocks the GC entirely', async () => {
  // saveStore already refuses to write a store whose file failed to parse, so the quarantined JSON
  // survives. The crops it references must survive with it — otherwise the data is protected and the
  // images it points at are destroyed, which is the worst of both.
  const b = boot({ peopleJson: '[{"id":"p1","name":"Ja' });
  try {
    await b.app.invoke('faces:saveScenes', []);
    assert.ok(existsSync(b.crop), 'crops survive while people.json is unreadable');
    assert.ok(existsSync(b.orphan), 'and the GC does not run AT ALL on an incomplete keep-set');
  } finally { b.cleanup(); }
});
