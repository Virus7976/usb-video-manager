// "Confirm all suggestions" asked him to accept an unknown quantity.
//
// The bulk-accept in the face review tags every suggested person across all their clips in one click
// — borderline suggestions included. It is the single biggest lever on his **458 pending clusters**,
// and the button named the action without naming its size. The difference between confirming 3 and
// confirming 90 is the difference between a glance and a decision, and he could not tell which he was
// making.
//
// Same principle applied to auto mode an hour earlier (`ae`): **something that acts in bulk has to be
// legible BEFORE it acts.** Here it is one word — the count — and it costs nothing.
//
// The count is computed with the SAME filter the click handler uses. A number derived separately
// could promise a different action than the one performed, which on face identity means promising a
// different set of names written into his footage.
//
// ⚠ NOT auto-confirmation. Tier 2 item 24 ("auto-confirm above a confidence he sets") is logged as
// QUESTIONS.md Q6 and deliberately not built: it decides identity without asking, and that identity
// is embedded into his files. Showing him the scale is the part that needs no decision from him.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8').replace(/\/\/.*$/gm, '');

const FILTER = "clusters.filter((c) => !c.done && !c.skipped && c.suggest && !c.rejected)";

test('⚠ the button says how many it will confirm', () => {
  assert.match(src, /Confirm all \$\{n\} suggestion\$\{n !== 1 \? 's' : ''\}/, 'the count is in the label');
});

test('⚠⚠ the count uses the SAME filter as the click handler', () => {
  // Two counts of "what is pending" that can disagree is a button that lies about what it does — and
  // here the lie would be about which names get written into his footage.
  const uses = src.split(FILTER).length - 1;
  assert.equal(uses, 2, `the label and the action share one definition of pending — found ${uses} uses`);
});

test('the label falls back cleanly when there is nothing to count', () => {
  // The button is hidden in that case, but a label reading "Confirm all 0 suggestions" would be a bug
  // waiting for the first time the hide condition and the count disagree.
  assert.match(src, /: 'Confirm all suggestions';/, 'a sane fallback');
});

test('the button is still hidden when nothing is suggested', () => {
  // Guard the existing behaviour: naming the count must not have made it always visible.
  assert.match(src, /btn\.style\.display = anySuggested \? '' : 'none';/, 'unchanged');
});

test('⚠ the bulk action still drops a restore point first', () => {
  // The safety this button already had, on his most laborious data. A wrong suggestion confirmed
  // across 40 clips needs one undo, not 40.
  const at = src.indexOf(".fg-confirm-all').addEventListener");
  assert.ok(at > -1, 'found the click handler');
  const handler = src.slice(at, src.indexOf('\n  });', at));
  assert.ok(handler.length > 0, 'sliced it');
  assert.match(handler, /saveVersionPoint\(/, 'a restore point is taken');
  assert.match(handler, /pending\.length >= 5/, 'for anything big enough to be worth it');
});

test('and it still funnels every confirmation through assign()', () => {
  // assign() is what persists the tag, the enrolment and the undo receipt. A bulk path that wrote
  // directly would skip all three.
  const at = src.indexOf(".fg-confirm-all').addEventListener");
  const handler = src.slice(at, src.indexOf('\n  });', at));
  assert.match(handler, /await assign\(c, c\.suggest\.name\)/, 'one code path for every confirmation');
});
