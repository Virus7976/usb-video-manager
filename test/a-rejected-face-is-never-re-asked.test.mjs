// Tier 2 item 26 — "never re-ask a face he has already answered, anywhere in the app."
//
// Checked rather than assumed, and it is already correct — but for a reason subtle enough that an
// innocent-looking optimisation would break it silently.
//
// A scan starts from the PERSISTED clusters (`loadPendingFaces`) and merges into them, so `done`,
// `skipped` and `rejected` survive. The part that matters is the merge condition:
//
//     let c = clusters.find((u) => faceDist(u.descriptor, f.descriptor) < FACE_CLUSTER_DIST);
//
// It searches **every** cluster, including ones he has already answered. So when the same person is
// detected again on a later card, the face merges into the cluster he rejected and inherits that
// rejection — it never returns to the grid.
//
// The tempting "optimisation" is to search only unresolved clusters, since those are the ones the grid
// renders. That would look faster, pass every existing test, and quietly resurrect **every face he has
// ever said no to** on the next scan. On a 458-cluster pile with 41 recorded "✗ No" answers, that is
// the app forgetting his decisions — the single thing he named as unacceptable.
//
// So this pins the property, not the implementation: the search is over all clusters, and answered
// state is carried through the store round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('⚠⚠ EVERY merge site searches ALL clusters, not only unanswered ones', () => {
  // There are TWO cluster-merge sites — the card scan and the Organize-screen scan. My first version
  // checked `indexOf` alone, so the second was unguarded: the exact "one path fixed, its twin missed"
  // shape that has produced a confirmed bug on four separate days here. Found because a break script
  // asserted its target appeared once and it appeared twice.
  const lines = [...src.matchAll(/^.*let c = clusters\.find\([^\n]*$/gm)].map((m) => m[0]);
  assert.equal(lines.length, 2, `both scan paths are checked — found ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /clusters\.find\(\(u\) => faceDist\(u\.descriptor, f\.descriptor\) < FACE_CLUSTER_DIST\)/,
      `matched purely on face distance — got ${line.trim()}`);
    assert.doesNotMatch(line, /rejected|done|skipped/,
      `⚠ filtering answered clusters out here would re-ask every face he has said no to — got ${line.trim()}`);
  }
});

test('a scan starts from the persisted clusters rather than an empty list', () => {
  // If a scan began from [], the merge above would have nothing to merge into and every answered face
  // would come back as new — the same bug by a different route.
  assert.match(src, /clusters = await loadPendingFaces\(\);/, 'seeded from the store');
});

test('the answered flags survive the round trip to disk', () => {
  // The flags are only useful if they persist. Both directions matter: written on save, restored on
  // load — a serializer that dropped `rejected` would lose his answers at the next launch.
  const saves = (src.match(/rejected: !!c\.rejected/g) || []).length;
  assert.ok(saves >= 2, `rejected is carried in the serialised shape — found ${saves}`);
});

test('⚠ an answered cluster is excluded from the REVIEW, not from the merge', () => {
  // The distinction that makes the whole thing work: the grid hides what he has answered, while the
  // merge still sees it. Both behaviours are required, and they read almost identically.
  assert.match(src, /live\.filter\(\(c\) => !c\.done && c\.suggest && !c\.rejected\)/, 'the grid filters answered out');
  assert.match(src, /clusters\.filter\(\(c\) => !c\.done && !c\.skipped && c\.suggest && !c\.rejected\)/,
    'and so does the bulk confirm');
});

test('keyboard navigation also skips what he has answered', () => {
  // The same rule in the third place it has to hold — otherwise Tab lands him back on a rejected face.
  assert.match(src, /!c\.done && !c\.rejected && !c\.skipped/, 'focus skips answered clusters');
});
