// Tier 2 item 31 — "make Select all the default on a fresh card rather than a click he makes 48
// times."
//
// Not a guess: his interaction log contains **48 "Select all" presses**. The card screen started with
// nothing ticked, so "back up this card" was a click he re-made on every import — on a screen whose
// entire purpose is backing the card up. Defaulting to ticked is simply what he was already doing by
// hand, minus the click.
//
// **Why this is the safe direction.** The selection drives the COPY, and the copy is additive: it
// never deletes anything, it preflights free space before starting, and clearing the card stays a
// separate, gated step ([[usb-app-delete-gate]]). Defaulting a DESTRUCTIVE action to "everything"
// would be indefensible; defaulting a backup to "everything" is the whole point of the screen.
//
// **The exception that makes it honest:** a clip he has already imported starts UNticked. Re-plugging
// the same card is common, and re-offering finished work would turn a helpful default into noise he
// has to undo — the mirror image of the problem being fixed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8').replace(/\/\/.*$/gm, '');

const mapBlock = (() => {
  const at = src.indexOf('state.scannedFiles = res.files.map(');
  assert.ok(at > -1, 'found the scan mapping');
  const end = src.indexOf('return clip;', at);
  assert.ok(end > at, 'and its end');
  return src.slice(at, end);
})();

test('⚠ a fresh clip arrives ticked', () => {
  assert.match(mapBlock, /selected: !importedSet\.has\(importKey\(f\)\)/, 'ticked unless already imported');
  assert.doesNotMatch(mapBlock, /selected: false/, 'no longer starts empty');
});

test('⚠⚠ a clip he has ALREADY imported starts unticked', () => {
  // The exception that keeps the default honest. Re-plugging a card must not re-offer finished work.
  assert.match(mapBlock, /!importedSet\.has\(importKey\(f\)\)/, 'the import index decides');
  // And it is the same test the `_imported` badge uses, so the tick and the badge cannot disagree.
  assert.match(mapBlock, /_imported: importedSet\.has\(importKey\(f\)\)/, 'same check as the badge');
});

test('the tick and the "already imported" badge use one source of truth', () => {
  // Two different notions of "already imported" would show a clip badged as done but ticked for copy.
  const uses = (mapBlock.match(/importedSet\.has\(importKey\(f\)\)/g) || []).length;
  assert.equal(uses, 2, `one expression, used for both — found ${uses}`);
});

test('restoring saved drafts still re-ticks what he had ticked', () => {
  // Drafts remember his selection across sessions. That restore must still win — otherwise coming
  // back to a half-done card would silently re-select clips he had deliberately unticked.
  assert.match(src, /if \(d\.selected\) clip\.selected = true;/, 'the draft restore is intact');
});

// --- the behaviour that makes the default safe, checked against main rather than assumed ---
let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('⚠ the copy this default feeds never deletes anything', () => {
  // The whole justification. If the selection drove a destructive action, ticking everything by
  // default would be reckless — so this pins that it does not.
  const copy = readFileSync(join(process.cwd(), 'main-mod', '06-copy-transfer.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const at = copy.indexOf("ipcMain.handle('copy:start'");
  assert.ok(at > -1, 'found the copy handler');
  const body = copy.slice(at, copy.indexOf('\n});', at));
  assert.ok(body.length > 0, 'sliced it');
  // Precisely: the only thing it may remove is its own partial DESTINATION file, which is required —
  // a cancelled copy must leave no truncated clip in the intake folder. My first version banned every
  // unlink and failed on exactly that legitimate cleanup: the assertion was wrong, not the code.
  // What must never happen is unlinking a SOURCE path, i.e. something on his card.
  const removals = body.match(/(?:fsp\.unlink|fsp\.rm|rmSync)\(([^)]*)\)/g) || [];
  assert.ok(removals.length > 0, 'the scan really found the removal calls');
  for (const r of removals) {
    assert.match(r, /destPath/, `only the partial destination is removed — found ${r}`);
    assert.doesNotMatch(r, /sourcePath|f\.path|srcPath/, `never a path on his card — found ${r}`);
  }
});

test('⚠ and clearing the card is still a separate, gated act', () => {
  // Unchanged by this, and must stay that way: the delete gate re-verifies every pair itself.
  const ipc = readFileSync(join(process.cwd(), 'main-mod', '09-ipc-boot.js'), 'utf8');
  assert.match(ipc, /ipcMain\.handle\('delete:source'/, 'deletion has its own explicit channel');
  assert.match(ipc, /verifyCopyPair\(/, 'which verifies before it removes anything');
});
