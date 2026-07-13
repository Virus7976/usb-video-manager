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

const DEPS = ['state', 'aiToolModelReady', 'subjectsCache', 'clipObsCache', 'clipKey',
  'markClipAnalyzing', 'aiCallGuard', 'window', 'aiCfg', 'runContext'];

/** Build aiNameWithTools with a controllable world around it. Returns the fn + a call log. */
function build({ toolReady = true, subjects = ['lawn-mowing', 'skiing'], obsCache = {}, api = {} } = {}) {
  const calls = [];
  const clip = { name: 'GX010042.MP4', size: 1234, sourcePath: 'E:/DCIM/GX010042.MP4', people: ['Jake'] };
  const state = { scannedFiles: [clip] };
  const fullApi = {
    aiPerceive: async (p) => { calls.push(['perceive', p]); return { ok: true, observation: 'A man mows a lawn.' }; },
    aiNameFromObservation: async (p) => { calls.push(['name', p]); return { ok: true, subject: 'lawn-mowing', description: 'front yard pass', tags: ['lawn'] }; },
    saveClipObs: async (p) => { calls.push(['saveObs', p]); return { ok: true }; },
    ...api,
  };
  const fn = extractFn('src/mod/04-tasks-ai.js', 'aiNameWithTools', DEPS)(
    state, toolReady, subjects, obsCache,
    (c) => `${c.name}__${c.size}`,
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
  assert.deepEqual(calls.map((c) => c[0]), ['perceive', 'saveObs', 'name']);

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
