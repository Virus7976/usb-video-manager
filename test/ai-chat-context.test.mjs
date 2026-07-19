// Audit #21/#22 — two structural holes in the tool-calling transport.
//
// #21: `ollamaChat` sent `options: { temperature }` and nothing else, so the ENTIRE tool-calling
// brain ran at Ollama's 4096-token default — while `pickNumCtx()` sat right there, used by
// ollamaGenerate, existing precisely to prevent the `exceed_context_size_error` a long tool trace
// causes. The trace GROWS every step (each tool result is appended), so this fails late and
// mid-batch, which is the worst way for it to fail.
//
// #22: `runToolLoop` awaited `ollamaChat` with no try/catch, so one transient 400/500 threw straight
// out of the loop — despite the loop's own doc comment promising it degrades gracefully instead of
// "crashing the run". The designed behaviour is to fall back to asking the user.
//
// NOTE these are TRANSPORT-CONFIG and ERROR-HANDLING changes, not prompt or tool-string changes —
// §8's "tool strings are measured input" rule does not apply, and no re-measurement is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app; let calls;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

function stubOllama(respond) {
  calls = [];
  app.get('globalThis').fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    const r = respond(String(url), body);
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    };
  };
}

const chatOk = (content) => ({ json: { message: { content, tool_calls: [] } } });

test('#21 ollamaChat sends a num_ctx — not Ollama\'s 4096 default', async () => {
  stubOllama(() => chatOk('hi'));
  await app.call('ollamaChat', 'qwen3:8b', [{ role: 'user', content: 'hello' }], {});
  const body = calls[0].body;
  assert.ok(body.options, 'options are sent');
  assert.ok(Number(body.options.num_ctx) >= 4096, `num_ctx is set (got ${body.options.num_ctx})`);
  assert.equal(body.options.temperature, 0.2, 'temperature still defaults as before');
});

test('#21 a long conversation asks for MORE context than a short one', async () => {
  // The whole point: the tool trace grows every step, so the window has to grow with it.
  stubOllama(() => chatOk('hi'));
  await app.call('ollamaChat', 'm', [{ role: 'user', content: 'x' }], {});
  const small = calls[0].body.options.num_ctx;

  stubOllama(() => chatOk('hi'));
  await app.call('ollamaChat', 'm', [{ role: 'user', content: 'y'.repeat(60000) }], {});
  const big = calls[0].body.options.num_ctx;

  assert.ok(big > small, `a 60k-char trace asks for more than a 1-char one (${big} vs ${small})`);
});

test('#21 the TOOL SCHEMAS count toward the estimate', async () => {
  // Tools are sent in the same body and consume the same window. Estimating from messages alone
  // under-counts exactly when a big toolset is in play.
  const tools = [{ type: 'function', function: { name: 'search_projects', description: 'x'.repeat(60000), parameters: {} } }];
  stubOllama(() => chatOk('hi'));
  await app.call('ollamaChat', 'm', [{ role: 'user', content: 'x' }], {});
  const without = calls[0].body.options.num_ctx;

  stubOllama(() => chatOk('hi'));
  await app.call('ollamaChat', 'm', [{ role: 'user', content: 'x' }], { tools });
  const with_ = calls[0].body.options.num_ctx;

  assert.ok(with_ > without, `a fat toolset raises the estimate (${with_} vs ${without})`);
});

test('#21 an explicit num_ctx override wins, but stays under the configured cap', async () => {
  // pickNumCtx clamps to config.ai.numCtxMax (default 8192) on purpose — an override that exceeds
  // what the GPU can hold would OOM, and this box has one 6 GB card (usb-app-single-gpu-rule).
  stubOllama(() => chatOk('hi'));
  await app.call('ollamaChat', 'm', [{ role: 'user', content: 'x' }], { num_ctx: 6144 });
  assert.equal(calls[0].body.options.num_ctx, 6144, 'an in-range override is honoured verbatim');

  stubOllama(() => chatOk('hi'));
  await app.call('ollamaChat', 'm', [{ role: 'user', content: 'x' }], { num_ctx: 999999 });
  assert.equal(calls[0].body.options.num_ctx, 8192, 'and an absurd one is clamped to the cap');
});

test('#22 a transport failure degrades to ask_user, it does not throw', async () => {
  // One transient 500 used to abort the whole loop as a hard failure, taking the batch with it.
  stubOllama(() => ({ ok: false, status: 500, json: { error: 'internal' } }));
  const r = app.plain(await app.call('runToolLoop', {
    model: 'm', system: 's', user: 'u', tools: ['ask_user'], maxSteps: 2,
  }));
  assert.equal(r.ok, false, 'it reports failure');
  assert.match(String(r.reason), /transport|chat|error/i, `a transport reason, not a crash (got ${r.reason})`);
});

test('#22 a transport failure on a LATER step keeps the work already done', async () => {
  // The trace is the evidence of what the model already established. Throwing it away on a
  // late transient error is what made one blip cost a whole clip's reasoning.
  let n = 0;
  stubOllama(() => {
    n += 1;
    if (n === 1) return { json: { message: { content: '', tool_calls: [{ function: { name: 'nope_not_a_tool', arguments: {} } }] } } };
    return { ok: false, status: 400, json: { error: 'exceed_context_size_error' } };
  });
  const r = app.plain(await app.call('runToolLoop', {
    model: 'm', system: 's', user: 'u', tools: ['ask_user'], maxSteps: 4,
  }));
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.trace) && r.trace.length >= 1, 'the trace so far is returned, not discarded');
});
