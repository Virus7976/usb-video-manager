// "If I'm analyzing with AI it should always remember where it was when it comes back."
//
// It didn't. Three separate defects conspired:
//
//   1. Mode "empty" (Only name blank clips) still ran the FULL vision pass on every selected
//      clip, then threw the answer away inside applyAiResult — which gates subject/description/
//      category on being blank. Cancel at clip 40 of 100, hit Analyze again → all 100 re-watched.
//   2. The "Reuse earlier analysis of N clips (faster)" checkbox was read in exactly ONE place,
//      inside `if (aiCfg.multiPass)`. multiPass is OFF by default. For a default install the
//      checkbox did nothing at all.
//   3. Face clusters were keyed by ABSOLUTE PATH while every other store uses the stable
//      name__size fingerprint — so a card replugged as F: instead of E: still showed the faces
//      but tagged ZERO clips when you confirmed them.
//
// The observation cache was always correct and always written. The app remembered; it just
// refused to use what it remembered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readMod = (f) => readFileSync(join(ROOT, 'src', 'mod', f), 'utf8');

/** Lift a real top-level function out of the shipping source and run it against stubs. */
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

const CLIP = (over = {}) => ({ name: 'GX010023.MP4', size: 12345, subject: '', description: '', ...over });

// --- 1. the resume predicate — the "is there work left here" question -------------------

function loadPredicate(cache) {
  return loadFns('src/mod/04-tasks-ai.js', {
    names: ['aiAlreadyAnalyzed'],
    injected: { clipObsCache: cache, clipKey: (c) => `${c.name}__${c.size}` },
  }).aiAlreadyAnalyzed;
}

test('a clip we analyzed AND named is done — resuming skips it', () => {
  const clip = CLIP({ subject: 'snow-walking', description: 'wide-ridge-hike' });
  const fn = loadPredicate({ 'GX010023.MP4__12345': { obs: 'a person walks along a snowy ridge' } });
  assert.equal(fn(clip), true, 'the expensive vision pass is already paid for — do not redo it');
});

test('a clip with NO cached observation is not done, however well-named', () => {
  // Named by hand / batch rename, never AI-analyzed. There IS work to do.
  const clip = CLIP({ subject: 'snow-walking', description: 'wide-ridge-hike' });
  assert.equal(loadPredicate({})(clip), false);
});

test('a clip we analyzed but did NOT name is not done — naming still owes us', () => {
  // Analysis succeeded, naming failed. Skipping this would strand it unnamed forever.
  const clip = CLIP({ subject: '', description: '' });
  const fn = loadPredicate({ 'GX010023.MP4__12345': { obs: 'a person walks along a snowy ridge' } });
  assert.equal(fn(clip), false);
  assert.equal(fn(CLIP({ subject: 'snow', description: '' })), false, 'half-named is not named');
  assert.equal(fn(CLIP({ subject: '   ', description: '  ' })), false, 'whitespace is not a name');
});

test('the observation key is the stable fingerprint, so a replug still counts as done', () => {
  // Same file, new drive letter. name__size is unchanged, so the cache still hits.
  const cache = { 'GX010023.MP4__12345': { obs: 'seen it' } };
  const onE = CLIP({ sourcePath: 'E:/DCIM/GX010023.MP4', subject: 's', description: 'd' });
  const onF = CLIP({ sourcePath: 'F:/DCIM/GX010023.MP4', subject: 's', description: 'd' });
  const fn = loadPredicate(cache);
  assert.equal(fn(onE), true);
  assert.equal(fn(onF), true, 'a new drive letter must not make the app forget it analyzed this clip');
});

// --- 2. the loop actually consults the predicate, and reuse is no longer multiPass-only ---

test('the analyze loop skips already-analyzed clips in `empty` mode', () => {
  const src = readMod('04-tasks-ai.js');
  const fn = src.slice(src.indexOf('async function aiAnalyzeSelected'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /mode === 'empty'/, 'empty mode is special-cased');
  assert.match(body, /idxs\s*=\s*idxs\.filter\(\(i\)\s*=>\s*!aiAlreadyAnalyzed/, 'the work list drops finished clips BEFORE any model call');
  assert.match(body, /setAiRunOrder\(idxs\)/, 'the live stage is re-pointed at the work actually being done');
});

test('the reuse cache is consulted OUTSIDE the multiPass branch', () => {
  // The regression that made the checkbox a lie: `dlg.reuse` read only inside if(multiPass).
  const src = readMod('04-tasks-ai.js');
  const single = src.slice(src.indexOf('  } else {', src.indexOf('if (aiCfg.multiPass)')));
  const loop = single.slice(0, single.indexOf('\n  }\n'));
  assert.match(loop, /dlg\.reuse/, 'single-pass (the DEFAULT) honours Reuse too');
  assert.match(loop, /observation:\s*cached/, 'the cached observation is actually handed to the model');
});

// --- 3. face review: stable keys + the confirm is persisted -------------------------------

test('face clusters are keyed by the stable fingerprint, never the absolute path', () => {
  const src = readMod('08-people.js');
  assert.equal(
    /clipKeys\.add\(clip\.key \|\| clip\.sourcePath\)/.test(src), false,
    'a path key breaks the moment the card comes back as a different drive letter',
  );
  assert.match(src, /clipKeys\.add\(clipKey\(clip\)\)/, 'clusters are keyed by clipKey');
  assert.match(src, /const attach = \(Array\.isArray\(keys\) && keys\.length\) \? keys : \[clipKey\(clip\)\]/);
});

test('the face-review lookup still resolves clusters saved under the OLD path key', () => {
  // faces-pending.json on disk right now holds path-keyed clusters. A pending review is
  // unconfirmed user work — the key fix must not silently strand it.
  const src = readMod('08-people.js');
  const line = src.split('\n').find((l) => l.includes('byKey[clipKey(c)]'));
  assert.ok(line, 'the lookup indexes by the stable key');
  assert.match(line, /byKey\[c\.sourcePath\]/, 'AND still by the legacy path key');
});

test('confirming a face persists immediately — it is not left in memory', () => {
  // savePendingNow() DROPS confirmed clusters from faces-pending.json, so if the clip tags
  // weren't flushed at that same moment, a crash lost the work from both places at once.
  const src = readMod('08-people.js');
  const tag = src.slice(src.indexOf('function tagClips('));
  assert.match(tag.slice(0, tag.indexOf('\n  }')), /flushDraftSave\(\)/, 'tagging a clip flushes drafts');
  const untag = src.slice(src.indexOf('function untagClips('));
  assert.match(untag.slice(0, untag.indexOf('\n  }')), /flushDraftSave\(\)/, 'untagging flushes too');
});

// --- 4. "Start over" must actually start over --------------------------------------------

test('"Start over" can change a subject, even though updateSubject defaults to false', () => {
  // The dialog offers: 'Start over' — "ignore what's there and name from scratch". But the
  // subject was gated on aiCfg.updateSubject (default FALSE) regardless of mode. Jake batch-
  // renames BEFORE analyzing, so every clip already has a subject → Start over could never
  // change one. It quietly rewrote descriptions only, and nothing said so.
  const src = readMod('04-tasks-ai.js');
  const fn = src.slice(src.indexOf('function applyAiResult('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const startOver = mode === 'all'/, 'the chosen mode is read');
  assert.match(body, /if \(res\.subject && \(startOver \|\| aiCfg\.updateSubject \|\| !clip\.subject\)/,
    'an explicit "start over" overrides the keep-my-subjects default');
  // …and the default still protects the OTHER modes, where the user did not ask for a rewrite.
  assert.match(body, /\(!onlyEmpty \|\| !clip\.subject\)/, '"only blank clips" still never overwrites');
});

test('the mode the dialog offers is the mode applyAiResult checks', () => {
  // A typo here ('start' vs 'all') would silently restore the old broken behaviour.
  const src = readMod('04-tasks-ai.js');
  assert.match(src, /\{ v: 'all', t: 'Start over'/, "the dialog's start-over value is 'all'");
});

// --- 5. state.copied must never outlive the flow that filled it --------------------------

test('a new flow starts with nothing to delete', () => {
  // state.copied gates the "3 Delete" step pill. It was cleared ONLY in startFlow's fresh-scan
  // branch — so importing a card and then backing up a phone left the CARD's clips in it, and
  // the Delete pill inside the phone flow listed them. One click from wiping the wrong source.
  const phone = readMod('09-phone-finalize.js');
  const entry = phone.slice(phone.indexOf('async function enterRenameWithPhoneFiles('));
  assert.match(entry.slice(0, 900), /state\.copied = \[\]/, 'entering the phone flow clears it');

  const people = readMod('08-people.js');
  const home = people.slice(people.indexOf('async function goHome('));
  assert.match(home.slice(0, 900), /state\.copied = \[\]/, 'going Home ends the delete session');
});
