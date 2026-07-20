// Filing from the POP-OUT destination map embedded no metadata at all.
//
// `showDestinationMap` has two entry points on the same screen, for the same clips, behind the same
// Apply button:
//
//   inline  (09-phone-finalize.js renderFinMap)      → passes `embedMeta: () => $('finEmbed').checked`
//   pop-out (07-organize-map.js showDestinationMapAuto) → omits it entirely
//
// The clip payloads are byte-identical — a previous sweep already reconciled `_ledgerRel` across this
// exact pair — but `embedMeta` was missed. Apply reads it as:
//
//     const embed = typeof opts.embedMeta === 'function' ? !!opts.embedMeta() : false;
//     … meta: (embed && c._ref && c._ref.meta) ? c._ref.meta : null
//
// so via the pop-out, `embed` is unconditionally false and **every move job ships `meta: null`**.
// `projects:move` then writes no XMP: no Title, Description, keywords, hierarchical tags, people or
// date into the filed file — the whole point of embedding, and what Resolve, digiKam and Windows
// search actually read. The confirm dialog quietly drops "with their metadata embedded" too.
//
// `openFinalize()` sets `finEmbed.checked = true`, so the checkbox reads ON while this route ignores
// it. The pop-out is reachable four ways: the two map buttons, the Edit menu, and the command palette.
//
// SECOND divergence at the same call site: no `onApplied`, so Apply falls through to `close()` and
// `finScan.files` is never pruned of the clips that just moved — the inline path prunes. The list goes
// on offering files that have left the folder.
//
// This is the "second entry point inherits none of the first one's fixes" shape, which produced a
// confirmed bug earlier today in the face-review resume path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '');
const mapSrc = strip(readFileSync(join(process.cwd(), 'src', 'mod', '07-organize-map.js'), 'utf8'));
const finSrc = strip(readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8'));

// The pop-out call site, sliced to the end of its options object.
const popout = (() => {
  const i = mapSrc.indexOf('function showDestinationMapAuto');
  const j = mapSrc.indexOf('showDestinationMap(sel.map(', i);
  return mapSrc.slice(j, mapSrc.indexOf('\n  }', j));
})();

test('the pop-out map passes the embed choice, like the inline one', () => {
  assert.ok(popout.length > 0, 'found the pop-out call site');
  assert.match(popout, /embedMeta\s*:/, 'it hands Apply the embed setting');
});

test('it reads the SAME checkbox the screen shows', () => {
  // Not a hardcoded true: the user can untick it, and the two routes must agree on what is ticked.
  assert.match(popout, /embedMeta:\s*\(\)\s*=>\s*\$\('finEmbed'\)\.checked/,
    'the same finEmbed checkbox the inline map reads');
});

test('the inline map is unchanged', () => {
  // Guard the other direction: the working path must keep working.
  const i = finSrc.indexOf('function renderFinMap');
  const inline = finSrc.slice(i, finSrc.indexOf('\n}', i));
  assert.match(inline, /embedMeta:\s*\(\)\s*=>\s*\$\('finEmbed'\)\.checked/, 'still passes it');
});

test('Apply still treats a missing embedMeta as OFF', () => {
  // Other callers legitimately omit it — the rename-screen preview is not editable and files nothing.
  // Defaulting to false is the safe direction: it writes no tags rather than writing wrong ones.
  assert.match(mapSrc, /typeof opts\.embedMeta === 'function' \? !!opts\.embedMeta\(\) : false/,
    'the default is unchanged');
});

test('the pop-out prunes the list after filing, like the inline one', () => {
  // Without onApplied, Apply falls to close() and finScan.files still lists clips that have moved.
  assert.match(popout, /onApplied\s*:/, 'it is told what to do after a successful run');
});

test('both call sites still send the same clip payload', () => {
  // The payloads were reconciled by an earlier sweep; keep them that way, since a divergence here is
  // exactly how embedMeta went missing in the first place.
  const fields = ['sourcePath', 'subject', 'description', 'location', 'date', 'people', 'shotType', 'tags', '_ledgerRel', '_ref'];
  const inlineCall = finSrc.slice(finSrc.indexOf('showDestinationMap(sel.map('));
  for (const f of fields) {
    assert.ok(popout.includes(f), `pop-out payload carries ${f}`);
    assert.ok(inlineCall.slice(0, 2000).includes(f), `inline payload carries ${f}`);
  }
});
