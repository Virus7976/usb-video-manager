// A meta-test: no negative assertion may run on a slice whose anchor was never checked.
//
// This session produced six blind fixtures and four shape-pinned assertions, and the most dangerous
// variant kept recurring — a test that passes because it is looking at NOTHING:
//
//     const body = src.slice(src.indexOf('function foo'), ...);   // anchor moves → indexOf is -1
//     assert.doesNotMatch(body, /dangerous/);                     // ...passes. Silently. Forever.
//
// `String.slice(-1)` returns the last character, so a missing anchor does not throw — it yields a
// one-character string that contains nothing, and every "must NOT contain" assertion on it succeeds.
// **A positive assertion fails loudly when its anchor drifts; a negative one goes quiet.** That
// asymmetry is why this class is worth a rule rather than vigilance: the failure mode is silence, and
// silence is exactly what a green suite looks like.
//
// ⚠ TWO CORRECTIONS I had to make while writing this, both worth keeping:
//
// 1. **Only the START anchor is dangerous.** `slice(0, indexOf(x))` with a missing anchor becomes
//    `slice(0, -1)` — the whole string bar one character, so a negative assertion runs on MORE text
//    and can only produce a false FAILURE, which is loud and safe. It is `slice(indexOf(x))` and
//    `slice(indexOf(x), …)` that collapse to nothing.
//
// 2. **`assert.ok(v.length > 0)` DOES NOT GUARD IT.** That was my first fix, applied to all 13
//    offenders, and it is worthless here: the collapsed slice is one character long, so the length
//    check passes and the negative assertion is still vacuous. I proved it —
//    `'…}'.length > 0` is true while `doesNotMatch(/dangerous/)` also passes. **The guard has to
//    assert the INDEX was found**, not that the slice is non-empty.
//
// It is not hypothetical here. `delete-gate.test.mjs` is on this list — the one irreversible act in
// the app, guarded by an assertion that would have stopped protecting it the moment someone renamed
// the function it anchors on.
//
// The rule: if a variable is defined by slicing at an `indexOf` anchor and any negative assertion
// reads it, the test must first assert the slice is non-empty. Two files already did this
// (`embed-sidecar`, `copy-integrity`) — this makes it the standard rather than a habit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = join(process.cwd(), 'test');
const files = [
  ...readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).map((f) => join(TEST_DIR, f)),
  ...readdirSync(join(TEST_DIR, 'e2e')).filter((f) => f.endsWith('.mjs')).map((f) => join(TEST_DIR, 'e2e', f)),
];

// Variables sliced from a START anchor — `slice(indexOf(...))`, not `slice(0, indexOf(...))`. Only
// this form collapses to a single character when the anchor is missing; see correction 1 above.
const slicedVars = (src) => new Set(
  [...src.matchAll(/const (\w+) = [^\n]*\.slice\(\s*(?!0\s*,)[^\n]*indexOf\(/g)].map((m) => m[1]),
);

// Does the file prove the ANCHOR was found? A length check does not count — see correction 2. What
// counts is an index assertion (`> -1`, `>= 0`, `b > a`) in the few lines around the slice, or a
// POSITIVE assertion on the slice itself, which fails loudly if the slice collapsed.
//
// Checked POSITIONALLY rather than by variable name: the guard usually names the index (`i`, `start`),
// not the slice. My first version only matched guards mentioning the slice variable, so a perfectly
// good `assert.ok(i > -1)` two lines above went unrecognised and the rule flagged its own fix.
const guarded = (src, v) => {
  const lines = src.split('\n');
  const at = lines.findIndex((l) => new RegExp(`const ${v} = .*\\.slice\\(`).test(l));
  if (at < 0) return false;
  // A window either side: guards are written before the slice as often as just after it. My first
  // version looked only backwards, which meant the "a length guard is not accepted" test below could
  // not distinguish anything — its sample puts the guard AFTER the slice, so the window was empty and
  // every branch returned false for the same reason. Weakening the rule then changed nothing, and the
  // break came back green.
  const near = lines.slice(Math.max(0, at - 6), at + 4).join('\n');
  if (/assert\.ok\([^\n]*(> ?-1|>= ?0)/.test(near)) return true;
  if (/assert\.ok\(\s*\w+ > \w+,/.test(near)) return true;
  return new RegExp(`assert\\.match\\(\\s*${v}\\b`).test(src);
};

// Assertions whose whole meaning is "this text is absent" — the ones an empty slice satisfies.
const negativeOn = (src, v) => [
  ...src.matchAll(new RegExp(`assert\\.doesNotMatch\\(\\s*${v}\\b`, 'g')),
  ...src.matchAll(new RegExp(`assert\\.equal\\(\\s*/[^/]+/\\.test\\(${v}\\)\\s*,\\s*false`, 'g')),
].length;

test('⚠ every negative assertion on an anchored slice proves the slice exists', () => {
  const violations = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const v of slicedVars(src)) {
      if (!negativeOn(src, v)) continue;          // positive-only assertions fail loudly on their own
      if (guarded(src, v)) continue;
      violations.push(`${f.replace(process.cwd() + '/', '')} → "${v}"`);
    }
  }
  assert.deepEqual(violations, [],
    'these tests would pass while asserting nothing if their anchor moved. Assert the INDEX resolved '
    + '(assert.ok(i > -1)) before slicing — a length check does NOT work, because a collapsed slice is '
    + 'one character long. See the corrections at the top of this file.');
});

test('the scan is actually finding sliced variables (cannot pass vacuously itself)', () => {
  // The rule this file enforces, applied to itself: if the detection regex stopped matching, the
  // check above would report zero violations forever and look perfectly healthy.
  let found = 0;
  for (const f of files) found += slicedVars(readFileSync(f, 'utf8')).size;
  assert.ok(found > 20, `the scan sees anchored slices across the suite — found ${found}`);
});

test('and it recognises a negative assertion when it sees one', () => {
  const sample = "const body = src.slice(src.indexOf('x'));\nassert.doesNotMatch(body, /y/);";
  assert.equal(negativeOn(sample, 'body'), 1, 'doesNotMatch is detected');
  const sample2 = "const body = src.slice(src.indexOf('x'));\nassert.equal(/y/.test(body), false);";
  assert.equal(negativeOn(sample2, 'body'), 1, 'the .test(...) === false form is detected too');
});

test('⚠ a LENGTH guard is explicitly NOT accepted — it does not guard', () => {
  // The correction that matters most. A collapsed slice is one character long, so this passes while
  // the negative assertion below it is still vacuous.
  const lengthOnly = "const body = src.slice(src.indexOf('x'));\nassert.ok(body.length > 0, 'found');\nassert.doesNotMatch(body, /y/);";
  assert.equal(guarded(lengthOnly, 'body'), false, 'a length check must not satisfy the rule');
});

test('a positive assertion on the same slice DOES satisfy it', () => {
  // If the test also asserts the slice CONTAINS something specific, a collapsed slice fails there
  // first — loudly — so the negative assertion can never run against nothing.
  const withPositive = "const body = src.slice(src.indexOf('x'));\nassert.match(body, /must-be-here/);\nassert.doesNotMatch(body, /y/);";
  assert.equal(guarded(withPositive, 'body'), true, 'a positive assertion pins the anchor');
});

test('slice(0, indexOf(...)) is not flagged — a missing anchor there is harmless', () => {
  const endAnchor = "const body = src.slice(0, src.indexOf('x'));\nassert.doesNotMatch(body, /y/);";
  assert.equal(slicedVars(endAnchor).has('body'), false, 'only START anchors collapse');
});
