// num_ctx sizing — the bug that silently dropped 3,744 clips in ONE run.
//
// ollamaGenerate set body.options = { temperature } and NOTHING else, so every
// call went out at Ollama's default context window of 4096 tokens. Current Ollama
// builds no longer truncate an over-long prompt; they return HTTP 400
// `exceed_context_size_error`. Our prompts routinely run 5–6k tokens (injected
// memories + style examples + shoot digest), so the batch analyze failed on
// thousands of clips at once with "request (5337 tokens) exceeds the available
// context size (4096 tokens)".
//
// The fix sizes num_ctx to the prompt, clamped to config.ai.numCtxMax. These tests
// pin that: small prompts stay at 4096, big prompts grow, a fixed override wins,
// and the window never exceeds the cap.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

/** Stub fetch to capture the request body sent to /api/generate. */
function captureGenerate() {
  const sent = [];
  app.get('globalThis').fetch = async (url, init) => {
    if (String(url).endsWith('/api/generate')) {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ response: '{}' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return sent;
}

beforeEach(() => {
  const cfg = app.get('config');
  cfg.ai = { enabled: true, endpoint: 'http://localhost:11434', numCtxMax: 8192, numCtx: 0 };
});

test('a small prompt keeps the floor (4096)', async () => {
  const sent = captureGenerate();
  await app.call('ollamaGenerate', 'qwen3:8b', 'hello', {});
  assert.equal(sent[0].options.num_ctx, 4096);
});

test('a 5,337-token-class prompt grows past 4096 (the exact failure)', async () => {
  const sent = captureGenerate();
  // ~5,300 tokens ≈ ~18.5k chars at the app's ~3.5 chars/token estimate.
  const big = 'x'.repeat(18500);
  await app.call('ollamaGenerate', 'qwen3:8b', big, {});
  assert.ok(sent[0].options.num_ctx > 4096, `expected > 4096, got ${sent[0].options.num_ctx}`);
  assert.ok(sent[0].options.num_ctx >= 6144, `must actually fit the prompt, got ${sent[0].options.num_ctx}`);
});

test('the window never exceeds config.ai.numCtxMax', async () => {
  const sent = captureGenerate();
  const huge = 'x'.repeat(200000); // way past any cap
  await app.call('ollamaGenerate', 'qwen3:8b', huge, {});
  assert.equal(sent[0].options.num_ctx, 8192);
});

test('a fixed config.ai.numCtx pins every call', async () => {
  app.get('config').ai.numCtx = 6000;
  const sent = captureGenerate();
  await app.call('ollamaGenerate', 'qwen3:8b', 'hello', {});
  assert.equal(sent[0].options.num_ctx, 6000);
});

test('vision calls budget for their images on top of the prompt', async () => {
  const sent = captureGenerate();
  await app.call('ollamaGenerate', 'qwen2.5vl:7b', 'describe', { images: ['AAAA', 'BBBB'] });
  // No images: 'describe' alone would floor at 4096. Two images add budget.
  assert.ok(sent[0].options.num_ctx > 4096, `images must widen the window, got ${sent[0].options.num_ctx}`);
});
