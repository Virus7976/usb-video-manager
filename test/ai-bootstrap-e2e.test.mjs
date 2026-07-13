// THE ONE TEST THAT DECIDES WHETHER ANY OF THIS REACHES HIM.
//
// Everything built for the AI — the tool loop, the subject enum, shoot context, placement — is gated
// on `subjectsCache` being populated. His REAL config on this machine, read off disk 2026-07-13:
//
//   ai.model      = 'llava-llama3:latest'   (measured hallucinating on his own footage)
//   ai.textModel  = ''                      (so every text task ran on the vision model, which
//                                            cannot call tools AT ALL)
//   styleExamples = 0                       (while 310 clips he named himself sat on disk)
//   subjects      = none                    (so the whole tool-naming path is DISABLED)
//   projectsRoot  = ''                      (so placement has nowhere to file)
//
// i.e. out of the box, on his actual machine, none of it runs. The health card is the only thing that
// turns it on, and it must do so in one click per problem. This test starts from his exact config and
// asserts the app ends up genuinely working — not merely "no problems reported".
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let app; let compressed;
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

// A faithful slice of the real archive: real subjects, real proportions, the real lawn-mowing split,
// the real `_delete_` marker, the real old-AI camera-word garbage, and raw GoPro names mixed in.
const ARCHIVE = [
  ...Array.from({ length: 14 }, (_, i) => `2026-06-0${(i % 9) + 1}_vlog_josiah-cleanroom_v${i + 1}.mp4`),
  ...Array.from({ length: 9 }, (_, i) => `2026-06-01_lawn-mowing_josiah_v${i + 1}.mp4`),
  ...Array.from({ length: 3 }, (_, i) => `2026-05-16_lawnmowing_liam_v${i + 1}.mp4`),
  ...Array.from({ length: 4 }, (_, i) => `2026-05-06_pov_headcam-getting-into-truck_v${i + 1}.mp4`),
  ...Array.from({ length: 3 }, (_, i) => `2026-06-11_calisthenics_climbing-tree-rope-ladder_v${i + 1}.mp4`),
  ...Array.from({ length: 2 }, (_, i) => `2026-05-11_timelapse_wood-cleanup-farm_v${i + 1}.mp4`),
  '2025-08-30_delete_bad-take_v1.mp4', '2025-08-30_delete_bad-take_v2.mp4',
  '2026-06-12_vlog_still-blending-eggs-kitchen_v1.mp4',
  'GH016805.mp4', 'GX016607.mp4',
];

const CAPS = {
  'llava-llama3:latest': ['completion', 'vision'],
  'qwen2.5vl:7b': ['completion', 'vision'],
  'qwen3:8b': ['completion', 'tools', 'thinking'],
};

before(() => {
  app = loadMain();
  compressed = mkdtempSync(join(tmpdir(), 'compressed-'));
  for (const n of ARCHIVE) writeFileSync(join(compressed, n), '');
  app.get('globalThis').fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return { ok: true, status: 200, json: async () => ({ models: Object.keys(CAPS).map((n) => ({ name: n })) }) };
    }
    if (u.endsWith('/api/show')) {
      const m = JSON.parse(init.body).model;
      return { ok: true, status: 200, json: async () => ({ capabilities: CAPS[m] || ['completion'] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
});
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(compressed, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** His config, exactly as it is on disk right now. */
beforeEach(() => {
  const cfg = app.get('config');
  cfg.ai = { enabled: true, model: 'llava-llama3:latest', textModel: '', styleExamples: [], memories: [] };
  cfg.finalizeSource = compressed;
  cfg.intakeFolder = '/L/01 - Uncompressed';
  cfg.projectsRoot = '';
  cfg.placementMemory = [];
  cfg.shootMemory = [];
});

test('HIS REAL CONFIG: the app knows it is broken, and every problem has a fix', async () => {
  const h = plain(await app.invoke('ai:health'));
  const ids = h.problems.map((p) => p.id);

  assert.ok(ids.includes('weak-vision'), 'the hallucinating vision model');
  assert.ok(ids.includes('no-style'), 'it has never read the 310 clips he named himself');
  assert.ok(ids.includes('no-projects-root'), 'placement has nowhere to file');
  for (const p of h.problems) assert.ok(p.fix, `"${p.id}" complains with no way to fix it`);

  // The tool model is auto-resolved rather than nagged about — qwen3:8b is installed.
  assert.equal(h.toolModel, 'qwen3:8b');
});

test('one click each → the app is genuinely WORKING, not just quiet', async () => {
  const cfg = app.get('config');

  // 1. "Use the better vision model" — llava measurably invented a motorcycle on his own footage.
  await app.invoke('ai:useVisionModel', 'qwen2.5vl:7b');

  // 2. "Learn from my clips" — the single best source of truth about how he names things.
  const learned = plain(await app.invoke('ai:learnFromLibrary', [compressed]));

  // 3. "Where are your projects?" — he picks the folder; nothing guesses it for him.
  cfg.projectsRoot = '/L/liam';

  const h = plain(await app.invoke('ai:health'));
  assert.deepEqual(h.problems, [], `still broken: ${h.problems.map((p) => p.id).join(', ')}`);

  // And now the part that actually matters — is the AI armed?
  const ai = app.getJSON('config').ai;

  assert.equal(ai.model, 'qwen2.5vl:7b', 'the vision model that can actually see');
  assert.equal(h.toolModel, 'qwen3:8b', 'a model that can call tools at all');

  // THE ENUM. Without this, aiNameWithTools returns null and the whole tool path stays off.
  assert.deepEqual(learned.subjects, ['vlog', 'lawn-mowing', 'pov', 'calisthenics', 'timelapse'],
    'his real subjects, commonest first, one spelling each');
  assert.equal(learned.subjects.includes('delete'), false, '`delete` is a marker, not a subject');
  assert.equal(learned.subjects.includes('lawnmowing'), false, 'the split spelling never enters the enum');

  // THE FEW-SHOT PAIRS — what actually moves an 8B model.
  assert.ok(ai.styleExamples.length >= 5, 'real examples he wrote himself');
  for (const e of ai.styleExamples) {
    assert.equal(/(^|-)(still|wide|panning|static|establishing|grid)(-|$)/.test(e), false,
      `the old AI's own garbage taught back as his style: "${e}"`);
  }

  // And it TELLS him about the fragmentation that is already costing him.
  assert.equal(learned.duplicates[0].keep, 'lawn-mowing');
  assert.equal(learned.duplicates[0].merge, 'lawnmowing');
});

test('after the fixes, naming a clip is possible AT ALL — the enum is real', async () => {
  await app.invoke('ai:learnFromLibrary', [compressed]);
  const subjects = plain(await app.invoke('ai:learnFromLibrary', [compressed])).subjects;

  // This is precisely the gate in aiNameWithTools: no subjects → return null → the tool path never
  // runs and analyze silently falls back to the old giant-prompt behaviour he called gimmicky.
  assert.ok(subjects.length > 0, 'the tool-naming path would be DISABLED');

  // The enum reaches the schema, so `car-door` is not a thing the model can emit.
  const schema = app.get('toolSchemas')(['set_clip_name'], { set_clip_name: { subject: subjects } });
  const subjParam = plain(schema)[0].function.parameters.properties.subject;
  assert.deepEqual(subjParam.enum, subjects, 'the subject is a schema-level enum of HIS subjects');
});

test('learning is idempotent — clicking it twice does not double the archive', async () => {
  const a = plain(await app.invoke('ai:learnFromLibrary', [compressed]));
  const b = plain(await app.invoke('ai:learnFromLibrary', [compressed]));
  assert.deepEqual(b.subjects, a.subjects);
  assert.equal(app.getJSON('config').ai.styleExamples.length, b.examples.length, 'examples replaced, not appended');
});

test('the Learn button is pointed at the folders that actually hold his named clips', async () => {
  // The silent failure: `arg` is what the button hands to learnFromLibrary. Point it anywhere else and
  // the card still says "Learn from my clips", the click still succeeds, and it learns NOTHING.
  const h = plain(await app.invoke('ai:health'));
  const learn = h.problems.find((p) => p.id === 'no-style');
  assert.ok(learn, 'the problem is raised');
  assert.ok(learn.arg.includes(app.get('config').finalizeSource),
    'it must scan the Compressed folder — that is where the 310 clips he named himself live');
});

// --- FILING BACK ONTO HIS COMPUTER --------------------------------------------------------------
//
// "C:\Users\jakeg\Videos\02 - Projects\2026 ... I would like to be able to select what footage goes
//  back here onto my computer" — and: file in BATCHES, not per clip.
//
// The numbers that shape this: C: has 31 GB free, L: has 2.3 TB, and the compressed archive is 73 GB.
// It does not all fit, which is exactly why he wants to choose what comes back.

test('the default Projects root finds his YEAR folder, not the level above it', () => {
  // His tree is ~/Videos/02 - Projects/2026/{2026 - Client Work, - Personal, - Social Media}.
  // Defaulting to `02 - Projects` would file every clip one level ABOVE his real project folders —
  // technically "organized", completely useless.
  const src = readFileSync(join(ROOT, 'main-mod', '02-media.js'), 'utf8');
  const fn = src.slice(src.indexOf('function defaultProjectsRoot()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /String\(new Date\(\)\.getFullYear\(\)\)/, 'prefers the current year…');
  assert.match(body, /statSync\(path\.join\(base, year\)\)\.isDirectory\(\)/, '…but only when it really exists');
  assert.match(body, /return base;/, 'and falls back honestly when it does not');
});

test('a Projects folder that already EXISTS is offered in one click, not a file browser', async () => {
  const cfg = app.get('config');
  cfg.projectsRoot = '';
  const h = plain(await app.invoke('ai:health'));
  const p = h.problems.find((x) => x.id === 'no-projects-root');
  assert.ok(p, 'it still says there is nowhere to file to');
  // On this test machine the guessed folder does not exist, so it must ask him to browse — and must
  // NOT invent a path he never agreed to.
  assert.equal(p.fix, 'pickProjects');
  assert.equal(p.arg, '', 'it never fabricates a destination for his footage');
});

test('filing COPIES by default — config.organizeCopy is opt-OUT, not opt-in', () => {
  // The default has to be the safe one. If organizeCopy were unset and treated as false, the very
  // first Run would empty his Compressed folder into a 31 GB disk.
  const src = readFileSync(join(ROOT, 'main-mod', '09-ipc-boot.js'), 'utf8');
  assert.match(src, /const copyMode = opts\.copy !== undefined \? !!opts\.copy : \(config\.organizeCopy !== false\);/,
    'unset must mean COPY');
});

test('the UI says what it does — the checkbox no longer claims to MOVE', () => {
  // It said "Move the files into the folders shown above" while copying. A checkbox that lies about
  // what happens to his footage is worse than no checkbox.
  const html = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8');
  assert.equal(/Move the files into the folders/.test(html), false, 'the stale label is gone');
  assert.match(html, /id="finKeepSource"[^>]*checked/, 'and "Keep the originals" is on by default');

  const boot = readFileSync(join(ROOT, 'src', 'mod', '10-boot.js'), 'utf8');
  assert.match(boot, /copy: \$\('finKeepSource'\)\.checked/, 'and it is actually wired to the run');
});
