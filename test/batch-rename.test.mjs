// Batch rename is step 2 of the owner's core flow (card → BATCH RENAME everything → AI analyse), and
// three separate bugs in it destroyed user data on the most ordinary path there is:
// "Select all → type a subject → Apply to N".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (f) => readFileSync(join(ROOT, 'src', 'mod', f), 'utf8');

/** Lift a real function out of the shipping source and run it against stubs. */
function loadFns(relFile, { names, injected = {}, prelude = '', expose = '{}' }) {
  const src = readFileSync(join(ROOT, relFile), 'utf8');
  const pick = (name) => {
    let start = src.indexOf(`async function ${name}(`);
    if (start < 0) start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found in ${relFile}`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error(`unbalanced braces for ${name}`);
  };
  const argNames = Object.keys(injected);
  // eslint-disable-next-line no-new-func
  const f = new Function(...argNames, `${prelude}\n${names.map(pick).join('\n')}\nreturn Object.assign({ ${names.join(', ')} }, ${expose});`);
  return f(...argNames.map((k) => injected[k]));
}

// --- 1. the batch date must never steamroll real capture dates --------------------------

test('a MIXED-date selection gets no shared date — every clip keeps its own', () => {
  // The bug: merely TICKING clips auto-filled the batch date from the FIRST selected clip, and
  // applyBatch applies whatever is in that field (copyDateMode defaults to 'always', so it never even
  // asks). "Select all → type a subject → Apply" therefore overwrote EVERY clip's real capture date
  // with the first clip's — and set dateLocked, which permanently blocks ffprobe from correcting it.
  // On a card holding two shoots, the older day's clips were stamped with the newer day's date.
  const el = { dataset: {}, value: '' };
  const { updateBatchBar } = loadFns('src/mod/05-preview.js', {
    names: ['updateBatchBar'],
    injected: {
      $: () => el,
      state: { scannedFiles: [{ selected: true, date: '2026-07-01' }, { selected: true, date: '2026-07-09' }] },
      selectedClips: () => [{ date: '2026-07-01' }, { date: '2026-07-09' }],
      setDateField: (e, v) => { e.dataset.value = v; },
      renderCheckedStrip: () => {}, refreshPreviewGrid: () => {},
    },
  });

  updateBatchBar();
  assert.equal(el.dataset.value, '', 'two different days → NO batch date is filled in');
  assert.equal(el.dataset.auto, undefined);
});

test('a same-day selection still gets its shared date (the feature is intact)', () => {
  const el = { dataset: {}, value: '' };
  const { updateBatchBar } = loadFns('src/mod/05-preview.js', {
    names: ['updateBatchBar'],
    injected: {
      $: () => el,
      state: { scannedFiles: [{ selected: true }, { selected: true }] },
      selectedClips: () => [{ date: '2026-07-09' }, { date: '2026-07-09' }],
      setDateField: (e, v) => { e.dataset.value = v; },
      renderCheckedStrip: () => {}, refreshPreviewGrid: () => {},
    },
  });

  updateBatchBar();
  assert.equal(el.dataset.value, '2026-07-09', 'one shoot → one shared date, as designed');
  assert.equal(el.dataset.auto, '1', 'and it is marked as OURS, not the user\'s');
});

test('a STALE auto-date is cleared when the selection changes', () => {
  // Untick everything → the field kept its value → tick a clip from a different day → the old date was
  // still sitting there and got stamped onto the new day's clips.
  const el = { dataset: { value: '2026-07-01', auto: '1' }, value: '' };
  const { updateBatchBar } = loadFns('src/mod/05-preview.js', {
    names: ['updateBatchBar'],
    injected: {
      $: () => el,
      state: { scannedFiles: [] },
      selectedClips: () => [],
      setDateField: (e, v) => { e.dataset.value = v; },
      renderCheckedStrip: () => {}, refreshPreviewGrid: () => {},
    },
  });

  updateBatchBar();
  assert.equal(el.dataset.value, '', 'the stale date is gone');
});

test('a date the USER picked is never touched', () => {
  // No `auto` flag → the user chose it → updateBatchBar must leave it completely alone, even for a
  // mixed-date selection. An explicit choice beats our helpfulness.
  const el = { dataset: { value: '2026-01-01' }, value: '' };
  const { updateBatchBar } = loadFns('src/mod/05-preview.js', {
    names: ['updateBatchBar'],
    injected: {
      $: () => el,
      state: { scannedFiles: [{ selected: true }, { selected: true }] },
      selectedClips: () => [{ date: '2026-07-01' }, { date: '2026-07-09' }],
      setDateField: (e, v) => { e.dataset.value = v; },
      renderCheckedStrip: () => {}, refreshPreviewGrid: () => {},
    },
  });

  updateBatchBar();
  assert.equal(el.dataset.value, '2026-01-01', 'the user\'s date survives');
});

test('picking a date from the calendar drops the auto flag', () => {
  const menus = mod('06-menus.js');
  const h = menus.slice(menus.indexOf("$('batchDate').addEventListener"));
  assert.match(h.slice(0, 500), /delete \$\('batchDate'\)\.dataset\.auto/, 'a user-chosen date stops being managed');
});

// --- 2. the row ⤓ must not blank what it doesn't have ------------------------------------

test('row "apply to all ticked" only propagates fields that are actually FILLED', () => {
  // It copied description and every custom organize field UNCONDITIONALLY. Tick 40 clips that already
  // have (typed or AI-generated) descriptions, type a subject on one row, hit its ⤓ → all 40
  // descriptions and all category/project values wiped. applyBatch is explicitly guarded against
  // exactly this; this path just wasn't. The user cannot even SEE the empty source values they are
  // propagating — cleanGrid hides the meta row by default.
  const ai = mod('04-tasks-ai.js');
  const fn = ai.slice(ai.indexOf('async function applyRowNameToSelected('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  assert.match(body, /if \(src\.subject\) c\.subject = src\.subject;/);
  assert.match(body, /if \(src\.description\) c\.description = src\.description;/, 'an empty description no longer wipes 40 of them');
  assert.match(body, /if \(src\.location\) c\.location = src\.location;/, 'location is copied at all now — it used to be silently omitted');
  assert.match(body, /for \(const fld of organizeFields\) if \(src\[fld\.id\]\) c\[fld\.id\] = src\[fld\.id\];/);
  assert.match(body, /if \(copyDate && src\.date\)/, 'and an absent date is not stamped either');
  assert.match(body, /flushDraftSave\(\);/, 'a bulk rewrite of N clips is persisted NOW, not on a debounce');
});

// --- 3. bulk actions must never reach a clip you cannot see -------------------------------

test('select-all is scoped to the ACTIVE FILTER', () => {
  // Filter to "Unnamed" → select all → type a subject → Apply. Every NAMED clip — hidden from view,
  // already finished — was selected and overwritten too.
  const pre = mod('05-preview.js');
  const h = pre.slice(pre.indexOf("$('selectAllClips').addEventListener"));
  const body = h.slice(0, h.indexOf('\n});'));
  assert.match(body, /const scoped = clipFilterActive\(\)/);
  assert.match(body, /if \(scoped && !clipMatchesFilter\(c\)\) return;/, 'a hidden clip is never ticked');
});

test('select-day is scoped to the filter too', () => {
  const ren = mod('03-rename.js');
  const fn = ren.slice(ren.indexOf('function selectDay('));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /if \(scoped && !clipMatchesFilter\(c\)\) return;/);
});

test('the filter predicate is shared — what you SEE and what a bulk action TOUCHES cannot disagree', () => {
  const ren = mod('03-rename.js');
  assert.match(ren, /function clipMatchesFilter\(c\)/, 'one predicate');
  const apply = ren.slice(ren.indexOf('function applyClipFilter('));
  assert.match(apply.slice(0, apply.indexOf('\n}')), /const ok = clipMatchesFilter\(c\);/, 'the display uses it');
});

test('a new card starts with no filter', () => {
  // clipFilterMode/clipFilterText are module-level and were never reset, while ensureClipFilterBar()
  // early-returns if the bar exists. A filter left on from the PREVIOUS card silently hid clips on the
  // next one — and with mode 'selected' and nothing ticked, the grid came up completely empty and
  // looked like the scan had failed.
  const ren = mod('03-rename.js');
  assert.match(ren, /function resetClipFilter\(\)/);
  assert.match(mod('01-core.js'), /resetClipFilter\(\);/, 'the card scan resets it');
  assert.match(mod('09-phone-finalize.js'), /resetClipFilter\(\);/, 'the phone entry resets it too');
});

// --- 4. a version restore must actually restore ------------------------------------------

test('restoring a save point puts back EVERYTHING the snapshot holds', () => {
  // buildDraftMap has always captured people/peopleAuto/tags/facesScanned/ledgerRel — applyVersionToClips
  // simply never read them back. So "Restore" from the automatic "Before AI analyze" point could not
  // undo what the AI had actually done: the tags it merged and the people face-scanning wrote survived
  // the rollback permanently, and were re-persisted by the draft save that follows. A partial undo is
  // worse than none, because you believe it worked.
  const core = mod('01-core.js');
  const fn = core.slice(core.indexOf('function applyVersionToClips('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  for (const field of ['people', 'peopleAuto', 'tags']) {
    assert.match(body, new RegExp(`clip\\.${field} = Array\\.isArray\\(d\\.${field}\\)`), `${field} is restored`);
  }
  assert.match(body, /clip\._facesScanned = !!d\.facesScanned/);
  assert.match(body, /clip\._ledgerRel = d\.ledgerRel \|\| ''/);
});

test('a restore undoes a wrongly-stamped date WITHOUT erasing the real one', () => {
  // Two ways to get this wrong. The old code cleared only the LOCK and left the bad date in place,
  // still driving finalName(). But blanking clip.date is wrong too: buildDraftMap only records a date
  // the user CHOSE, so "no date in the snapshot" means "this clip was on its NATURAL date" — blanking
  // would throw away the file's real capture date. Restore the natural default instead.
  const core = mod('01-core.js');
  const fn = core.slice(core.indexOf('function applyVersionToClips('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /clip\.date = phoneDateOf\(clip\.name\) \|\| toDateStr\(clip\.mtimeMs\) \|\| ''/,
    'it falls back to the same expression the scan itself uses');
  assert.equal(/clip\.date = '';/.test(body), false, 'it never simply blanks the date');
});
