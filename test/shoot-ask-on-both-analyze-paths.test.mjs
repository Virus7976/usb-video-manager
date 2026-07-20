// The shoot question had ONE call site, and it was the path his older footage never takes.
//
// `askAboutShoots` was called only from the card-flow run loop. Analysing from the **Organize**
// screen — the path his already-copied footage goes through, which after Tdarr is most of his
// library — never asked at all. Combined with the render-latch race fixed alongside this, that is why
// `shootMemory` reads **0 entries** on a store with 28 distinct shoot days.
//
// It is the "second entry point inherits none of the first's fixes" shape, which has produced a
// confirmed bug on three separate days here. And it could not simply be called from the new place:
//
//     async function askAboutShoots(idxs) {
//       const dates = idxs.map((i) => (state.scannedFiles[i] || {}).date)...
//
// It took INDICES into `state.scannedFiles`, silently binding it to the card flow. The Organize
// screen builds its list from `finScan.files` and has no such indices — passing its own numbers
// would have meant reading unrelated clips, which is EXACTLY the wrong-context wiring that collapsed
// the group-shot sort twice this week. So it now takes clips, and the card flow maps its indices at
// the call site. A shared function must not know which screen is asking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '');
const tasks = strip(readFileSync(join(process.cwd(), 'src', 'mod', '04-tasks-ai.js'), 'utf8'));
const fin = strip(readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8'));

const askFn = (() => {
  const i = tasks.indexOf('async function askAboutShoots');
  return tasks.slice(i, tasks.indexOf('\n}', i));
})();

test('⚠ askAboutShoots takes CLIPS, not indices into one screen\'s array', () => {
  assert.match(askFn, /async function askAboutShoots\(clips\)/, 'the parameter is the clips themselves');
  assert.doesNotMatch(askFn, /state\.scannedFiles\[/,
    'it no longer reaches into the card flow\'s array — that is what bound it to one screen');
});

test('the dates come from the clips it was given', () => {
  // Reads BOTH shapes since 2026-07-20. Card clips carry a top-level .date; finalize:scan rows keep
  // it at .meta.date. Reading c.date alone meant `dates` was always empty on the Organize path, so
  // this feature returned early and never once fired there — the reason shootMemory reads 0.
  assert.match(askFn, /const clipShootDate = \(c\) => \(c && \(c\.date \|\| \(c\.meta && c\.meta\.date\)\)\) \|\| '';/,
    'one accessor for both clip shapes');
  assert.match(askFn, /const dates = list\.map\(clipShootDate\)\.filter\(Boolean\);/, 'dates from the list');
});

test('and so do the per-shoot groups', () => {
  // The groups drive the thumbnail and the "N clips" count on each card. Building them from a
  // different source than the dates is how a card ends up saying 0 clips.
  assert.match(askFn, /list\.filter\(\(c\) => clipShootDate\(c\) === date\)/,
    'groups from the same list, through the same accessor — otherwise it returns before rendering');
});

test('⚠ the CARD flow still asks — it maps its indices at the call site', () => {
  // Guard the path that already worked: the refactor must not have quietly unhooked it.
  assert.match(tasks, /await askAboutShoots\(idxs\.map\(\(i\) => state\.scannedFiles\[i\]\)\)/,
    'the card flow converts its indices to clips');
});

test('⚠⚠ the ORGANIZE flow now asks too', () => {
  assert.match(fin, /await askAboutShoots\(pending\)/, 'it passes the clips it is about to name');
});

test('it asks BEFORE naming, on the phase boundary', () => {
  // Two reasons, both load-bearing: his answer must land before any clip from that shoot is named, and
  // the GPU is empty between phases — on a 6 GB card that is the one moment a human pause is free.
  // Locate the phase marker in the RAW source: `fin` has its comments stripped, and "PHASE 2 — NAME"
  // is a comment. My first version searched the stripped copy, found -1, and failed on its own
  // preprocessing rather than on the code.
  const rawFin = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8');
  const askIdx = rawFin.indexOf('await askAboutShoots(pending)');
  const phase2 = rawFin.indexOf('PHASE 2 — NAME');
  assert.ok(askIdx > 0 && phase2 > 0, `both markers present — ask ${askIdx}, phase2 ${phase2}`);
  assert.ok(askIdx < phase2, 'the question comes before the naming phase');
});

test('a failure there never blocks the naming run', () => {
  const near = fin.slice(fin.indexOf('await askAboutShoots(pending)') - 200, fin.indexOf('await askAboutShoots(pending)') + 200);
  assert.match(near, /catch \{/, 'wrapped — the run continues even if the question fails');
});

test('it respects the abort flag like every other phase step', () => {
  const near = fin.slice(fin.indexOf('await askAboutShoots(pending)') - 200, fin.indexOf('await askAboutShoots(pending)'));
  assert.match(near, /if \(!aiAborted\)/, 'cancelling the run skips the question');
});
