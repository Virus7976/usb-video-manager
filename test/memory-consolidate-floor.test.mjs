// `maybeAutoConsolidate()` could delete almost every hand-taught memory rule, unattended.
//
// The header says it merges/dedupes "in the BACKGROUND (no approval) so it stays a tight set of
// distinct rules forever". The only gate on applying the model's output was:
//
//     if (merged.length && merged.length <= mems.length && after !== before) {
//
// `merged.length <= mems.length` bounds GROWTH. It says nothing about how far the set may SHRINK, so
// a model that returns one rule for twenty passes it and nineteen are gone. That isn't a malfunction
// the guard was failing to catch, either — the prompt itself instructs "DELETE anything redundant,
// vague, or now contradicted" and "Aim for ≤ 18 rules", so aggressive collapse is the requested
// behaviour and a 7-8B local model obliges enthusiastically.
//
// Its sibling gets this right: `ai:consolidateMemories` returns `{ok, proposed, before}` and applies
// NOTHING; a separate `ai:replaceMemories` commits only after the user approves. Same operation, two
// paths, opposite consent models — the sibling-divergence shape this codebase has been burned by
// repeatedly.
//
// What is lost: `config.ai.memories`, the preference rules the user typed as feedback or that were
// distilled from their corrections. No version history, no undo, no source to rebuild from.
//
// THE PROMPT STRING IS NOT TOUCHED by this fix. AI prompts and tool strings are measured input here
// (a cosmetic rename of one tool result once cost 20 points of subject accuracy), so the change is
// confined to the gate that decides whether to APPLY what came back.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// Drive the real function with a stubbed transport: return exactly N rules whatever we're asked.
function modelReturns(n) {
  app.get(`ollamaGenerate = function () { return Promise.resolve(JSON.stringify({ memories: Array.from({ length: ${n} }, (_, i) => ({ rule: 'merged rule ' + i, example: '' })) })); }`);
}
function seedMemories(count) {
  const cfg = app.get('config');
  cfg.ai = cfg.ai || {};
  cfg.ai.textModel = 'qwen3:8b';
  cfg.ai.memories = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, text: `rule number ${i}`, example: '', ts: 1 }));
}
const memCount = () => (app.plain(app.get('config').ai.memories) || []).length;

beforeEach(() => { app.get('_autoConsolidating = false'); });

test('a catastrophic collapse is REFUSED', async () => {
  // 20 rules in, 1 back. The old gate passed this because 1 <= 20.
  seedMemories(20);
  modelReturns(1);
  await app.get('maybeAutoConsolidate')();
  assert.equal(memCount(), 20, 'the hand-taught rules survive a model that returned almost nothing');
});

test('a reasonable merge is still APPLIED', async () => {
  // The feature must keep working — this is a real consolidation, not data loss.
  seedMemories(20);
  modelReturns(12);
  await app.get('maybeAutoConsolidate')();
  assert.equal(memCount(), 12, 'a genuine merge still applies unattended');
});

test('the prompt\'s own target of 18 is allowed from a large set', async () => {
  // The prompt says "Aim for ≤ 18 rules". A floor that blocked the documented target would make the
  // feature useless on a big memory list, which is exactly when it is wanted.
  seedMemories(40);
  modelReturns(18);
  await app.get('maybeAutoConsolidate')();
  assert.equal(memCount(), 18, 'consolidating 40 down to the documented 18 is allowed');
});

test('but a large set cannot be collapsed below that target', async () => {
  seedMemories(40);
  modelReturns(3);
  await app.get('maybeAutoConsolidate')();
  assert.equal(memCount(), 40, '40 rules are not silently replaced by 3');
});

test('a refused consolidation leaves the rules byte-identical', async () => {
  // Refusing must not half-apply: no reordering, no re-stamping, no id churn.
  seedMemories(20);
  const snapshot = JSON.stringify(app.plain(app.get('config').ai.memories));
  modelReturns(2);
  await app.get('maybeAutoConsolidate')();
  assert.equal(JSON.stringify(app.plain(app.get('config').ai.memories)), snapshot, 'untouched');
});

test('an applied consolidation keeps a recoverable snapshot of what it replaced', async () => {
  // This runs unattended with no undo and no version history. Keeping the previous list makes a bad
  // consolidation recoverable by hand from config.json rather than lost outright.
  seedMemories(20);
  modelReturns(12);
  await app.get('maybeAutoConsolidate')();
  const prev = app.plain(app.get('config').ai.memoriesPrev) || [];
  assert.equal(prev.length, 20, 'the pre-consolidation rules are still on disk');
  assert.match(String(prev[0].text || ''), /rule number/, 'and they are the ORIGINAL texts');
});

test('the AI prompt string is not modified by this fix', async () => {
  // Guard the measured input. If a future edit "tidies" this prompt, that changes model behaviour
  // and must be re-measured against the real Ollama models, not slipped in with a safety fix.
  const src = readFileSync(join(process.cwd(), 'main-mod', '07-naming-organize.js'), 'utf8');
  assert.match(src, /Aim for ≤ 18 rules\. Reply STRICT JSON only/, 'the prompt is byte-stable');
  assert.match(src, /DELETE anything redundant, vague, or now contradicted\. Do not invent new rules\./, 'and unedited');
});
