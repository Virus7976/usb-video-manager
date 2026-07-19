// Regression guards for defects found by the first automated audit of main-mod (2026-07-09).
// Each test below FAILS against the code as it was before that pass.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let m;
before(() => { m = loadMain(); });
after(() => m && m.dispose());

// ---------------------------------------------------------------------------
// scanBalancedJson — the shared "find the JSON in noisy text" primitive.
// ---------------------------------------------------------------------------
test('scanBalancedJson: skips a brace-containing banner and finds the real JSON', () => {
  assert.deepEqual(m.plain(m.call('scanBalancedJson', 'DEBUG {mod} ok\n[{"a":1}]')), [{ a: 1 }]);
});

test('scanBalancedJson: stops at the real close, ignoring trailing prose with a brace', () => {
  assert.deepEqual(m.plain(m.call('scanBalancedJson', '{"a":1}\nuse it wisely :}')), { a: 1 });
});

test('scanBalancedJson: braces and escaped quotes inside strings are not structural', () => {
  assert.deepEqual(m.plain(m.call('scanBalancedJson', '{"a":"}{"}')), { a: '}{' });
  assert.deepEqual(m.plain(m.call('scanBalancedJson', '{"s":"\\""}')), { s: '"' });
});

test('scanBalancedJson: returns undefined when there is no JSON at all', () => {
  assert.equal(m.call('scanBalancedJson', 'no json here {oops'), undefined);
  assert.equal(m.call('scanBalancedJson', ''), undefined);
});

// ---------------------------------------------------------------------------
// pbCleanPath — an LLM-proposed folder path is later path.join'd to the library root.
// ---------------------------------------------------------------------------
test('pbCleanPath: drops .. and . segments so a model reply cannot escape the root', () => {
  assert.equal(m.call('pbCleanPath', '../../etc/passwd'), 'etc/passwd');
  assert.equal(m.call('pbCleanPath', '..'), '');
  assert.equal(m.call('pbCleanPath', 'a/../../../b'), 'a/b');
  assert.equal(m.call('pbCleanPath', './a/./b'), 'a/b');
  assert.equal(m.call('pbCleanPath', '..\\..\\windows\\system32'), 'windows/system32');
});

test('pbCleanPath: ordinary relative paths are unchanged', () => {
  assert.equal(m.call('pbCleanPath', '/2026/2026-Travel/Iceland/'), '2026/2026-Travel/Iceland');
  assert.equal(m.call('pbCleanPath', '2026\\Travel'), '2026/Travel');
  assert.equal(m.call('pbCleanPath', ''), '');
  assert.equal(m.call('pbCleanPath', null), '');
});

// ---------------------------------------------------------------------------
// classifyGyro — NaN must not read as maximum motion.
// ---------------------------------------------------------------------------
test('classifyGyro: NaN / Infinity yield no reading rather than "fast action"', () => {
  assert.equal(m.call('classifyGyro', NaN), '');
  assert.equal(m.call('classifyGyro', Infinity), '');
  assert.equal(m.call('classifyGyro', undefined), '');
});

test('classifyGyro: real buckets still work', () => {
  assert.match(m.call('classifyGyro', 0), /locked off/);
  assert.match(m.call('classifyGyro', 0.2), /handheld/);
  assert.match(m.call('classifyGyro', 1.0), /moving/);
  assert.match(m.call('classifyGyro', 9), /fast action/);
});

// ---------------------------------------------------------------------------
// buildCompressArgs — `scale` lands inside one -vf element, so it must be an integer.
// ---------------------------------------------------------------------------
const vf = (args) => { const i = args.indexOf('-vf'); return i === -1 ? null : args[i + 1]; };

test('buildCompressArgs: a comma in `scale` cannot inject an extra ffmpeg filter', () => {
  const args = m.plain(m.call('buildCompressArgs', 'in.mp4', 'out.mp4',
    { scale: '720,transpose=1', codec: 'h264', preset: 'medium' }));
  assert.equal(vf(args), null, 'a non-integer scale is dropped, not passed to the filtergraph');
  assert.equal(args.join(' ').includes('transpose'), false);
});

test('buildCompressArgs: a plain integer scale still builds the filter (clamped, no upscale)', () => {
  const args = m.plain(m.call('buildCompressArgs', 'in.mp4', 'out.mp4',
    { scale: 1080, codec: 'h264', preset: 'medium' }));
  // Height is clamped to the source via ffmpeg's min() expression; the inner comma is escaped so
  // the filtergraph parser keeps it as ONE filter argument.
  assert.equal(vf(args), 'scale=-2:min(1080\\,ih)');
});

test('buildCompressArgs: "source" scale adds no -vf, and paths stay separate argv elements', () => {
  const args = m.plain(m.call('buildCompressArgs', '-weird name.mp4', 'out dir/o.mp4',
    { scale: 'source', codec: 'h264', preset: 'medium' }));
  assert.equal(vf(args), null);
  assert.ok(args.includes('-weird name.mp4'), 'src is its own argv element');
  assert.ok(args.includes('out dir/o.mp4'), 'out is its own argv element');
});

// ---------------------------------------------------------------------------
// slugFolder — Windows cannot create a folder named for a legacy DOS device.
// ---------------------------------------------------------------------------
test('slugFolder: Windows reserved device names are made creatable', () => {
  assert.equal(m.call('slugFolder', 'CON'), 'con-folder');
  assert.equal(m.call('slugFolder', 'aux'), 'aux-folder');
  assert.equal(m.call('slugFolder', 'NUL'), 'nul-folder');
  assert.equal(m.call('slugFolder', 'com1'), 'com1-folder');
  assert.equal(m.call('slugFolder', 'LPT9'), 'lpt9-folder');
});

test('slugFolder: ordinary names and traversal are unaffected', () => {
  assert.equal(m.call('slugFolder', 'Iceland Trip'), 'iceland-trip');
  assert.equal(m.call('slugFolder', 'console'), 'console', 'only an EXACT reserved name is suffixed');
  assert.equal(m.call('slugFolder', '..'), '', 'dots slug to a hyphen, which is then stripped');
  assert.equal(m.call('slugFolder', '../../etc'), 'etc');
});
