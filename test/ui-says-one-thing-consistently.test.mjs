// The first batch from the 2026-07-20 UI audit — Jake's own complaint: "the navigation is all over
// the place on the top bar and nothing is up to date. buttons are all over the place."
//
// These are the findings that MISLEAD rather than merely look untidy:
//
//   1. ⚠⚠ "Cancel" on the rename step was a hand-rolled copy of goHome() that had drifted five ways,
//      and one could cost footage: it never called `confirmLeaveTransfer()`. So "Back to home" from
//      every other screen warned him mid-copy, and the button literally labelled Cancel — on the
//      screen where the copy runs — walked out silently. It also left #finalize/#phone visible (so
//      Home could render stacked under another screen) and never refreshed the device list or the
//      "footage waiting" counts.
//   2. ⚠ A DRIVE card looked like navigation and did nothing visible; the identical-looking PHONE
//      card next to it opened a screen. `onDrive()` set state and explicitly HID the flow.
//   3. Three tool names for one step: the home card advertised "ffmpeg (H.264/H.265)" while the
//      screen opens in Tdarr/watch-folder mode by DEFAULT, and the Done panel said
//      "HandBrake / Resolve" — two apps this app never launches.
//   4. Four names for one folder — "intake folder", "Uncompressed folder", "01 - Uncompressed",
//      "Clips are copied to" — with two buttons calling the SAME handler under two different names.
//   5. A dead `finMap2Btn`: permanently `hidden`, nothing ever unhid it, but it carried a live
//      listener. Step 2 already renders that map inline and Step 3 has a working button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p) => readFileSync(join(process.cwd(), ...p), 'utf8');
const html = read('src', 'index.html');
const core = read('src', 'mod', '01-core.js').replace(/\/\/.*$/gm, '');
const menus = read('src', 'mod', '06-menus.js').replace(/\/\/.*$/gm, '');
const boot = read('src', 'mod', '10-boot.js').replace(/\/\/.*$/gm, '');

test('⚠⚠ Cancel goes home through goHome(), so it cannot skip the mid-copy warning', () => {
  assert.match(core, /\$\('cancelFlowBtn'\)\.addEventListener\('click', \(\) => \{ goHome\(\); \}\);/,
    '⚠ Cancel must delegate — a second implementation is what drifted away from confirmLeaveTransfer');
  // And prove the thing it now inherits actually exists, or delegating buys nothing.
  const people = read('src', 'mod', '08-people.js').replace(/\/\/.*$/gm, '');
  const at = people.indexOf('async function goHome');
  assert.ok(at > -1, 'goHome exists');
  const body = people.slice(at, people.indexOf('\n}', at));
  assert.match(body, /if \(!\(await confirmLeaveTransfer\(\)\)\) return;/, 'and it still guards a running transfer');
  // goHome hides the other screens through showScreen('home') since 2026-07-20 — there were 6+
  // hand-written hide-lists and they had drifted (goToCopyProgress left #finalize visible, so the
  // copy chip stacked two screens). The property is the same; it is just no longer open-coded here.
  assert.match(body, /showScreen\('home'\)/, 'and hides the other screens, via the one helper that does that');
});

test('⚠ Cancel no longer reimplements any of it', () => {
  // The regression this guards: someone "restoring" the inline version. Any of these lines appearing
  // inside the cancelFlowBtn handler means the divergence is back.
  // ⚠ Prove the INDEX resolved, not the slice length. A missing anchor gives indexOf -1, slice(-1)
  // returns the last character, and a `length > 0` check passes on that one character while the
  // negative assertion below matches nothing. The repo's own meta-test caught me doing exactly this.
  const at = core.indexOf("$('cancelFlowBtn')");
  assert.ok(at > -1, 'found the cancel handler');
  const goAt = core.indexOf('goHome();', at);
  assert.ok(goAt > at, 'and it delegates to goHome');
  const end = core.indexOf('\n', goAt);
  assert.ok(end > goAt, 'and the line ends');
  const handler = core.slice(at, end + 1);
  assert.ok(handler.length < 200, `the handler is one line — got ${handler.length} chars`);
  assert.doesNotMatch(handler, /saveSession|state\.copied|classList/,
    '⚠ any of these inside the handler means it is diverging from goHome again');
});

test('⚠ every device card navigates — the drive card no longer just highlights itself', () => {
  assert.match(core, /const openDrive = async \(drive\) => \{/, 'drives get an open path');
  assert.match(core, /onDrive\(drive\);/, 'the drive is still selected first — startFlow reads state.drive');
  assert.match(core, /startFlow\(\);/, '⚠ and then the flow actually opens');
  // All three card kinds go somewhere.
  assert.match(core, /if \(b\.dataset\.kind === 'phone'\) openPhone\(phones\[Number\(b\.dataset\.i\)\]\);/, 'phone');
  assert.match(core, /else if \(b\.dataset\.kind === 'pbfolder'\) openDrive\(/, 'backup folder');
  assert.match(core, /else openDrive\(drives\[Number\(b\.dataset\.i\)\]\);/, 'drive');
  assert.doesNotMatch(core, /else onDrive\(drives\[Number\(b\.dataset\.i\)\]\);/, 'the select-only path is gone');
});

test('⚠ opening a drive mid-copy does not stack two screens', () => {
  // onDrive already redirects to copy progress when a transfer is running; entering the flow on top
  // would put the flow over it — the same defect the global copy chip has.
  const at = core.indexOf('const openDrive = async (drive)');
  const body = core.slice(at, core.indexOf('\n  };', at));
  assert.match(body, /const cs = await window\.api\.copyStatus\(\);/, 'it checks first');
  assert.match(body, /if \(cs && cs\.active\) return;/, 'and does not open the flow over the progress screen');
});

test('⚠ the app names ONE compress story, and never a tool it cannot launch', () => {
  // Scoped to the COMPRESS step, not the whole file. My first version banned /HandBrake|Resolve/
  // globally and failed on the DaVinci Resolve CSV export and the "metadata Resolve reads" hints —
  // which are real features correctly naming a real tool. Banning a word is not the assertion; the
  // assertion is that the compress step doesn't send him to software this app never launches.
  const s2 = html.indexOf('<b>Compress them</b>');
  assert.ok(s2 > -1, 'found the compress step');
  const s3 = html.indexOf('<b>Organize &amp; back up</b>', s2);
  assert.ok(s3 > s2, 'and the step after it');
  const step2 = html.slice(s2, s3);
  assert.ok(step2.length < 400, `sliced just the compress step — got ${step2.length} chars`);
  assert.doesNotMatch(step2, /HandBrake|Resolve/,
    '⚠ the Done panel must not send him to apps this app never opens');
  assert.match(step2, /Use the Compress screen/, 'it points at the screen that actually exists');
  assert.doesNotMatch(html, /Shrink your intake clips with ffmpeg/,
    'the home card no longer advertises the mode that is NOT the default');
  assert.match(html, /Hand off to your watch-folder tool, or encode here/,
    'it describes the choice the screen actually offers');
  // And the default really is the watch-folder mode, which is what made the old copy wrong.
  assert.match(boot, /mode: d\.mode \|\| 'external'/, 'external/Tdarr is still the default mode');
});

test('⚠ ONE name for the Uncompressed folder', () => {
  // Four names for one folder, including two buttons on the SAME handler under different labels.
  assert.doesNotMatch(html, /intake folder/i, 'the HTML says Uncompressed');
  assert.doesNotMatch(menus, /'Open intake folder'/, 'and so does the File menu');
  const opens = (menus.match(/'Open Uncompressed folder'/g) || []).length;
  assert.equal(opens, 2, `both menu entries agree — found ${opens}`);
  assert.match(html, /Open Uncompressed folder/, 'and the button matches the menu');
});

test('the dead "Visualize destinations…" twin is gone, and the live ones remain', () => {
  assert.doesNotMatch(html, /finMap2Btn/, 'the permanently-hidden element is removed');
  assert.doesNotMatch(boot, /finMap2Btn/, '⚠ and its listener with it — an unreachable handler is a lie about the UI');
  // The capability must NOT have been removed with it.
  assert.match(html, /finMapBtn/, 'Step 3 still has a working button');
  assert.match(menus, /Visualize destinations…/, 'and the Edit-menu route still exists');
});
