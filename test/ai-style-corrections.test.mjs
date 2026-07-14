// LEARNING FROM WHAT HE ACTUALLY CORRECTS.
//
// The hole this closes: `styleExamples` — the few-shot pairs the model is shown — could only ever be
// written by the two BULK MINERS (learnFromLibrary, learnNames), which read old filenames off disk.
// When Jake looked at a name the AI produced and typed a better one, that pair was sent off to be
// distilled into an English rule and then DROPPED. The single cleanest signal in the system — him
// saying "you wrote X, it is actually Y" — never reached the model as an example.
//
// Three things have to hold, and each is a trap:
//   1. corrections live in their OWN store, because mining REPLACES styleExamples;
//   2. corrections WIN the 12-slot cut, or they are stored and still never seen;
//   3. …but take at most half of it, or twelve vlog corrections erase every other subject.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

beforeEach(() => {
  const cfg = app.get('config');
  cfg.ai = { model: 'qwen2.5vl:7b', textModel: 'qwen3:8b', memories: [], styleExamples: [], styleCorrections: [] };
});

const correct = (subject, description) => app.invoke('ai:recordStyleCorrection', { subject, description });
const pairs = () => (app.getJSON('config').ai.styleCorrections || []).map((c) => c.pair);

// --- it is kept at all ----------------------------------------------------------------------

test('a correction is stored as the PAIR he typed', async () => {
  await correct('lawn-mowing', 'josiah-front-lawn');
  assert.deepEqual(pairs(), ['lawn-mowing / josiah-front-lawn']);
});

test('half a name teaches half a lesson — an incomplete pair is refused', async () => {
  assert.equal((await correct('lawn-mowing', '')).ok, false);
  assert.equal((await correct('', 'josiah-front-lawn')).ok, false);
  assert.deepEqual(pairs(), []);
});

test('`delete` is his junk MARKER, not a subject — it never becomes an example', async () => {
  // He writes `_delete_` to mean "this clip is junk". learnFromLibrary already refuses to learn it as
  // a subject (MARKER_SUBJECTS); a live correction must not smuggle it back in through the other door.
  assert.equal((await correct('delete', 'blurry-handheld')).ok, false);
  assert.equal((await correct('vlog', 'delete')).ok, false);
  assert.deepEqual(pairs(), []);
});

test('a camera word in HIS correction is KEPT — authorship is the whole point', async () => {
  // CAMERA_WORDS strips `still-`/`wide-`/`panning-` from MINED examples because 18% of his archive's
  // descriptions were written by the OLD AI and a filename cannot say who typed it. Here it can: he
  // did, just now, to correct us. Second-guessing his own correction would make the app disagree with
  // the user about what the user prefers.
  await correct('pov', 'wide-shot-of-the-valley');
  assert.deepEqual(pairs(), ['pov / wide-shot-of-the-valley']);
});

// --- it SURVIVES the things that rewrite config.ai ------------------------------------------

test('⚠ re-mining the library does NOT wipe his corrections', async () => {
  // THE regression. learnFromLibrary ASSIGNS over styleExamples (there is a test pinning
  // "replaced, not appended"), so had corrections been appended to that same array, one click of the
  // health card's "learn my style" fix would have silently erased every correction he had ever made.
  const lib = mkdtempSync(join(tmpdir(), 'lib-'));
  for (const n of ['2026-06-01_lawn-mowing_josiah-front-lawn_v1.mp4', '2026-06-01_vlog_kitchen-table_v1.mp4',
    '2026-05-11_pov_wood-cleanup_v1.mp4', '2026-05-11_vlog_water-park_v1.mp4']) writeFileSync(join(lib, n), 'x');

  await correct('calisthenics', 'pullups-on-the-bar');
  await app.invoke('ai:learnFromLibrary', [lib]);

  assert.deepEqual(pairs(), ['calisthenics / pullups-on-the-bar'], 'the correction is still there');
  assert.ok((app.getJSON('config').ai.styleExamples || []).length > 0, 'and the mined examples landed');
});

test('⚠ saving Settings does NOT wipe his corrections', async () => {
  // config.ai is REBUILT on a settings save. Anything the rebuild does not carry over is gone — and
  // this store is the only copy (styleExamples can be re-mined from disk; a name he typed once cannot).
  await correct('lawn-mowing', 'josiah-front-lawn');
  await app.invoke('prefs:set', { ai: { enabled: true, model: 'qwen2.5vl:7b', textModel: 'qwen3:8b', temperature: 0.3 } });
  assert.deepEqual(pairs(), ['lawn-mowing / josiah-front-lawn']);
});

// --- it actually REACHES the model ----------------------------------------------------------

test('⚠ a correction WINS the cut — being stored is not the same as being seen', async () => {
  // The few-shot is sliced to 12 and the mined set holds up to 60. A correction appended to the end of
  // that list would never once reach the model: learned, saved, and ignored.
  const cfg = app.get('config');
  cfg.ai.styleExamples = Array.from({ length: 60 }, (_, i) => `vlog / mined-example-${i}`);
  await correct('lawn-mowing', 'josiah-front-lawn');

  const shown = app.get('styleFewShot')(12);
  assert.equal(shown[0], 'lawn-mowing / josiah-front-lawn', 'his correction is the FIRST thing the model sees');
  assert.equal(shown.length, 12);
});

test('the freshest correction is the one that survives', async () => {
  for (let i = 0; i < 10; i += 1) await correct('vlog', `desc-${i}`);
  const shown = app.get('styleFewShot')(12);
  assert.equal(shown[0], 'vlog / desc-9', 'most recent first');
});

test('⚠ corrections take at most HALF the budget — his other subjects survive', async () => {
  // If he corrects twelve vlog clips in a row, twelve vlog examples would crowd out every other
  // subject and the model would forget `pov` and `calisthenics` exist. learnFromLibrary deliberately
  // spreads the MINED examples across subjects for exactly this reason; don't then bury them.
  const cfg = app.get('config');
  cfg.ai.styleExamples = ['pov / wood-cleanup', 'calisthenics / pullups', 'lawn-mowing / front-lawn'];
  for (let i = 0; i < 20; i += 1) await correct('vlog', `corrected-${i}`);

  const shown = app.get('styleFewShot')(12);
  assert.equal(shown.filter((s) => s.startsWith('vlog / corrected')).length, 6, 'corrections capped at half of 12');
  for (const subj of ['pov', 'calisthenics', 'lawn-mowing']) {
    assert.ok(shown.some((s) => s.startsWith(`${subj} / `)), `${subj} still reaches the model`);
  }
});

test('correcting the same pair twice does not duplicate it — it refreshes it', async () => {
  await correct('vlog', 'kitchen-table');
  await correct('pov', 'wood-cleanup');
  await correct('vlog', 'kitchen-table');
  assert.deepEqual(pairs(), ['pov / wood-cleanup', 'vlog / kitchen-table'], 'moved to the end, not duplicated');
});

test('the store is capped — newest kept', async () => {
  for (let i = 0; i < 60; i += 1) await correct('vlog', `desc-${i}`);
  const p = pairs();
  assert.equal(p.length, 40);
  assert.equal(p[p.length - 1], 'vlog / desc-59');
  assert.equal(p[0], 'vlog / desc-20', 'the oldest fell off, not the newest');
});

// --- both prompt sites read through the ONE owner -------------------------------------------

test('get_naming_style and the legacy prompt BOTH read styleFewShot', () => {
  // Two call sites reading ai.styleExamples directly is how one of them silently stops showing the
  // model his corrections while the other keeps working.
  assert.match(read('main-mod/10-ai-tools.js'), /examples: styleFewShot\(12\)/, 'the tool');
  assert.match(read('main-mod/07-naming-organize.js'), /const exs = styleFewShot\(12\);/, 'the legacy giant prompt');
  const both = read('main-mod/10-ai-tools.js') + read('main-mod/07-naming-organize.js');
  assert.equal(/styleExamples \|\| \[\]\)\.slice\(0, 12\)/.test(both), false, 'no direct slice survives');
});

// --- the renderer actually sends it ---------------------------------------------------------

test('recordAiEdit sends the PAIR, not just the changed field', () => {
  // A style example is a "subject / description" pair, but recordAiEdit fires per FIELD — and it fires
  // BEFORE the call sites assign the new value onto the clip, so the corrected field has to come from
  // `to` and the other one from the clip.
  const src = read('src/mod/04-tasks-ai.js');
  const fn = src.slice(src.indexOf('function recordAiEdit('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /subject: field === 'subject' \? to : \(clip\.subject \|\| ''\)/);
  assert.match(body, /description: field === 'description' \? to : \(clip\.description \|\| ''\)/);
  assert.match(body, /window\.api\.aiRecordStyleCorrection\(pair\)/);
  assert.match(body, /\.catch\(\(\) => \{\}\)/, 'a dead main process must not break him typing a name');
  assert.match(read('preload.js'), /aiRecordStyleCorrection: \(pair\) => ipcRenderer\.invoke\('ai:recordStyleCorrection', pair\)/);
});

test('it respects "learn from my edits" being switched OFF', () => {
  // The recording sits INSIDE recordAiEdit, below its `if (!clip || !aiCfg.learnFromEdits) return;`
  // guard. If the user turned learning off, the app does not quietly keep learning anyway.
  const src = read('src/mod/04-tasks-ai.js');
  const fn = src.slice(src.indexOf('function recordAiEdit('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.indexOf('!aiCfg.learnFromEdits') < body.indexOf('aiRecordStyleCorrection'),
    'the opt-out gate comes first');
});

// --- the dead handlers are gone -------------------------------------------------------------

test('ai:batchQuestions and ai:parseRoute are deleted, not merely unused', () => {
  const main = read('main-mod/03-ai-ollama.js');
  const pre = read('preload.js');
  assert.equal(/ipcMain\.handle\('ai:batchQuestions'/.test(main), false);
  assert.equal(/ipcMain\.handle\('ai:parseRoute'/.test(main), false);
  assert.equal(/aiBatchQuestions|aiParseRoute/.test(pre), false, 'the preload surface goes too');
  // …and the one that SUPERSEDED parseRoute is still there.
  assert.match(main, /ipcMain\.handle\('ai:parseRules'/);
  assert.match(main, /DESCRIPTOR_WORDS/, 'the shared word list survived the delete');
});

// --- the measured baseline is not disturbed --------------------------------------------------

test('⚠ with no corrections, the few-shot is IDENTICAL to the old code', () => {
  // AGENTS.md: the tool-result strings are load-bearing and MEASURED — renaming one key once cost 20
  // points of subject accuracy, deterministically. get_naming_style's `examples` was
  // `(ai.styleExamples || []).slice(0, 12)`, and the 5/5-on-his-real-six measurement was taken with
  // exactly that. This proves the change is a no-op until he actually corrects something, so that
  // result still stands — and the only thing that ever alters what the model sees is HIS OWN edit.
  const cfg = app.get('config');
  const mined = Array.from({ length: 30 }, (_, i) => `vlog / example-${i}`);
  cfg.ai.styleExamples = mined;
  cfg.ai.styleCorrections = [];
  // JSON round-trip: styleFewShot builds its array INSIDE the vm, so it carries the sandbox's
  // Array.prototype and a strict deepEqual would fail on identity rather than on content.
  const shown = JSON.parse(JSON.stringify(app.get('styleFewShot')(12)));
  assert.deepEqual(shown, mined.slice(0, 12));
});
