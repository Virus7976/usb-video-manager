// Four more from the 2026-07-20 audit backlog, all in the face subsystem.
//
//   1. ⚠⚠ GROUP SHOTS WERE THE STORE THE #8 KEY MIGRATION MISSED. Every scope statement in AGENTS.md
//      lists drafts, observations, face clipKeys and copiedLog (later corrected to add aiQueue as
//      "the fifth"); faceScenes appears in none of them. `noteFaceScene` landed 2026-07-13, the
//      migration 2026-07-19 — it simply predates it. So scenes were keyed `name__size`, which is not
//      unique: two GoPro clips of identical name and size from different cards (ordinary, given his
//      2-to-6-chapter recordings) collided, and the second scan REPLACED the first clip's group shot.
//      `faces:saveScenes` then runs gcFaceCrops, which unlinks the displaced frame — the group shot
//      and its image, gone. Worse, the byKey map holds both key forms with last-write-wins, so the
//      surviving scene resolved to whichever clip won and naming a face in it tagged the WRONG clip.
//   2. The fix has a trap: writing V2 while matching with `===` would fail to find a clip's existing
//      LEGACY-keyed scene and push a SECOND record for the same clip — two group shots for one clip,
//      the stale one keeping its crop alive. Reads must stay cross-form. That is the #8 contract:
//      new writes use V2, reads try V2 then legacy, nothing on disk is rewritten or deleted.
//   3. ⚠ A face engine that died MID-RUN marked every remaining clip permanently scanned.
//      `detectFacesForClip` returns `{ready:false}` with NEITHER readError NOR detectError, because
//      both are derived from frames that were never fetched — so "the GPU died" looked exactly like
//      "this clip has no faces", and those clips are excluded from every future scan. Both scan paths
//      had the gap.
//   4. Descriptor samples per cluster were uncapped. Measured on his store: 14 MB across 4715
//      vectors, one cluster holding 318 (~880 KB), and only 37 KB of the file is thumbnails. Since
//      enrolment truncates to 80 on arrival anyway, everything past the 80th was written, re-written
//      on every debounced save during a review, and then thrown away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8').replace(/\/\/.*$/gm, '');

const fnBody = (name, endPat = '\n}') => {
  const i = src.indexOf(name);
  assert.ok(i > -1, `found ${name}`);
  const end = src.indexOf(endPat, i);
  assert.ok(end > i, `and the end of ${name}`);
  return src.slice(i, end);
};

test('⚠⚠ a new group shot is written under the COLLISION-FREE key', () => {
  const fn = fnBody('async function noteFaceScene');
  assert.match(fn, /const key = clipKeyV2\(clip\);/,
    '⚠ writing clipKey(name__size) lets two different clips overwrite each other\'s group shot');
  assert.doesNotMatch(fn, /const key = clipKey\(clip\);/, 'the legacy write is gone');
});

test('⚠⚠ but a clip\'s EXISTING legacy-keyed scene is still found, not duplicated', () => {
  // The trap in the fix. Exact-matching on V2 would push a second record for the same clip.
  const fn = fnBody('async function noteFaceScene');
  assert.match(fn, /faceScenes\.findIndex\(\(s\) => s && sceneKeyMatches\(s\.clipKey, clip\)\)/,
    'the lookup is cross-form, not ===');
  const m = fnBody('function sceneKeyMatches');
  assert.match(m, /s === clipKeyV2\(clip\)/, 'matches an already-migrated record');
  assert.match(m, /s === clipKey\(clip\)/, '⚠ and one still on the legacy key — or it duplicates');
});

test('an empty stored key never matches anything', () => {
  // Without this, a record with clipKey:'' would match the first clip whose key was also falsy and
  // silently claim someone else's group shot.
  const m = fnBody('function sceneKeyMatches');
  assert.match(m, /if \(!s\) return false;/, 'an empty key matches nothing');
});

test('⚠⚠ BOTH scan paths refuse to mark a clip scanned when the ENGINE failed', () => {
  // The `ready` flag is the third failure mode, and it was missing from both sites — the classic
  // twin gap in this repo. A run whose face engine dies must leave clips re-scannable.
  const collect = fnBody('  if (fr.ready && !fr.readError && !fr.detectError)', '\n  }');
  assert.ok(collect.length > 0, 'collectClipFaces checks ready');
  assert.match(src, /if \(!res\.ready \|\| res\.detectError \|\| res\.readError\)/,
    '⚠ scanFacesForClips must treat a dead engine as "learned nothing", not as "no faces"');
  // And prove the flag actually exists on the failure return, or both guards are checking a
  // permanently-undefined field and would never mark anything scanned.
  assert.match(src, /return \{ ready: false, error: ready\.error, faces: \[\], scene: null \};/,
    'the model-failure return really sets ready:false');
  assert.match(src, /ready: true,/, 'and the success return sets ready:true — so the guard can pass');
});

test('⚠ descriptor samples are capped on BOTH the save and the load path', () => {
  // Capping only on save would leave his existing 318-sample cluster fully resident in memory until
  // the next write; capping only on load would let a long review session grow unbounded again.
  // The SAVE path caps inside packDescriptors() since the 5dp precision change; the LOAD path still
  // caps inline (it deliberately does not re-round, so existing records are not rewritten on read).
  // Assert the property — both paths cap — rather than one literal expression.
  const loadCap = (src.match(/\(c\.descriptors \|\| \[\]\)\.slice\(0, 80\)/g) || []).length;
  assert.equal(loadCap, 1, `the load path caps inline — found ${loadCap}`);
  const packFn = src.slice(src.indexOf('function packDescriptors'), src.indexOf('function _serializePending'));
  assert.match(packFn, /\.slice\(0, 80\)/, 'and the save path caps inside packDescriptors');
  assert.match(src, /descriptors: packDescriptors\(c\.descriptors\)/, 'which is what save uses');
  assert.doesNotMatch(src, /descriptors: c\.descriptors \|\| \[\],/, 'no uncapped copy is left');
});

test('the cap matches the limit enrolment already applies', () => {
  // 80 is not a guess: people:save truncates to 80 the moment a cluster is enrolled, so samples past
  // the 80th could never have affected recognition. If that limit ever changes, this should too.
  const feedback = readFileSync(join(process.cwd(), 'main-mod', '08-finalize-feedback.js'), 'utf8');
  const enrol = [...feedback.matchAll(/capFacesKeepingConfirmed\([^;]*?,\s*(\d+)\)/g)].map((m) => m[1]);
  assert.ok(enrol.length > 0, 'found the enrolment caps');
  assert.deepEqual([...new Set(enrol)], ['80'],
    `the pending cap of 80 tracks the enrolment cap — enrolment now uses ${[...new Set(enrol)].join(', ')}`);
});

test('⚠ the cluster\'s own descriptor is never capped away', () => {
  // `descriptor` (singular) is what faceDist matches on. Capping the SAMPLES is safe precisely
  // because identity does not live in them.
  const at = src.indexOf('function _serializePending');
  const body = src.slice(at, src.indexOf('\n}', at));
  // Written on every save — now rounded to 5dp (measured: shifts a distance by ~1/25,000th of the
  // matching threshold), but never dropped or truncated. Capping the SAMPLES is safe precisely
  // because identity does not live in them.
  assert.match(body, /descriptor: packDescriptor\(c\.descriptor\)/, 'the identity descriptor is always written');
  assert.doesNotMatch(body, /descriptor: packDescriptors\(c\.descriptor\)/, 'and not confused with the sample list');
});
