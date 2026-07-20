// FEATURES.md items 7, 10 and 28 — three capabilities that were BUILT, SHIPPED and UNREACHABLE.
//
// Each had a working ipcMain handler and a preload binding, and no caller anywhere in the renderer.
// So each was a one-way door in the UI:
//
//   ·  7 — fast transfer (ADB) could be turned ON and never OFF. ADB is the flakier transport; a
//          phone that stops authorising, or a wireless pairing that drops, blocked every phone
//          transfer with no route back to MTP short of hand-editing config.json.
//   · 10 — the wireless backup folder could be SET and never UNSET, so a NAS path he stopped using
//          sat in the Devices list forever.
//   · 28 — a remembered field value could be added and never removed, so every typo he has ever
//          typed into a custom organizing field is offered back to him forever.
//
// The handlers are covered elsewhere; what was missing is the ROUTE. So these tests bind the caller
// to the bridge method, and — the part that matters — assert the surrounding safety, because two of
// the three are the "off switch" for something and an off switch that quietly does more than it says
// is worse than no off switch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const read = (...p) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\/\/.*$/gm, '');
const core = read('src', 'mod', '01-core.js');
const combo = read('src', 'mod', '02-combo.js');
const menus = read('src', 'mod', '06-menus.js');
const phone = read('src', 'mod', '09-phone-finalize.js');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// --- item 7: turn fast transfer back OFF -----------------------------------------------------

test('⚠⚠ there is a button that turns fast transfer off, and it calls the bridge', () => {
  const at = phone.indexOf('async function renderPhFast');
  assert.ok(at > -1, 'the fast-transfer card exists');
  const body = phone.slice(at, phone.indexOf('\nasync function showWirelessPairModal', at));
  assert.match(body, /id="phFastOff"/, 'the button is rendered');
  assert.match(body, /el\.querySelector\('#phFastOff'\)/, 'and looked up');
  assert.match(body, /await window\.api\.adbDisable\(\)/,
    '⚠ and actually invokes adb:disable — the handler that had no caller');
});

test('⚠ the off button is only offered when fast transfer is ON', () => {
  // Offering "turn it off" while it is already off is the kind of always-present control that makes
  // a status card unreadable — the card's whole job is to say which transport is in use.
  const at = phone.indexOf('async function renderPhFast');
  const body = phone.slice(at, phone.indexOf('\nasync function showWirelessPairModal', at));
  // ⚠ Anchor the split on the OFF-branch's own text, not on `} else {` — the on-branch has three
  // nested cases and one of them is itself an `} else {`, so a naive split put half the on-branch in
  // the off-branch and this test failed against correct code.
  const cut = body.indexOf("el.innerHTML = 'Transfers use MTP");
  assert.ok(cut > -1, 'found the off-branch');
  const onBranch = body.slice(body.indexOf('if (st.useAdb) {'), cut);
  const offBranch = body.slice(cut, body.indexOf('const b = el.querySelector'));
  assert.ok(onBranch.includes('offBtn'), 'the on-branch offers it');
  assert.ok(!offBranch.includes('offBtn'), '⚠ the off-branch does not');
  assert.match(offBranch, /phFastOn/, 'the off-branch offers turning it ON instead');
});

test('⚠ turning it off says what did NOT happen', () => {
  // "Fast transfer off" alone reads, on a screen about a connected phone, like something was done to
  // the phone. It only flips a config flag.
  const at = phone.indexOf("el.querySelector('#phFastOff')");
  const body = phone.slice(at, phone.indexOf('#phPairWifi', at));
  assert.match(body, /Nothing on your phone changed/, 'the toast is explicit about the blast radius');
  assert.match(body, /renderPhFast\(\)/, 'and the card re-reads the real state rather than assuming');
  assert.match(body, /catch \{[^}]*Could not turn fast transfer off/,
    'a failed call says so instead of showing a success message');
});

test('adb:disable really does turn it off in main', async () => {
  const cfg = app.get('config');
  cfg.useAdb = true;
  const r = app.plain(await app.invoke('adb:disable'));
  assert.equal(r.ok, true);
  assert.equal(app.get('config.useAdb'), false, 'the flag the transfer path reads is cleared');
});

// --- item 10: un-set the wireless backup folder ------------------------------------------------

test('⚠⚠ there is a route to stop using the wireless backup folder', () => {
  assert.match(menus, /Stop using the wireless backup folder/, 'it is in the File menu');
  assert.match(menus, /action: \(\) => stopWirelessBackupFolder\(\)/, 'wired to the renderer function');
  const at = core.indexOf('async function stopWirelessBackupFolder');
  assert.ok(at > -1, 'which exists');
  const body = core.slice(at, core.indexOf('\nfunction refreshDriveList', at));
  assert.match(body, /await window\.api\.clearPhoneBackupFolder\(\)/,
    '⚠ and invokes phoneBackup:clear — the handler that had no caller');
});

test('⚠⚠ it is named differently from the bridge method ON PURPOSE', () => {
  // The reachability guard matches `.name(`, so a renderer-local function sharing the bridge's name
  // satisfies it without calling anything. This exact shape nearly shipped.
  assert.ok(!/function clearPhoneBackupFolder/.test(core),
    '⚠ no renderer function shadows the bridge method name');
});

test('⚠⚠ the confirmation states that NOTHING IS DELETED', () => {
  // He pointed a NAS folder at this. "Stop using this folder?" with no further words is a question a
  // careful person answers "no" to, because it might mean the footage.
  const at = core.indexOf('async function stopWirelessBackupFolder');
  const body = core.slice(at, core.indexOf('\nfunction refreshDriveList', at));
  assert.match(body, /await confirmDialog\(/, 'it asks first');
  assert.match(body, /Nothing in the folder is deleted or moved/, '⚠ and says the blast radius');
  assert.match(body, /if \(!ok\) return;/, 'declining does nothing');
  const declineAt = body.indexOf('if (!ok) return;');
  assert.ok(declineAt < body.indexOf('window.api.clearPhoneBackupFolder'),
    '⚠ the early return precedes the call, so Cancel cannot clear it');
});

test('⚠ with no folder set it says so rather than confirming a no-op', () => {
  const at = core.indexOf('async function stopWirelessBackupFolder');
  const body = core.slice(at, core.indexOf('\nfunction refreshDriveList', at));
  assert.match(body, /if \(!cur\) \{ showToast\('No wireless backup folder is set\.'\); return; \}/);
  assert.match(body, /refreshDriveList\(\)/, 'and Devices is re-rendered after a real clear');
});

test('phoneBackup:clear really does clear it in main', async () => {
  const cfg = app.get('config');
  cfg.phoneBackupSource = 'Z:\\nas\\upload';
  const r = app.plain(await app.invoke('phoneBackup:clear'));
  assert.equal(r.ok, true);
  assert.equal(app.get('config.phoneBackupSource'), '', 'the path is forgotten');
});

// --- item 28: prune a bad autocomplete entry ---------------------------------------------------

test('⚠⚠ a suggestion row carries a way to forget it', () => {
  const at = combo.indexOf('function openComboFlyout');
  const body = combo.slice(at, combo.indexOf('\nfunction setComboHighlight', at));
  assert.match(body, /const onRemove = input\._comboRemove;/, 'the flyout knows whether the list is prunable');
  assert.match(body, /x\.className = 'flyout-forget';/, 'and renders the control');
  assert.match(body, /onRemove\(s\)/, 'which removes THAT row’s value');
});

test('⚠⚠ clicking the × does not also fill the field with the value being deleted', () => {
  // The × lives inside the row <button>, whose own mousedown fills the input. Without
  // stopPropagation, forgetting a typo would type it into the field on the way out — a bug that
  // would look like the app arguing with you.
  const at = combo.indexOf("x.addEventListener('mousedown'");
  const body = combo.slice(at, combo.indexOf('item.appendChild(x);', at));
  assert.match(body, /e\.stopPropagation\(\);/, '⚠ the row handler never sees it');
  assert.match(body, /e\.preventDefault\(\);/, 'and the input keeps focus');
});

test('⚠ only prunable lists get the control', () => {
  // Subjects, descriptions and locations are managed in their own screens and are also drawn from
  // clips in the current session, where a × would mean nothing. Only saved field history is prunable
  // here, so only that combo passes a remover.
  assert.match(combo, /attachCombo\(input, \(\) => fieldHistoryCache\[fieldId\] \|\| \[\], \(\) => metaFieldNext\(input\),\s*\n?\s*\(value\) => forgetFieldValue\(fieldId, value\)\);/,
    'the field combo passes one');
  const subj = combo.slice(combo.indexOf('function attachSubjectCombo'), combo.indexOf('function attachFieldCombo'));
  assert.ok(!subj.includes('forget'), '⚠ subject/description/location combos do not');
});

test('⚠⚠ forgetting is undoable, and the undo is offered where it happened', () => {
  const at = combo.indexOf('async function forgetFieldValue');
  assert.ok(at > -1, 'the remover exists');
  const body = combo.slice(at, combo.indexOf('\n}', combo.indexOf('showToastAction', at)));
  assert.match(body, /await window\.api\.removeFieldHistory\(fieldId, value\)/,
    '⚠ it invokes fieldHistory:remove — the handler that had no caller');
  assert.match(body, /showToastAction\(`Forgot “\$\{value\}”\.`, 'Undo'/, 'with an inline Undo');
  assert.match(body, /window\.api\.addFieldHistory\(fieldId, value\)/, 'that really puts it back');
  assert.match(body, /catch \{ showToast\('Could not forget that\.'\); return; \}/,
    'and a failure says so rather than pretending');
});

test('⚠ the local cache is updated from what main returned, not guessed', () => {
  // Guessing means the dropdown and the store disagree the moment anything else edits the list.
  const at = combo.indexOf('async function forgetFieldValue');
  const body = combo.slice(at, combo.indexOf('showToastAction', at));
  assert.match(body, /Array\.isArray\(list\)\s*\n?\s*\? list/, 'main’s list wins when it gives one');
  assert.match(body, /filter\(\(v\) => v !== value\)/, 'with a local fallback if it did not');
});

test('fieldHistory:remove really does remove it in main', async () => {
  const cfg = app.get('config');
  cfg.fieldHistory = { category: ['promo', 'pormo', 'wedding'] };
  const left = app.plain(await app.invoke('fieldHistory:remove', { id: 'category', value: 'pormo' }));
  assert.deepEqual(left, ['promo', 'wedding'], 'the typo is gone and the rest survive');
  const again = app.plain(await app.invoke('fieldHistory:remove', { id: 'category', value: 'pormo' }));
  assert.deepEqual(again, ['promo', 'wedding'], 'removing it twice is harmless');
});

test('⚠ removing a field value touches ONLY the suggestion list', async () => {
  // The bound that makes "no confirmation" the right call. If this ever started editing drafts or
  // filed records, an undoable toast would not be enough.
  const cfg = app.get('config');
  cfg.fieldHistory = { category: ['promo', 'pormo'] };
  cfg.renameDrafts = { 'a.mp4__1__1': { subject: 'lawn-mowing', meta: { category: 'pormo' } } };
  cfg.finalMeta = { 'b.mp4': { subject: 'lawn-mowing', category: 'pormo', done: true } };
  await app.invoke('fieldHistory:remove', { id: 'category', value: 'pormo' });
  assert.equal(app.plain(app.get('config.renameDrafts'))['a.mp4__1__1'].meta.category, 'pormo',
    '⚠ the draft still says what he typed');
  assert.equal(app.plain(app.get('config.finalMeta'))['b.mp4'].category, 'pormo',
    '⚠ and so does the filed record');
});
