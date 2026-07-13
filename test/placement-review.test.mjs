// Placement review — the face-confirm grid, for filing.
//
// Jake: "I love the popup for when it asks me who is who in faces. That's really good."
//
// It's good because it SHOWS you the thing, makes a confident suggestion ("Is this Jake?"), offers
// tap-chips of the people you already have, and batches it onto one page so confirming is one tap.
// This is that, for projects. The AI's questions stop being a text prompt and become the same
// interaction — which also gives ask_user somewhere sane to land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (f) => readFileSync(join(ROOT, 'src', 'mod', f), 'utf8');
const css = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8');

function loadFns(relFile, { names, injected = {}, prelude = '' }) {
  const src = readFileSync(join(ROOT, relFile), 'utf8');
  const pick = (name) => {
    let start = src.indexOf(`async function ${name}(`);
    if (start < 0) start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced');
  };
  const args = Object.keys(injected);
  // eslint-disable-next-line no-new-func
  return new Function(...args, `${prelude}\n${names.map(pick).join('\n')}\nreturn { ${names.join(', ')} };`)(...args.map((k) => injected[k]));
}

const groupFns = () => loadFns('src/mod/07-organize-map.js', {
  names: ['groupClipsForPlacement'],
  injected: { slug: (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') },
});

// --- grouping is DETERMINISTIC — no model involved ------------------------------------------

test('a group is a SHOOT, not a subject — one decision per shoot', () => {
  // The point of grouping: 309 clips is ~15 shoots. That's ~15 questions instead of 309, and every
  // clip in a shoot is GUARANTEED to land together.
  const { groupClipsForPlacement } = groupFns();
  const clips = [
    { subject: 'mowing', description: 'ride-on', date: '2026-06-01' },
    { subject: 'mowing', description: 'edges', date: '2026-06-01' },
    { subject: 'Mowing', description: 'again', date: '2026-06-01' },   // same subject, different case
    { subject: 'turf', description: 'laying', date: '2026-06-01' },
  ];
  const groups = groupClipsForPlacement(clips);
  assert.equal(groups.length, 2, 'two subjects on one day → two decisions, not four');
  const mow = groups.find((g) => g.key === '2026-06-01|mowing');
  assert.equal(mow.clips.length, 3, 'case-insensitive — "Mowing" and "mowing" are one shoot');
});

test('the SAME subject on DIFFERENT days is two shoots, and two questions', () => {
  // The bug this replaces: grouping by subject alone meant every lawn-mowing clip he has ever shot —
  // June 1st at Josiah's, June 12th at another property, May 16th — collapsed into ONE card and was
  // filed into ONE project. Two different jobs, one answer, no way to tell them apart.
  const { groupClipsForPlacement } = groupFns();
  const groups = groupClipsForPlacement([
    { subject: 'lawn-mowing', date: '2026-06-01' },
    { subject: 'lawn-mowing', date: '2026-06-01' },
    { subject: 'lawn-mowing', date: '2026-06-12' },   // a DIFFERENT job
  ]);
  assert.equal(groups.length, 2, 'two shoots → two questions');
  assert.equal(groups.find((g) => g.date === '2026-06-01').clips.length, 2);
  assert.equal(groups.find((g) => g.date === '2026-06-12').clips.length, 1);
});

test('a group carries its OWN shoot date, not whatever the first clip happened to have', () => {
  const { groupClipsForPlacement } = groupFns();
  const groups = groupClipsForPlacement([{ subject: 'mowing', date: '2026-06-12T09:00:00Z' }]);
  assert.equal(groups[0].date, '2026-06-12', 'an ISO timestamp resolves to its day');
});

test('no clip is ever lost — every clip lands in exactly one group', () => {
  // The bug that would silently drop footage on the floor.
  const { groupClipsForPlacement } = groupFns();
  const clips = [
    { subject: 'a' }, { subject: 'b' }, { subject: '' }, { subject: null },
    { subject: 'a' }, { subject: '   ' },
  ];
  const groups = groupClipsForPlacement(clips);
  const total = groups.reduce((n, g) => n + g.clips.length, 0);
  assert.equal(total, clips.length, `${total} of ${clips.length} clips survived grouping`);
  const unnamed = groups.find((g) => g.key.endsWith('|_unnamed'));
  assert.equal(unnamed.clips.length, 3, 'unnamed clips are collected, not discarded');
});

test('a group carries the people and observation the AI needs to place it', () => {
  const { groupClipsForPlacement } = groupFns();
  const groups = groupClipsForPlacement([
    { subject: 'skiing', people: ['jake'], observation: '', location: '' },
    { subject: 'skiing', people: ['sam', 'jake'], observation: 'two people on a snowy ridge', location: 'chamonix' },
  ]);
  const g = groups[0];
  assert.deepEqual(g.people.sort(), ['jake', 'sam'], 'people are unioned across the shoot, not taken from clip 0');
  assert.equal(g.observation, 'two people on a snowy ridge', 'an observation is picked up from whichever clip has one');
  assert.equal(g.location, 'chamonix');
});

// --- the grid mirrors the face grid ------------------------------------------------------------

test('it reuses the face grid\'s own classes, so it inherits that styling exactly', () => {
  // A bespoke .pr-yes button would render as a bare browser button beside a beautifully styled grid.
  const src = mod('07-organize-map.js');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /class="fgc-yes pr-yes"/, 'the confirm button IS the face grid\'s confirm button');
  assert.match(fn, /class="fgc-no pr-no"/);
  assert.match(fn, /face-grid-card-item/);
  assert.match(fn, /ov\.className = 'modal-overlay'/, 'the overlay class the face grid actually uses');

  for (const c of ['fgc-yes', 'fgc-no', 'fgc-chip', 'fgc-photo', 'fgc-q', 'face-grid-card-item']) {
    assert.ok(css.includes(`.${c}`), `.${c} is a real style, not one I invented`);
  }
});

test('a confident suggestion is the "Is this Jake?" card; no suggestion is the "Who is this?" card', () => {
  const src = mod('07-organize-map.js');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /File into <b>\$\{escapeHtml\(g\.suggest\.split\('\/'\)\.pop\(\)\)\}<\/b>\?/, 'the suggested state');
  // Two shoots can now share a subject, so the ask-card must name the SHOOT (date + subject) —
  // otherwise he is looking at two identical "lawn-mowing" cards with no way to tell them apart.
  assert.match(fn, /Where does the <b>\$\{escapeHtml\(shootLabel\)\}<\/b> shoot go\?/, 'the ask state names the shoot');
  assert.match(fn, /const shootLabel = \[g\.date, g\.subject \|\| 'this'\]/);
  assert.match(fn, /fgc-chips compact/, 'both states offer tap-chips of what you already have');
});

test('when the model cannot answer, the card still WORKS — it becomes a question', () => {
  // The honest failure. ai:placeGroup returns action:'ask' when the model answered in prose or never
  // decided, so the grid gets a "Where does X go?" card with the candidates as chips, rather than a
  // silent gap or a made-up destination.
  const src = mod('07-organize-map.js');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /if \(!r \|\| !r\.ok\) \{[\s\S]*?g\.question = /, 'a failed call becomes a question, not a crash');
  assert.match(fn, /g\.options = r\.options && r\.options\.length \? r\.options :/, 'ask_user\'s options are used when it gave them');
  assert.match(fn, /searchProjects|search_projects/, 'and otherwise the chips fall back to what the search actually found');
});

test('the model is asked one group at a time — the GPU only holds one model', () => {
  // Jake's machine cannot hold a vision model and an 8B text model at once (verified: CUDA OOM).
  // Firing N placement calls in parallel would be the fastest possible way to rediscover that.
  const src = mod('07-organize-map.js');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /for \(const g of groups\) \{[\s\S]*?await window\.api\.aiPlaceGroup/, 'sequential, not Promise.all');
  assert.equal(/Promise\.all\([\s\S]*aiPlaceGroup/.test(fn), false, 'never fanned out');
});

test('Done returns only the groups the user actually confirmed', () => {
  // Closing the grid must not file the AI's unconfirmed guesses. Confirmation is the whole point.
  const src = mod('07-organize-map.js');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /resolve\(groups\.filter\(\(g\) => g\.chosen\)/, 'only chosen groups are returned');
});

// --- the plumbing exists ----------------------------------------------------------------------

test('the tool-based handlers are exposed to the renderer', () => {
  const pre = readFileSync(join(ROOT, 'preload.js'), 'utf8');
  assert.match(pre, /aiPlaceGroup: \(group\) => ipcRenderer\.invoke\('ai:placeGroup', group\)/);
  assert.match(pre, /aiNameFromObservation:/);
  assert.match(pre, /aiBackfillLedger:/);
});

// --- the entry point, and the loop-closer ------------------------------------------------------
//
// The grid existed but NOTHING could open it — Organize had no button. And the last time this loop
// was built, the app asked, the user answered, and the destination map still filed everything into
// _Unsorted, because the answer was never written back as `ledgerRel` (the only field the map reads).
// Both failures are invisible without these.

test('Organize has a button that actually opens the placement grid', () => {
  const html = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8');
  const step2 = html.slice(html.indexOf('id="finStep2"'), html.indexOf('id="finStep3"'));
  assert.match(step2, /id="finPlaceBtn"/, 'the button lives in the Organize step');

  const src = mod('09-phone-finalize.js');
  assert.match(src, /\$\('finPlaceBtn'\)\.addEventListener\('click', finPlaceIntoProjects\)/, 'and it is bound');
  assert.match(src, /showPlacementReview\(clips\)/, 'to the real grid');
});

test('a confirmed placement is written back as ledgerRel — or the map ignores the answer', () => {
  const src = mod('09-phone-finalize.js');
  const fn = src.slice(src.indexOf('async function finPlaceIntoProjects('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  assert.match(body, /f\.meta\.ledgerRel = path/, 'the destination map reads ledgerRel, and nothing else');
  assert.match(body, /window\.api\.saveFinalMeta\(patch\)/, 'and it survives a restart');
  assert.match(body, /renderFinMap\(\)/, 'and the folder map redraws with the new destinations');

  // The map is keyed by clip NAME (see renderFinMap), so the patch must be too.
  assert.match(body, /patch\[f\.name\] = \{ \.\.\.f\.meta \}/);
});

test('the button cannot strand itself mid-sort', () => {
  // showPlacementReview awaits a human. If the button is disabled without a guaranteed release, a
  // closed-without-choosing grid leaves "Sorting…" on screen forever. See the async-cleanup rule.
  const src = mod('09-phone-finalize.js');
  const fn = src.slice(src.indexOf('async function finPlaceIntoProjects('));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /withBusyBtn\(\$\('finPlaceBtn'\)/);
});

test('it refuses gracefully rather than opening an empty grid', () => {
  const src = mod('09-phone-finalize.js');
  const body = src.slice(src.indexOf('async function finPlaceIntoProjects('));
  assert.match(body, /if \(!sel\.length\)/, 'nothing ticked');
  assert.match(body, /if \(!aiCfg\.enabled\)/, 'AI switched off entirely');
});
