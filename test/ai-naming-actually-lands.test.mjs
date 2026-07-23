// ⚠⚠⚠ THE AI NAMED EVERY CLIP AND WROTE THE NAME NOWHERE.
//
// `aiSuggestClip` has two paths. The legacy one ends `return applyAiResult(i, res, mode)` — and
// `applyAiResult` is the ONLY place in the renderer where an AI answer is ever assigned to
// `clip.subject` / `clip.description` (04-tasks-ai.js:805, :814). The tool path, which became the
// default the moment a tool-capable text model was configured, ended:
//
//     const toolResult = await aiNameWithTools(i, opts);
//     if (toolResult) return toolResult;              // ← never went through applyAiResult
//
// The comment directly above the return in `aiNameWithTools` says the result is "shaped exactly like
// the old aiSuggest result, so applyAiResult and everything downstream is untouched". It was shaped
// correctly and then handed to nobody.
//
// WHAT IT COST, measured on his real store:
//     clip-observations.json   1084 clips WATCHED by the vision model
//       → matching draft named   331   (all observed 2026-07-05 … 07-15)
//       → matching draft BLANK   716   (all observed 2026-07-14 … 07-17)
// 331 is exactly the "331 of 4,594 named" figure the whole roadmap is built around. Naming produced
// no new names at all after the tool path became the default: the vision model still burned GPU on
// every clip and still saved the observation, and then the name was dropped on the floor. Every run
// reported those clips as named — and because `aiAlreadyAnalyzed()` needs a subject AND a
// description, none of them ever counted as done, so the next run re-watched all of them. Forever.
//
// ⚠⚠ WHY 36 GREEN TESTS MISSED IT — and the rule this file exists to enforce.
// `ai-analyze-tools.test.mjs` and `ai-naming-tools.test.mjs` are thorough about the tool path and
// every one of them asserts on the RETURNED VALUE (`r.subject`). Not one asserts the OUTCOME
// (`clip.subject`). The returned value was always perfect. That is PROMPT.md §8b-2 #4 exactly:
// a test that asserts the expression instead of the effect cannot see a result that goes nowhere.
//
// So every test below asserts on the CLIP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Pull a real top-level function out of the shipping source and run it with injected deps. */
function extractFn(relFile, name, injected = []) {
  const src = readSrc(relFile);
  const start = src.indexOf(`async function ${name}(`) >= 0
    ? src.indexOf(`async function ${name}(`)
    : src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${relFile}`);
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

const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Build the real `aiSuggestClip` around the REAL `applyAiResult`. Stubbing applyAiResult would
// re-create the exact blind spot this file exists to close: the bug is that the two are not
// connected, so the test has to use the genuine one and look at what it wrote.
function build({ toolResult = null, legacy = null, subjects = ['lawn-mowing'] } = {}) {
  const clip = { name: 'GX010042.MP4', sourcePath: 'E:/DCIM/GX010042.MP4', subject: '', description: '', tags: [] };
  const state = { scannedFiles: [clip] };
  const aiCfg = { model: 'llava', updateSubject: false, detectShot: false, suggestCategory: false };
  const subjectsCache = subjects;
  const fieldHistoryCache = {};
  const remembered = [];

  const applyAiResult = extractFn('src/mod/04-tasks-ai.js', 'applyAiResult', [
    'state', 'slug', 'matchKnownSubject', 'rememberSubject', 'rememberDescription',
    'renderClipTags', 'syncRowInputs', 'refreshNames', 'flashNamed', 'aiCfg', 'fieldHistoryCache',
  ])(
    state, slug,
    (s) => { for (const k of subjectsCache) if (slug(k) === slug(s)) return k; return ''; },
    (s) => remembered.push(s), () => {},
    () => {}, () => {}, () => {}, () => {}, aiCfg, fieldHistoryCache,
  );

  const toasts = [];
  const aiSuggestClip = extractFn('src/mod/04-tasks-ai.js', 'aiSuggestClip', [
    'state', 'aiReady', 'aiNameWithTools', 'window', 'aiCfg', 'subjectsCache', 'fieldHistoryCache',
    'runContext', 'canonicalSubject', 'applyAiResult', 'showToast', 'noteClipObs', 'clipObsFor',
  ])(
    state, () => true,
    async () => toolResult,
    { api: { aiSuggest: async () => legacy } },
    aiCfg, subjectsCache, fieldHistoryCache,
    () => ({}), async (s) => ({ ok: true, canonical: s, matched: false }),
    applyAiResult, (m) => toasts.push(m), () => {}, () => ({}),
  );
  return { aiSuggestClip, clip, toasts, remembered };
}

const TOOL_ANSWER = {
  ok: true, subject: 'lawn-mowing', description: 'front yard pass', shotType: '',
  tags: ['mowing', 'grass'], observation: 'A man mows a lawn.', category: '', newSubject: '',
};

test('⚠⚠⚠ the tool path WRITES THE NAME ONTO THE CLIP', async () => {
  // The whole bug in one assertion. Before the fix `r.ok` was true, `r.subject` was 'lawn-mowing',
  // and the clip was untouched — so the run reported "named 1 clip ✓" and named nothing.
  const { aiSuggestClip, clip } = build({ toolResult: TOOL_ANSWER });
  const r = await aiSuggestClip(0, 'all');

  assert.equal(r.ok, true, 'the call still succeeds');
  assert.equal(clip.subject, 'lawn-mowing', '⚠⚠ THE CLIP must carry the subject, not just the return value');
  assert.equal(clip.description, 'front-yard-pass', '⚠⚠ and the description');
});

test('⚠⚠ the tags the tool model chose reach the clip too', async () => {
  // Tags become XMP keywords on his files. Dropped silently by the same bypass.
  const { aiSuggestClip, clip } = build({ toolResult: TOOL_ANSWER });
  await aiSuggestClip(0, 'all');
  assert.deepEqual([...clip.tags].sort(), ['grass', 'mowing'], '⚠ AI keyword tags must land on the clip');
});

test('⚠⚠ a named clip counts as analyzed, so the next run does not re-watch it', async () => {
  // `aiAlreadyAnalyzed()` requires a subject AND a description. With neither ever written, all 1084
  // watched clips stayed "unanalyzed" and every run re-watched them — the single most expensive
  // thing the app can do, repeated indefinitely on a 6 GB card.
  const { aiSuggestClip, clip } = build({ toolResult: TOOL_ANSWER });
  await aiSuggestClip(0, 'all');
  assert.ok(clip.subject && clip.description,
    '⚠ both fields are required for a clip to ever count as done');
});

test('⚠ the subject is remembered, so his vocabulary grows from real runs', async () => {
  // `rememberSubject` feeds `config.subjects` — one of the sources the canonicaliser snaps onto.
  // A naming path that never lands also never teaches the vocabulary anything.
  const { aiSuggestClip, remembered } = build({ toolResult: TOOL_ANSWER });
  await aiSuggestClip(0, 'all');
  assert.ok(remembered.includes('lawn-mowing'), '⚠ the subject reaches rememberSubject');
});

test('⚠⚠ "start over" really replaces a subject he already had', async () => {
  // `applyAiResult` gates the subject on `startOver || aiCfg.updateSubject || !clip.subject`, and
  // his `ai.updateSubject` is FALSE. So routing through it is not merely "also assign" — the MODE
  // has to travel with it, or Analyze-with-start-over silently keeps the old subject.
  const { aiSuggestClip, clip } = build({ toolResult: { ...TOOL_ANSWER, subject: 'hedge-trimming' } });
  clip.subject = 'old-name';
  await aiSuggestClip(0, 'all');
  assert.equal(clip.subject, 'hedge-trimming', '⚠ mode "all" must reach applyAiResult, not just the result');
});

test('⚠⚠ "only fill what is empty" still does NOT overwrite his typing', async () => {
  // The other side of the same coin, and the one that would be unforgivable: routing the tool result
  // through applyAiResult must not become a licence to overwrite a name he typed himself.
  const { aiSuggestClip, clip } = build({ toolResult: { ...TOOL_ANSWER, subject: 'hedge-trimming' } });
  clip.subject = 'his-own-name';
  await aiSuggestClip(0, 'empty');
  assert.equal(clip.subject, 'his-own-name', '⚠⚠ mode "empty" must leave what he typed alone');
});

test('⚠ the legacy path still lands too — the fix must not swap one bypass for another', async () => {
  // Guards the obvious wrong fix: making the tool path work by changing applyAiResult's contract.
  const { aiSuggestClip, clip } = build({
    toolResult: null,
    legacy: { ok: true, subject: 'skiing', description: 'blue run', tags: [] },
  });
  await aiSuggestClip(0, 'all');
  assert.equal(clip.subject, 'skiing', '⚠ the non-tool path still writes to the clip');
});

test('⚠⚠ a tool path that declines still falls back rather than half-naming', async () => {
  // `aiNameWithTools` returns null when it cannot run. That must reach the legacy call, not return
  // a bare success — "fall back rather than half-name it" is the rule its own comment states.
  const { aiSuggestClip, clip } = build({
    toolResult: null,
    legacy: { ok: true, subject: 'lawn-mowing', description: 'back yard', tags: [] },
  });
  const r = await aiSuggestClip(0, 'all');
  assert.equal(r.ok, true);
  assert.equal(clip.subject, 'lawn-mowing');
});

// --- and the structural guard, because this is a ONE-LINE regression -----------------------------
//
// The bug was a single missing call. A future edit reverting it would pass every behavioural test
// above only if those tests were also deleted — but it would sail past any test that reads the
// return value, which is what the previous 36 did. Bind directly to the call site.

test('⚠⚠ the tool result is routed through applyAiResult at the call site', () => {
  const src = readSrc('src/mod/04-tasks-ai.js').replace(/\/\/.*$/gm, '');
  const at = src.indexOf('async function aiSuggestClip(');
  assert.ok(at > -1, 'aiSuggestClip exists');
  const body = src.slice(at, src.indexOf('\nasync function', at + 10));
  assert.match(body, /if \(toolResult\) return applyAiResult\(i, toolResult, mode\)/,
    '⚠⚠ the tool path must hand its result to applyAiResult, WITH the mode');
  assert.ok(!/if \(toolResult\) return toolResult;/.test(body),
    '⚠⚠ and must not return it raw — that is the exact line that named 4,263 clips into the void');
});

// --- AND THE COUNTER THAT REPORTED FAILURES AS NAMES --------------------------------------------
//
// `aiAutoEnhance` — "Auto-name everything (background)", the path he actually leaves running — ended
// its loop with a bare `done += 1`, no check on the result. So `missed = planned - done` was ALWAYS
// zero, which made BOTH honest branches below it unreachable code: the `, N failed` suffix and the
// `Couldn't name any of the N clips` message could never print. Reproduced with every model call
// stubbed to fail: three clips, all blank afterwards, toast said "AI auto-enhance complete ✓ —
// named 3" and the desktop notification said it again.
//
// Compounding with the bug above this is the whole story of his 4,594 clips: the tool path computed
// a name and dropped it, and the counter then reported every one of those as named.

test('⚠⚠ auto-enhance counts SUCCESSES, not attempts', () => {
  const src = readSrc('src/mod/04-tasks-ai.js').replace(/\/\/.*$/gm, '');
  const at = src.indexOf('async function aiAutoEnhance');
  assert.ok(at > -1, 'aiAutoEnhance exists');
  const body = src.slice(at, src.indexOf('\nlet aiRunDirection', at));

  assert.match(body, /if \(r && r\.ok\) done \+= 1;/,
    '⚠⚠ the reported count must be gated on the result');
  assert.ok(!/^\s*done \+= 1;\s*$/m.test(body),
    '⚠⚠ no unconditional increment may remain — that is the exact line that reported failures as names');
});

test('⚠ the progress bar still advances past a failure', () => {
  // The wrong fix: gate `done` and leave it driving `setTask`, so the progress bar freezes on the
  // first failure and a long run looks hung — replacing a lie with a different lie.
  const src = readSrc('src/mod/04-tasks-ai.js').replace(/\/\/.*$/gm, '');
  const at = src.indexOf('async function aiAutoEnhance');
  const body = src.slice(at, src.indexOf('\nlet aiRunDirection', at));
  assert.match(body, /setTask\('ai', aiModelLabel\(\), attempted \+ 1,/,
    '⚠ progress is driven by an ATTEMPT counter, separate from the success count');
  assert.match(body, /attempted \+= 1;/, 'which really increments');
});

test('⚠⚠ the sibling counters that drive progress only were left alone', () => {
  // The over-correction: `aiAnalyzeSelected` and `aiImproveSelected` also carry `done += 1`, and
  // theirs are CORRECT — those functions report from their own okCount/failCount pair, and gating
  // their `done` would stall the progress bar for no gain. A sibling sweep has to check what each
  // counter is FOR, not pattern-match the line.
  const src = readSrc('src/mod/04-tasks-ai.js').replace(/\/\/.*$/gm, '');
  const analyzeAt = src.indexOf('async function aiAnalyzeSelected');
  assert.ok(analyzeAt > -1);
  const analyze = src.slice(analyzeAt);
  assert.match(analyze, /okCount/, 'aiAnalyzeSelected reports from okCount, not from done');
});
