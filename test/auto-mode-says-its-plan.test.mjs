// Tier 1 item 10 — "a single 'Do it all' button with a plain-English preview of every step it will
// take."
//
// The button already existed. The preview did not: auto mode announced itself with
// **"⚡ Auto mode — copying to intake…"**, which tells him a MODE is on, not what is about to happen
// to his footage. A thing that acts on its own has to be legible BEFORE it acts — otherwise the only
// way to know what it did is to go and look afterwards, which is the exact habit this app exists to
// break.
//
// Now it says the run: how many clips and photos, where they are going, whether the NAS mirror is on,
// that every copy is verified — and, last, the fact he most needs to be certain of: **nothing on the
// card is deleted.** Card deletes are the one irreversible act and are never automated
// ([[usb-app-delete-gate]]); an automatic mode that did not say so out loud would be quietly asking
// him to trust it on precisely the point where trust matters most.
//
// The counts come from the SAME helpers the copy uses (`filesToCopy`, `clipPhotos`, `cfg.nasBackup`),
// so the sentence cannot describe a different run than the one that follows. A preview computed
// separately from the action is the "two implementations that disagree" shape, and here it would be a
// promise about his footage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8');
const src = raw.replace(/\/\/.*$/gm, '');

const planFn = (() => {
  const i = src.indexOf('function autoModePlan');
  assert.ok(i > -1, 'found autoModePlan');
  const end = src.indexOf('\n}', i);
  assert.ok(end > i, 'and its end');
  return src.slice(i, end);
})();

test('⚠ auto mode states its plan instead of announcing a mode', () => {
  assert.match(src, /showToast\(autoModePlan\(\), \d+\)/, 'the trigger shows the plan');
  assert.doesNotMatch(src, /'⚡ Auto mode — copying to intake…'/, 'the old mode-only message is gone');
});

test('⚠⚠ it promises that nothing is deleted', () => {
  // The single most important sentence in an automatic mode, on an app whose one irreversible act is
  // clearing a card.
  assert.match(planFn, /Nothing on the card is deleted/, 'said plainly');
  assert.match(planFn, /separate step you do/, 'and whose job it remains');
});

test('⚠ the counts come from the same helpers the copy uses', () => {
  // A preview computed independently of the action is a promise the run need not keep.
  assert.match(planFn, /filesToCopy\(\)\.length/, 'clips, from the copy list itself');
  assert.match(planFn, /clipPhotos\(\)\.length/, 'photos, likewise');
});

test('it names the destination, and the NAS only when it is really on', () => {
  assert.match(planFn, /isPhoneFlow\(\) \? 'Uncompressed' : 'your intake folder'/, 'the right destination per flow');
  assert.match(planFn, /cfg\.nasBackup && cfg\.nasBackup\.enabled && cfg\.nasBackup\.path/,
    'the NAS clause requires it to be enabled AND configured');
});

test('it says the copies are verified', () => {
  // Verification is the reason he can trust the copy at all — and it is invisible unless said.
  assert.match(planFn, /verifying every copy/, 'stated');
});

test('⚠ an empty card does not produce a nonsense sentence', () => {
  // With no clips and no photos the counts are 0, and "copying  → your intake folder" would read as
  // broken. There is a fallback subject.
  assert.match(planFn, /\|\| 'this card'/, 'falls back to something readable');
});

test('the numbers are pluralised honestly', () => {
  assert.match(planFn, /clip\$\{vids !== 1 \? 's' : ''\}/, 'clips');
  assert.match(planFn, /photo\$\{pics !== 1 \? 's' : ''\}/, 'photos');
});

test('the toast lasts long enough to read', () => {
  // The old one was 3 s for six words. This is a sentence he is meant to actually read before his
  // footage starts moving.
  const at = src.indexOf('showToast(autoModePlan()');
  const call = src.slice(at, src.indexOf(')', src.indexOf(',', at)) + 1);
  const ms = Number((call.match(/,\s*(\d+)\)/) || [])[1] || 0);
  assert.ok(ms >= 5000, `at least five seconds — got ${ms}`);
});

test('⚠ auto mode still never touches the delete step', () => {
  // The guard that matters more than any wording. Nothing in the auto path may call the delete flow.
  const at = src.indexOf('if (autoMode() && !copyInProgress) {');
  assert.ok(at > -1, 'found the auto trigger');
  const block = src.slice(at, src.indexOf('\n  }', at));
  assert.ok(block.length > 0, 'sliced it');
  assert.doesNotMatch(block, /deleteSource|delete:source|buildDeleteStep/, 'it only copies');
});
