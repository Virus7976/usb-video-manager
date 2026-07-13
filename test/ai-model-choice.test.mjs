// Which model runs which task. This one line was most of "the AI feels gimmicky":
//
//     function aiTextModel() { return config.ai.textModel || config.ai.model || ''; }
//
// `textModel` defaults to '' (the picker's placeholder literally reads "(use vision model)"), so out
// of the box EVERY text task in the app — project placement, rule distillation, memory
// consolidation, the reasoning passes of multi-pass — silently ran on the VISION model. A vision
// model is weak at instruction-following, weak at JSON, and cannot call tools at all. The app even
// knew something was wrong and papered over it: ai:improve sends the contact sheet on a TEXT-only
// task because "many vision models fail or stall on a TEXT-ONLY generate".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let app;

before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

/** Stub Ollama: `installed` is what /api/tags reports, `caps` maps model -> capabilities. */
function stubOllama(installed, caps) {
  app.get('globalThis').fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) {
      return { ok: true, status: 200, json: async () => ({ models: installed.map((n) => ({ name: n })) }) };
    }
    if (u.endsWith('/api/show')) {
      const m = JSON.parse(init.body).model;
      return { ok: true, status: 200, json: async () => ({ capabilities: caps[m] || ['completion'] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// Jake's actual machine.
const INSTALLED = ['qwen2.5vl:7b', 'qwen3:8b', 'llama3.2-vision:latest', 'llava-llama3:latest'];
const CAPS = {
  'qwen2.5vl:7b': ['completion', 'vision'],
  'qwen3:8b': ['completion', 'tools', 'thinking'],
  'llama3.2-vision:latest': ['tools', 'completion', 'vision'],
  'llava-llama3:latest': ['completion', 'vision'],
};

test('aiTextModel no longer silently falls back to the vision model', () => {
  const cfg = app.get('config');
  cfg.ai = { model: 'qwen2.5vl:7b', textModel: '' };
  assert.equal(app.get('aiTextModel')(), '', 'no text model configured means NO text model — not "use the vision one"');

  cfg.ai.textModel = 'qwen3:8b';
  assert.equal(app.get('aiTextModel')(), 'qwen3:8b');
});

test('a tool model is auto-picked from what is actually installed', async () => {
  // The user almost certainly has a tool-capable model already and simply never opened the picker.
  const cfg = app.get('config');
  cfg.ai = { model: 'qwen2.5vl:7b', textModel: '' };
  stubOllama(INSTALLED, CAPS);

  const picked = await app.get('aiToolModel')();
  assert.equal(picked, 'qwen3:8b', 'the preferred tool-capable reasoning model wins');
  assert.equal(cfg.ai.textModel, 'qwen3:8b', 'and it is PERSISTED — we do not re-probe every launch');
});

test('the vision model is never chosen as the tool model, even when it is the only "model" set', async () => {
  // The decisive property. qwen2.5vl is what `model` points at, and the old code would have handed
  // it every text task. It cannot call tools — it would just return prose, and every downstream
  // assumption would break in a way that looks like "the AI is being stupid".
  const cfg = app.get('config');
  cfg.ai = { model: 'qwen2.5vl:7b', textModel: '' };
  stubOllama(['qwen2.5vl:7b', 'llava-llama3:latest'], CAPS);   // ONLY vision models installed

  const picked = await app.get('aiToolModel')();
  assert.equal(picked, '', 'no tool-capable model installed → say so, do not pretend');
  assert.notEqual(picked, 'qwen2.5vl:7b');
});

test('an explicitly-chosen model that cannot call tools is rejected, not used', async () => {
  // If the user picks a vision model as their "reasoning" model, honouring that for TOOL work would
  // just produce prose. Refuse, rather than silently doing something that cannot work.
  const cfg = app.get('config');
  cfg.ai = { model: 'qwen3:8b', textModel: 'llava-llama3:latest' };
  stubOllama(INSTALLED, CAPS);
  assert.equal(await app.get('aiToolModel')(), '');
});

test('a tool-capable VISION model is acceptable — capability, not category, is what matters', async () => {
  const cfg = app.get('config');
  cfg.ai = { model: 'x', textModel: 'llama3.2-vision:latest' };   // reports tools AND vision
  stubOllama(INSTALLED, CAPS);
  assert.equal(await app.get('aiToolModel')(), 'llama3.2-vision:latest');
});

test('/api/tags has ONE owner now', () => {
  // It was being fetched and re-parsed in four separate places.
  const src = readFileSync(join(ROOT, 'main-mod', '06-copy-transfer.js'), 'utf8');
  assert.match(src, /async function ollamaListModels\(\)/);
});

test('the fallback that caused this is really gone', () => {
  const src = readFileSync(join(ROOT, 'main-mod', '06-copy-transfer.js'), 'utf8');
  const fn = src.slice(src.indexOf('function aiTextModel()'));
  const body = fn.slice(0, fn.indexOf('\n'));
  assert.equal(/config\.ai && config\.ai\.model/.test(body), false,
    'aiTextModel must not reach for the vision model');
});
