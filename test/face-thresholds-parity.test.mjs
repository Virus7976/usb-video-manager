// Audit #91 — the recognition thresholds live in two places and can drift apart silently.
//
// Main (`main-mod/08-finalize-feedback.js`: FACE_CONFIRM_T / FACE_SUGGEST_T) and the renderer
// (`src/mod/08-people.js`: FACE_CONFIRM_DIST / FACE_SUGGEST_DIST) each carry their own copy. That is
// not laziness — main and renderer are SEPARATE concatenated bundles with no shared module, so one
// constant is not physically possible across the process boundary. The duplication is forced; the
// drift is what has to be prevented.
//
// Why drift matters more than it looks: the renderer passes its ceiling to `people:match` as the
// `threshold` argument, and main clamps with `Math.min(payload.threshold, FACE_SUGGEST_T)`. So if the
// two sides disagree, the effective behaviour is whichever is stricter — silently, with no error and
// no log. Recognition quietly gets tighter or looser than either file claims.
//
// This test is the anti-drift mechanism a shared constant would otherwise provide. It reads the
// SOURCE of both sides rather than importing, because that is the only way to compare across the
// bundle boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mainSrc = readFileSync(join(process.cwd(), 'main-mod', '08-finalize-feedback.js'), 'utf8');
const rendSrc = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8');

const numberOf = (src, name) => {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([0-9.]+)`).exec(src);
  assert.ok(m, `${name} is declared`);
  return Number(m[1]);
};

test('#91 the CONFIRM threshold is identical on both sides', () => {
  assert.equal(numberOf(rendSrc, 'FACE_CONFIRM_DIST'), numberOf(mainSrc, 'FACE_CONFIRM_T'),
    'renderer FACE_CONFIRM_DIST and main FACE_CONFIRM_T must match — change both or neither');
});

test('#91 the SUGGEST threshold is identical on both sides', () => {
  // This is the one actually sent over IPC, and main clamps to the stricter of the two, so a
  // mismatch changes recognition behaviour with nothing reported anywhere.
  assert.equal(numberOf(rendSrc, 'FACE_SUGGEST_DIST'), numberOf(mainSrc, 'FACE_SUGGEST_T'),
    'renderer FACE_SUGGEST_DIST and main FACE_SUGGEST_T must match — change both or neither');
});

test('#91 confirm is stricter than suggest, and clustering is looser than both', () => {
  // The ordering IS the design: auto-tag only when very close, suggest when plausible, and merge two
  // unknown faces into one review card on a looser bar than either. If this ever inverts, the app
  // would auto-tag things it would not even suggest.
  const confirm = numberOf(rendSrc, 'FACE_CONFIRM_DIST');
  const suggest = numberOf(rendSrc, 'FACE_SUGGEST_DIST');
  const cluster = numberOf(rendSrc, 'FACE_CLUSTER_DIST');
  assert.ok(confirm < suggest, `confirm (${confirm}) must be stricter than suggest (${suggest})`);
  assert.ok(cluster <= suggest, `clustering (${cluster}) must not be looser than suggest (${suggest})`);
});

test('#91 the de-dup distance is named, not a bare literal', () => {
  // It was a raw `0.35` at its single call site with no explanation of why it differs from the
  // recognition thresholds. It answers a different question — "is this the same photo of a face" —
  // and must stay much tighter than CONFIRM or saving a face would swallow genuine new angles.
  const dedup = numberOf(mainSrc, 'FACE_DEDUP_T');
  assert.ok(dedup < numberOf(mainSrc, 'FACE_CONFIRM_T'),
    'de-dup must be tighter than the confirm threshold');
  assert.equal(/faceDist\(f\.d, d\) < 0\.35/.test(mainSrc), false, 'no bare literal left at the call site');
});
