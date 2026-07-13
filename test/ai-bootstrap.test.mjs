// Learn from the library the user ALREADY has.
//
// Jake's `ai.styleExamples` and subject list were BOTH EMPTY — while 310 correctly-named clips sat in
// his Compressed folder. The single best source of truth about how he names things (hundreds of
// examples he wrote himself) was on disk, unread, while the AI invented subjects like `car-door` and
// `skateboarding` for want of knowing that `pov` and `vlog` existed.
//
// No model is involved. It parses the filenames he already wrote.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let lib;
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

// A faithful slice of Jake's REAL archive: the real subjects, the real proportions, the real
// fragmentation, and the real un-named GoPro files mixed in.
const REAL = [
  ...Array.from({ length: 12 }, (_, i) => `2024-12-0${(i % 9) + 1}_vlog_josiah-cleanroom-timelapse_v${i + 1}.mp4`),
  ...Array.from({ length: 7 }, (_, i) => `2026-06-01_lawn-mowing_josiah_v${i + 1}.mp4`),
  ...Array.from({ length: 3 }, (_, i) => `2026-06-02_lawnmowing_liam_v${i + 1}.mp4`),        // the SPLIT
  ...Array.from({ length: 4 }, (_, i) => `2026-05-06_pov_headcam-getting-into-truck_v${i + 1}.mp4`),
  ...Array.from({ length: 3 }, (_, i) => `2026-06-03_calisthenics_still-static-grid_v${i + 1}.mp4`),
  '2026-05-31_timelapse_wood-cleanup-farm_v1.mp4',
  '2026-05-31_timelapse_wood-cleanup-farm_v2.mp4',
  '2026-05-06_vloghead-owenpack-josiahpack-insidehouse_x_v1.mp4',   // used ONCE — a typo, not a subject
  'GH016805.mp4', 'GX016607.mp4', 'GH016823.mp4',                    // raw camera names — teach nothing
];

before(() => {
  app = loadMain();
  lib = mkdtempSync(join(tmpdir(), 'lib-'));
  mkdirSync(lib, { recursive: true });
  for (const n of REAL) writeFileSync(join(lib, n), '');
});
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(lib, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('it learns the subjects he actually uses, commonest first', () => {
  const r = app.get('learnFromLibrary')([lib]);
  assert.equal(r.parsed, REAL.length - 3, 'the three raw GoPro names are correctly ignored');
  assert.equal(r.subjects[0], 'vlog', 'his commonest subject leads');
  for (const s of ['vlog', 'lawn-mowing', 'pov', 'calisthenics', 'timelapse']) {
    assert.ok(r.subjects.includes(s), `${s} is a real subject of his`);
  }
});

test('a subject used ONCE is not a subject — it is a typo', () => {
  // His archive really contains `vloghead-owenpack-josiahpack-insidehouse`, used exactly once. Putting
  // that in the enum would offer the model a mistake as if it were a considered choice.
  const r = app.get('learnFromLibrary')([lib]);
  assert.equal(r.subjects.some((s) => s.startsWith('vloghead')), false);
});

test('it FINDS the fragmentation already in his archive', () => {
  const r = app.get('learnFromLibrary')([lib]);
  const dupe = r.duplicates.find((d) => d.merge === 'lawnmowing');
  assert.ok(dupe, 'lawnmowing/lawn-mowing is detected');
  assert.equal(dupe.keep, 'lawn-mowing', 'the DOMINANT spelling is the one to keep');
  assert.ok(dupe.keepCount > dupe.mergeCount);
});

test('…and the duplicate is kept OUT of the enum, so it cannot get worse', () => {
  // Reporting is not enough. If both spellings stay selectable, the model keeps offering the minority
  // one and the split grows every single run. The existing FILES keep their names — renaming his clips
  // is a destructive act and his call, not a side effect of learning.
  const r = app.get('learnFromLibrary')([lib]);
  assert.equal(r.subjects.includes('lawnmowing'), false, 'the model can no longer choose it');
  assert.ok(r.subjects.includes('lawn-mowing'));
  assert.ok(r.allSubjects.includes('lawnmowing'), 'but we still know it exists, so we can offer a merge');
});

test('the duplicate is not taught as a good EXAMPLE either', () => {
  const r = app.get('learnFromLibrary')([lib]);
  assert.equal(r.examples.some((e) => e.startsWith('lawnmowing /')), false);
});

test('examples are SPREAD across subjects, not 60 copies of the commonest', () => {
  // Taking the first 60 pairs off his real archive would give 60 clips of `vlog` and teach the model
  // nothing whatsoever about `pov` or `calisthenics`.
  const r = app.get('learnFromLibrary')([lib]);
  const subjectsShown = new Set(r.examples.map((e) => e.split(' / ')[0]));
  assert.ok(subjectsShown.size >= 5, `only ${subjectsShown.size} subjects represented in the examples`);
  assert.ok(subjectsShown.has('pov') && subjectsShown.has('calisthenics'));
});

test('the examples are real subject/description pairs — few-shot, not English rules', () => {
  // Few-shot pairs are what actually move a 7B model. English rules ("prefer short descriptions") do
  // very little, and 300 of them do less than none.
  const r = app.get('learnFromLibrary')([lib]);
  assert.match(r.examples[0], /^[a-z0-9-]+ \/ [a-z0-9-]+$/);
});

test('saving it populates the enum and the style — both of which were EMPTY', async () => {
  const cfg = app.get('config');
  cfg.ai = { model: 'x', styleExamples: [] };
  cfg.subjects = [];

  const r = await app.invoke('ai:learnFromLibrary', [lib]);
  assert.equal(r.ok, true);
  assert.ok(cfg.ai.styleExamples.length > 0, 'styleExamples was 0 and is now real');
  assert.ok(cfg.subjects.includes('vlog'));
  assert.equal(cfg.subjects.includes('lawnmowing'), false, 'the duplicate never enters the saved subject list');
});

test('a library with nothing named yet says so, rather than pretending it learned', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'lib0-'));
  writeFileSync(join(empty, 'GH016805.mp4'), '');
  const r = await app.invoke('ai:learnFromLibrary', [empty]);
  assert.equal(r.ok, false);
  assert.match(r.error, /name a few by hand first/);
  rmSync(empty, { recursive: true, force: true });
});

test('an existing subject the user typed is kept, not overwritten', async () => {
  // A subject he uses but hasn't filed yet is still a subject.
  const cfg = app.get('config');
  cfg.subjects = ['wedding'];
  await app.invoke('ai:learnFromLibrary', [lib]);
  assert.ok(cfg.subjects.includes('wedding'), 'his own entry survives');
  assert.ok(cfg.subjects.includes('vlog'), 'and the learned ones are added');
});

// --- the vision model that started all this -----------------------------------------------

test('the vision ranking puts the HALLUCINATING model below the accurate one', () => {
  // Measured, not assumed. On the same frames llava-llama3 described a pickup truck as "a person
  // riding a motorcycle", while qwen2.5vl read "COME AND SEE" off a monitor.
  const rank = app.get('visionRankOf');
  assert.ok(rank('qwen2.5vl:7b') < rank('llava-llama3:latest'), 'the accurate one wins');
  assert.ok(rank('qwen2.5vl:7b') < rank('llava:7b'));
  assert.ok(rank('llama3.2-vision:latest') > rank('qwen2.5vl:7b'), 'the one that 500s on this hardware is last');
});

test('an UNKNOWN vision model outranks llava — a new model is likelier to be good', () => {
  const rank = app.get('visionRankOf');
  assert.ok(rank('some-new-vlm:9b') < rank('llava-llama3'), 'we do not assume the worst of the unknown');
  assert.ok(rank('some-new-vlm:9b') > rank('qwen2.5vl'), '…but it does not beat a model we have measured');
});

test('the advice names the ACTUAL failure, not "a better model exists"', async () => {
  const cfg = app.get('config');
  cfg.ai = { model: 'llava-llama3:latest' };
  app.get('globalThis').fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'llava-llama3:latest' }, { name: 'qwen2.5vl:7b' }] }) };
    if (u.endsWith('/api/show')) {
      const m = JSON.parse(init.body).model;
      return { ok: true, status: 200, json: async () => ({ capabilities: ['completion', 'vision'], model: m }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const r = await app.invoke('ai:visionAdvice');
  assert.equal(r.advice.kind, 'upgrade');
  assert.equal(r.advice.best, 'qwen2.5vl:7b');
  assert.match(r.advice.why, /motorcycle/, 'it tells him what his model actually got wrong, on his own footage');
});

test('no advice when already on the best model — it does not nag', async () => {
  const cfg = app.get('config');
  cfg.ai = { model: 'qwen2.5vl:7b' };
  app.get('globalThis').fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'llava-llama3:latest' }, { name: 'qwen2.5vl:7b' }] }) };
    return { ok: true, status: 200, json: async () => ({ capabilities: ['completion', 'vision'] }) };
  };
  const r = await app.invoke('ai:visionAdvice');
  assert.equal(r.advice, null);
});
