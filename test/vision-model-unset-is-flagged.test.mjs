// ⚠⚠ A FRESH MACHINE WITH A VISION MODEL INSTALLED AND NONE SELECTED WAS TOLD EVERYTHING WAS FINE.
//
// `visionAdviceInner` reports two different situations:
//
//     kind: 'upgrade' — a vision model is selected, but a better one is installed
//     kind: 'unset'   — a vision model is INSTALLED and none is selected
//
// `ai:health` only ever turned 'upgrade' into a problem card. `unset` was dropped, so someone who
// pulled a vision model and never picked one got no nudge: AI naming silently describes nothing, and
// the health check — whose stated job is "tell him when the AI setup is silently wrong" — reported a
// clean bill of health.
//
// That is the state a FRESH INSTALL is in, which is the audience the zero-setup work exists for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';
import { createRequire } from 'node:module';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const problemFor = (advice) => app.plain(app.call('visionProblemFor', advice));

test('⚠ CONTROL — an "upgrade" recommendation still produces its card', () => {
  // Without this, "unset now produces a card" could pass while the upgrade path had been broken.
  const p = problemFor({ kind: 'upgrade', best: 'qwen2.5vl:7b', why: 'it can actually see motorcycles' });
  assert.ok(p, '⚠ the upgrade case still reports');
  assert.equal(p.id, 'weak-vision');
  assert.equal(p.arg, 'qwen2.5vl:7b', 'and carries the model the fix will select');
  assert.equal(p.fix, 'useVision');
});

test('⚠⚠⚠ an "unset" recommendation now produces a card too', () => {
  const p = problemFor({ kind: 'unset', best: 'qwen2.5vl:7b', installed: ['qwen2.5vl:7b'] });
  assert.ok(p, '⚠⚠⚠ a fresh machine with no vision model selected is told');
  assert.equal(p.severity, 'high', 'at high severity — nothing about naming works without it');
  assert.equal(p.fix, 'useVision', 'with the same one-click fix');
  assert.equal(p.arg, 'qwen2.5vl:7b', 'naming the model it will select');
});

test('⚠⚠ the two cards are distinguishable, not one message reused', () => {
  // "Switch to X" is wrong when nothing is selected — there is nothing to switch FROM, and a user
  // reading it looks for a setting they have already got right.
  const up = problemFor({ kind: 'upgrade', best: 'a', why: 'w' });
  const unset = problemFor({ kind: 'unset', best: 'a' });
  assert.notEqual(up.id, unset.id, '⚠⚠ different ids, so the UI and the log can tell them apart');
  assert.notEqual(up.title, unset.title, '⚠⚠ and different wording');
  assert.match(unset.title, /No vision model is selected/i, 'which describes the real situation');
});

test('⚠ no advice, or advice with nothing to recommend, produces nothing', () => {
  // The health check must not invent a card when Ollama is down or no vision model is installed —
  // "install something" is a different problem with a different card.
  for (const a of [null, undefined, {}, { kind: 'unset' }, { kind: 'upgrade' }, { kind: 'other', best: 'x' }]) {
    assert.equal(problemFor(a), null, `⚠ nothing for ${JSON.stringify(a)}`);
  }
});

test('⚠⚠ ai:health routes through this function rather than re-deciding inline', () => {
  // The reason it was extracted: inline in a 200-line health check, this rule could only be checked
  // by reading. If someone re-inlines it, the branch can silently lose a case again.
  // eslint-disable-next-line global-require
  const { readFileSync } = createRequire(import.meta.url)('node:fs') ? createRequire(import.meta.url)('node:fs') : null;
  const src = readFileSync(new URL('../main-mod/10-ai-tools.js', import.meta.url), 'utf8')
    .replace(/\/\/.*$/gm, '');
  assert.match(src, /const visionProblem = visionProblemFor\(advice\);/,
    '⚠⚠ the health check asks the function');
  assert.ok(!/advice\.kind === 'upgrade'\s*\)\s*\{\s*problems\.push/.test(src),
    '⚠⚠ and does not carry its own copy of the branch');
});
