// Two overlapping face scans could throw away confirmed faces.
//
// `scanFacesForClips` is a load-modify-replace across a very long await:
//     clusters = await loadPendingFaces();     // snapshot the whole review
//     … minutes of GPU face detection …
//     savePendingNow(clusters);                // and the main handler REPLACES the store:
//                                              //   config.ai.facesPending = list
// Two runs both snapshot, both replace, and the later one wins — so everything the first run
// clustered, named or confirmed is gone.
//
// REACHABILITY, checked rather than assumed (this is what makes it a bug and not a hazard). There
// are three entry points and NONE of them guards or disables:
//     src/mod/08-people.js  scanFacesSelected()      -> the standalone "just scan faces" action
//     src/mod/08-people.js  q('.pd-scan') click      -> the People dashboard, which close()s first
//     src/mod/04-tasks-ai.js                          -> the Analyze flow's scan phase
// A face scan is minutes of GPU work over a card of clips, so a second invocation during the first
// is an ordinary thing to do, not a millisecond-wide window.
//
// `faceScanActive` already existed — but only to widen the save debounce (`audit #67`), never as a
// guard. It is set before the long work and cleared in a `finally`, which is exactly the shape a
// re-entrancy guard needs, so this promotes it rather than adding a second flag. The codebase's own
// model for this is `aiAutoEnhance`'s `autoEnhancing`.
//
// Renderer-only, so asserted against the source — comments stripped, naming the exact expressions,
// per the rule this session paid for repeatedly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8');
const src = raw.replace(/\/\/.*$/gm, '');
// The function body, sliced to the start of the NEXT top-level function — never a fixed window.
const fnStart = src.indexOf('async function scanFacesForClips');
const fn = src.slice(fnStart, src.indexOf('\nasync function ', fnStart + 10));

test('a second scan is refused while one is running', () => {
  assert.ok(fnStart > 0, 'found scanFacesForClips');
  assert.match(fn, /if \(faceScanActive\)/, 'the in-flight flag is checked, not just used for debounce timing');
});

test('the refusal happens BEFORE the store is read', () => {
  // Guarding after `await loadPendingFaces()` would be useless: the second run would already hold a
  // snapshot it could later write back over the first run's work.
  const guard = fn.indexOf('if (faceScanActive)');
  const load = fn.indexOf('await loadPendingFaces()');
  assert.ok(guard > 0 && load > 0, 'found both');
  assert.ok(guard < load, 'the guard precedes every read of the pending store');
});

test('the refusal is VISIBLE — it does not look like a no-op', () => {
  // A silent return on a button click reads as "the app ignored me". The codebase convention is to
  // say something.
  // Same LINE as the guard, not "somewhere in the next 300 characters" — a window that size reaches
  // unrelated toasts further down the function, and did: making the guard silent left this green.
  assert.match(fn, /if \(faceScanActive\)[^\n]*showToast\(/, 'the user is told why nothing started');
});

test('the flag is still cleared in a finally, so a failed scan cannot wedge the guard', () => {
  // The whole reason this flag is safe to promote: a scan that throws must not leave face scanning
  // permanently refused for the rest of the session.
  const fin = fn.slice(fn.lastIndexOf('} finally {'));
  assert.match(fin, /faceScanActive = false/, 'cleared on every exit path');
});

test('the flag is set before the long work, not after it', () => {
  // Target the CUMULATIVE load (`clusters = await …`), not the first textual match: an earlier
  // branch reopens a saved review and returns without scanning, so it legitimately reads the store
  // before the flag is claimed.
  const set = fn.indexOf('faceScanActive = true');
  const load = fn.indexOf('clusters = await loadPendingFaces()');
  assert.ok(set > 0 && load > 0, 'found both');
  assert.ok(set < load, 'the window between claiming the scan and reading the store is closed');
});

test('the one-time re-detect recursion is not blocked by its own guard', () => {
  // scanFacesForClips calls ITSELF for the "no saved review — detect now?" path. That recursion
  // happens before the flag is set, and must keep working; a guard that killed it would make the
  // first-run offer do nothing.
  const recurse = fn.indexOf('return scanFacesForClips(clipList');
  const set = fn.indexOf('faceScanActive = true');
  assert.ok(recurse > 0, 'the self-call still exists');
  assert.ok(recurse < set, 'and it runs before the flag is claimed, so it is unaffected');
});
