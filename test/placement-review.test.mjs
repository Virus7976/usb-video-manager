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
  // The card must say whether it is FILING into a project he already has, or CREATING one out of thin
  // air. A card that looks identical either way is not a confirmation, it is a rubber stamp.
  assert.match(fn, /\$\{g\.isNew \? 'Create' : 'File into'\} <b>\$\{escapeHtml\(leaf\)\}<\/b>\?/, 'the suggested state');
  assert.match(fn, /in \$\{escapeHtml\(parent\)\}/, 'and it shows which category it would land in');
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
  assert.equal(/Promise\.all\([\s\S]*aiPlaceGroup/.test(fn), false, 'never fanned out');

  // There is exactly ONE place that calls the model, and every caller goes through the one queue.
  // This used to be asserted as "the aiPlaceGroup call sits inside the for-loop", which stopped being
  // true — and stopped being ENOUGH — the moment `undo` could re-ask: that fires from a click handler,
  // OUTSIDE the loop, so `for … await` gives you nothing. Two tool loops on the same 8B model don't OOM
  // the way vision-plus-text does; they double the KV cache on a 6 GB card and both crawl.
  assert.equal((fn.match(/window\.api\.aiPlaceGroup/g) || []).length, 1, 'one call site');
  assert.match(fn, /const queueAsk = \(g\) => \{\s*modelQueue = modelQueue\.then\(\(\) => askModel\(g\)\)/,
    'serialized through one promise chain');
  assert.match(fn, /await queueAsk\(g\);/, 'the initial pass goes through it');
  assert.match(fn, /learn\(\(\) => queueAsk\(g\)\)/, '…and so does an undo re-ask, so a click cannot race the loop');
  assert.equal(/(?<!queue)askModel\(g\)(?!\))/.test(fn.replace(/const askModel = async \(g\) => \{/, '')), false,
    'nothing calls askModel directly, bypassing the queue');
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

  assert.match(body, /f\.meta\.ledgerRel = rel/, 'the destination map reads ledgerRel, and nothing else');
  // A SUBFOLDER PER SHOOT: `Gourgess Lawns/2026-06-01/…`. A client runs all year; a shoot is a day.
  // 68 lawn-mowing clips loose in one client folder is not organized, it is a pile with a name.
  assert.match(body, /const rel = shootFolderFor\(path, day\)/);
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

/** Pull shootFolderFor out of the shipping renderer source and run the real thing. */
function shootFns() {
  const src = mod('09-phone-finalize.js');
  const start = src.indexOf('function shootFolderFor(');
  let depth = 0; let end = -1;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}; return { shootFolderFor };`)();
}

// --- THE SHAPE HE ASKED FOR (2026-07-13) --------------------------------------------------------
//
//   2026 - Client Work\Gourgess Lawns\2026-06-01\2026-06-01_lawn-mowing_josiah_v23.mp4
//   └ category         └ project       └ SHOOT   └ clip
//
// A client runs all year; a shoot is a day. 68 lawn-mowing clips loose in one client folder is not
// organized, it is a pile with a name.

test('a shoot gets its own dated subfolder inside the project', () => {
  const { shootFolderFor } = shootFns();
  assert.equal(shootFolderFor('2026 - Client Work/Gourgess Lawns', '2026-06-01'),
    '2026 - Client Work/Gourgess Lawns/2026-06-01');
});

test('…but NOT when the project folder IS the shoot', () => {
  // He already has several of these: `2026-05-30_vlog_water-park_v1` is a one-off video whose project
  // folder is named after the shoot. Nesting `2026-05-30/` inside it would be a date folder inside a
  // folder already named after that date.
  const { shootFolderFor } = shootFns();
  assert.equal(shootFolderFor('2026 - Social Media/2026-05-30_vlog_water-park_v1', '2026-05-30'),
    '2026 - Social Media/2026-05-30_vlog_water-park_v1');
});

test('a clip with no usable date files into the project itself, rather than an "undefined" folder', () => {
  const { shootFolderFor } = shootFns();
  assert.equal(shootFolderFor('2026 - Personal/Facebook', ''), '2026 - Personal/Facebook');
  assert.equal(shootFolderFor('2026 - Personal/Facebook', 'not-a-date'), '2026 - Personal/Facebook');
  assert.equal(shootFolderFor('', '2026-06-01'), '', 'and no project means no path at all');
});

test('a trailing slash on the project path never doubles up', () => {
  const { shootFns: _x } = {};
  const { shootFolderFor } = shootFns();
  assert.equal(shootFolderFor('2026 - Client Work/Charles/', '2026-06-01'),
    '2026 - Client Work/Charles/2026-06-01');
});

test('the memory stores the PROJECT, not the dated shoot folder', () => {
  // Otherwise the next shoot for Gourgess Lawns would recall `Gourgess Lawns/2026-06-01` and file
  // July's footage into June's folder. The project is the durable fact; the date is per shoot.
  const src = mod('07-organize-map.js');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /aiRememberPlacement\(\{ date: g\.date, subject: g\.subject, people: g\.people, location: g\.location, path: p \}\)/,
    'the remembered path is what he picked — the project — with the shoot recorded separately');

  const fin = mod('09-phone-finalize.js');
  const place = fin.slice(fin.indexOf('async function finPlaceIntoProjects('));
  assert.match(place, /shootFolderFor\(path, day\)/, 'and the date folder is added at FILING time');
});
