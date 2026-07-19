// The last two swallowed failures from the 2026-07-19al sweep. Both LOW severity, both the same
// shape as the "🧠 AI learned N things" fix — and that shape has now appeared four times, which is
// why they're worth closing rather than leaving logged.
//
// 1. "Remember this direction". The user TICKS A BOX asking the app to keep the steering they typed:
//        if (dlg.direction && dlg.remember) {
//          try { await window.api.aiAddMemories([…]); … } catch { /* non-fatal */ }
//        }
//    No `.ok` check, and no toast either way. Ranked below the others precisely because there is no
//    false ✓ — but that cuts both ways: there is no signal at all, so a failure is discovered months
//    later by the AI simply not behaving that way. An explicit request deserves an explicit answer.
//
// 2. The project-ledger write after a successful filing run:
//        try { await recordToLedger(clips, placement, r.results || []); } catch (e) { /* non-fatal */ }
//    Genuinely non-fatal to the FOOTAGE — the clips are filed either way — and the fail-open decision
//    is right, so this keeps swallowing. What it must not do is swallow SILENTLY: a rejection means
//    the Projects index won't list this run and same-shoot detection won't offer the project on the
//    next import. That is learned work quietly degrading, and one logIssue costs nothing.
//
// Renderer-only. Asserted against the source: comments stripped, exact expressions named, sliced to
// real boundaries, each part broken separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '');
const tasks = strip(readFileSync(join(process.cwd(), 'src', 'mod', '04-tasks-ai.js'), 'utf8'));
const map = strip(readFileSync(join(process.cwd(), 'src', 'mod', '07-organize-map.js'), 'utf8'));

// --- 1. remember this direction ---------------------------------------------------------------
const remStart = tasks.indexOf('if (dlg.direction && dlg.remember)');
const remember = tasks.slice(remStart, tasks.indexOf('\n  if (uiPrefs.autoVersionOnAi', remStart));

test('a remembered direction confirms that it was remembered', () => {
  assert.ok(remStart > 0, 'found the remember block');
  // BOTH answers, named separately. A bare /showToast\(/ matched either branch, so deleting the
  // success confirmation left this green while half the answer was gone.
  assert.match(remember, /showToast\('Remembered/, 'it confirms when the direction was kept');
  assert.match(remember, /showToast\('Couldn.{1,3}t remember that direction/, 'and says so when it was not');
});

test('a failure to remember is reported, not swallowed', () => {
  const i = remember.indexOf('catch');
  assert.ok(i > 0, 'the catch is still there');
  const tail = remember.slice(i);
  assert.match(tail, /logIssue\(/, 'a failed remember is recorded');
});

test('the in-memory copy only grows when the save landed', () => {
  // Same rule as the aiAddMemories fix: memory and disk must not diverge, or the app believes it
  // knows something it will forget on restart.
  const push = remember.indexOf('aiCfg.memories.push');
  const gate = remember.search(/if \(kept\)|if \(saved\)|if \(ok\)/);
  assert.ok(push > 0 && gate > 0, 'the push is gated on the outcome');
  assert.ok(gate < push, 'and the gate comes first');
});

// --- 2. the ledger write ----------------------------------------------------------------------
// From the START of the line — slicing from the call itself begins after the `try {` that wraps it,
// so the fail-open assertions below had nothing to match.
const _lg = map.indexOf('await recordToLedger(');
const ledgerLine = map.slice(map.lastIndexOf('\n', _lg) + 1, map.indexOf('\n', _lg));

test('a failed ledger write is logged', () => {
  assert.ok(ledgerLine.length > 0, 'found the ledger call');
  assert.match(ledgerLine, /logIssue\(/, 'the rejection is recorded instead of vanishing');
});

test('the ledger write still cannot fail the filing run', () => {
  // The files are already filed by this point. Reporting must not become throwing — this is a
  // deliberate fail-open, exactly like organize:undo's ledger reversal.
  assert.match(ledgerLine, /try \{/, 'still wrapped');
  assert.match(ledgerLine, /catch/, 'and still swallows the failure itself');
  assert.doesNotMatch(ledgerLine, /throw/, 'it never rethrows');
});

test('the ledger failure does not shout at the user', () => {
  // The footage is filed and nothing is lost; a toast here would be noise on a successful run. The
  // log is the right channel — this is the counter-case to the two toast fixes above.
  assert.doesNotMatch(ledgerLine, /showToast\(/, 'logged, not toasted');
});
