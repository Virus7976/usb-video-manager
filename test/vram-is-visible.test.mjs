// FEATURES.md item 55 — show which model is resident in VRAM. Another handler + bridge method with
// no caller (`ai:loaded`), which meant the app knew the answer and never said it.
//
// ⚠ WHY THIS IS NOT COSMETIC. His card is 6 GB. That fits ONE 7-8B model. The app's whole resource
// policy is built on that (`ensureOnlyModel` — batch the vision phase, evict at the phase boundary,
// never need two at once), and when the policy fails the symptom is an analyze run that crawls
// because Ollama is swapping. Until now nothing in the app could tell him whether that was happening.
//
// It goes in the Model store because that is the screen where the answer changes a decision: which
// model to use, and which to remove.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const people = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8').replace(/\/\/.*$/gm, '');
const store = people.slice(people.indexOf('function showModelStore'), people.indexOf('\nfunction showAiSettings'));

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('⚠⚠ the model store asks what is resident — the bridge method finally has a caller', () => {
  assert.match(store, /await window\.api\.aiLoaded\(\)/, 'ai:loaded is invoked');
  assert.match(store, /loadedByBase = new Map\(models\.map\(\(m\) => \[String\(m\.name\)\.split\(':'\)\[0\], m\]\)\);/,
    'keyed by base name, so qwen3:8b matches the catalogue entry qwen3');
});

test('⚠ VRAM is read BEFORE the rows render, so the badges and the summary cannot disagree', () => {
  // Two independent reads would drift and produce a screen that contradicts itself — the kind of
  // detail that makes a status display untrustworthy the first time it happens.
  const at = store.indexOf('async function load()');
  const body = store.slice(at, store.indexOf('function renderRows', at));
  const readAt = body.indexOf('await readVram()');
  assert.ok(readAt > -1, 'it reads once');
  assert.ok(readAt < body.indexOf("renderRows(q('.ms-list')"), '⚠ before the rows');
  assert.ok(readAt < body.indexOf("q('.ms-status').textContent = `${res.catalog.length}"), 'and before the summary');
});

test('⚠⚠ TWO resident models is called out, not merely listed', () => {
  // The single fact worth interrupting for. One model resident is normal; two on a 6 GB card is the
  // state that makes everything slow, and "qwen3:8b, minicpm-v" printed flatly does not say so.
  assert.match(store, /models\.length > 1/, 'the two-model case is distinguished');
  assert.match(store, /they are competing for your card/, '⚠ and says what it means for him');
  assert.match(store, /'nothing loaded in VRAM'/, 'and the empty case reads as a fact, not an error');
});

test('a resident model is badged on its own row', () => {
  assert.match(store, /loadedByBase\.get\(String\(m\.name\)\.split\(':'\)\[0\]\)/, 'each row checks');
  assert.match(store, /In VRAM · \$\{escapeHtml\(gb\(res\.vram\)\)\}/, 'and shows how much it is using');
});

test('⚠ Ollama being down never breaks the model store', () => {
  // AI is optional in this app and the store is also how you INSTALL Ollama-side things. A throw here
  // would blank the screen you go to when the AI is broken — exactly when you need it.
  const at = store.indexOf('async function readVram');
  const body = store.slice(at, store.indexOf('const gb =', at));
  assert.match(body, /catch \{ r = null; \}/, 'a failed call is swallowed');
  assert.match(body, /const models = \(r && r\.models\) \|\| \[\];/, 'and degrades to "nothing loaded"');
});

test('ai:loaded really answers in main', async () => {
  const r = app.plain(await app.invoke('ai:loaded'));
  assert.equal(r.ok, true, 'it always answers');
  assert.ok(Array.isArray(r.models), 'with a list — empty here, since no Ollama runs in the test env');
});
