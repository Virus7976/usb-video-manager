// Audit #23 — the NAMING phase of a batch run had no timeout guard.
//
// `aiCallGuard` wraps aiImprove and both aiPerceive calls, but the naming step
// (aiSuggestClip → aiNameWithTools) was bare. The tool loop runs maxSteps:5 with a 120 s per-call
// timeout, so one wedged clip could hold the batch for ~10 minutes — and then fall through to the
// legacy aiSuggest for another 180 s. On a 200-clip card that is how a run "just stops".
//
// Source-level test: the batch loop is deep inside a modal flow with GPU/model state that can't be
// driven from the vm harness, so what's asserted is that the two BATCH call sites are guarded — the
// same approach face-scenes.test.mjs uses for wiring that can't be invoked directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/mod/04-tasks-ai.js'), 'utf8');

// Every `await aiSuggestClip(...)` that sits inside the batch runner must be wrapped.
const batchCalls = src.split('\n')
  .map((line, i) => ({ n: i + 1, line }))
  .filter(({ line }) => /await\s+(aiCallGuard\()?\s*aiSuggestClip\(/.test(line) && /quiet:\s*true/.test(line));

test('#23 the batch naming loop has call sites to guard at all', () => {
  // If this drops to 0 the file was restructured and the assertions below would pass vacuously.
  assert.ok(batchCalls.length >= 2, `found the batch naming calls (got ${batchCalls.length})`);
});

test('#23 every batch naming call is wrapped in aiCallGuard', () => {
  const unguarded = batchCalls.filter(({ line }) => !/aiCallGuard\(/.test(line));
  assert.deepEqual(unguarded.map((u) => u.n), [],
    `an unguarded naming call lets one wedged clip stall the whole batch: ${JSON.stringify(unguarded)}`);
});

test('#23 the naming guard is more generous than the perceive guard', () => {
  // Naming can legitimately take several tool steps, so its bound must be LOOSER than perceive's —
  // too tight a guard is worse than the bug, because it skips clips that would have succeeded.
  const guarded = batchCalls.map(({ line }) => {
    const m = /aiCallGuard\([\s\S]*?,\s*(\d+)\s*\)/.exec(line);
    return m ? Number(m[1]) : null;
  });
  assert.ok(guarded.every((ms) => ms && ms >= 200000), `each naming guard is >= the 200s perceive guard (got ${guarded})`);
});

test('#23 aiCallGuard reports a timeout as a normal failed result, not a throw', () => {
  // The batch loop calls queueQuestions(i, r) straight after — a rejected promise there would kill
  // the run outright, which is the failure this whole guard exists to prevent.
  const fn = src.slice(src.indexOf('function aiCallGuard('), src.indexOf('function aiCallGuard(') + 600);
  assert.match(fn, /resolve\(/, 'it resolves');
  assert.match(fn, /ok:\s*false/, 'with a plain {ok:false} result');
  assert.equal(/reject\(/.test(fn), false, 'and never rejects');
});
