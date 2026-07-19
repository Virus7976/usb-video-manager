// A background consolidation could erase preference rules the user taught it WHILE it was thinking.
//
// `maybeAutoConsolidate` is a read-modify-replace across the longest await in the app:
//     const mems = (ai.memories || []).filter(…);          // snapshot
//     … await ollamaGenerate(…, { timeout: 180000 })       // up to THREE MINUTES
//     config.ai.memories = merged.map(…);                  // wholesale replace, from the snapshot
//
// `_autoConsolidating` guards this against a second consolidation — and it is genuinely correct for
// that, which is what makes it misleading: its presence reads as "this is handled". It does nothing
// about the OTHER writers to the same store. `ai:addMemories`, the feedback-learning handlers and the
// memory-inbox ingest all `ai.memories.push(...)` synchronously, and the AI-learned-from-your-edits
// flow calls `aiAddMemories` — so the very act of correcting a clip mid-consolidation adds a rule
// that the consolidation then overwrites out of existence.
//
// Three minutes is not a race window you need luck to hit; it is a window you walk through. And what
// is lost is the same thing the FLOOR added in 2026-07-19ag protects: hand-taught rules with no undo
// and no version history.
//
// The fix keeps the consolidation (that feature is wanted) but re-reads the store after the await and
// carries forward anything added while it was away, identified by id.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

beforeEach(() => { app.get('_autoConsolidating = false'); });

function seedMemories(count) {
  const cfg = app.get('config');
  cfg.ai = cfg.ai || {};
  cfg.ai.textModel = 'qwen3:8b';
  cfg.ai.memories = Array.from({ length: count }, (_, i) => ({ id: `m${i}`, text: `rule number ${i}`, example: '', ts: 1 }));
}
const texts = () => (app.plain(app.get('config').ai.memories) || []).map((m) => m.text);

// Stub the model call so that DURING the await a new memory arrives, exactly as ai:addMemories would
// add one while the user keeps working.
function modelReturnsWhileUserAdds(n, newRule) {
  app.get(`ollamaGenerate = function () {
    return new Promise((resolve) => {
      config.ai.memories.push({ id: 'live-1', text: ${JSON.stringify(newRule)}, example: '', ts: Date.now() });
      resolve(JSON.stringify({ memories: Array.from({ length: ${n} }, (_, i) => ({ rule: 'merged rule ' + i, example: '' })) }));
    });
  }`);
}

test('a rule taught DURING the consolidation is not erased by it', async () => {
  seedMemories(20);
  modelReturnsWhileUserAdds(12, 'always call the drone shots "aerial"');
  await app.get('maybeAutoConsolidate')();
  assert.ok(texts().includes('always call the drone shots "aerial"'),
    'the rule added mid-flight survived the wholesale replace');
});

test('the consolidation still applies its merge', async () => {
  // The feature must keep working — carrying the late arrival forward must not mean discarding the
  // model's result.
  seedMemories(20);
  modelReturnsWhileUserAdds(12, 'late rule');
  await app.get('maybeAutoConsolidate')();
  const t = texts();
  assert.ok(t.some((x) => x.startsWith('merged rule')), 'the merged set was applied');
  assert.equal(t.filter((x) => x.startsWith('rule number')).length, 0, 'and the old rules were replaced');
});

test('the result is the merge PLUS the late arrival, nothing more', async () => {
  seedMemories(20);
  modelReturnsWhileUserAdds(12, 'late rule');
  await app.get('maybeAutoConsolidate')();
  assert.equal(texts().length, 13, '12 merged + 1 added while it was thinking');
});

test('with no concurrent write the outcome is unchanged', async () => {
  // Guard the other direction: the ordinary case must not gain a stray entry.
  seedMemories(20);
  app.get(`ollamaGenerate = function () { return Promise.resolve(JSON.stringify({ memories: Array.from({ length: 12 }, (_, i) => ({ rule: 'merged rule ' + i, example: '' })) })); }`);
  await app.get('maybeAutoConsolidate')();
  assert.equal(texts().length, 12, 'exactly the merged set');
});

test('a late arrival cannot be double-counted if it also appears in the merge', async () => {
  // The model is given the pre-await list, so it cannot legitimately return the late rule — but if a
  // future prompt change made that possible, carrying it forward must not duplicate it.
  // The merge must CLEAR THE FLOOR (min(18, half) — 10 for a 20-rule set), or the consolidation is
  // refused outright and the dedup never runs. A first version returned 2 rules, so this test passed
  // green with the dedup deleted: it was asserting on a consolidation that never applied.
  seedMemories(20);
  app.get(`ollamaGenerate = function () {
    return new Promise((resolve) => {
      config.ai.memories.push({ id: 'live-1', text: 'shared rule', example: '', ts: Date.now() });
      const out = [{ rule: 'shared rule', example: '' }];
      for (let i = 0; i < 11; i += 1) out.push({ rule: 'merged rule ' + i, example: '' });
      resolve(JSON.stringify({ memories: out }));
    });
  }`);
  await app.get('maybeAutoConsolidate')();
  assert.equal(texts().filter((x) => x === 'shared rule').length, 1, 'kept once, not twice');
});
