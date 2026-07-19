// Pulling the card mid-analyze must stop the run ONCE, not fail every remaining clip separately.
//
// Found by sweeping for sibling-path gaps, and it is the INVERTED case of the usual one: the guarded
// loop was the FALLBACK, and the unguarded loops were the default. `cardIsGone()` had exactly one
// call site — the legacy single-pass loop — while
//     const batched = aiCfg.multiPass || aiToolModelReady
// means that as soon as a tool model is configured (the normal setup) the batched path runs and the
// guard is unreachable.
//
// The cost is not cosmetic. Each remaining clip pays a full aiCallGuard timeout — 200 s in the
// perceive phase, 300 s in naming — so on a 200-clip card the app appears to hang for hours, and the
// honest one-time "the card was removed" is replaced by N separate "model timeout" entries in the
// activity log. The legacy loop's own comment says exactly this; it was simply never carried across.
//
// A THIRD loop was unguarded too (the "name every unnamed clip" pass), which the original sweep
// missed — its comment even says it is "guarded for the same reason as the other two batch loops",
// referring to the TIMEOUT guard, which is a different concern.
//
// Asserted against the live renderer's own source: these are renderer functions the vm harness
// cannot reach, and driving a real card-removal needs hardware.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
let src;
before(async () => {
  if (!RUN) return;
  app = await launchApp({ seed: { 'config.json': { firstRun: false } } });
  // The batch loops live in aiAnalyzeSelected; the third (unnamed-clip) pass lives in its own
  // function, so read both and assert against the pair.
  const a = await read(app.win, 'String(aiAnalyzeSelected)');
  const b = await read(app.win, "typeof aiAutoEnhance === 'function' ? String(aiAutoEnhance) : ''");
  src = a + '\n' + b;
});
after(async () => { if (app) await app.close(); });

test('every analyze loop checks whether the card is still there', { skip: !RUN }, async () => {
  // One check per loop: perceive, batch-naming, the unnamed-clip pass, and the legacy single-pass.
  const checks = (src.match(/await cardIsGone\(\)/g) || []).length;
  assert.ok(checks >= 4, `expected a check in every loop, found ${checks}`);
});

test('the check reports ONCE and breaks, rather than per clip', { skip: !RUN }, async () => {
  // reportCardGone() is idempotent by design, but a guard that continued would still burn a full
  // timeout on every remaining clip — the exact cost being avoided.
  const guards = src.match(/if \(!\(r && r\.ok\) && await cardIsGone\(\)\) \{ reportCardGone\(\); break; \}/g) || [];
  assert.ok(guards.length >= 3, `each batch loop breaks out; found ${guards.length}`);
});

test('the batched path is the DEFAULT, which is why the gap mattered', { skip: !RUN }, async () => {
  // If this ever flips back to opt-in the urgency changes, so pin why this was worth fixing.
  assert.match(src, /const batched = aiCfg\.multiPass \|\| aiToolModelReady/,
    'a configured tool model selects the batched path');
});

test('the guard sits AFTER the draft flush, so a yanked card cannot lose the last name', { skip: !RUN }, async () => {
  // Ordering matters: breaking before flushDraftSave() would discard the clip just named.
  const i = src.indexOf('flushDraftSave();   // persist each named clip');
  assert.ok(i > 0, 'the naming loop flushes each clip');
  // Generous window: the explanatory comment above the guard is itself several hundred characters,
  // so a tight slice reports a false failure (same trap as matching a call across a long comment).
  const after = src.slice(i, i + 1600);
  assert.match(after, /await cardIsGone\(\)/, 'and the card check comes after that flush');
});
