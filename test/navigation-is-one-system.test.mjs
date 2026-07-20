// UI audit batch 3 (2026-07-20). Two of these corrected the audit rather than following it, which is
// the more useful outcome — a recommendation applied without checking would have caused a regression.
//
//   4. ⚠ The Done screen's "Copied & named — in your Uncompressed folder" panel was WRONG on the
//      phone flow: phone videos stage in `_Phone Video Temp`, which is why that same screen shows a
//      "Send N videos to Uncompressed" button. The static panel claimed the files were already in
//      the folder the button below it was offering to put them in.
//
//   6. ⚠⚠ THE AUDIT WAS WRONG, AND MERGING WOULD HAVE BROKEN LAYOUT. `.ghost` and `.subtle` do look
//      pixel-identical — same transparent background, same hover, same active. But they are NOT
//      interchangeable: `.row-actions` orders buttons BY CLASS, and ghost (order 6, "Back/dismiss")
//      and subtle (order 8, "utilities → far right") sit in different slots. Consolidating them, as
//      recommended, would silently reorder buttons across every footer in the app. Kept both,
//      documented the distinction, and pinned the ordering system so nobody merges them later.
//
//   7. ⚠ Half of this finding also dissolved on inspection. Every step footer IS a `.row-actions`,
//      and that container orders by class regardless of DOM order — so "three different button
//      orders" is not a visual problem at all. What WAS real: step 2's Continue was `class="btn"`
//      (order 4, "neutral middle") while steps 1 and 3 lead with a primary, so the one control that
//      moves him forward on the middle step was both the weakest-looking and parked mid-row. And the
//      escape control was called "Cancel" on one screen and "Back to home" everywhere else.
//
//  13/15. Every screen-SHOWING path now goes through `showScreen`. Migrating them surfaced two more
//      instances of the original bug: `goToRename` and `openFinalize` never hid `#phone` at all, so
//      arriving from the phone screen left it rendered underneath. And the File menu — described in
//      its own comment as the "navigation hub" — had no route to the Phone screen, while View
//      duplicated two File entries under different labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p) => readFileSync(join(process.cwd(), ...p), 'utf8');
const strip = (s) => s.replace(/\/\/.*$/gm, '');
const html = read('src', 'index.html');
const css = read('src', 'styles.css');
const core = strip(read('src', 'mod', '01-core.js'));
const fin = strip(read('src', 'mod', '09-phone-finalize.js'));
const menus = strip(read('src', 'mod', '06-menus.js'));

test('⚠ the Done screen tells the truth about where phone footage actually is', () => {
  const at = core.indexOf("const d1t = $('dnStep1T')");
  assert.ok(at > -1, 'the panel is set from code, not hardcoded');
  const end = core.indexOf("$('stepDone')", at);
  assert.ok(end > at, 'sliced the block');
  const body = core.slice(at, end);
  assert.match(body, /isPhoneFlow\(\)/, 'it branches on the flow');
  assert.match(body, /phone \? 'Pulled & named' : 'Copied & named'/, 'the verb matches what happened');
  assert.match(body, /phone \? 'In your phone video temp folder' : 'In your Uncompressed folder'/,
    '⚠ and the location is where the files really are');
  assert.match(html, /id="dnStep1T"/, 'the element is addressable');
});

test('⚠⚠ .ghost and .subtle are NOT merged — they order differently', () => {
  // The audit called them redundant. They are not: this is the rule that makes them mean different
  // things, and merging the classes would reorder every footer in the app.
  assert.match(css, /\.row-actions > \.btn\.ghost\s+\{ order: 6; \}/, 'ghost is the Back/dismiss slot');
  assert.match(css, /\.row-actions > \.btn\.subtle \{ order: 8; \}/, 'subtle is the utilities slot');
  assert.match(css, /\.row-actions > \.btn\.primary,\s*\n\.row-actions > \.btn\.danger \{ order: 1; \}/,
    'and the main action leads');
  assert.ok(css.indexOf('.btn.ghost, .btn.subtle { background: transparent') > -1,
    'they still SHARE the look — which is why they read as interchangeable');
});

test('⚠ the forward action is primary on every step, including the middle one', () => {
  // Step 2's Continue was `class="btn"` — order 4, neutral middle — while steps 1 and 3 lead with a
  // primary. The one control that moves him forward was the weakest-looking thing on the screen.
  assert.match(html, /<button id="finNext1Btn" class="btn primary"/, 'step 1');
  assert.match(html, /<button id="finNext2Btn" class="btn primary">Continue →<\/button>/, 'step 2');
  assert.doesNotMatch(html, /<button id="finNext2Btn" class="btn">/, 'no longer neutral');
});

test('⚠ one label for leaving a screen', () => {
  // It was "Cancel" on the card flow and "Back to home" everywhere else — and it now literally calls
  // goHome(), so "Cancel" also implied undoing a copy that it does not undo.
  assert.match(html, /<button id="cancelFlowBtn" class="btn ghost">Back to home<\/button>/, 'card flow');
  assert.match(html, /class="btn ghost fin-home">Back to home<\/button>/, 'and the finalize steps agree');
  // ⚠ Scoped to NAVIGATION. My first version banned every "Cancel" in the file and failed on
  // #phCopyCancel — which cancels a running phone copy. That one is correctly named: it aborts an
  // operation rather than leaving a screen, and renaming it would be the opposite of this fix.
  const cancels = [...html.matchAll(/<button id="([^"]+)"[^>]*>Cancel<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(cancels, ['phCopyCancel'],
    `only an operation-abort may be called Cancel — found ${cancels.join(', ')}`);
});

test('⚠⚠ EVERY screen-showing path goes through showScreen', () => {
  // The regression guard for the whole class of bug. A new `$('flow').classList.remove('hidden')`
  // anywhere means someone has hand-rolled the hide-list again — which is how goToCopyProgress came
  // to leave #finalize visible, and how goToRename/openFinalize came to never hide #phone.
  for (const [name, src] of [['01-core.js', core], ['09-phone-finalize.js', fin]]) {
    const shows = (src.match(/\$\('(?:flow|finalize|phone)'\)\.classList\.remove\('hidden'\)/g) || []);
    assert.deepEqual(shows, [], `⚠ ${name} shows a screen without showScreen: ${shows.join(', ')}`);
  }
});

test('the migrated entry points really do call it', () => {
  // Prove the paths exist rather than inferring it from the absence above — a file that no longer
  // opened any screen would also pass that test.
  for (const [fn, screen] of [['async function openPhone', 'phone'], ['async function goToRename', 'flow'], ['async function openFinalize', 'finalize']]) {
    const at = fin.indexOf(fn);
    assert.ok(at > -1, `found ${fn}`);
    const body = fin.slice(at, at + 600);
    assert.match(body, new RegExp(`showScreen\\('${screen}'\\)`), `${fn} opens ${screen} through the helper`);
  }
  const sf = core.indexOf('async function startFlow');
  assert.ok(sf > -1, 'found startFlow');
  assert.match(core.slice(sf), /showScreen\('flow'\)/, 'startFlow too');
});

test('⚠ the File menu can reach every main screen, including Phone', () => {
  // It calls itself the navigation hub and had no route to the phone screen at all — reachable only
  // by clicking a device row. "Phone backup folder (wireless)…" is a folder picker, not the screen.
  const at = menus.indexOf('  file: [');
  assert.ok(at > -1, 'found the File menu');
  const body = menus.slice(at, menus.indexOf('\n  ],', at));
  assert.match(body, /\{ label: 'Home', action: goHome \}/, 'home');
  assert.match(body, /\{ label: 'Name & copy clips', action: goToRename \}/, 'rename');
  assert.match(body, /\{ label: 'Organize & back up…', action: openFinalize \}/, 'organize');
  assert.match(body, /\{ label: 'Back up a phone…', action: \(\) => openPhone\(\) \}/, '⚠ and the phone screen');
});

test('⚠ View no longer duplicates File’s navigation under other names', () => {
  const at = menus.indexOf('  view: [');
  assert.ok(at > -1, 'found the View menu');
  const body = menus.slice(at, menus.indexOf('\n  ],', at));
  assert.doesNotMatch(body, /'Back to home'/, '⚠ two labels for one destination is the complaint');
  assert.doesNotMatch(body, /'Open Uncompressed folder'/, 'and this was a straight duplicate of File');
  // The view OPTIONS must survive — this was a de-duplication, not a deletion.
  assert.match(body, /Play audio on hover/, 'view options are untouched');
});
