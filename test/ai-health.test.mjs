// AI health — the four things that were silently wrong in the REAL config on this machine:
//
//   ai.model      = 'llava-llama3'   → measured hallucinating whole objects on his own footage
//   ai.textModel  = ''               → so EVERY text task ran on that vision model, which cannot
//                                      call tools at all
//   styleExamples = 0                → while 310 clips he had named himself sat on disk, unread
//   projectsRoot  = ''               → there was NOWHERE to file to, which is the real reason
//                                      "organize sucks" — and nothing ever said so
//
// Not one appeared anywhere in the UI. The app just quietly did its worst and looked stupid.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Values crossing the vm boundary carry the SANDBOX's prototypes, so deepStrictEqual fails on
// identity even when the structure matches. Compare by value.
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
let app;

before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

/** `installed` is what Ollama reports; `caps` maps model -> capabilities. */
function stubOllama(installed, caps) {
  app.get('globalThis').fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: installed.map((n) => ({ name: n })) }) };
    if (u.endsWith('/api/show')) {
      const m = JSON.parse(init.body).model;
      return { ok: true, status: 200, json: async () => ({ capabilities: caps[m] || ['completion'] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const CAPS = {
  'llava-llama3:latest': ['completion', 'vision'],
  'qwen2.5vl:7b': ['completion', 'vision'],
  'qwen3:8b': ['completion', 'tools', 'thinking'],
};

beforeEach(() => {
  const cfg = app.get('config');
  cfg.ai = { enabled: true, model: '', textModel: '', memories: [], styleExamples: [] };
  cfg.projectsRoot = '';
  cfg.finalizeSource = '';
  cfg.intakeFolder = '';
  cfg.placementMemory = [];
});

test('HIS EXACT CONFIG reports all four problems', async () => {
  const cfg = app.get('config');
  cfg.ai = { enabled: true, model: 'llava-llama3:latest', textModel: '', styleExamples: [], memories: [] };
  cfg.finalizeSource = 'L:/Videos/02 - Projects/Compression/02 - Compressed';
  cfg.projectsRoot = '';
  stubOllama(['llava-llama3:latest', 'qwen2.5vl:7b', 'qwen3:8b'], CAPS);

  const h = await app.invoke('ai:health');
  const ids = h.problems.map((p) => p.id);

  assert.ok(ids.includes('weak-vision'), 'the hallucinating vision model');
  assert.ok(ids.includes('no-style'), 'never learned his naming style');
  assert.ok(ids.includes('no-projects-root'), 'nowhere to file to');
  // The tool model is AUTO-FIXED (qwen3:8b is installed), so it is resolved rather than reported.
  assert.equal(ids.includes('no-tool-model'), false);
  assert.equal(h.toolModel, 'qwen3:8b', 'and it picked the tool-capable model for him');
});

test('the vision problem names what HIS model actually got wrong', async () => {
  // "A better model is available" is ignorable. "Yours invented a motorcycle" is not.
  const cfg = app.get('config');
  cfg.ai = { enabled: true, model: 'llava-llama3:latest', textModel: 'qwen3:8b', styleExamples: ['x'] };
  cfg.projectsRoot = 'L:/proj';
  stubOllama(['llava-llama3:latest', 'qwen2.5vl:7b', 'qwen3:8b'], CAPS);

  const h = await app.invoke('ai:health');
  const v = h.problems.find((p) => p.id === 'weak-vision');
  assert.ok(v);
  assert.equal(v.arg, 'qwen2.5vl:7b');
  assert.match(v.detail, /motorcycle/);
  assert.equal(v.severity, 'high');
  assert.equal(v.fix, 'useVision');
});

test('a healthy config reports NOTHING — it does not invent problems to look busy', async () => {
  const cfg = app.get('config');
  cfg.ai = { enabled: true, model: 'qwen2.5vl:7b', textModel: 'qwen3:8b', styleExamples: ['vlog / x'], memories: [] };
  cfg.projectsRoot = 'L:/Videos/Projects';
  cfg.finalizeSource = 'L:/Compressed';
  stubOllama(['qwen2.5vl:7b', 'qwen3:8b'], CAPS);

  const h = await app.invoke('ai:health');
  assert.deepEqual(plain(h.problems), [], `it reported: ${plain(h.problems).map((p) => p.id).join(', ')}`);
});

test('no tool-capable model installed → say so, with the fix', async () => {
  const cfg = app.get('config');
  cfg.ai = { enabled: true, model: 'qwen2.5vl:7b', textModel: '', styleExamples: ['x'] };
  cfg.projectsRoot = 'L:/p';
  stubOllama(['qwen2.5vl:7b', 'llava-llama3:latest'], CAPS);   // vision only — nothing can call tools

  const h = await app.invoke('ai:health');
  const p = h.problems.find((x) => x.id === 'no-tool-model');
  assert.ok(p);
  assert.equal(p.arg, 'qwen3:8b');
  assert.match(p.detail, /A vision model cannot/);
  assert.equal(h.toolModel, '', 'and it does NOT pretend a vision model will do');
});

test('switching the vision model actually persists', async () => {
  const cfg = app.get('config');
  cfg.ai = { model: 'llava-llama3:latest' };
  const r = await app.invoke('ai:useVisionModel', 'qwen2.5vl:7b');
  assert.equal(r.ok, true);
  assert.equal(cfg.ai.model, 'qwen2.5vl:7b');
});

test('the fallback list degrades to the BEST remaining model, not an arbitrary one', () => {
  // A fallback fires when a model fails to load. It used to take whatever Ollama listed first, so a
  // broken qwen2.5vl could silently demote him to llava — which hallucinates. A fallback should lose
  // as little as possible.
  const src = readFileSync(join(ROOT, 'main-mod', '06-copy-transfer.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function listVisionModels('));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /out\.sort\(\(a, b\) => visionRankOf\(a\) - visionRankOf\(b\)\)/);
});

// --- the card itself ---------------------------------------------------------------------

test('the card only appears when something IS wrong', () => {
  const core = readFileSync(join(ROOT, 'src', 'mod', '01-core.js'), 'utf8');
  const fn = core.slice(core.indexOf('async function renderAiHealth('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(!problems\.length\) \{ host\.classList\.add\('hidden'\)/, 'silent when healthy');
  assert.match(body, /if \(!aiCfg\.enabled\)/, 'and silent when AI is off entirely');
});

test('each problem has a ONE-CLICK fix — it does not just complain', () => {
  const core = readFileSync(join(ROOT, 'src', 'mod', '01-core.js'), 'utf8');
  const fn = core.slice(core.indexOf('async function applyAiHealthFix('));
  for (const fix of ['useVision', 'learn', 'pickProjects', 'pull']) {
    assert.ok(fn.includes(`p.fix === '${fix}'`), `${fix} is actually handled`);
  }
  assert.match(fn, /withBusyBtn\(card,/, 'and the button cannot strand itself — see the async-cleanup rule');
});

test('learning tells him about the fragmentation it found', () => {
  // He has lawn-mowing (68) AND lawnmowing (15). That is costing him right now, and he cannot fix
  // what he does not know about.
  const core = readFileSync(join(ROOT, 'src', 'mod', '01-core.js'), 'utf8');
  const fn = core.slice(core.indexOf('async function applyAiHealthFix('));
  assert.match(fn, /r\.duplicates \|\| \[\]/);
  assert.match(fn, /is really/, 'it names the duplicate');
  assert.match(fn, /won't create any more of those/, 'and says what it will do about it');
});
