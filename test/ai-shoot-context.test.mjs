// get_shoot_context — the biggest accuracy win in the naming loop, and the least obvious.
//
// MEASURED ON HIS REAL LIBRARY (310 clips he named himself, real GPU, real footage):
//   subject match 60% -> 80% with this tool. Nothing else came close.
//
// WHY it works: HE SHOOTS IN BATCHES. 20 of his 28 shoot days are entirely one subject; 2026-06-01 is
// 37 lawn-mowing clips and 14 vlog. Knowing only the DATE and guessing that day's dominant subject
// scores 88% by itself — better than the entire vision pipeline managed.
//
// WHY vision could never fix it: `2026-06-01_lawn-mowing_josiah_v23` is twelve minutes of two men
// SITTING ON THE GRASS repairing a mower. Nobody mows. I pulled 9 frames and looked at them myself —
// the label is not in the pixels. The subject is what the footage is FOR (the job), and that lives in
// the sibling clips. More frames would only have cost him time.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

/** Run the tool exactly as runToolLoop would — out of the real registry. */
const runTool = (ctx) => app.get('AI_TOOLS').get_shoot_context.run({}, ctx);

// Seed the REAL store the tool reads (freshStore('finalMeta')), not the stale in-memory config copy.
const seedLibrary = (map) => { app.get('config').finalMeta = map; app.call('saveStore', 'finalMeta'); };

beforeEach(() => { seedLibrary({}); });

test('it reports what he called the OTHER clips from the same day', async () => {
  seedLibrary({
    'a.mp4': { date: '2026-06-01', subject: 'lawn-mowing' },
    'b.mp4': { date: '2026-06-01', subject: 'lawn-mowing' },
    'c.mp4': { date: '2026-06-01', subject: 'vlog' },
    'd.mp4': { date: '2026-05-11', subject: 'timelapse' },   // a DIFFERENT shoot — must not leak in
  });
  const r = await runTool({ date: '2026-06-01' });
  assert.deepEqual(JSON.parse(JSON.stringify(r.clips_you_already_named_from_this_shoot)),
    { 'lawn-mowing': 2, vlog: 1 });
  assert.equal(r.date, '2026-06-01');
});

test('it returns COUNTS, not a verdict — so the model can still disagree with the majority', async () => {
  // THE ADVERSARIAL CASE, from his real data: 2026-05-11 is timelapse×13 vs pov×2. A tool that
  // returned "the answer is timelapse" would have overridden the observation and got it WRONG — his
  // name for that clip is pov. Verified on the real GPU: given the counts, qwen3 still answered pov,
  // because the observation said so. Returning a single verdict would break that.
  seedLibrary({
    a: { date: '2026-05-11', subject: 'timelapse' }, b: { date: '2026-05-11', subject: 'timelapse' },
    c: { date: '2026-05-11', subject: 'pov' },
  });
  const r = await runTool({ date: '2026-05-11' });
  const counts = r.clips_you_already_named_from_this_shoot;
  assert.equal(counts.timelapse, 2);
  assert.equal(counts.pov, 1, 'the minority subject is still visible to the model');
  assert.equal(r.verdict, undefined, 'it must NOT hand down a single answer');
  assert.match(r.note, /weigh them against the observation/i);
});

test('clips named EARLIER IN THIS RUN count too — clip 30 learns from clips 1-29', async () => {
  const r = await runTool({
    date: '2026-06-01',
    siblings: [
      { date: '2026-06-01', subject: 'lawn-mowing' },
      { date: '2026-06-01', subject: 'lawn-mowing' },
      { date: '2026-06-02', subject: 'vlog' },        // wrong day — excluded
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(r.clips_you_already_named_from_this_shoot)), { 'lawn-mowing': 2 });
});

test('the run and the library are COMBINED — a re-visited shoot works on its very first clip', async () => {
  seedLibrary({ old: { date: '2026-06-01', subject: 'lawn-mowing' } });
  const r = await runTool({ date: '2026-06-01', siblings: [{ date: '2026-06-01', subject: 'vlog' }] });
  const c = r.clips_you_already_named_from_this_shoot;
  assert.equal(c['lawn-mowing'], 1, 'from the library');
  assert.equal(c.vlog, 1, 'and from this run');
});

test('subjects are slugged, so lawn-mowing and "Lawn Mowing" are not counted as two shoots', async () => {
  seedLibrary({
    a: { date: '2026-06-01', subject: 'Lawn Mowing' },
    b: { date: '2026-06-01', subject: 'lawn-mowing' },
  });
  const r = await runTool({ date: '2026-06-01' });
  assert.deepEqual(JSON.parse(JSON.stringify(r.clips_you_already_named_from_this_shoot)), { 'lawn-mowing': 2 });
});

test('no date, or nothing else from that shoot → it says so rather than inventing context', async () => {
  const noDate = await runTool({ date: '' });
  assert.match(noDate.note, /no date/i);
  assert.equal(noDate.clips_you_already_named_from_this_shoot, undefined);

  const empty = await runTool({ date: '2026-06-01' });
  assert.match(empty.note, /Nothing else from this day/i);
});

test('a full ISO timestamp still resolves to its day', async () => {
  seedLibrary({ a: { date: '2026-06-01T14:22:00Z', subject: 'lawn-mowing' } });
  const r = await runTool({ date: '2026-06-01T09:00:00Z' });
  assert.equal(r.clips_you_already_named_from_this_shoot['lawn-mowing'], 1);
});

// --- the wiring ------------------------------------------------------------------------------

test('the naming loop is actually GIVEN the tool, and the context it needs', () => {
  const src = readFileSync(join(ROOT, 'main-mod', '10-ai-tools.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('ai:nameFromObservation'");
  const h = src.slice(start, src.indexOf('\n});', start));
  assert.match(h, /tools: \[[^\]]*'get_shoot_context'/, 'the tool is offered to the loop');
  assert.match(h, /date: p\.date \|\| '', siblings: p\.siblings \|\| \[\]/, 'and its ctx is populated');

  const r = readFileSync(join(ROOT, 'src', 'mod', '04-tasks-ai.js'), 'utf8');
  const call = r.slice(r.indexOf('window.api.aiNameFromObservation({'));
  assert.match(call.slice(0, 900), /date: clip\.date/, 'the renderer sends the clip date');
  assert.match(call.slice(0, 900), /siblings: state\.scannedFiles/, 'and what it already named this run');
});

test('the tool result STRINGS are load-bearing — measured, not decoration', async () => {
  // I renamed the key and reworded the note. Cosmetic change, identical data. It flipped
  // `2026-05-11_pov_wood-cleanup-fairview` from `pov` (his name, correct) to `vlog` (wrong) —
  // deterministically, 4 runs out of 4 each way, at temperature 0.1 on the real qwen3:8b.
  //
  // A tidy-up cost 20 points of subject accuracy. On an 8B model the phrasing of a tool RESULT is
  // input, not documentation: "for the same day" + "a day can STILL contain more than one subject"
  // keeps the counts as evidence to weigh, while calling the day a "shoot" frames it as one thing and
  // the model starts answering with the day instead of with the footage.
  //
  // If you change these words, RE-MEASURE against his footage. That is what this test is for.
  seedLibrary({ a: { date: '2026-05-11', subject: 'pov' } });
  const r = await runTool({ date: '2026-05-11' });
  assert.ok('clips_you_already_named_from_this_shoot' in r, 'the key the model was measured against');
  assert.equal(r.note,
    'These are his own names for the same day. Weigh them against the observation — a day can still contain more than one subject.');
});
