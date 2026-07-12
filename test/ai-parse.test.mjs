// Characterization tests for the AI-response parsers and the compression arg builder.
//
// These functions consume UNTRUSTED, malformed LLM output, so this file pins down
// EXACTLY what the current code does with the ugly shapes a local model actually
// emits (fenced blocks, prose, trailing commas, truncation, injected objects, …).
// Every assertion below documents CURRENT behavior — including the rough edges — so a
// future refactor can't change it silently. Suspected defects are called out in the
// final report, not encoded as failing tests.
//
// Covered functions:
//   06-copy-transfer.js: parseJsonLoose, aiExtractStrings, aiExtractRules, extractRulesFrom
//   03-ai-ollama.js:     normalizeParsedRule, pbCleanPath, rankCandidateFolders
//   09-ipc-boot.js:      compressSettings, buildCompressArgs
//   07-naming-organize.js: classifyGyro, nameToTokens
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

// One shared bundle instance — every function under test is pure, so a single
// throwaway userData dir is enough and keeps the suite fast.
let m;
before(() => { m = loadMain(); });
after(() => { if (m) m.dispose(); });

// Helpers that re-materialize vm-realm values into the host realm before comparison.
const pj = (s) => m.plain(m.call('parseJsonLoose', s));
const call = (name, ...args) => m.plain(m.call(name, ...args));

// ---------------------------------------------------------------------------
// parseJsonLoose — the workhorse that every LLM JSON response passes through.
// ---------------------------------------------------------------------------
test('parseJsonLoose: a plain bare object parses', () => {
  assert.deepEqual(pj('{"a":1}'), { a: 1 });
});

test('parseJsonLoose: fenced ```json block', () => {
  assert.deepEqual(pj('```json\n{"a":1,"b":"x"}\n```'), { a: 1, b: 'x' });
});

test('parseJsonLoose: bare ``` fence (no language tag)', () => {
  assert.deepEqual(pj('```\n{"a":1}\n```'), { a: 1 });
});

test('parseJsonLoose: prose BEFORE the JSON is stripped', () => {
  assert.deepEqual(pj('Sure, here you go: {"a":1}'), { a: 1 });
});

test('parseJsonLoose: prose AFTER the JSON (no stray brace) is stripped', () => {
  assert.deepEqual(pj('{"a":1}\nHope that helps!'), { a: 1 });
});

test('parseJsonLoose: a bare array round-trips (direct JSON.parse path)', () => {
  assert.deepEqual(pj('[1,2,3]'), [1, 2, 3]);
});

test('parseJsonLoose: a bare scalar reply degrades to {}, never a non-object', () => {
  // Every caller immediately property-accesses the result (`o.placements`, `o.name`), so
  // returning a scalar threw a TypeError that surfaced as a generic "AI failed".
  assert.deepEqual(pj('42'), {});
});

test('parseJsonLoose: nested braces INSIDE a string value survive (valid JSON)', () => {
  assert.deepEqual(pj('{"a":"}{"}'), { a: '}{' });
});

test('parseJsonLoose: an escaped quote inside a string survives (valid JSON)', () => {
  assert.deepEqual(pj('{"s":"\\""}'), { s: '"' });
});

test('parseJsonLoose: a } inside a string is fine when the real close is last', () => {
  assert.deepEqual(pj('Sure: {"note":"use } carefully"}'), { note: 'use } carefully' });
});

// --- The rough edges: current code returns {} (or a scalar) for these. ---

test('parseJsonLoose: a trailing comma is NOT tolerated -> {}', () => {
  assert.deepEqual(pj('{"a":1,}'), {});
});

test('parseJsonLoose: single-quoted keys/values are NOT tolerated -> {}', () => {
  assert.deepEqual(pj("{'a':1}"), {});
});

test('parseJsonLoose: truncated / unterminated JSON -> {}', () => {
  assert.deepEqual(pj('{"a":1'), {});
});

test('parseJsonLoose: an empty string -> {}', () => {
  assert.deepEqual(pj(''), {});
});

test('parseJsonLoose: a null reply degrades to {} so callers can property-access it', () => {
  assert.deepEqual(pj('null'), {});
  assert.deepEqual(pj(null), {});
});

test('parseJsonLoose: an array embedded in prose is recovered', () => {
  assert.deepEqual(pj('Result: [1,2,3]'), [1, 2, 3]);
});

test('parseJsonLoose: prose AFTER the JSON containing a } no longer breaks extraction', () => {
  // Regression guard. The old greedy /\{[\s\S]*\}/ spanned the first "{" to the LAST "}",
  // so a stray "}" in the trailing prose dragged the slice past the real close and the
  // whole suggestion silently came back empty.
  assert.deepEqual(pj('{"a":1}\nUse it wisely :}'), { a: 1 });
  assert.deepEqual(pj('Sure: {"note":"careful }"} done }'), { note: 'careful }' });
});

test('parseJsonLoose: MULTIPLE objects in one response -> the first one', () => {
  // The greedy match used to grab `{"a":1}\n{"b":2}` as one invalid blob.
  assert.deepEqual(pj('{"a":1}\n{"b":2}'), { a: 1 });
});

// ---------------------------------------------------------------------------
// aiExtractStrings — flatten whatever shape the model returned to clean strings.
// ---------------------------------------------------------------------------
test('aiExtractStrings: a bare string', () => {
  assert.deepEqual(call('aiExtractStrings', 'hi'), ['hi']);
});

test('aiExtractStrings: an array of strings, trimming and dropping empties', () => {
  assert.deepEqual(call('aiExtractStrings', ['  a  ', 'b', '', '   ']), ['a', 'b']);
});

test('aiExtractStrings: an array of objects yields their string values', () => {
  assert.deepEqual(call('aiExtractStrings', [{ rule: 'a' }, { rule: 'b' }]), ['a', 'b']);
});

test('aiExtractStrings: non-string scalars (numbers/null/bool) are dropped', () => {
  assert.deepEqual(call('aiExtractStrings', [1, null, true, 'x']), ['x']);
});

test('aiExtractStrings: deeply nested strings are recovered', () => {
  assert.deepEqual(call('aiExtractStrings', { a: { b: ['deep'] } }), ['deep']);
});

// ---------------------------------------------------------------------------
// aiExtractRules — like aiExtractStrings but keeps {text, example} pairs.
// ---------------------------------------------------------------------------
test('aiExtractRules: a bare string becomes {text, example:""}', () => {
  assert.deepEqual(call('aiExtractRules', 'hi'), [{ text: 'hi', example: '' }]);
});

test('aiExtractRules: {rule, example} objects', () => {
  assert.deepEqual(call('aiExtractRules', [{ rule: 'a', example: 'e' }]), [{ text: 'a', example: 'e' }]);
});

test('aiExtractRules: {text, eg} aliases are accepted', () => {
  assert.deepEqual(call('aiExtractRules', [{ text: 't', eg: 'g' }]), [{ text: 't', example: 'g' }]);
});

test('aiExtractRules: numeric scalars produce NO rules', () => {
  assert.deepEqual(call('aiExtractRules', [1, 2, 3]), []);
});

test('aiExtractRules: null / undefined produce NO rules', () => {
  assert.deepEqual(call('aiExtractRules', null), []);
  assert.deepEqual(call('aiExtractRules', undefined), []);
});

test('aiExtractRules: an object with NO rule/text key falls back to its values', () => {
  // No `rule`/`text` string key -> Object.values() are walked as rules.
  assert.deepEqual(call('aiExtractRules', { foo: 'bar', baz: 'qux' }),
    [{ text: 'bar', example: '' }, { text: 'qux', example: '' }]);
});

test('aiExtractRules: an object-valued example is flattened, never "[object Object]"', () => {
  assert.deepEqual(call('aiExtractRules', [{ rule: 'r', example: { a: 'x', b: 'y' } }]),
    [{ text: 'r', example: 'x y' }]);
});

// ---------------------------------------------------------------------------
// extractRulesFrom — unwrap {memories:[...]} / {rules:[...]} / bare shapes.
// ---------------------------------------------------------------------------
test('extractRulesFrom: {memories:[...]} default key', () => {
  assert.deepEqual(call('extractRulesFrom', { memories: ['a', 'b'] }),
    [{ text: 'a', example: '' }, { text: 'b', example: '' }]);
});

test('extractRulesFrom: an explicit alternate key ("rules")', () => {
  assert.deepEqual(call('extractRulesFrom', { rules: ['a'] }, 'rules'), [{ text: 'a', example: '' }]);
});

test('extractRulesFrom: a bare array (not wrapped) passes straight through', () => {
  assert.deepEqual(call('extractRulesFrom', ['a', 'b']),
    [{ text: 'a', example: '' }, { text: 'b', example: '' }]);
});

test('extractRulesFrom: missing wrap key falls back to walking the whole object', () => {
  assert.deepEqual(call('extractRulesFrom', { foo: 'bar' }), [{ text: 'bar', example: '' }]);
});

// ---------------------------------------------------------------------------
// normalizeParsedRule — coerce one raw LLM rule into the canonical shape.
// ---------------------------------------------------------------------------
test('normalizeParsedRule: non-object input returns null', () => {
  assert.equal(call('normalizeParsedRule', null), null);
  assert.equal(call('normalizeParsedRule', 'nope'), null);
});

test('normalizeParsedRule: a route rule normalizes dest (slashes stripped, lowercased match)', () => {
  assert.deepEqual(call('normalizeParsedRule', { kind: 'route', match: ['Dog'], dest: '/2026/Pets/' }),
    { kind: 'route', name: 'dog', match: ['dog'], dest: '2026/Pets', byDay: false });
});

test('normalizeParsedRule: a descriptor rule emits placement + derived joinProject', () => {
  assert.deepEqual(call('normalizeParsedRule', { kind: 'descriptor', match: ['vlog'] }),
    { kind: 'descriptor', name: 'vlog', match: ['vlog'], placement: 'separate', joinProject: false, byDay: true });
});

test('normalizeParsedRule: a comma-string "match" is split into tokens', () => {
  assert.deepEqual(call('normalizeParsedRule', { match: 'a, b ,c' }),
    { kind: 'route', name: 'a', match: ['a', 'b', 'c'], dest: '', byDay: false });
});

test('normalizeParsedRule: a trailing YYYY-MM-DD segment is stripped from dest', () => {
  const r = call('normalizeParsedRule', { kind: 'route', match: ['x'], dest: 'a/b/2026-01-02' });
  assert.equal(r.dest, 'a/b');
});

test('normalizeParsedRule: a route with no dest whose keywords are ALL descriptor words flips to descriptor', () => {
  const r = call('normalizeParsedRule', { kind: 'route', match: ['vlog', 'pov'] });
  assert.equal(r.kind, 'descriptor');
});

test('normalizeParsedRule: an injected OBJECT in match is String()-coerced, never crashes', () => {
  // An LLM handing back {} where a keyword belongs becomes the literal token
  // "[object object]" — junk, but it does NOT throw and never reaches new RegExp().
  const r = call('normalizeParsedRule', { match: [{}], dest: 'x' });
  assert.deepEqual(r.match, ['[object object]']);
  assert.equal(r.dest, 'x');
});

test('normalizeParsedRule: an injected OBJECT dest is String()-coerced', () => {
  const r = call('normalizeParsedRule', { dest: { evil: 1 }, match: ['x'] });
  assert.equal(r.dest, '[object Object]');
});

// ---------------------------------------------------------------------------
// pbCleanPath — normalize a relative path for comparison.
// ---------------------------------------------------------------------------
test('pbCleanPath: backslashes become forward slashes, edges trimmed', () => {
  assert.equal(call('pbCleanPath', '\\a\\b\\'), 'a/b');
});

test('pbCleanPath: leading/trailing forward slashes are trimmed', () => {
  assert.equal(call('pbCleanPath', '/a/b/'), 'a/b');
});

test('pbCleanPath: ".." segments are dropped (it IS a traversal guard)', () => {
  // The result is path.join'd to the library root by projects:move, so a model reply of
  // "../../.." must not be able to walk out of it.
  assert.equal(call('pbCleanPath', '../../etc/passwd'), 'etc/passwd');
});

// ---------------------------------------------------------------------------
// rankCandidateFolders — must not throw or NaN on empty / null inputs.
// ---------------------------------------------------------------------------
test('rankCandidateFolders: empty everything returns a clean empty result', () => {
  assert.deepEqual(call('rankCandidateFolders', [], [], [], [], { max: 80 }),
    { shown: [], hiddenCount: 0, ranked: false });
});

test('rankCandidateFolders: all-null args do not throw', () => {
  assert.deepEqual(call('rankCandidateFolders', null, null, null, null, undefined),
    { shown: [], hiddenCount: 0, ranked: false });
});

test('rankCandidateFolders: a large tree with NO clip signal truncates without ranking', () => {
  const folders = Array.from({ length: 100 }, (_, i) => `2026/Cat/proj${i}`);
  const res = call('rankCandidateFolders', folders, [], [], [], { max: 80 });
  assert.equal(res.shown.length, 80);
  assert.equal(res.hiddenCount, 20);
  assert.equal(res.ranked, false);
});

test('rankCandidateFolders: real clip signal ranks matching folders to the top', () => {
  const folders = Array.from({ length: 100 }, (_, i) => `2026/Cat/proj${i}`);
  folders.push('2026/Clients/Gourgess Lawns');
  const clips = [{ subject: 'gourgess lawns mowing', people: [], location: '' }];
  const res = call('rankCandidateFolders', folders, clips, [], [], { max: 80 });
  assert.equal(res.ranked, true);
  assert.ok(res.shown.includes('2026/Clients/Gourgess Lawns'), 'the matching project is shown');
});

test('rankCandidateFolders: a standing-route dest is always kept even if it scored out', () => {
  const folders = Array.from({ length: 100 }, (_, i) => `2026/Cat/proj${i}`);
  folders.push('2026/Standing/Route Dest');
  const clips = [{ subject: 'proj5', people: [], location: '' }];
  const routeRules = [{ dest: '2026/Standing/Route Dest' }];
  const res = call('rankCandidateFolders', folders, clips, [], routeRules, { max: 80 });
  assert.ok(res.shown.includes('2026/Standing/Route Dest'), 'route dest is never hidden');
});

// ---------------------------------------------------------------------------
// compressSettings / buildCompressArgs — the ffmpeg argv builder.
// ---------------------------------------------------------------------------
test('compressSettings: undefined -> the balanced preset with skipExisting on', () => {
  assert.deepEqual(call('compressSettings', undefined),
    { codec: 'h264', crf: 23, preset: 'medium', scale: '1080', audio: 'aac', skipExisting: true });
});

test('compressSettings: an unknown preset name falls back to balanced', () => {
  const s = call('compressSettings', { preset: 'does-not-exist' });
  assert.equal(s.codec, 'h264');
  assert.equal(s.crf, 23);
});

test('compressSettings: overrides win and skipExisting:false is honored', () => {
  assert.deepEqual(call('compressSettings', { preset: 'balanced', overrides: { crf: 18 }, skipExisting: false }),
    { codec: 'h264', crf: 18, preset: 'medium', scale: '1080', audio: 'aac', skipExisting: false });
});

test('buildCompressArgs: the default balanced argv is well-formed', () => {
  const s = call('compressSettings', {});
  assert.deepEqual(call('buildCompressArgs', 'in.mp4', 'out.mp4', s), [
    '-y', '-i', 'in.mp4',
    '-vf', 'scale=-2:1080',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23',
    '-preset', 'medium',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats',
    'out.mp4',
  ]);
});

test('buildCompressArgs: h265 uses libx265 + hvc1 tag and its own crf', () => {
  const s = call('compressSettings', { preset: 'smaller' });
  const a = call('buildCompressArgs', 'in.mp4', 'out.mp4', s);
  assert.ok(a.includes('libx265'));
  assert.equal(a[a.indexOf('-tag:v') + 1], 'hvc1');
  assert.equal(a[a.indexOf('-crf') + 1], '28');
});

test('buildCompressArgs: scale=source omits the -vf filter entirely', () => {
  const s = call('compressSettings', { preset: 'hq' });   // scale:'source'
  const a = call('buildCompressArgs', 'in.mp4', 'out.mp4', s);
  assert.equal(a.includes('-vf'), false, 'no scale filter when scale is "source"');
  assert.equal(a[a.indexOf('-crf') + 1], '20');
  assert.equal(a[a.indexOf('-preset') + 1], 'slow');
});

test('buildCompressArgs: CRF, preset and scale are placed at their own argv slots', () => {
  const s = call('compressSettings', { preset: 'balanced' });
  const a = call('buildCompressArgs', 'in.mp4', 'out.mp4', s);
  // Each flag and its value are DISTINCT elements (flag immediately precedes value).
  assert.equal(a[a.indexOf('-vf') + 1], 'scale=-2:1080');
  assert.equal(a[a.indexOf('-crf') + 1], '23');
  assert.equal(a[a.indexOf('-preset') + 1], 'medium');
});

test('buildCompressArgs: a path with SPACES is one distinct argv element (no shell splitting)', () => {
  const s = call('compressSettings', {});
  const a = call('buildCompressArgs', '/my clips/in file.mp4', '/out dir/final cut.mp4', s);
  assert.equal(a[a.indexOf('-i') + 1], '/my clips/in file.mp4', 'input path is a single element');
  assert.equal(a[a.length - 1], '/out dir/final cut.mp4', 'output path is a single element');
});

test('buildCompressArgs: a path starting with "-" is still passed as a distinct element', () => {
  // It is NOT concatenated onto the previous flag, so it can never masquerade as one.
  const s = call('compressSettings', {});
  const a = call('buildCompressArgs', '-rf.mp4', '-out.mp4', s);
  assert.equal(a[a.indexOf('-i') + 1], '-rf.mp4');
  assert.equal(a[a.length - 1], '-out.mp4');
  // The output element is exactly the leading-dash string, not merged with -nostats.
  assert.equal(a[a.length - 2], '-nostats');
});

test('buildCompressArgs: a comma in `scale` cannot inject an extra ffmpeg filter', () => {
  // A scale override containing a comma used to append an EXTRA filter to the same -vf
  // element. Never a shell injection (spawn takes argv), but it was still one ffmpeg
  // filtergraph the user never asked for. A non-integer height is now ignored outright.
  const a = call('buildCompressArgs', 'in.mp4', 'out.mp4', { scale: '720,transpose=1', codec: 'h264', preset: 'medium' });
  assert.equal(a.indexOf('-vf'), -1, 'no -vf at all for a non-integer scale');
});

// ---------------------------------------------------------------------------
// classifyGyro — bucket a mean gyro magnitude into a plain-English motion label.
// ---------------------------------------------------------------------------
test('classifyGyro: the four normal buckets', () => {
  assert.equal(call('classifyGyro', 0), 'locked off / static (tripod or set down)');
  assert.equal(call('classifyGyro', 0.3), 'handheld with small movement');
  assert.equal(call('classifyGyro', 1.0), 'moving — panning, walking or following the subject');
  assert.equal(call('classifyGyro', 2.0), 'lots of movement — fast action');
});

test('classifyGyro: NaN yields no reading, not the MAX bucket', () => {
  // NaN fails every `<` comparison, so it used to land on the final "fast action" return
  // and told the AI namer that a tripod shot was fast action.
  assert.equal(call('classifyGyro', NaN), '');
});

test('classifyGyro: a negative magnitude reads as static', () => {
  assert.equal(call('classifyGyro', -1), 'locked off / static (tripod or set down)');
});

// ---------------------------------------------------------------------------
// nameToTokens — split a person name into lowercase tokens.
// ---------------------------------------------------------------------------
test('nameToTokens: splits on spaces and hyphens, lowercases, drops punctuation', () => {
  assert.deepEqual(call('nameToTokens', 'Liam-Josiah OConnor'), ['liam', 'josiah', 'oconnor']);
});

test('nameToTokens: null / empty yields an empty array', () => {
  assert.deepEqual(call('nameToTokens', null), []);
  assert.deepEqual(call('nameToTokens', ''), []);
});
