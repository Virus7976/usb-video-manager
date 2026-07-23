// ⚠⚠ THE MESSAGES SAYING A SECOND COPY DID NOT HAPPEN VANISHED WITH THE SCREEN.
//
// Probed the NAS-unreachable case, which is a real state for him — his backup target is a network
// share. With a NAS path that genuinely cannot be created, filing behaves WELL:
//
//     run    : ok=true moved=4 backedUp=0
//     errors : ["Backup 2026-06-01_…: ENOTDIR …", ×4]
//
// `backedUp: 0` is honest, the count is shown with a warning class, and the messages are listed on
// screen. That is most of the job and it was already right — this is not a bug report about filing.
//
// The gap is durability. That list disappears the moment he navigates away, and the only other copy
// went to `console.warn`, which he will never open. "A second copy of this footage does not exist"
// is exactly the kind of fact he needs to find TOMORROW, not in the ten seconds after a run —
// especially since the delete gate's whole premise is that copies provably exist elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const boot = readFileSync(join(ROOT, 'src/mod/10-boot.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('⚠⚠ run errors are written to the issue log, not just the screen', () => {
  const at = boot.indexOf('summary.errors && summary.errors.length');
  assert.ok(at > -1, 'the error block exists');
  const body = boot.slice(at, at + 1400);
  assert.match(body, /logIssue\('Organize', String\(e\)\)/,
    '⚠⚠ each issue reaches the log that answers "what did it actually do"');
  assert.match(body, /finResultList/, '⚠ and the on-screen list is still there too');
});

test('⚠ a 310-clip run cannot bury the log', () => {
  // One error per clip is realistic when a backup target is unreachable. Writing all 310 would push
  // every other entry out of the log he reads.
  const at = boot.indexOf('summary.errors && summary.errors.length');
  const body = boot.slice(at, at + 1400);
  assert.match(body, /summary\.errors\.slice\(0, 30\)/, '⚠ capped');
  // ⚠ ASSERT THE GUARD, NOT JUST THE MESSAGE. The first version matched only the "…and N more"
  // string, so replacing `if (summary.errors.length > 30)` with `if (false)` left the text sitting
  // in the source and the test green. A disabled branch is invisible to a test that only greps for
  // what it would have printed. Caught by breaking it.
  assert.match(body, /if \(summary\.errors\.length > 30\) \{/,
    '⚠⚠ the overflow branch is live, not just present');
  assert.match(body, /and \$\{summary\.errors\.length - 30\} more/,
    '⚠⚠ and the cap is STATED — a silent truncation reads as "that was all of them"');
});

test('⚠ logging cannot break the run summary', () => {
  // This runs after the footage has already moved. A throw here would replace a successful run's
  // summary with an error, which is the opposite of the truth.
  const at = boot.indexOf('summary.errors && summary.errors.length');
  const body = boot.slice(at, at + 1400);
  assert.match(body, /try \{ logIssue/, '⚠ guarded');
});
