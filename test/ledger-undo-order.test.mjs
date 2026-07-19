// The project-ledger write raced the Undo offered right beside it.
//
// In the map's Apply handler (src/mod/07-organize-map.js):
//     try { recordToLedger(clips, placement, r.results || []); } catch (e) { /* non-fatal */ }
//     …
//     if (okN) showToastAction(`Filed ${okN} ✓`, 'Undo', () => undoLastOrganize(), …);
//
// `recordToLedger` is `async` and was NOT awaited, so two things were wrong at once:
//
// 1. THE RACE. `ledgerRecord` is what stamps `config.lastLedger`, and `reverseLastLedger` is its only
//    consumer. Click Undo before that IPC lands and the reversal sees no delta and returns 0 — then
//    `organize:undo` sets `config.lastOrganize = null`, destroying the second chance. The in-flight
//    write then lands for clips that are no longer filed, leaving a phantom project whose dates and
//    subjects keep scoring future imports. That is exactly what audit #37 removed, re-created through
//    a timing hole.
//
// 2. THE try/catch CAUGHT NOTHING. Wrapping an un-awaited async call in try/catch cannot catch its
//    rejection — the function returns a promise immediately and the rejection surfaces later as an
//    unhandled rejection. The `/* non-fatal */` comment described a guarantee that wasn't there.
//
// Awaiting is cheap here, which is what makes this the right fix rather than a trade-off: the only
// awaited work inside `recordToLedger` is the single `ledgerRecord` IPC. The slow part — the
// per-project AI summaries — is already deliberately fire-and-forget in a detached async IIFE, so it
// does not delay the toast.
//
// Renderer-only and inside a DOM click handler, so the vm harness cannot invoke it: asserted against
// the source, naming the specific ordering that would go missing rather than a bare identifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '07-organize-map.js'), 'utf8');

test('the ledger write is awaited', () => {
  assert.match(src, /await\s+recordToLedger\s*\(/, 'recordToLedger is awaited, so lastLedger is stamped before anything can undo');
});

test('it is awaited BEFORE the Undo is offered', () => {
  // Ordering is the whole point — an await placed after the toast would still match the test above.
  // Match the CALL, not the definition: `async function recordToLedger(clips, placement, results)`
  // also starts with "recordToLedger(clips", and indexOf found that first — which made `between`
  // span most of the file and fail for the wrong reason. The call passes `r.results`.
  const call = src.indexOf('recordToLedger(clips, placement, r.results');
  // Anchor on the START of the toast call, not its 'Undo' argument: a slice ending at the argument
  // necessarily contains the `showToastAction(` that introduces it, so the old between-check could
  // never pass. Assert the positions directly instead.
  const toast = src.indexOf('showToastAction(`Filed');
  assert.ok(call > 0 && toast > 0, 'found both sites');
  assert.ok(call < toast, 'the ledger write is issued before the Undo is offered');
  // STRIP COMMENTS before asserting on code. The lines between these two sites include an
  // explanatory comment that mentions `undoLastOrganize()`, which matched and failed the check —
  // the same "source text includes comments" trap this repo already documents for
  // Function.prototype.toString().
  const between = src.slice(call, toast).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(between, /undoLastOrganize\s*\(/, 'and no code can trigger an undo in between');
});

test('the summary pass stays detached, so awaiting does not stall the toast', () => {
  // If someone "tidies" the detached IIFE into an awaited loop, Apply would block on one AI text
  // call per touched project before the user sees anything. Awaiting the record is only acceptable
  // because this part is not awaited.
  const fn = src.slice(src.indexOf('async function recordToLedger'), src.indexOf('\n}', src.indexOf('async function recordToLedger')));
  assert.match(fn, /\(async \(\) => \{/, 'the summary loop still runs detached');
  assert.match(fn, /await window\.api\.ledgerRecord/, 'while the ledger record itself is awaited inside');
});

test('the ledger record is still non-fatal to the filing run', () => {
  // The files are already filed by this point. A ledger failure must not throw out of the handler and
  // strand the UI — but now that the call is awaited, the try/catch around it genuinely works.
  const call = src.indexOf('await recordToLedger(clips');
  const line = src.slice(src.lastIndexOf('\n', call), src.indexOf('\n', call));
  assert.match(line, /try\s*\{/, 'still wrapped');
  assert.match(line, /catch/, 'and still swallows a ledger failure rather than failing the run');
});
