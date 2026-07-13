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
  // Real proportions: MOST of his calisthenics clips he named himself; one is the old AI's garbage.
  // (A subject whose examples are 100% garbage would end up in the enum with no style example at all
  // — correct, but not what his archive looks like.)
  ...Array.from({ length: 3 }, (_, i) => `2026-06-03_calisthenics_action-climbing-tree-rope-ladder_v${i + 1}.mp4`),
  '2026-06-03_calisthenics_still-static-grid_v9.mp4',
  '2026-05-31_timelapse_wood-cleanup-farm_v1.mp4',
  '2026-05-31_timelapse_wood-cleanup-farm_v2.mp4',
  '2026-05-06_vloghead-owenpack-josiahpack-insidehouse_x_v1.mp4',   // used ONCE — a typo, not a subject
  'GH016805.mp4', 'GX016607.mp4', 'GH016823.mp4',                    // raw camera names — teach nothing
  // His `_delete_` MARKER: 6 real clips in the archive. Used often enough to pass the "seen twice"
  // filter, so it landed in the enum and the model could name a clip `delete`.
  '2025-08-30_delete_bad-take_v1.mp4', '2025-08-30_delete_bad-take_v2.mp4',
  '2026-05-06_pov_delete_v1.mp4',
  // The OLD AI's camera-word garbage — 18% of his real archive (49 of 272). Mining filenames cannot
  // tell HIS names from the AI's, so these were being taught back as exemplary style.
  '2026-06-12_vlog_still-liam-sitting-computer-cluttered-room_v1.mp4',
  '2026-06-12_vlog_still-blending-eggs-kitchen-counter_v1.mp4',
  '2026-06-12_vlog_wide-establishing-panning-car-houses_v1.mp4'
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

// --- HIS ARCHIVE IS NOT A CLEAN TEACHER ---------------------------------------------------------
//
// Two kinds of poison, both found by reading what this actually produced from his real 310 clips.

test('a workflow MARKER is not a subject — `delete` must never reach the enum', async () => {
  // He writes `_delete_` to mean "this clip is junk". Six clips, so it sails past the seen-twice
  // filter and lands in the subject enum — after which the model may legitimately name a clip
  // `delete`. It is a marker, not a thing he films.
  const r = plain(await app.invoke('ai:learnFromLibrary', [lib]));
  assert.equal(r.subjects.includes('delete'), false, 'the model could have named a clip `delete`');
  assert.equal((app.getJSON('config').ai.styleExamples || []).some((e) => /(^|\/ )delete\b/.test(e)), false,
    'nor is it taught as a description');
});

test('the OLD AI\'s camera-word garbage is not laundered back in as HIS style', async () => {
  // 18% of his real archive (49 of 272 named clips) has descriptions the old naming pass wrote:
  // `still-liam-sitting-computer-cluttered-room`, `wide-establishing-panning-car-houses`. Mining
  // filenames cannot tell his names from the AI's, so it was feeding the old model's mistakes to the
  // new one as exemplary style. That is the self-confirmation loop again, wearing a different hat.
  //
  // set_clip_name is explicitly FORBIDDEN from using camera words. An example full of them does not
  // merely fail to teach — it contradicts the instruction, in the one place the model trusts most.
  await app.invoke('ai:learnFromLibrary', [lib]);
  const examples = app.getJSON('config').ai.styleExamples || [];
  assert.ok(examples.length, 'it still learns something');
  for (const e of examples) {
    assert.equal(/(^|-)(still|wide|panning|static|establishing|grid)(-|$)/.test(e), false,
      `taught the model its own old garbage: "${e}"`);
  }
});

test('…but HIS compound words survive — the filter is word-boundary aware, not a substring match', async () => {
  // `josiah-topbunk-updownshot` is a real name HE wrote. A naive `includes('shot')` would bin it and
  // quietly throw away the best examples in the archive.
  writeFileSync(join(lib, '2024-11-29_vlog_josiah-topbunk-updownshot_v1.mp4'), '');
  writeFileSync(join(lib, '2024-11-29_vlog_josiah-topbunk-updownshot_v2.mp4'), '');
  await app.invoke('ai:learnFromLibrary', [lib]);
  const examples = app.getJSON('config').ai.styleExamples || [];
  assert.ok(examples.some((e) => e.includes('updownshot')), 'his own compound word was thrown away');
});

test('a subject that is ONLY ever marker-named still disappears cleanly', async () => {
  // Guard against the filter half-working: dropping the example but keeping the subject, leaving an
  // enum entry the model can choose but has no idea how to describe.
  const r = plain(await app.invoke('ai:learnFromLibrary', [lib]));
  for (const s of r.subjects) {
    assert.equal(['delete', 'trash', 'junk', 'temp'].includes(s), false, `marker "${s}" survived`);
  }
});
