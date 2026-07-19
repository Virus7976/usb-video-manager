// Batch 6: data-safety + config fixes.
//  #61 config:get UI defaults no longer drift from ui:set (shared UI_DEFAULTS)
//  #79 ollamaReleaseAll evicts ONLY models this app loaded (not another app's / a CLI's)
//  #28 confirming a suggested face PROMOTES the unconfirmed near-dup to confirmed (grows the vote set)
//  #9  gcFaceCrops keeps crops referenced by the Ignored bin (was deleting them)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });
beforeEach(() => { const c = app.get('config'); c.ui = undefined; c.ai = { people: [], ignored: [], facesPending: [], faceScenes: [] }; });

test('#61 config:get returns cleanGrid/dayDividers/showLocation (no longer undefined)', async () => {
  const c = await app.invoke('config:get');
  assert.equal(c.ui.cleanGrid, true);
  assert.equal(c.ui.dayDividers, true);
  assert.equal(c.ui.showLocation, false);
});

test('#79 ollamaReleaseAll unloads only THIS app\'s models', async () => {
  app.get("ollamaLoaded = async () => [{ name: 'qwen3:8b' }, { name: 'someotherapp-model:latest' }]");
  app.get('globalThis.__unloaded = [];');
  app.get('ollamaUnload = async (n) => { globalThis.__unloaded.push(n); return { ok: true }; };');
  app.get("_appLoadedModels.clear(); _appLoadedModels.add('qwen3');");   // app loaded qwen3
  const r = await app.call('ollamaReleaseAll');
  const unloaded = app.getJSON('globalThis.__unloaded');
  assert.deepEqual(unloaded, ['qwen3:8b'], 'only the app model is evicted');
  assert.equal(r.freed.length, 1);
});

test('#28 confirming a suggested face promotes the unconfirmed near-dup to confirmed', async () => {
  const d = Array.from({ length: 128 }, (_, i) => (i % 7) * 0.01);
  await app.invoke('people:save', { name: 'Liam', descriptors: [d], confirmed: false });   // auto-guess
  await app.invoke('people:save', { name: 'Liam', descriptors: [d], confirmed: true });     // user confirms
  const people = app.getJSON('config').ai.people;
  const liam = people.find((p) => p.name === 'Liam');
  assert.equal(liam.faces.length, 1, 'not duplicated — the near-dup was promoted, not appended');
  assert.equal(liam.faces[0].confirmed, true, 'promoted to confirmed so it now votes in matching');
});

test('#9 gcFaceCrops keeps a crop referenced by the Ignored bin', () => {
  const dir = app.get('FACES_DIR');
  mkdirSync(dir, { recursive: true });
  const crop = join(dir, 'ignored-face.jpg');
  writeFileSync(crop, 'jpegbytes');
  const url = app.call('fileUrl', crop);
  app.get('config').ai.ignored = [{ d: [0.1], t: url, confirmed: false }];
  app.call('gcFaceCrops');
  assert.equal(existsSync(crop), true, 'the ignored face crop is NOT garbage-collected');
});
