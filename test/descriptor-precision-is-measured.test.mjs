// Face descriptors dominate faces-pending.json: 4,715 vectors at ~2,764 bytes each = 14.5 MB, of
// which only 37 KB is thumbnails. That file is rewritten on every debounced save while he works
// through the face review — which is exactly the workflow currently abandoned at 458 unconfirmed.
//
// Storing them at 5 decimal places halves the file. But a descriptor is INPUT to the matcher, and
// this repo has already learned once that quietly altering measured input costs real accuracy
// ([[usb-app-tool-strings-are-input]] — a cosmetic rename of a tool RESULT cost 20 points, 4/4
// deterministic). So the precision was MEASURED against his real store before it was chosen:
//
//     precision   bytes/vector   largest euclidean shift over 400 real pairs
//     full         2764          —
//     6 dp         1336          —
//     5 dp         1210 (-56%)   0.000014      ← chosen
//     4 dp         1079 (-61%)   0.000118
//     3 dp          948 (-66%)   0.001383
//
// This file pins BOTH halves: the chosen precision, and the property that justifies it. If someone
// later "saves more space" by dropping to 3 dp, the accuracy assertion below fails and they have to
// re-measure rather than guess.
//
// ⚠ A correction worth recording: the 80-sample cap added earlier the same day was described as a
// large win. Measured, it is 15% — only 7 of 458 clusters exceed 80. It is worth keeping because it
// bounds UNBOUNDED growth (one cluster had reached 318), but it did not reclaim much. The precision
// change is where the actual size comes from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8');
const stripped = src.replace(/\/\/.*$/gm, '');

// Reimplemented here rather than imported: 08-people.js is renderer code inside a concatenated
// bundle, so it cannot be required. Pinned to the source constant by the first test below, so the
// two cannot drift silently.
const DP = 1e5;
const pack = (d) => d.map((x) => Math.round(x * DP) / DP);
const dist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));

// A deterministic stand-in for real descriptors: 128 values in the range face-api.js produces.
function vec(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return (s / 2147483648) * 0.4 - 0.2; };
  return Array.from({ length: 128 }, rnd);
}

test('⚠ the stored precision is 5 dp, and the code agrees with this test', () => {
  assert.match(stripped, /const DESC_DP = 1e5;/,
    '⚠ if this changes, the accuracy bound below was measured for a DIFFERENT precision — re-measure');
});

test('⚠⚠ rounding cannot change a matching decision', () => {
  // The property that makes the whole change safe. FACE_CLUSTER_DIST / FACE_SUGGEST_DIST are
  // ~0.35-0.5; a shift anywhere near that could flip "same person" to "new face" on his 458 clusters.
  let worst = 0;
  for (let i = 0; i < 400; i += 1) {
    const a = vec(i * 7919 + 1); const b = vec(i * 104729 + 3);
    worst = Math.max(worst, Math.abs(dist(a, b) - dist(pack(a), pack(b))));
  }
  assert.ok(worst < 0.0001,
    `⚠ largest distance shift ${worst} must stay far below the ~0.35 decision threshold`);
  // State the margin explicitly, so a future precision change cannot quietly erode it.
  assert.ok(0.35 / Math.max(worst, 1e-12) > 1000,
    `the shift must be at least 1000x smaller than the threshold — margin was ${0.35 / worst}`);
});

test('rounding is stable — packing twice changes nothing', () => {
  // Idempotence matters: every debounced save re-packs the same clusters, and a value that drifted
  // on each pass would slowly walk away from the original.
  const a = vec(42);
  assert.deepEqual(pack(pack(a)), pack(a), 'a second pack is a no-op');
});

test('⚠ the SAVE path packs both the identity descriptor and the samples', () => {
  const at = stripped.indexOf('function _serializePending');
  assert.ok(at > -1, 'found the save path');
  const body = stripped.slice(at, stripped.indexOf('\n}', at));
  assert.match(body, /descriptor: packDescriptor\(c\.descriptor\)/, 'the identity descriptor');
  assert.match(body, /descriptors: packDescriptors\(c\.descriptors\)/, 'and the samples');
});

test('⚠⚠ the LOAD path does NOT pack — existing records read back untouched', () => {
  // The migration story: nothing on disk is rewritten or degraded on read. A record written at full
  // precision keeps it until the next save, so there is no moment where data is lost by upgrading.
  const at = stripped.indexOf('async function loadPendingFaces');
  assert.ok(at > -1, 'found the load path');
  const body = stripped.slice(at, stripped.indexOf('\n}', at));
  assert.match(body, /descriptors: \(c\.descriptors \|\| \[\]\)\.slice\(0, 80\)/,
    'load caps but does not re-round');
  assert.doesNotMatch(body, /packDescriptor/, '⚠ packing on load would rewrite his data on a mere read');
});

test('the 80-sample cap still applies on save', () => {
  // Kept alongside the precision change: it is what bounds a single cluster growing without limit
  // (his largest had reached 318), even though it only reclaims ~15% today.
  const at = stripped.indexOf('function packDescriptors');
  const body = stripped.slice(at, stripped.indexOf('\n}', at));
  assert.match(body, /\.slice\(0, 80\)/, 'still capped');
});
