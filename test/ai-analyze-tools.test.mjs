// Analyze now runs PERCEIVE → CHOOSE instead of one giant prompt.
//
// The old path handed a 7B VISION model three jobs in one call: look at the footage, reason about
// what to call it, and serialise that as JSON. It got one of the three wrong nearly every time —
// that is where "it's very gimmicky" came from. It invented subjects (`car-door`) because nothing
// stopped it, and it re-watched footage it had already seen.
//
// Now the vision model only LOOKS, and a tool-capable model NAMES by choosing from a schema-level
// enum of Jake's real subjects. These tests pin the parts that would silently rot:
//   - it must FALL BACK, never half-name, when the tool path can't run
//   - it must never run the tool path on a model that cannot call tools
//   - it must reuse a cached observation rather than re-watch the clip
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Pull a real top-level function out of the shipping source and run it with injected deps. */
function extractFn(relFile, name, injected = []) {
  const src = read(relFile);
  const start = src.indexOf(`async function ${name}(`) >= 0
    ? src.indexOf(`async function ${name}(`)
    : src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${relFile}`);

  // Walk the PARAMETER LIST out first. `aiNameWithTools(i, opts = {})` has a `{}` default, and
  // brace-matching from the first `{` would latch onto that and slice the body off mid-signature.
  let paren = 0; let bodyStart = -1;
  for (let i = src.indexOf('(', start); i < src.length; i += 1) {
    if (src[i] === '(') paren += 1;
    else if (src[i] === ')') { paren -= 1; if (paren === 0) { bodyStart = src.indexOf('{', i); break; } }
  }
  let depth = 0; let end = -1;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(...injected, `${src.slice(start, end)}; return ${name};`);
}

// #8: observations are reached through clipObsFor/noteClipObs now, so the extracted code needs them
// in scope. The fixtures carry no mtimeMs, so clipKeyV2 falls back to the legacy key and the stubs
// below address the same entries they always did.
const DEPS = ['state', 'aiToolModelReady', 'aiToolModelName', 'subjectsCache', 'clipObsCache', 'clipKey',
  'clipObsFor', 'noteClipObs',
  'markClipAnalyzing', 'aiCallGuard', 'window', 'aiCfg', 'runContext'];

/** Build aiNameWithTools with a controllable world around it. Returns the fn + a call log. */
function build({ toolReady = true, subjects = ['lawn-mowing', 'skiing'], obsCache = {}, api = {} } = {}) {
  const calls = [];
  const clip = { name: 'GX010042.MP4', size: 1234, sourcePath: 'E:/DCIM/GX010042.MP4', people: ['Jake'] };
  const state = { scannedFiles: [clip] };
  const fullApi = {
    aiUseOnly: async (m) => { calls.push(['useOnly', m]); return { ok: true, freed: [] }; },
    aiPerceive: async (p) => { calls.push(['perceive', p]); return { ok: true, observation: 'A man mows a lawn.' }; },
    aiNameFromObservation: async (p) => { calls.push(['name', p]); return { ok: true, subject: 'lawn-mowing', description: 'front yard pass', tags: ['lawn'] }; },
    saveClipObs: async (p) => { calls.push(['saveObs', p]); return { ok: true }; },
    ...api,
  };
  const fn = extractFn('src/mod/04-tasks-ai.js', 'aiNameWithTools', DEPS)(
    state, toolReady, 'qwen3:8b', subjects, obsCache,
    (c) => `${c.name}__${c.size}`,
    (c) => obsCache[`${c.name}__${c.size}`],                                   // clipObsFor (#8)
    (c, obs) => { obsCache[`${c.name}__${c.size}`] = { obs, ts: 0 }; fullApi.saveClipObs({ key: `${c.name}__${c.size}`, obs }); },  // noteClipObs (#8)
    () => {},                       // markClipAnalyzing — DOM, not under test
    (p) => p,                       // aiCallGuard — passthrough
    { api: fullApi },
    { model: 'qwen2.5vl:7b' },
    () => 'ski trip',               // runContext
  );
  return { fn, calls, clip };
}

test('the happy path: vision LOOKS, then the tool model CHOOSES', async () => {
  const { fn, calls, clip } = build();
  const r = await fn(0, {});

  assert.equal(r.ok, true);
  assert.equal(r.subject, 'lawn-mowing');
  assert.equal(r.description, 'front yard pass');
  assert.equal(r.observation, 'A man mows a lawn.');

  // ONE MODEL IN VRAM AT A TIME. Each model is claimed exclusively before it is used — the vision
  // model to look, then the reasoning model to name. On a single-GPU / older machine, loading the
  // second on top of the first is `cudaMalloc failed: out of memory`.
  assert.deepEqual(calls.map((c) => c[0]), ['useOnly', 'perceive', 'saveObs', 'useOnly', 'name']);
  assert.deepEqual(calls.filter((c) => c[0] === 'useOnly').map((c) => c[1]),
    ['qwen2.5vl:7b', 'qwen3:8b'], 'vision first, then the reasoning model — never both');

  // The namer must be handed the real subject list — that list becomes the schema enum in main, and
  // it is the ONLY thing that makes inventing `car-door` impossible.
  const nameArgs = calls.find((c) => c[0] === 'name')[1];
  assert.deepEqual(nameArgs.subjects, ['lawn-mowing', 'skiing']);
  assert.equal(nameArgs.observation, 'A man mows a lawn.');
  assert.deepEqual(nameArgs.people, ['Jake']);
  assert.equal(nameArgs.context, 'ski trip');

  // …and the observation is written through, so a resumed session never re-watches this clip.
  assert.equal(clip.observation, 'A man mows a lawn.');
});

test('NO tool-capable model → returns null so analyze falls back; it never guesses', async () => {
  const { fn, calls } = build({ toolReady: false });
  assert.equal(await fn(0, {}), null);
  assert.deepEqual(calls, [], 'and it does not waste a vision pass on a path it cannot finish');
});

test('no known subjects → returns null; an enum of nothing constrains nothing', async () => {
  const { fn, calls } = build({ subjects: [] });
  assert.equal(await fn(0, {}), null);
  assert.deepEqual(calls, []);
});

test('a cached observation is REUSED — re-watching footage is the most expensive thing it can do', async () => {
  const { fn, calls } = build({ obsCache: { 'GX010042.MP4__1234': { obs: 'Seen before: a lawn.', ts: 1 } } });
  const r = await fn(0, {});

  assert.equal(r.observation, 'Seen before: a lawn.');
  assert.equal(calls.some((c) => c[0] === 'perceive'), false, 'the vision model must NOT run again');
  assert.equal(calls.find((c) => c[0] === 'name')[1].observation, 'Seen before: a lawn.');
});

test('an explicit observation (a re-run with user hints) beats the cache', async () => {
  const { fn, calls } = build({ obsCache: { 'GX010042.MP4__1234': { obs: 'stale', ts: 1 } } });
  const r = await fn(0, { observation: 'Actually this is my ski trip.' });
  assert.equal(r.observation, 'Actually this is my ski trip.');
  assert.equal(calls.some((c) => c[0] === 'perceive'), false);
});

test('vision fails → null (fall back), NOT a name invented from no observation at all', async () => {
  const { fn, calls } = build({ api: { aiPerceive: async () => ({ ok: false }) } });
  assert.equal(await fn(0, {}), null);
  assert.equal(calls.some((c) => c[0] === 'name'), false, 'it must not name a clip it never saw');
});

test('the tool loop returning no subject → null, rather than a half-filled name', async () => {
  const { fn } = build({ api: { aiNameFromObservation: async () => ({ ok: true, subject: '' }) } });
  assert.equal(await fn(0, {}), null);
});

test('a THROW in the tool loop degrades to the old path instead of killing the run', async () => {
  const { fn } = build({ api: { aiNameFromObservation: async () => { throw new Error('ollama died'); } } });
  assert.equal(await fn(0, {}), null);   // a rejection here would abort the whole analyze sweep
});

// --- the wiring, which no unit test can see -------------------------------------------------

test('aiSuggestClip tries the tool path BEFORE the old giant-prompt path', () => {
  const src = read('src/mod/04-tasks-ai.js');
  const fn = src.slice(src.indexOf('async function aiSuggestClip('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const tool = body.indexOf('aiNameWithTools(');
  const old = body.indexOf('window.api.aiSuggest(');
  assert.ok(tool > 0 && old > 0, 'both paths still exist');
  assert.ok(tool < old, 'the tool path must be attempted first');
  assert.match(body, /if \(toolResult\) return toolResult;/, 'and the old path is the fallback, not dead code');
});

test('tool readiness is latched BEFORE the healthy-config early return', () => {
  // The bug I nearly shipped: renderAiHealth returns early when there are no problems — which is
  // exactly the config where a tool model EXISTS. Latching after that return would mean the tool
  // path only ever switched on for a BROKEN setup.
  const src = read('src/mod/01-core.js');
  const fn = src.slice(src.indexOf('async function renderAiHealth('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const latch = body.indexOf('aiToolModelReady =');
  const bail = body.indexOf('if (!problems.length)');
  assert.ok(latch > 0, 'renderAiHealth latches the flag');
  assert.ok(latch < bail, 'and it does so BEFORE the no-problems early return');
});

// --- THE RESOURCE POLICY: one model at a time, and give the GPU back ---------------------------
//
// "The computer can't run 2 AI models at once. It needs to work in batches." — and: "don't be a
// resource hog really" / "build this to work on older computers but still work good".
//
// Older machines are the constraint, not the exception. A 6-8 GB card fits ONE 7-8B model. Three
// rules make that work, and all three are easy to silently undo later:

test('a BATCH never perceives inside the naming step — that would swap VRAM per clip', async () => {
  // The worst thing the app could do: load vision, load reasoning, load vision, … once PER CLIP.
  // The batch loop always supplies an observation; noPerceive makes that a rule the code enforces.
  const { fn, calls } = build();
  assert.equal(await fn(0, { noPerceive: true }), null, 'it bails rather than reloading the vision model');
  assert.deepEqual(calls, [], 'no vision load, no tool load — nothing');
});

test('the run loop batches whenever a separate tool model exists — the checkbox gets no say', () => {
  // multiPass was an opt-in quality setting and it was OFF by default, so the default install ran the
  // swap-per-clip path. With a distinct reasoning model, batching is not a preference — it is the
  // only correct way to run.
  const src = read('src/mod/04-tasks-ai.js');
  assert.match(src, /const batched = aiCfg\.multiPass \|\| aiToolModelReady;/);
  assert.match(src, /if \(batched\) \{/);
});

test('phase 2 EVICTS the vision model before the reasoning model loads', () => {
  // The load-bearing line. Batching separates the phases in TIME; only this separates them in MEMORY.
  // Ollama holds a model for 5 minutes after its last request, so without this the vision model is
  // still resident when the 8B loads — and the second load OOMs on exactly the machines we care about.
  const src = read('src/mod/04-tasks-ai.js');
  const p2 = src.slice(src.indexOf('// PHASE 2'), src.indexOf('// PHASE 2') + 2600);
  assert.match(p2, /await window\.api\.aiUseOnly\(/, 'phase 2 claims its model exclusively');
  assert.match(p2, /noPerceive: true/, 'and cannot fall back into a vision load mid-phase');

  const p1 = src.slice(src.indexOf('// PHASE 1'), src.indexOf('// PHASE 2'));
  assert.match(p1, /await window\.api\.aiUseOnly\(aiCfg\.model\)/, 'phase 1 claims the vision model');
});

test('EVERY path that ends AI work hands the GPU back — including when cancelled', () => {
  // Ollama's 5-minute keep_alive meant a finished run sat on 5+ GB while the user went off to edit
  // video. There are THREE functions that end AI work, not one; missing any of them leaks the card.
  // The release sits after clearTask, which the abort `break`s also fall through to.
  const src = read('src/mod/04-tasks-ai.js');
  for (const fnName of ['aiAnalyzeSelected', 'aiImproveSelected', 'aiAutoEnhance']) {
    const at = src.indexOf(`async function ${fnName}(`);
    assert.ok(at > 0, `${fnName} exists`);
    const next = src.indexOf('\nasync function ', at + 10);
    const body = src.slice(at, next > 0 ? next : src.length);
    assert.match(body, /releaseGpu\(\)/, `${fnName} releases the VRAM when it finishes`);
  }
  const rel = src.slice(src.indexOf('async function releaseGpu('));
  assert.match(rel.slice(0, 300), /try \{ await window\.api\.aiRelease\(\); \} catch/,
    'best-effort — failing to unload never fails a run that otherwise worked');
});

test('residency is driven by what is ACTUALLY loaded, not by our own bookkeeping', () => {
  // Another app, an earlier run, or an `ollama run` in a terminal can load a model behind our back.
  // Bookkeeping would say "nothing loaded" while the GPU is full. Ask Ollama.
  const src = read('main-mod/06-copy-transfer.js');
  const useOnly = src.slice(src.indexOf('async function ollamaUseOnly('));
  assert.match(useOnly.slice(0, 600), /await ollamaLoaded\(\)/, 'reads real state from /api/ps');
  assert.match(useOnly.slice(0, 600), /await ollamaUnload\(m\.name\)/, 'and evicts everything else');

  const loaded = src.slice(src.indexOf('async function ollamaLoaded('));
  assert.match(loaded.slice(0, 400), /\/api\/ps/);

  const unload = src.slice(src.indexOf('async function ollamaUnload('));
  assert.match(unload.slice(0, 600), /keep_alive: 0/, 'keep_alive:0 is what actually evicts a model');
});

test('an unload is VERIFIED against /api/ps, never assumed from a 200', () => {
  // Measured on the real GPU (RTX 3060, 6 GB): one keep_alive:0 to /api/generate evicts both
  // generate-loaded and chat-loaded models within ~1s, so the happy path is a single call. This
  // verification is deliberate belt-and-braces, not a fix for an observed failure: an unload we only
  // BELIEVE happened is the one failure that silently breaks everything downstream — the next model
  // loads on top of it and OOMs on a card this size — and /api/ps costs nothing to check.
  const src = read('main-mod/06-copy-transfer.js');
  const unload = src.slice(src.indexOf('async function ollamaUnload('));
  const body = unload.slice(0, unload.indexOf('\n}\n'));
  assert.match(body, /isResident/, 'it checks whether the model actually left');
  assert.match(body, /\['\/api\/generate', \{\}\], \['\/api\/chat', \{ messages: \[\] \}\]/, 'and escalates');
  assert.match(body, /stillResident: true/, 'and reports honestly when a model will not budge');
});

test('a model that refuses to unload is REPORTED, not swallowed', () => {
  // Returning a cheerful ok:true over a GPU that is still full is how the next load OOMs.
  const src = read('main-mod/06-copy-transfer.js');
  for (const fn of ['ollamaUseOnly', 'ollamaReleaseAll']) {
    const body = src.slice(src.indexOf(`async function ${fn}(`));
    assert.match(body.slice(0, body.indexOf('\n}\n')), /stuck/, `${fn} surfaces a stuck model`);
  }
});
