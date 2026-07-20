// The same "empty clip list" bug as the Home-resume path (2026-07-19bx), on the path I did NOT fix.
//
// `scanFacesForClips(clipList, opts)` receives a perfectly good clip list and then hands the review
// grid `state.scannedFiles` instead — twice:
//
//     if (pending.length) { await showFaceReviewGrid(pending, state.scannedFiles, 0); return; }
//     if (clusters.length) await showFaceReviewGrid(clusters, state.scannedFiles, 0);
//
// The INTENT is documented and good: *"Pass ALL scanned clips (not just this batch) so confirming a
// merged-in face from an earlier scan still tags its clips."* But it is a SUBSTITUTION where a UNION
// was meant — and on the Organize screen `state.scannedFiles` is EMPTY.
//
// It is empty there because it is only ever assigned by the card scan and the phone staging flow. The
// Organize screen is reachable without either (Home's pending-work card, and session resume), and the
// face-scan entry points on that screen build their list from `finScan` instead — `currentSelectedClips()`
// explicitly branches on the finalize screen being visible.
//
// So scanning faces from Organize passed `[]`, and `byKey` is built purely from that argument:
//   • the group-shot sort collapses to '' vs '' and falls back to raw clipKey order — the "all the
//     photos are out of order" complaint again;
//   • the pop-out preview mirror never fires;
//   • in-memory people tagging on confirm is a silent no-op.
//
// The fix is the union the comment describes: the batch's own clips, plus everything scanned, so the
// documented cross-batch behaviour is preserved AND the Organize path stops handing over nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8').replace(/\/\/.*$/gm, '');
const fn = (() => {
  const i = src.indexOf('async function scanFacesForClips');
  return src.slice(i, src.indexOf('\nasync function ', i + 10));
})();

test('neither review call hands over state.scannedFiles alone', () => {
  assert.ok(fn.length > 0, 'found scanFacesForClips');
  assert.doesNotMatch(fn, /showFaceReviewGrid\([a-zA-Z]+,\s*state\.scannedFiles\s*,/,
    'no call passes the (possibly empty) global list as the whole clip context');
});

test('the batch it was given is always included', () => {
  // The clips it is scanning are the one thing guaranteed to be non-empty on every entry point.
  // Name the SPREAD, not the variable: `reviewClips` appears at both call sites too, so matching the
  // name stayed green when clipList was dropped from the union entirely.
  assert.match(fn, /\[\.\.\.\(clipList \|\| \[\]\), \.\.\.\(state\.scannedFiles/,
    'the caller-supplied clipList is unioned in, not replaced');
});

test('the documented cross-batch behaviour is kept', () => {
  // "Pass ALL scanned clips (not just this batch) so confirming a merged-in face from an earlier scan
  // still tags its clips." A union preserves that; dropping it would trade one bug for another.
  assert.match(fn, /state\.scannedFiles/, 'previously scanned clips are still contributed');
});

test('both review call sites use the same context', () => {
  // Two calls, one screen. They diverging is how this class of bug starts.
  const calls = fn.match(/showFaceReviewGrid\(([^)]*)\)/g) || [];
  assert.ok(calls.length >= 2, `found both calls — got ${calls.length}`);
  const ctxArg = calls.map((c) => c.split(',')[1] && c.split(',')[1].trim());
  assert.equal(ctxArg[0], ctxArg[1], `both pass the same clip context — got ${JSON.stringify(ctxArg)}`);
});

test('duplicates are not introduced when both sources overlap', () => {
  // On the card path clipList IS a subset of state.scannedFiles, so a naive concat would index every
  // clip twice. byKey would still resolve, but the "N clips" counts a cluster shows come from key
  // lookups — doubling the list is a silent way to make those wrong.
  // Name the CHECK, not the container: `const seen = new Set()` remains even when the guard that
  // uses it is removed, so matching /new Set/ stayed green with the dedupe disabled.
  assert.match(fn, /if \(seen\.has\(k\)\) continue;/, 'the union skips clips it has already added');
});
