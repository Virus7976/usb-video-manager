// UI audit batch 2 (2026-07-20) — the findings where the app told him something untrue about his
// own footage, plus the structural one that caused a whole class of them.
//
//   13. ⚠⚠ SIX HAND-ROLLED HIDE-LISTS. `#flow`, `#finalize` and `#phone` are sibling sections, and
//       "showing" one meant hand-writing the list of the others to hide. They had drifted:
//       `goToCopyProgress` showed `#flow` without hiding `#finalize`/`#phone`, and the copy chip that
//       calls it is a GLOBAL top-bar control clickable from any screen — so clicking it from Organize
//       rendered the Organize screen on top of the copy progress. Now one `showScreen(id)` derived
//       from an array, so a screen added later is hidden by every other screen automatically.
//   10. ⚠ The step-2 hero told PHONE users "the originals stay safe on the card until Step 3" — the
//       files are already on the computer, and Step 3 is not even reachable on that flow (setStep(3)
//       refuses with a toast). Those toasts also said "card"/"drive" unconditionally.
//    9. The Copy button label flipped format: `renderUploadList()` re-runs on every checkbox toggle
//       and rewrote the label the phone branch had set OUTSIDE it, so it read "Copy out" until he
//       ticked anything, then permanently named a card-flow destination.
//   11. Two `primary` buttons on the Done screen — and the `primary` one was "Close" (which actually
//       calls hideWindow()), while the action the screen's OWN text points at was `ghost`.
//    8. (AI backlog) Face-chip ranking tier 2 read `p.faces.length`, but `people:get` never sends a
//       faces array. Always 0, so chips fell through to alphabetical — the raw-store-order problem
//       the ranking was written to replace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p) => readFileSync(join(process.cwd(), ...p), 'utf8');
const strip = (s) => s.replace(/\/\/.*$/gm, '');
const html = read('src', 'index.html');
const core = strip(read('src', 'mod', '01-core.js'));
const fin = strip(read('src', 'mod', '09-phone-finalize.js'));
const people = strip(read('src', 'mod', '08-people.js'));

test('⚠⚠ ONE place decides which screen is visible, and it is derived from a list', () => {
  const at = core.indexOf('function showScreen(id)');
  assert.ok(at > -1, 'showScreen exists');
  const end = core.indexOf('\n}', at);
  assert.ok(end > at, 'and has a body');
  const body = core.slice(at, end);
  assert.match(core, /const APP_SCREENS = \['flow', 'finalize', 'phone'\];/,
    'the screens are a list, not a hand-written hide sequence');
  assert.match(body, /for \(const s of APP_SCREENS\)/, 'and every one of them is considered');
  assert.match(body, /classList\.toggle\('hidden', s !== id\)/,
    '⚠ showing one screen hides ALL the others — that is the whole point');
});

test('⚠⚠ the copy-progress screen hides the others (the stacking bug)', () => {
  const at = fin.indexOf('function goToCopyProgress');
  assert.ok(at > -1, 'found goToCopyProgress');
  const end = fin.indexOf('\n  if (status', at);
  assert.ok(end > at, 'sliced its head');
  const body = fin.slice(at, end);
  assert.match(body, /showScreen\('flow'\)/,
    '⚠ it must go through showScreen — showing #flow alone left Organize rendered on top');
  assert.doesNotMatch(body, /\$\('flow'\)\.classList\.remove\('hidden'\)/, 'the bare show is gone');
});

test('goHome uses the same helper, so home and the flow cannot disagree', () => {
  const at = people.indexOf('async function goHome');
  const body = people.slice(at, people.indexOf('\n}', at));
  assert.match(body, /showScreen\('home'\)/, 'one code path for both');
});

test('⚠ the phone flow is never told its originals are safe on a card', () => {
  // The claim was false in two ways: the files are already on the computer, and the Step 3 it
  // promises is unreachable on that flow.
  const at = fin.indexOf("const heroT = $('upHeroTitle')");
  assert.ok(at > -1, 'the hero is set from code');
  const end = fin.indexOf('\n  renderUploadList();', at);
  assert.ok(end > at, 'sliced the hero block');
  const body = fin.slice(at, end);
  assert.match(body, /if \(isPhoneFlow\(\)\)/, 'it branches on the flow');
  assert.match(body, /Nothing is removed from your phone\./, 'and says something true for a phone');
  // The card wording must survive for the card flow — this is a branch, not a replacement.
  assert.match(body, /The originals stay safe on the card until Step&nbsp;3\./, 'the card copy is intact');
});

test('⚠ the step toasts name the right source', () => {
  assert.match(fin, /const src = isPhoneFlow\(\) \? 'phone' : 'drive';/, 'derived, not hardcoded');
  assert.match(fin, /Nothing has been copied out yet — copy first\./, 'and the delete-step toast too');
});

test('⚠ the Copy button label is set INSIDE the renderer that rewrites it', () => {
  // The bug was purely one of placement: the phone branch ran once, at the call site, and every
  // subsequent renderUploadList() wiped it.
  const at = fin.indexOf('const phone = isPhoneFlow();');
  assert.ok(at > -1, 'the flow is read inside the render function');
  const listAt = fin.indexOf('function renderUploadList');
  assert.ok(listAt > -1 && listAt < at, 'and that is inside renderUploadList, not before it');
  // ⚠ Bind to the CONDITION, not just the string. My first version asserted the phone wording
  // appeared somewhere in the file — which stayed true when I broke the branch to `else if (false)`,
  // because the dead code still contained the text. The break passed and the test lied.
  assert.match(fin, /\} else if \(phone\) \{\s*\n\s*\$\('copyStartBtn'\)\.textContent = `Copy \$\{n\} video/,
    '⚠ the phone wording must be reached by the phone branch, not merely present in the file');
  assert.doesNotMatch(fin, /\$\('copyStartBtn'\)\.textContent = 'Copy out';/,
    '⚠ the one-shot override that got wiped is gone');
});

test('⚠ the card wording no longer names the intake folder by a fourth name', () => {
  assert.match(fin, /to your Uncompressed folder/, 'one name for the folder, in the button too');
});

test('⚠ the Done screen has ONE primary action, and it is the one it tells him to do', () => {
  const at = html.indexOf('<button id="phSendUncompressedBtn"');
  assert.ok(at > -1, 'found the Done action row');
  const end = html.indexOf('</div>', at);
  assert.ok(end > at, 'sliced the row');
  const row = html.slice(at, end);
  assert.match(row, /<button id="doneOrganizeBtn" class="btn primary">/,
    '⚠ Organize is the action the screen\'s own text points at, so it is the primary one');
  assert.match(row, /<button id="finishBtn" class="btn ghost">Hide<\/button>/,
    'and the tray button is secondary — and honestly labelled, since it calls hideWindow()');
  // phSendUncompressedBtn is `primary` too but starts `hidden` and only appears on the phone flow,
  // where it IS the next action — so it never competes with Organize on screen at the same time.
  assert.match(row, /id="phSendUncompressedBtn" class="btn primary hidden"/, 'the phone-only primary stays hidden by default');
});

test('⚠⚠ face chips rank by a field the store actually sends', () => {
  assert.match(people, /Number\(p\.confirmed\) \|\| Number\(p\.count\) \|\| 0/,
    '⚠ p.faces is never sent to the renderer — reading it made tier 2 always 0');
  assert.doesNotMatch(people, /\[p\.name, \(p\.faces && p\.faces\.length\) \|\| 0\]/, 'the dead read is gone');
  // And prove the field really is what main sends, so this can't rot the other way.
  const feedback = read('main-mod', '08-finalize-feedback.js');
  assert.match(feedback, /function personCounts\(p\) \{[^}]*return \{ count: fs\.length, confirmed: conf/,
    'people:get really does send count/confirmed');
});
