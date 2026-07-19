// The map's Apply threw away two things main went out of its way to tell it.
//
// 1. EMBED FAILURES. `projects:move` records them deliberately, and says why in the comment:
//        // A failure here must never block filing the clip — but we DO record it so the
//        // caller can tell the user "filed, but metadata didn't write" instead of it
//        // silently vanishing.
//        } catch (e) { embedded = false; embedError = …; }
//    …and returns `out.embedded` / `out.embedError` (main-mod/02-media.js). An embed failure still
//    has `ok: true`, because filing must not be blocked by it. The renderer counted only `.ok`, so
//    the clip counted as a full success. The confirm dialog promises "with their metadata embedded"
//    and the result says "Filed 40 ✓" — while none of them carry it.
//
// 2. PER-CLIP MOVE ERRORS. `results.push({ from, ok: false, action: 'error', error: err.message })`
//    — the renderer derived `failN` from the array length and printed ", 3 failed". No logIssue, no
//    list, no reason. The twin path renders `summary.errors` into a visible list, so this is sibling
//    divergence rather than a decision.
//
// SCOPE, checked rather than assumed: a sweep claimed the un-embedded metadata is then evicted by the
// finalMeta prune "as consumed". That is WRONG for this path — `markFinalMetaDone` is called only by
// `finalize:run` (main-mod/09-ipc-boot.js), never by `projects:move`, and the prune only evicts
// entries flagged done. So the metadata survives and this is a TRUST bug, not a data-loss bug: the
// user is told the footage carries its metadata when it doesn't. Logged the missing `.xmp` sidecar
// fallback (which the twin has) as a separate follow-up rather than smuggling it in here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '07-organize-map.js'), 'utf8');
// The Apply handler, sliced from the results-counting block to the end of the click handler — not a
// fixed character window. COMMENTS STRIPPED: the explanatory comments here mention `embedError`,
// `logIssue` and `.error`, and a first version of these tests matched those and stayed green while
// the real detection was deleted. Assert on code, and name the exact expression that would go
// missing — an identifier appearing "somewhere nearby" is not a guard.
const start = src.indexOf('const okN = (r && r.results || [])');
const apply = src.slice(start, src.indexOf('loadTree();', start)).replace(/\/\/.*$/gm, '');

test('embed failures are detected from the results main returned', () => {
  assert.ok(start > 0, 'found the Apply result handling');
  assert.match(apply, /filter\(\(x\) => x && x\.ok && x\.embedded === false\)/,
    'clips filed with ok:true but embedded:false are picked out');
});

test('per-clip move errors are detected', () => {
  assert.match(apply, /filter\(\(x\) => x && !x\.ok && x\.error\)/,
    'failed clips and their reasons are picked out');
});

test('both are surfaced AND logged, not just counted', () => {
  // A toast expires; logIssue is where the user goes looking afterwards. The twin path does both.
  const embedBlock = apply.slice(apply.indexOf('noEmbed.length'));
  assert.match(embedBlock.slice(0, 500), /showToast\(/, 'the embed failure is shown');
  assert.match(embedBlock.slice(0, 500), /logIssue\(/, 'and recorded');
  const errBlock = apply.slice(apply.indexOf('errs.length'));
  assert.match(errBlock.slice(0, 500), /showToast\(/, 'the filing failure is shown');
  assert.match(errBlock.slice(0, 500), /logIssue\(/, 'and recorded');
});

test('the failure messages carry the REASON', () => {
  // "3 failed" without a reason was the complaint. The messages must interpolate the real text.
  assert.match(apply, /embedError/, 'the embed reason is used');
  assert.match(apply, /errs\[0\]\.error|x\.error/, 'and the filing error text is used');
});

test('the warnings are conditional, so a clean run stays quiet', () => {
  assert.match(apply, /if \(noEmbed\.length\)/, 'no embed warning unless something failed to embed');
  assert.match(apply, /if \(errs\.length\)/, 'no error warning unless something failed to file');
});

test('the success line and the Undo offer are untouched', () => {
  assert.match(apply, /Filed \$\{okN\}/, 'the normal success message is intact');
  assert.match(apply, /showToastAction\(`Filed/, 'and the Undo offer still fires');
});
