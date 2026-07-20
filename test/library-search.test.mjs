// FEATURES.md item 91 — search the whole LIBRARY, not just the loaded screen.
//
// ⚠⚠ WHAT WAS ACTUALLY WRONG. Ctrl+K already said "Type a command or clip name…" and already listed
// clips. It listed `state.scannedFiles` — the CURRENT SCREEN. Measured on his real store that is a
// few hundred clips out of **4,594**, and nothing said so. A search box that silently covers 4% of
// the library answers "not found" with total confidence, which is worse than having no search box:
// he would conclude the clip does not exist.
//
// Measured on his actual store while building this (drafts.json + final-meta.json):
//   "lawn"    → 14 hits    "curling" → 6     "corgi" → 1     "zzzz" → 0
// The last one matters as much as the others: the matcher is SUBSTRING, not fuzzy, precisely so it
// can say nothing. The palette's fuzzy matcher is right for 40 command labels and wrong for 4,594
// records, where subsequence matching returns something for almost any query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'main.js'));
const L = require('./core/library-search');

// Shaped like his real records — a draft carries far more than a filename, and he types into all of
// it. Searching only the name would miss "corgi-puppies-playing-inside-crate".
const DRAFTS = {
  'VID_001.mp4__1__1': { subject: 'lawn-mowing', description: 'dennis-front-yard', observation: 'man-mowing-lawn', tags: ['grass', 'summer'], date: '2026-05-31' },
  'VID_002.mp4__2__2': { subject: 'curling', description: 'sliding-stone', observation: 'action-curler-sweeping-brooms', tags: ['ice', 'rink'], date: '2026-01-24' },
  'VID_003.mp4__3__3': { subject: 'misc', description: 'b-roll-corgi-puppies-play-inside-crate', observation: 'corgi-puppies-playing', tags: ['puppies'], date: '2026-01-13' },
  'VID_004.mp4__4__4': { subject: '', description: '', people: ['dennis'], tags: [] },
  'lawn-clip.mp4__5__5': { subject: '', description: '' },
};
const FINAL = {
  '2026-05-31_lawn-mowing_dennis_v1.mp4': { subject: 'lawn-mowing', description: 'dennis', category: '2026 - Client Work', project: 'Gourgess Lawns', date: '2026-05-31' },
};
const find = (q, opts) => L.searchLibrary({ drafts: DRAFTS, finalMeta: FINAL }, q, opts);
const names = (r) => r.results.map((x) => x.name);

test('⚠⚠ it searches EVERY record, not the ones on screen', () => {
  const r = find('lawn');
  assert.ok(r.total >= 3, `it finds the lot — got ${r.total}`);
  assert.equal(r.searched, Object.keys(DRAFTS).length + Object.keys(FINAL).length,
    '⚠ and reports how many it looked at, so "no matches" can be trusted');
});

test('⚠⚠ it can say NOTHING', () => {
  // The bound that makes the whole thing usable. A fuzzy/subsequence matcher over 4,594 records
  // returns a plausible-looking answer for any query at all, and a search that never says "no" is
  // not a search.
  const r = find('zzzzq');
  assert.equal(r.total, 0, '⚠ an absent thing is absent');
  assert.deepEqual(r.results, []);
  assert.ok(!L.fieldScore('lawn-mowing-dennis', 'lmn'), '⚠ and a subsequence is NOT a match');
});

test('it searches what he typed, not just the filename', () => {
  // He describes footage in the description/observation/tags. Name-only search would find none of it.
  assert.deepEqual(names(find('corgi')), ['VID_003.mp4'], 'a description hit');
  assert.deepEqual(names(find('brooms')), ['VID_002.mp4'], 'an observation hit');
  assert.deepEqual(names(find('rink')), ['VID_002.mp4'], 'a tag hit');
  assert.ok(names(find('dennis')).includes('VID_004.mp4'), 'and a PEOPLE hit');
});

test('⚠⚠ the result shows the filename AS IT IS ON DISK', () => {
  // Caught by a test failing rather than by review: the obvious helper here, `clipKeyFileName`,
  // lower-cases — which is right for MATCHING and wrong for DISPLAY. His footage is `GX010042.MP4`
  // and `VID_20250820_110511.mp4`; a result list showing `gx010042.mp4` is showing him a filename
  // that does not exist on his disk, which is precisely the kind of small lie that makes him stop
  // trusting a screen.
  assert.deepEqual(names(find('corgi')), ['VID_003.mp4'], '⚠ case preserved');
  assert.deepEqual(names(find('CORGI')), ['VID_003.mp4'], 'and matching is still case-insensitive');
  assert.deepEqual(names(find('vid_003')), ['VID_003.mp4'], 'in both directions');
});

test('⚠ a subject hit outranks a weak tag hit', () => {
  // Ordering is the whole value once there are 14 results. "lawn-mowing" as the subject is what he
  // means; a clip whose filename merely contains "lawn" is not.
  const r = find('lawn');
  assert.ok(r.results.length > 1);
  assert.ok(r.results[0].subject === 'lawn-mowing', `the subject match leads — got ${r.results[0].name}`);
  assert.ok(names(r).indexOf('lawn-clip.mp4') > 0, 'the name-only clip ranks below it');
});

test('⚠ each result says WHY it matched', () => {
  // "It matched" without "on what" is what makes a user distrust a search — especially when the hit
  // was on a tag they had forgotten writing.
  const hit = find('corgi').results[0];
  assert.ok(hit.matched.includes('description'), `names the fields — got ${hit.matched.join(',')}`);
  assert.match(hit.summary, /corgi/, 'and summarises the clip in his own words');
});

test('⚠⚠ a FILED clip outranks an equivalent draft, and says where it is', () => {
  // The filed record is the more useful answer: it is the one that can point at a folder on disk.
  const hit = find('gourgess').results[0];
  assert.equal(hit.filed, true);
  assert.equal(hit.where, '2026 - Client Work / Gourgess Lawns', 'the two levels organize files into');
});

test('⚠ the same clip in both stores is listed ONCE', () => {
  // A draft is keyed by the source filename and finalMeta by the final one; after a rename they can
  // be the same string. Listing it twice — once "named", once "filed" — reads as two clips.
  const drafts = { 'shared.mp4__1__1': { subject: 'lawn-mowing' } };
  const finalMeta = { 'shared.mp4': { subject: 'lawn-mowing', category: 'A', project: 'B' } };
  const r = L.searchLibrary({ drafts, finalMeta }, 'lawn');
  assert.equal(r.total, 1, '⚠ deduped');
  assert.equal(r.results[0].filed, true, 'and the FILED record is the one kept — it knows where the footage is');
});

test('⚠⚠ the limit bounds what is RETURNED, never what is searched', () => {
  // Silently truncating is the same defect as only covering the loaded screen: the caller has to be
  // able to say "showing 25 of 312".
  const many = {};
  for (let i = 0; i < 100; i += 1) many[`c${i}.mp4__1__${i}`] = { subject: 'lawn-mowing' };
  const r = L.searchLibrary({ drafts: many, finalMeta: {} }, 'lawn', { limit: 10 });
  assert.equal(r.results.length, 10, 'ten come back');
  assert.equal(r.total, 100, '⚠ and it says there are a hundred');
});

test('an empty query returns nothing rather than everything', () => {
  for (const q of ['', '   ', null, undefined]) {
    const r = L.searchLibrary({ drafts: DRAFTS, finalMeta: FINAL }, q);
    assert.equal(r.total, 0, `"${q}" yields nothing`);
  }
});

test('junk stores are survived quietly', () => {
  assert.equal(L.searchLibrary(null, 'lawn').total, 0, 'no stores at all');
  assert.equal(L.searchLibrary({ drafts: { a: null, b: 'not an object' } }, 'lawn').total, 0, 'junk records skipped');
});

test('⚠ the module is stateless, as every core/ module must be', () => {
  // The require cache is per-process while the vm context is per-loadMain(), so module-level state
  // would leak between tests.
  assert.deepEqual(find('lawn').results, find('lawn').results, 'deterministic');
});
