// "Done" over a run that filed nothing — the dead-end, in the one place it costs him everything.
//
// Tier 1 item 12: *"if a run ends without filing, say so explicitly and offer the one-click fix."*
//
// Filing is the entire point of this screen, and his project ledger read **0** for months. A run with
// **Organize unticked** embeds metadata and then reports a green **"Done"** — and because the stat
// chips are built per-option (`if (options.organize) stats.push(['moved', …])`), an unticked Organize
// means **nothing on screen mentions filing at all**. There is no zero to notice. The natural reading
// is "finished", he walks away, and the pile has not moved.
//
// Then it hid the Run button and showed "Open destination" and "Done → Home", which is the app
// congratulating him for a run that achieved the one thing it was supposed to avoid.
//
// The fix is deliberately small: name the outcome honestly, tick Organize, keep Run on screen. The
// difference between a dead end and a next step is one visible button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = readFileSync(join(process.cwd(), 'src', 'mod', '10-boot.js'), 'utf8');
const src = raw.replace(/\/\/.*$/gm, '');

// The end-of-run block. Anchored on code, and the anchor is proven before use — an empty slice would
// make every "must not say Done" assertion below pass while checking nothing
// (test/assertions-cannot-pass-vacuously.test.mjs).
const at = src.indexOf('const filedNothing =');
const end = src.indexOf('finRunScan();', at);
const block = (() => {
  assert.ok(at > -1, 'found the end-of-run reporting');
  assert.ok(end > at, 'and its closing anchor');
  return src.slice(at, end);
})();

test('⚠ a run that moved nothing does not report "Done"', () => {
  assert.match(block, /const filedNothing = !summary\.moved;/, 'the outcome is judged on what actually moved');
  assert.match(block, /filedNothing \? 'Nothing was filed' : 'Done'/, 'and it says which');
});

test('and it does not wear the success styling', () => {
  // A green tick beside "Nothing was filed" is worse than either alone.
  assert.match(block, /classList\.toggle\('done', !filedNothing\)/, 'the done class follows the real outcome');
});

test('⚠ the Run button stays available — that is the one-click fix', () => {
  // Hiding Run is what made this a dead end rather than a next step.
  assert.match(block, /\$\('finRunBtn'\)\.classList\.remove\('hidden'\)/, 'Run is shown again');
  assert.match(block, /\$\('finRunBtn'\)\.disabled = false;/, 'and it is clickable');
});

test('⚠ Organize is ticked for him, since that is usually why nothing moved', () => {
  assert.match(block, /if \(org\) org\.checked = true;/, 'the box that would have filed them is ticked');
});

test('the message distinguishes the two reasons', () => {
  // "Organize was unticked" and "organize ran but moved nothing" need different next steps — one is a
  // tick, the other is a destination problem. One generic message would send him to the wrong place.
  assert.match(block, /Organize was unticked/, 'the unticked case');
  assert.match(block, /Check the destination folder above/, 'and the moved-nothing case');
  // ORDER, not just presence. `wasOff` must be read before we tick the box — reading it after means
  // it is always false and the message always blames the destination, even when the real cause was
  // the unticked box. My first version only asserted the line existed, and reordering the two lines
  // left it green.
  const readAt = block.indexOf('const wasOff = org && !org.checked;');
  const tickAt = block.indexOf('if (org) org.checked = true;');
  assert.ok(readAt > -1 && tickAt > -1, 'both lines present');
  assert.ok(readAt < tickAt, 'the previous state is captured BEFORE we change it');
});

test('⚠ a SUCCESSFUL run is unchanged — Run still goes away', () => {
  // The other direction. Leaving Run on screen after a good run invites a pointless re-file.
  assert.match(block, /\} else \{\s*\$\('finRunBtn'\)\.classList\.add\('hidden'\);/,
    'a run that filed something still hides Run');
});

test('a CSV path is not discarded by the new message', () => {
  // finSub already carried the Resolve CSV path, and this block runs after it. A bare overwrite would
  // throw away a real output the run produced.
  assert.match(block, /summary\.csvPath \? `\$\{why\}/, 'the CSV path is appended, not replaced');
});

test('the success path still reports the stats it always did', () => {
  // Guard the whole surrounding behaviour: the chips are the honest record of what happened.
  assert.match(src, /stats\.push\(\['moved', summary\.moved, ''\]\)/, 'moved chip');
  assert.match(src, /stats\.push\(\[`not filed \(no place on the map\)`/, 'and the unplanned warning');
});
