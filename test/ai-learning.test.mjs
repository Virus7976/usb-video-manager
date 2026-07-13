// How the AI "learns" — the part Jake said doesn't work.
//
// Two defects, both structural:
//
//  1. A SELF-CONFIRMATION LOOP. `learnFromAnalysis` defaults ON. After every analyze run of >=2
//     clips, the app sent the model its OWN observations paired with its OWN generated names, under
//     a prompt reading "a system … produced these names … work backwards, what rules explain these
//     choices?" — and auto-saved the answer into memory, which is then injected into the next clip's
//     prompt. The AI wrote down what it already does, called it the user's preference, and then
//     followed it harder. The one real signal — the user CORRECTING a name — was not privileged in
//     any way, and landed in the same undifferentiated blob.
//
//  2. AN UNCAPPED MEMORY BLOB. Style examples were capped at 12; memories were capped at NOTHING.
//     The store holds up to 300, so a well-used install injected ~18 KB of English rules into every
//     single clip's prompt, on a 7B model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// --- 1. it learns from the USER, not from itself -------------------------------------------

test('reflection only learns from clips the USER corrected', () => {
  // A clip the user never touched carries no signal: its name IS the AI's output. Feeding it back is
  // how the memory list filled up with the AI's own habits dressed as Jake's preferences.
  const ai = read('src/mod/04-tasks-ai.js');
  const fn = ai.slice(ai.indexOf('async function reflectFromClips('));
  const body = fn.slice(0, fn.indexOf('\n  if (samples.length < 2)'));
  assert.match(body, /if \(!c\._userNamed\) return null;/, 'unedited clips are excluded from the sample');
});

test('a user correction is what MARKS a clip as user-named', () => {
  const ai = read('src/mod/04-tasks-ai.js');
  const fn = ai.slice(ai.indexOf('function recordAiEdit('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /clip\._userNamed = true;/);
  // …and only when the value ACTUALLY changed — recordAiEdit bails when from === to.
  assert.match(body, /if \(!from \|\| !to \|\| from\.toLowerCase\(\) === to\.toLowerCase\(\)\) return;/);
});

test('the reflect PROMPT no longer tells the model these are its own choices', () => {
  // Filtering the samples isn't enough on its own: the prompt literally said "a system … produced
  // these names", so the model reasoned about itself. It has to be told these are the USER's names,
  // or it looks for the wrong thing.
  const src = read('main-mod/07-naming-organize.js');
  const h = src.slice(src.indexOf("ipcMain.handle('ai:reflect'"));
  const body = h.slice(0, h.indexOf('\n});'));

  assert.equal(/A system looked at these video clips/.test(body), false, 'the self-referential framing is gone');
  assert.match(body, /the name THE USER chose/, 'the model is told whose names these are');
  assert.match(body, /Work BACKWARDS from THE USER'S choices/);
  assert.match(body, /none is a perfectly good answer/, 'inventing rules to look useful is discouraged');
});

// --- 2. the prompt is not 300 rules long ---------------------------------------------------

test('memories are CAPPED — 300 rules never reach a 7B model again', () => {
  const selectMemories = app.get('selectMemories');
  const many = Array.from({ length: 300 }, (_, i) => ({ text: `rule number ${i}`, example: '' }));
  assert.equal(selectMemories(many, 'a lawn mower in the garden', 24).length, 24);
});

test('under the cap, NOTHING is dropped', () => {
  // The dangerous failure mode of a naive relevance filter: silently binning the user's rules.
  const selectMemories = app.get('selectMemories');
  const few = [{ text: 'always lowercase with hyphens' }, { text: 'call the back garden "garden"' }];
  assert.equal(selectMemories(few, 'totally unrelated clip about skiing', 24).length, 2,
    'a rule with zero lexical overlap is still kept while there is room');
});

test('over the cap, RELEVANT rules win — but global style rules are not sacrificed lightly', () => {
  const selectMemories = app.get('selectMemories');
  const mems = [
    { text: 'always lowercase with hyphens' },                 // global, no overlap
    ...Array.from({ length: 30 }, (_, i) => ({ text: `irrelevant rule about skiing ${i}` })),
    { text: 'call the ride-on mower "mower"', example: 'mower-cutting-lawn' },   // relevant
  ];
  const picked = selectMemories(mems, 'a ride-on mower cutting a lawn in the garden', 5);
  assert.equal(picked.length, 5);
  assert.ok(picked.some((m) => /mower/.test(m.text)), 'the rule about THIS clip is selected');
});

test('the selected rules keep their original order', () => {
  // The prompt should be stable between clips. Reshuffling the rule list re-anchors the model for no
  // reason and makes runs non-reproducible.
  const selectMemories = app.get('selectMemories');
  const mems = Array.from({ length: 50 }, (_, i) => ({ text: `rule ${i}` }));
  const picked = selectMemories(mems, 'rule 49 rule 48', 5);
  const idx = picked.map((m) => Number(m.text.split(' ')[1]));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'emitted in original order, not ranked order');
});

test('the naming prompt actually USES the cap', () => {
  // selectMemories existing is worthless if aiNamingSpec still dumps ai.memories wholesale.
  const src = read('main-mod/07-naming-organize.js');
  const fn = src.slice(src.indexOf('function aiNamingSpec('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /selectMemories\(ai\.memories, \(opts && opts\.clipText\) \|\| '', 24\)/);
  assert.equal(/ai\.memories : \[\]\)\.map/.test(body), false, 'the uncapped map is gone');
});

test('both naming call sites pass what the clip is ABOUT, so relevance has something to rank on', () => {
  const src = read('main-mod/07-naming-organize.js');
  assert.match(src, /aiNamingSpec\(ai, \{ subjects, categories, hasPeople, clipText \}\)/, 'ai:suggest');
  assert.match(src, /clipText: clipText2 \}\)/, 'ai:improve');
});
