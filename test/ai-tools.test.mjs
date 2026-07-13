// The AI layer, finally under test.
//
// The harness had no `fetch` in its vm context, so every Ollama path threw ReferenceError the moment
// a test touched it — which is why none of the AI subsystem has ever had a single test. It does now,
// and a test can swap in its own transport, so this runs with no Ollama and no GPU.
//
// What's being established here is the basis of the redesign: the model should CHOOSE A TOOL, not
// reason its way to a JSON blob inside a 3,000-character prompt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let app; let calls;

before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

/** Swap the global fetch inside the vm for a recording stub. */
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

// Values that cross the vm boundary carry the SANDBOX's Object.prototype, so deepStrictEqual fails
// on prototype identity even when the structure is identical. Compare by value.
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

// --- capability detection ------------------------------------------------------------------

test('a tool-capable model is detected from Ollama\'s own capabilities', async () => {
  // /api/show already returns `capabilities: ["completion","tools","vision"]`, and ollamaModelVision
  // ALREADY parsed that array — it just only ever tested for 'vision'. The information was sitting
  // right there.
  stubOllama(() => ({ json: { capabilities: ['completion', 'tools', 'thinking'] } }));
  assert.equal(await app.get('ollamaModelTools')('qwen3:8b'), true);
  assert.equal(await app.get('ollamaModelVision')('qwen3:8b'), false);
});

test('a vision-only model is NOT treated as tool-capable', async () => {
  // qwen2.5vl:7b — the model this app falls back to for text tasks by default — reports
  // ["completion","vision"]. It cannot call tools. Pretending otherwise would just get prose back.
  stubOllama(() => ({ json: { capabilities: ['completion', 'vision'] } }));
  assert.equal(await app.get('ollamaModelTools')('qwen2.5vl:7b'), false);
  assert.equal(await app.get('ollamaModelVision')('qwen2.5vl:7b'), true);
});

test('when Ollama can\'t tell us, we never GUESS a model into tool mode', async () => {
  // A model that can't call tools, asked to, just returns prose — and then every downstream
  // assumption breaks. Vision has a name heuristic to fall back on; tools must not.
  stubOllama(() => ({ ok: false, status: 500, json: {} }));
  assert.equal(await app.get('ollamaModelTools')('mystery-model'), false);
});

test('capabilities are cached — /api/show is not asked once per clip', async () => {
  stubOllama(() => ({ json: { capabilities: ['completion', 'tools'] } }));
  await app.get('ollamaModelTools')('cache-me:1b');
  await app.get('ollamaModelTools')('cache-me:1b');
  await app.get('ollamaModelVision')('cache-me:1b');
  assert.equal(calls.length, 1, 'one /api/show for three questions about the same model');
});

// --- the chat/tools transport ----------------------------------------------------------------

test('ollamaChat posts to /api/chat WITH the tools, and returns the chosen call', async () => {
  stubOllama(() => ({ json: {
    message: { content: '', tool_calls: [{ function: { name: 'file_into_project', arguments: { project: 'Alps 2026' } } }] },
  } }));

  const tools = [{ type: 'function', function: { name: 'file_into_project', description: 'x', parameters: {} } }];
  const r = await app.get('ollamaChat')('qwen3:8b', [{ role: 'user', content: 'a snowy ridge' }], { tools });

  assert.equal(calls[0].url.endsWith('/api/chat'), true, 'the CHAT endpoint — not /api/generate');
  assert.deepEqual(plain(calls[0].body.tools), plain(tools), 'the tools go with the request');
  assert.equal(calls[0].body.think, false, 'thinking is off — for tool selection the choice IS the answer');
  assert.deepEqual(plain(r.toolCalls), [{ name: 'file_into_project', args: { project: 'Alps 2026' } }]);
});

test('a model that emits its arguments as a JSON STRING is handled', async () => {
  // Ollama normally hands back a parsed object, but some models emit a string. Take both, or the
  // redesign breaks on a model swap in a way that looks like the model "not understanding".
  stubOllama(() => ({ json: {
    message: { tool_calls: [{ function: { name: 'create_project', arguments: '{"name":"Garden Reno"}' } }] },
  } }));
  const r = await app.get('ollamaChat')('qwen3:8b', [], { tools: [] });
  assert.deepEqual(plain(r.toolCalls), [{ name: 'create_project', args: { name: 'Garden Reno' } }]);
});

test('garbage arguments degrade to {} rather than throwing', async () => {
  stubOllama(() => ({ json: {
    message: { tool_calls: [{ function: { name: 'ask_user', arguments: 'not json at all' } }] },
  } }));
  const r = await app.get('ollamaChat')('qwen3:8b', [], { tools: [] });
  assert.deepEqual(plain(r.toolCalls), [{ name: 'ask_user', args: {} }]);
});

test('NO tool call is reported honestly — it is a signal, not an error', async () => {
  // A model answering in prose when it was given tools usually means "I don't know". The old
  // parseJsonLoose could never express that: it always returned an object, so a total failure was
  // indistinguishable from an empty answer.
  stubOllama(() => ({ json: { message: { content: 'I am not sure which project this belongs to.' } } }));
  const r = await app.get('ollamaChat')('qwen3:8b', [], { tools: [] });
  assert.deepEqual(plain(r.toolCalls), []);
  assert.match(r.content, /not sure/);
});

test('<think> blocks are stripped from the content', async () => {
  stubOllama(() => ({ json: { message: { content: '<think>hmm, a lawn…</think>Garden Reno' } } }));
  const r = await app.get('ollamaChat')('qwen3:8b', [], {});
  assert.equal(r.content, 'Garden Reno');
});

test('an Ollama error surfaces its real reason, not a bare HTTP code', async () => {
  stubOllama(() => ({ ok: false, status: 500, json: { error: 'llama-server terminated: cudaMalloc failed: out of memory' } }));
  await assert.rejects(
    () => app.get('ollamaChat')('qwen3:8b', [], {}),
    /out of memory/,
    'the actual cause — this is exactly what a GPU that already has a vision model loaded says',
  );
});

// --- A DATED FOLDER IS THE HOME OF THAT SHOOT, AND NO OTHER -------------------------------------
//
// MEASURED ON HIS REAL TREE, with the real qwen3:8b. Some of his project folders ARE shoots — he names
// them exactly like clips: `2026-05-30_vlog_water-park_v1`, `2026-06-11_vlog_footage-from-gopros_v1`.
// Which means the folder name contains the SUBJECT word `vlog`, so every vlog shoot he ever films
// matches it lexically, forever.
//
// A wedding for a NEW client got filed into `2026 - Personal/2026-06-11_vlog_footage-from-gopros_v1`
// — three runs out of three. The search returned it as a hit and the model trusts hits. It was never
// a hit; it was a word collision. Better prompting could not fix that: the TOOL was handing the model
// a wrong answer and calling it a match.
//
// The rule his tree actually encodes:
//   dateless (`Gourgess Lawns`, `Calisthetics Journey`) → an ONGOING project; new shoots welcome
//   dated    (`2026-05-30_vlog_water-park_v1`)          → the home of THAT shoot, and no other
//
// With this in, the same three cases go 3/3: lawn-mowing → Gourgess Lawns, calisthenics →
// Calisthetics Journey, and the wedding → ask_user instead of a wrong folder.

test('an ongoing project (no date in its name) accepts new shoots', () => {
  const f = app.get('folderIsOtherShoot');
  assert.equal(f('2026 - Client Work/Gourgess Lawns', '2026-07-20'), false);
  assert.equal(f('2026 - Social Media/Calisthetics Journey', '2026-07-20'), false);
});

test("a folder named after ANOTHER shoot is not a home for this one", () => {
  const f = app.get('folderIsOtherShoot');
  assert.equal(f('2026 - Social Media/2026-05-30_vlog_water-park_v1', '2026-07-22'), true);
  assert.equal(f('2026 - Personal/2026-06-11_vlog_footage-from-gopros_v1', '2026-07-22'), true);
});

test("…but a folder named after THIS shoot obviously is", () => {
  // Re-running organize on a shoot already filed must land in the same place, not refuse it.
  const f = app.get('folderIsOtherShoot');
  assert.equal(f('2026 - Social Media/2026-05-30_vlog_water-park_v1', '2026-05-30'), false);
});

test('the date is only read from the LEAF, not from a dated parent', () => {
  // `2026 - Client Work` contains no date, but a parent like `Archive/2024-01-01/Gourgess Lawns` must
  // not disqualify an ongoing project because of its ancestor.
  const f = app.get('folderIsOtherShoot');
  assert.equal(f('2024-01-01 Archive/Gourgess Lawns', '2026-07-20'), false);
});

test('with no shoot date at all, nothing is excluded — we do not filter on ignorance', () => {
  const f = app.get('folderIsOtherShoot');
  assert.equal(f('2026 - Social Media/2026-05-30_vlog_water-park_v1', ''), true,
    'a dated folder still is not a general-purpose home');
  assert.equal(f('2026 - Client Work/Gourgess Lawns', ''), false, 'and an ongoing project still is');
});

test('search_projects actually applies it', () => {
  const src = readFileSync(join(ROOT, 'main-mod', '10-ai-tools.js'), 'utf8');
  const fn = src.slice(src.indexOf("defineTool('search_projects'"));
  assert.match(fn.slice(0, 3000), /\.filter\(\(c\) => !folderIsOtherShoot\(c\.path, ctx\.date\)\)/);
});
