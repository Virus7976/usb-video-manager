// ⚠⚠⚠ HIS OWN FILING RULES WOULD HAVE FORKED HIS PROJECTS TREE.
//
// Measured on his real config and his real disk, 2026-07-22. His two standing filing rules
// ("Calisthenics", "Lawn care (Gourgess Lawns)") store:
//
//     dest         = "2026/2026 - Client Work/Gourgess Lawns"
//     projectsRoot = "C:\Users\jakeg\Videos\02 - Projects\2026"
//
// `resolveFolderPath(projectsRoot, dest.split('/'))` therefore produces
//
//     .../02 - Projects/2026/**2026**/2026 - Client Work/Gourgess Lawns
//                            ^^^^^^ the root's own name, a second time
//
// beside the folder he actually uses. **117 of 309 clips** — the routed ones, his lawn and
// calisthenics work, the footage he cares most about — would land in that duplicate tree.
//
// HOW IT GOT THAT WAY, and why it is the app's fault rather than his. The Filing-rules picker offers
// paths relative to `projectsRoot` (`projects:tree`), so when he saved those rules the root was one
// level HIGHER — `...\02 - Projects` — and `2026/...` was correct. Then he clicked the AI health
// card's "No Projects folder set → Use that folder", which called `setProjectsRoot(defaultProjectsRoot())`
// and set it to the YEAR folder, one level deeper. **Nothing revalidates a stored route dest when the
// root moves.** A setting the app changed on his behalf silently invalidated a setting he had made.
//
// ⚠ WHY THE REPAIR IS NARROW. It fires ONLY when the first segment of the dest equals the root's own
// folder name AND the de-prefixed path exists on disk AND the prefixed one does not. All three, so it
// can never invent a destination or "helpfully" rewrite a tree he really does have nested that way —
// a real `.../2026/2026/` is left alone, because then the prefixed path exists and the rule declines.
// It prefers a folder he already has; it never creates one. That is the same rule `resolveFolderPath`
// already follows for case and separators.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base; let root;
before(() => { app = loadMain(); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ⚠ THE ROOT'S FOLDER MUST LITERALLY BE NAMED `2026`. The whole bug is that the dest's first segment
// equals the ROOT'S OWN NAME, so a `mkdtemp` root (`uvd-2026-XvKp2`) cannot reproduce it — the first
// draft of this file did exactly that and the fix "failed" against a fixture that was never the right
// shape. Build his actual layout: `<base>/02 - Projects/2026`, with the real project inside it.
beforeEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  base = mkdtempSync(join(tmpdir(), 'uvd-proj-'));
  root = join(base, '02 - Projects', '2026');
  mkdirSync(join(root, '2026 - Client Work', 'Gourgess Lawns'), { recursive: true });
});

const resolve = (dest) => app.call('resolveFolderPath', root, String(dest).split('/'));

test('⚠⚠⚠ a stale dest that re-prefixes the root name lands in the REAL folder', async () => {
  // The exact string from his config, against the exact shape of his tree.
  const out = await resolve('2026/2026 - Client Work/Gourgess Lawns');
  assert.equal(out, join(root, '2026 - Client Work', 'Gourgess Lawns'),
    '⚠⚠⚠ must join the folder he already has, not fork a duplicate beside it');
});

test('⚠⚠ when BOTH paths exist, the dest he wrote wins', async () => {
  // The over-correction that would be worse than the bug: he genuinely has `2026/2026/Archive` AND
  // `2026/Archive`, two real folders, and the rule says the first. Stripping would silently file into
  // the other one.
  //
  // ⚠ BOTH FOLDERS MUST EXIST FOR THIS TO TEST ANYTHING. The first draft created only the nested one,
  // so the de-prefixed path was missing and the repair declined for that reason instead — deleting
  // the guard left this test green. Caught by breaking it. This is the only arrangement in which the
  // `asWritten` guard is the thing making the decision.
  mkdirSync(join(root, '2026', 'Archive'), { recursive: true });
  mkdirSync(join(root, 'Archive'), { recursive: true });
  const out = await resolve('2026/Archive');
  assert.equal(out, join(root, '2026', 'Archive'),
    '⚠⚠ an existing prefixed path is real configuration, not staleness — it must be honoured');
});

test('⚠⚠ it never INVENTS a destination when neither path exists', async () => {
  // If the de-prefixed folder is not on disk either, there is nothing to prefer and no evidence the
  // dest is stale. Creating the de-prefixed one would be a guess about his tree.
  const out = await resolve('2026/Brand New Thing');
  assert.equal(out, join(root, '2026', 'Brand New Thing'),
    '⚠⚠ with no folder to prefer, the dest is used exactly as written');
});

test('⚠ a dest that does not start with the root name is untouched', async () => {
  const out = await resolve('2026 - Client Work/Gourgess Lawns');
  assert.equal(out, join(root, '2026 - Client Work', 'Gourgess Lawns'),
    '⚠ a correct dest must resolve exactly as before');
});

test('⚠ the match on the root name is case- and separator-insensitive, like the rest of the ladder', async () => {
  // `resolveFolderPath` already prefers his spelling over ours for case and separators; the prefix
  // check has to use the same rule or it fires inconsistently.
  const out = await resolve('2026/2026 - client work/gourgess lawns');
  assert.equal(out, join(root, '2026 - Client Work', 'Gourgess Lawns'),
    '⚠ his folder spelling still wins after the prefix is stripped');
});

test('⚠⚠ only ONE duplicate segment is stripped, not every matching segment', async () => {
  // Stripping greedily would eat a legitimate repeat deeper in the path.
  mkdirSync(join(root, 'Sub', '2026'), { recursive: true });
  const out = await resolve('2026/Sub/2026');
  assert.equal(out, join(root, 'Sub', '2026'),
    '⚠⚠ the leading duplicate goes; a later segment of the same name stays');
});

test('⚠ a single-segment dest equal to the root name is left alone', async () => {
  // `dest: "2026"` with root `.../2026` — stripping would leave NOTHING and file into the bare root,
  // which is the failure `finalize:run` has an explicit guard against.
  const out = await resolve('2026');
  assert.equal(out, join(root, '2026'),
    '⚠ stripping must never reduce a dest to nothing and dump into the root');
});
