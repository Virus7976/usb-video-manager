// The shoot question could be skipped by a race, and his shoot memory is empty.
//
// He shoots in batches — 20 of his 28 shoot days are a single subject — so one question settles a
// whole day, and the answer is remembered forever. It is the strongest predictive signal the app has
// (the shoot date predicts the subject ~88% of the time). **Measured on his real store: `shootMemory`
// holds 0 entries.**
//
// The feature is fully wired (handler, bridge, renderer, a careful never-ask-twice rule), so this is
// not the usual "built but never fed". It is a gate:
//
//     if (!aiToolModelReady || !subjectsCache.length) return;
//
// and `aiToolModelReady` is latched inside `renderAiHealth()` — a RENDER, fired un-awaited at boot,
// which then awaits `aiHealth()` and round-trips to Ollama. Seconds, if the server is cold. Insert a
// card and analyse inside that window and the flag is still `false`, so `askAboutShoots` returns
// immediately and the whole batch goes unasked. Silently: there is no path where the app says "I
// skipped that".
//
// **A latch set by a render is not a fact, it is a race.** The fix resolves the tool model on demand;
// one health call is trivial next to an analyze run, and health already auto-picks and persists a
// tool model if one exists — so asking is also what makes it true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '');
const core = strip(readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8'));
const tasks = strip(readFileSync(join(process.cwd(), 'src', 'mod', '04-tasks-ai.js'), 'utf8'));

const askFn = (() => {
  const i = tasks.indexOf('async function askAboutShoots');
  return tasks.slice(i, tasks.indexOf('\n}', i));
})();

test('⚠ the shoot question no longer depends on a render having run', () => {
  assert.ok(askFn.length > 0, 'found askAboutShoots');
  assert.doesNotMatch(askFn, /if \(!aiToolModelReady/,
    'it does not bail on the raw latch, which may simply not be set yet');
  assert.match(askFn, /await ensureToolModelKnown\(\)/, 'it resolves the tool model itself');
});

test('the resolver exists and is genuinely on-demand', () => {
  const fn = core.slice(core.indexOf('async function ensureToolModelKnown'), core.indexOf('\n}', core.indexOf('async function ensureToolModelKnown')));
  assert.ok(fn.length > 0, 'found ensureToolModelKnown');
  assert.match(fn, /if \(aiToolModelReady\) return true;/, 'it short-circuits once known — no repeat round-trips');
  assert.match(fn, /await window\.api\.aiHealth\(\)/, 'and asks health when it is not');
});

test('⚠ it still refuses when there is genuinely NO tool model', () => {
  // The gate must keep gating. A vision model cannot call tools, so running the tool path without one
  // would fail in a much more confusing way than skipping.
  const fn = core.slice(core.indexOf('async function ensureToolModelKnown'), core.indexOf('\n}', core.indexOf('async function ensureToolModelKnown')));
  assert.match(fn, /aiToolModelReady = !!aiToolModelName;/, 'readiness follows the model name');
  assert.match(askFn, /if \(!\(await ensureToolModelKnown\(\)\)\) return;/, 'and the caller still returns when it is false');
});

test('a health failure leaves it false rather than throwing into the analyze run', () => {
  // Ollama being down must not turn a naming run into an exception — it should just mean no question.
  const fn = core.slice(core.indexOf('async function ensureToolModelKnown'), core.indexOf('\n}', core.indexOf('async function ensureToolModelKnown')));
  assert.match(fn, /catch \{/, 'the health call is guarded');
  assert.match(fn, /return aiToolModelReady;/, 'and it reports the honest answer');
});

test('the subjects check still runs, and runs FIRST', () => {
  // With no remembered subjects there is nothing to offer as an answer, so asking is pointless — and
  // checking that before the network call keeps the cheap test cheap.
  const subjIdx = askFn.indexOf('subjectsCache.length');
  const toolIdx = askFn.indexOf('ensureToolModelKnown');
  assert.ok(subjIdx > 0 && toolIdx > 0, 'both checks are present');
  assert.ok(subjIdx < toolIdx, 'the free check comes before the round-trip');
});

test('renderAiHealth still latches it too — the fast path is unchanged', () => {
  // On-demand resolution is a fallback, not a replacement: when health has already run, no analyze
  // should pay for a second call.
  assert.match(core, /aiToolModelName = \(h && h\.toolModel\) \|\| '';/, 'health still sets the name');
  assert.match(core, /aiToolModelReady = !!aiToolModelName;/, 'and the flag');
});
