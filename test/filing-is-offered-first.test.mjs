// ⚠⚠ HE HAS NEVER ONCE OPENED THE ORGANIZE SCREEN.
//
// Measured on his real interaction log: 1,487 clicks over 14 days of use. 226 "✓ Yes" face
// confirmations, 354 typed fields, 48 "Select all", 18 "Analyze selected" — and **0 clicks on
// `finalize`**. Not "few". None.
//
// Meanwhile the filing pipeline itself works: driven directly against his real layout, `finalize:run`
// moved 309 clips into 47 folders with 0 errors, 12.3% to `_unsorted`, 0 to the root, idempotent on
// re-run. The back half of this app is correct and unvisited.
//
// The Home "pending work" cards were ordered faces → phone → filing, so "footage ready to organize"
// sat THIRD, behind 458 pending faces and 700 staged phone videos. Both of those are PREPARATION.
// Filing is the payoff. Ordering preparation above payoff is how someone does 267 face decisions and
// files nothing — which is precisely the measured shape of his usage.
//
// This does not make filing louder or nag him. It puts the thing that finishes the job at the top of
// the list of things waiting for him.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = readFileSync(join(ROOT, 'src/mod/01-core.js'), 'utf8');

const at = (id) => core.indexOf(`id="${id}"`);

test('⚠⚠⚠ the filing card is offered BEFORE faces and phone', () => {
  const go = at('pwGo'); const faces = at('pwFaces'); const phone = at('pwPhone');
  assert.ok(go > -1 && faces > -1 && phone > -1, 'all three cards exist');
  assert.ok(go < faces, '⚠⚠⚠ filing comes before face review — payoff before preparation');
  assert.ok(go < phone, '⚠⚠⚠ and before the phone queue');
});

test('⚠ each card is still conditional — filing does not appear when there is nothing to file', () => {
  // Moving it first must not mean showing it always. A card offering to file nothing is worse than
  // no card: it teaches him the list is noise.
  // ⚠ Find the BLOCK GUARD, not the nearest `if (` — the card template is preceded by ternaries,
  // and "nearest if" landed on one of those. The first draft of this test failed for that reason,
  // which is the honest kind of failure: the assertion was wrong, not the code.
  const guardAt = core.indexOf('if (ready || uncompressed || uncPhotos) {');
  const goAt = core.indexOf('id="pwGo"');
  assert.ok(guardAt > -1, '⚠ the filing card is still inside a guard');
  assert.ok(guardAt < goAt, 'which encloses it');
  // And nothing else opens a card block between the guard and the button.
  const between = core.slice(guardAt, goAt);
  assert.ok(!/id="pwFaces"|id="pwPhone"/.test(between), '⚠ the guard belongs to THIS card');
});

test('⚠ the other two cards keep their own guards', () => {
  for (const [id, needle] of [['pwFaces', 'facesWaiting'], ['pwPhone', 'phoneStaged']]) {
    const idAt = core.indexOf(`id="${id}"`);
    const guard = core.lastIndexOf('if (', idAt);
    assert.match(core.slice(guard, core.indexOf('\n', guard)), new RegExp(needle),
      `⚠ ${id} is still conditional on ${needle}`);
  }
});

test('⚠⚠ the click handler is still wired to the filing screen', () => {
  // Reordering by moving a template block is exactly the kind of edit that can leave a button with
  // no listener — the block moved, the handler lookup did not.
  assert.match(core, /host\.querySelector\('#pwGo'\)/, 'the handler still finds the button');
  const goHandler = core.indexOf("querySelector('#pwGo')");
  const body = core.slice(goHandler, goHandler + 400);
  assert.match(body, /openFinalize|finalize/i, '⚠⚠ and still opens the Organize screen');
});
