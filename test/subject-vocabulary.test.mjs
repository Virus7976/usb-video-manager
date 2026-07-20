// FEATURES.md item 29 — the controlled subject vocabulary. The unblock, not a feature.
//
// Measured on his real store: 4,594 clips, 331 named, **1 filed**. 112 distinct subjects across 206
// named clips. Filing groups by subject; with 112 competing names nothing groups, so everything falls
// through to `_unsorted` and nothing files. Every filing capability in the app is correct, tested,
// and produces nothing because of this.
//
// ⚠⚠ THE DANGER IN THE FIX IS OVER-MERGING, AND IT IS WORSE THAN THE DISEASE.
// Fragmentation leaves clips unfiled — annoying, recoverable. A bad merge files a personal vlog into
// a client job, which is a real failure this repo has already seen and reverted (2026-07-20). So the
// tests below spend more effort on what must NOT merge than on what must.
//
// This module never rewrites what he typed. It CANONICALISES (proposes a name he already uses) and
// FLAGS (says "that describes the shot, not the job"). Both advisory; the caller decides whether to
// ask. Silently renaming his subjects would be the same mistake as an AI that decides instead of
// proposes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'main.js'));
const V = require('./core/subjects');

test('a subject is stored in one canonical form', () => {
  for (const [input, want] of [
    ['Lawn Mowing', 'lawn-mowing'],
    ['  lawn_mowing  ', 'lawn-mowing'],
    ['Lawn—Mowing!', 'lawn-mowing'],
    ['LAWN  MOWING', 'lawn-mowing'],
  ]) assert.equal(V.normalizeSubject(input), want, `${input} normalises`);
});

test('⚠⚠ a name that describes the SHOT is flagged, with a reason he can act on', () => {
  // 46% of his named clips are these. The subject is what the footage is FOR, not what is in frame —
  // filing by "talking-head" produces a folder of unrelated jobs.
  for (const s of ['talking-head', 'talking-head-young', 'person-sitting-couch', 'vlog-young-man', 'misc']) {
    const c = V.classifySubject(s);
    assert.equal(c.shotLike, true, `⚠ "${s}" describes the shot`);
  }
  // And the reason names the offending words, because "invalid" is not actionable.
  assert.match(V.classifySubject('talking-head-young').why, /talking|head|young/);
});

test('⚠⚠ a REAL subject is never flagged', () => {
  // The bound that keeps this usable. Flagging his actual shoot names would train him to ignore it.
  for (const s of ['lawn-mowing', 'dennis-front-yard', 'gourgess-promo', 'curling', 'deer-butcher', 'kitchen-remodel']) {
    assert.equal(V.classifySubject(s).shotLike, false, `⚠ "${s}" is a real subject and must pass`);
  }
});

test('genuine fragments of one subject are recognised', () => {
  // The shape of his actual fragmentation: one name's tokens are a subset of another's.
  assert.ok(V.similarity('curlers', 'curlers-ice-rink') >= 0.7, 'curlers ⊂ curlers-ice-rink');
  assert.ok(V.similarity('b-roll', 'b-roll-living') >= 0.7, 'b-roll variants');
  assert.ok(V.similarity('lawn-mowing', 'lawn-mowing-dennis') >= 0.7, 'a shoot with a location suffix');
});

test('⚠⚠ a single GENERIC token does not merge two different shoots', () => {
  // The bug found by running this against his real data: with plain containment, `vlog` absorbed TEN
  // variants — kitchen-vlog, bedtime-vlog, vlog-david-googins. Those are plausibly different shoots,
  // and merging them destroys exactly the distinction filing needs.
  assert.equal(V.similarity('vlog', 'kitchen-vlog'), 0, '⚠ vlog must not swallow kitchen-vlog');
  assert.equal(V.similarity('vlog', 'bedtime-vlog'), 0, '⚠ nor bedtime-vlog');
  assert.equal(V.similarity('misc', 'misc-lawn-job'), 0, 'nor misc anything');
  // But two SPECIFIC names sharing a generic token still relate, because the rest carries meaning.
  assert.ok(V.similarity('kitchen-vlog', 'kitchen-vlog-b-roll') >= 0.7, 'specific names still merge');
});

test('⚠⚠ unrelated subjects never merge', () => {
  for (const [a, b] of [
    ['lawn-mowing', 'curling'],
    ['deer-butcher', 'kitchen-remodel'],
    ['dennis-front-yard', 'josiah-talking-head'],
  ]) assert.ok(V.similarity(a, b) < 0.7, `⚠ "${a}" and "${b}" are different shoots`);
});

test('a vocabulary built from his own history collapses the variants', () => {
  const counts = {
    'lawn-mowing': 12, 'lawn-mowing-dennis': 3, 'lawn-mow': 2,
    curling: 5, 'curlers-ice-rink': 2,
    vlog: 7, 'kitchen-vlog': 4,          // must stay apart
  };
  const v = V.buildVocabulary(counts);
  const names = v.subjects.map((s) => s.name);
  assert.ok(names.includes('lawn-mowing'), 'the busiest name survives as canonical');
  assert.equal(v.aliases['lawn-mowing-dennis'], 'lawn-mowing', 'its variant points at it');
  assert.ok(!names.includes('lawn-mowing-dennis'), 'and is not offered separately');
  assert.ok(names.includes('vlog') && names.includes('kitchen-vlog'),
    '⚠ vlog and kitchen-vlog stay separate — different shoots');
});

test('⚠ canonicalising an AI suggestion snaps it onto a name he already uses', () => {
  const v = V.buildVocabulary({ 'lawn-mowing': 12, curling: 5 });
  const r = V.canonicalize('lawn-mowing-dennis-yard', v);
  assert.equal(r.canonical, 'lawn-mowing', 'it maps onto the existing subject');
  assert.equal(r.matched, true);
  assert.ok(r.score >= 0.7, `with a real score — got ${r.score}`);
});

test('⚠⚠ a genuinely NEW subject is left alone, not forced into the vocabulary', () => {
  // The failure mode that would make this hated: his first clip of a new job being filed under an
  // old one. A new name must survive contact with the vocabulary.
  const v = V.buildVocabulary({ 'lawn-mowing': 12, curling: 5 });
  const r = V.canonicalize('wedding-fieldhouse', v);
  assert.equal(r.matched, false, '⚠ a new shoot stays new');
  assert.equal(r.canonical, 'wedding-fieldhouse', 'and keeps the name he gave it');
});

test('canonicalising also reports whether the name describes the shot', () => {
  // So the caller can offer "that looks like a shot type — what is this footage FOR?" at the moment
  // it is proposed, rather than discovering it 4,000 clips later.
  const v = V.buildVocabulary({ 'lawn-mowing': 12 });
  const r = V.canonicalize('talking-head-young', v);
  assert.equal(r.shotLike, true);
  assert.match(r.why, /on screen/);
});

test('an empty or junk subject is handled without throwing', () => {
  const v = V.buildVocabulary({ 'lawn-mowing': 1 });
  for (const junk of ['', '   ', '!!!', null, undefined]) {
    const r = V.canonicalize(junk, v);
    assert.equal(r.canonical, '', `"${junk}" yields nothing, quietly`);
  }
  assert.deepEqual(V.buildVocabulary(null).subjects, [], 'and an empty history is fine');
});

test('⚠ the module is stateless, as every core/ module must be', () => {
  // The require cache is per-process while the vm context is per-loadMain(), so module-level state
  // would leak between tests. Same call, same answer, regardless of what ran before.
  const v1 = V.buildVocabulary({ a: 1, 'a-b': 1 });
  const v2 = V.buildVocabulary({ a: 1, 'a-b': 1 });
  assert.deepEqual(v1.subjects, v2.subjects, 'deterministic');
  assert.deepEqual(v1.aliases, v2.aliases);
});
