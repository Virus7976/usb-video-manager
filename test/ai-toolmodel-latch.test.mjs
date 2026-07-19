// The "No reasoning model" warning that would NOT go away.
//
// His real config is correct: ai.textModel = 'qwen3:8b', which Ollama reports as
// capabilities ['completion','tools','thinking'] — a genuinely tool-capable model.
// Yet the home screen showed the red "No reasoning model · Get qwen3:8b" card.
//
// The cause was a latch in ollamaCapabilities(): it caches whatever it computed,
// INCLUDING the `null` it returns when it simply couldn't tell (a /api/show that
// threw or came back non-ok). renderAiHealth() runs at app boot — the one moment
// Ollama is most likely still warming up — so a single transient failure there
// cached qwen3:8b as "capabilities unknown" for the WHOLE session. ollamaModelTools()
// treats unknown as false (never guess a model into tool mode), so aiToolModel()
// returned '' forever after, and the warning stuck even once Ollama was up.
//
// The fix: never cache the null sentinel. A transient failure must re-probe next time.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const CAPS = {
  'qwen2.5vl:7b': ['completion', 'vision'],
  'qwen3:8b': ['completion', 'tools', 'thinking'],
};

/**
 * Ollama transport where the FIRST /api/show call fails (as if Ollama were still
 * warming at boot), and every call after that succeeds. `fail.n` counts show calls.
 */
function stubOllamaFlaky(installed, caps) {
  const state = { showCalls: 0, failFirstShow: true };
  app.get('globalThis').fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return { ok: true, status: 200, json: async () => ({ models: installed.map((n) => ({ name: n })) }) };
    }
    if (u.endsWith('/api/show')) {
      state.showCalls += 1;
      if (state.failFirstShow && state.showCalls === 1) throw new Error('ECONNREFUSED (Ollama still starting)');
      const m = JSON.parse(init.body).model;
      return { ok: true, status: 200, json: async () => ({ capabilities: caps[m] || ['completion'] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return state;
}

beforeEach(() => {
  const cfg = app.get('config');
  // His real, correct config: a tool-capable reasoning model IS chosen.
  cfg.ai = { enabled: true, model: 'qwen2.5vl:7b', textModel: 'qwen3:8b', styleExamples: ['x'], memories: [] };
  cfg.projectsRoot = 'L:/proj';
  cfg.finalizeSource = 'L:/comp';
  cfg.intakeFolder = '';
  cfg.placementMemory = [];
});

test('a transient /api/show failure at boot does NOT latch "No reasoning model"', async () => {
  const state = stubOllamaFlaky(['qwen2.5vl:7b', 'qwen3:8b'], CAPS);

  // Boot render: Ollama is still warming, the first show throws. It is fine for the
  // warning to appear right now — Ollama genuinely isn't answering yet.
  const first = await app.invoke('ai:health');
  assert.ok(first.problems.map((p) => p.id).includes('no-tool-model'),
    'while Ollama is down, warning IS expected');

  // Ollama is up now. A later render (after a fix-click, drive detect, etc.) must
  // re-probe and clear the warning — not serve a cached "unknown" from the boot blip.
  const second = await app.invoke('ai:health');
  assert.equal(second.toolModel, 'qwen3:8b', 'qwen3:8b must be recognised once Ollama answers');
  assert.equal(second.problems.map((p) => p.id).includes('no-tool-model'), false,
    'the "No reasoning model" warning must clear once Ollama is up');
  assert.ok(state.showCalls >= 2, 'it must have re-probed /api/show, not reused the cached null');
});
