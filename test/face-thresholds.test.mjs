// Audit #91 — the face-recognition distances were bare literals repeated across five call sites
// (0.45 once, 0.5 four times), interacting with the named FACE_CONFIRM/SUGGEST pair but free to
// drift away from it. They are MEASURED values, not preferences (usb-app-tool-strings-are-input),
// so this pins them: a change here must be deliberate, visible in review, and re-measured.
//
// It also guards the consolidation itself — if someone re-introduces a bare `< 0.5` next to a
// faceDist call, the whole point of naming them is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const people = fs.readFileSync(path.join(ROOT, 'src/mod/08-people.js'), 'utf8');
const backend = fs.readFileSync(path.join(ROOT, 'main-mod/08-finalize-feedback.js'), 'utf8');

const constOf = (src, name) => {
  const m = new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`).exec(src);
  return m ? parseFloat(m[1]) : null;
};

test('#91 the face distances are named constants, with their measured values pinned', () => {
  // Renderer-side.
  assert.equal(constOf(people, 'FACE_CLUSTER_DIST'), 0.5, 'cluster-merge distance');
  assert.equal(constOf(people, 'FACE_FRAME_DEDUPE_DIST'), 0.45, 'same-face-across-frames distance');
  assert.equal(constOf(people, 'FACE_CONFIRM_DIST'), 0.46, 'auto-tag distance');
  assert.equal(constOf(people, 'FACE_SUGGEST_DIST'), 0.54, 'suggest ceiling');
  // Backend must agree with the renderer, or a face auto-tags on one side and not the other.
  assert.equal(constOf(backend, 'FACE_CONFIRM_T'), 0.46, 'backend auto-tag matches the renderer');
  assert.equal(constOf(backend, 'FACE_SUGGEST_T'), 0.54, 'backend suggest matches the renderer');
});

test('#91 no bare distance literal creeps back in beside a faceDist call', () => {
  // The exact shape that was there before: `faceDist(a, b) < 0.5`.
  const bare = people.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, l]) => /faceDist\([^)]*\)\s*<\s*0\.\d/.test(l));
  assert.deepEqual(bare, [], `use a named constant instead: ${JSON.stringify(bare)}`);
});

test('#91 confirm is stricter than suggest (the ordering the whole flow depends on)', () => {
  // If these ever cross, a face would auto-tag at a distance it is not even willing to suggest at.
  assert.ok(constOf(people, 'FACE_CONFIRM_DIST') < constOf(people, 'FACE_SUGGEST_DIST'));
});

// NOT asserted: that clustering is at least as strict as auto-tag. It currently ISN'T
// (0.50 vs 0.46) — see audit #13 and the comment block in 08-people.js. Making that true is a
// MEASURED change that needs real sibling footage first, so this test deliberately pins today's
// reality rather than encoding an aspiration that would fail.
