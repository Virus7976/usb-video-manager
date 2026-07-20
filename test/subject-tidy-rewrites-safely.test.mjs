// The retroactive half of FEATURES.md item 29 — and the one that moves the number.
//
// Snapping new names stops the fragmentation GROWING. It does nothing for the 4,594 clips already
// carrying 112 competing subjects, and those are what filing has to group today. One clip is filed.
//
// ⚠⚠ THIS REWRITES HIS EXISTING METADATA — the most destructive operation in the app. So the tests
// below spend most of their effort on what it must REFUSE to do, not on the happy path:
//   · nothing is applied that he did not explicitly pick (there is no apply-everything path);
//   · a chained rename is impossible — clips can never land on a name he did not choose;
//   · it refuses entirely against a store that failed to READ this launch, because rewriting into an
//     empty default would strip the subject off every clip;
//   · a save point is taken BEFORE the rewrite, so Version history undoes it.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const seed = (drafts, finalMeta = {}) => {
  const cfg = app.get('config');
  cfg.subjects = [];
  cfg.renameDrafts = {};
  cfg.finalMeta = {};
  let i = 0;
  for (const [subject, n] of Object.entries(drafts)) {
    for (let k = 0; k < n; k += 1) cfg.renameDrafts[`d${i += 1}.mp4__1__1`] = { subject };
  }
  for (const [name, subject] of Object.entries(finalMeta)) cfg.finalMeta[name] = { subject, done: true };
};
const plan = async () => app.plain(await app.invoke('subjects:mergePlan'));
const apply = async (picks) => app.plain(await app.invoke('subjects:applyMerge', { picks }));
const subjectsOf = () => Object.values(app.plain(app.get('config.renameDrafts')) || {}).map((r) => r.subject);

beforeEach(() => { seed({}); });

test('the plan states real consequences, not "these look similar"', async () => {
  seed({ 'lawn-mowing': 12, 'lawn-mowing-dennis': 3 }, { 'a.mp4': 'lawn-mowing-dennis' });
  const p = await plan();
  assert.equal(p.ok, true);
  const m = p.merges.find((x) => x.to === 'lawn-mowing');
  assert.ok(m, 'the merge is proposed');
  assert.deepEqual(m.from, ['lawn-mowing-dennis']);
  assert.equal(m.clips, 4, 'counts drafts AND filed records — 3 drafts + 1 filed');
  assert.equal(m.filed, 1, '⚠ and says how many are ALREADY FILED, which is the scary part');
  assert.equal(m.toClips, 12, 'and how many already use the target');
});

test('⚠⚠ ONLY what he picked is applied', async () => {
  // There is deliberately no apply-everything path. A bad merge files a personal vlog into a client
  // job — a failure this repo has already had and reverted.
  seed({ 'lawn-mowing': 5, 'lawn-mowing-dennis': 2, curling: 4, 'curling-rink': 2 });
  const r = await apply([{ to: 'lawn-mowing', from: ['lawn-mowing-dennis'] }]);
  assert.equal(r.ok, true);
  assert.equal(r.changed, 2, 'only the two lawn clips moved');
  const subs = subjectsOf();
  assert.equal(subs.filter((s) => s === 'lawn-mowing').length, 7);
  assert.equal(subs.filter((s) => s === 'curling-rink').length, 2, '⚠ the unpicked merge is untouched');
});

test('⚠⚠ a CHAINED rename is impossible', async () => {
  // If A→B and B→C were both applied, clips from A would land on C — a name he never picked for
  // them. Silently moving footage somewhere unchosen is the exact failure this app keeps producing.
  seed({ a: 3, b: 3, c: 3 });
  const r = await apply([{ to: 'b', from: ['a'] }, { to: 'c', from: ['b'] }]);
  assert.equal(r.ok, true);
  const subs = subjectsOf();
  assert.equal(subs.filter((s) => s === 'c').length, 6, 'b→c applied');
  assert.equal(subs.filter((s) => s === 'a').length, 3, '⚠ a is left alone rather than chained to c');
  assert.equal(subs.filter((s) => s === 'b').length, 0, 'and b is gone, as picked');
});

test('a subject never merges into itself', async () => {
  // ⚠ HONESTY NOTE: removing the `from !== to` check does NOT fail this test, and I checked why
  // rather than assuming it was caught. The chain guard below it (`if (map.has(to)) map.delete(from)`)
  // sees `lawn-mowing -> lawn-mowing`, finds the target is itself a key, and drops the entry — so the
  // map empties and the call is refused anyway.
  //
  // So `from !== to` is redundant defence, not the thing under test. It stays because it states the
  // intent at the point a reader looks for it, and because a future change to the chain guard would
  // silently remove the only protection. Recorded here so nobody mistakes this test for proof of it.
  seed({ 'lawn-mowing': 4 });
  const r = await apply([{ to: 'lawn-mowing', from: ['lawn-mowing'] }]);
  assert.equal(r.ok, false, 'refused as a no-op rather than counted as work');
  assert.equal(subjectsOf().filter((s) => s === 'lawn-mowing').length, 4);
  // Bind the intent explicitly, since behaviour cannot reach it.
  const src = readFileSync(join(process.cwd(), 'main-mod', '10-ai-tools.js'), 'utf8');
  assert.match(src, /if \(from && from !== to\) map\.set\(from, to\);/,
    'the explicit self-merge guard is present even though another layer also covers it');
});

test('⚠⚠ it refuses entirely against a store that could not be READ', async () => {
  // An unreadable store leaves an empty default in memory. Rewriting into that would strip the
  // subject off every clip — the same contract the rest of the app follows.
  seed({ 'lawn-mowing': 5, 'lawn-mowing-dennis': 2 });
  app.get('storeReadFailed').renameDrafts = true;
  const r = await apply([{ to: 'lawn-mowing', from: ['lawn-mowing-dennis'] }]);
  app.get('storeReadFailed').renameDrafts = false;
  assert.equal(r.ok, false, 'it refuses');
  assert.match(r.error, /could not be read/i, 'and says why');
  assert.equal(r.changed, 0);
  assert.equal(subjectsOf().filter((s) => s === 'lawn-mowing-dennis').length, 2, '⚠ nothing was touched');
});

test('filed metadata is rewritten too, and reported separately', async () => {
  // A filed clip's subject is what the ledger and future filing match on, so leaving it behind would
  // half-fix the problem in the place it matters most.
  seed({ 'lawn-mowing': 2 }, { 'x.mp4': 'lawn-mowing-dennis', 'y.mp4': 'lawn-mowing-dennis' });
  const r = await apply([{ to: 'lawn-mowing', from: ['lawn-mowing-dennis'] }]);
  assert.equal(r.filedChanged, 2, 'both filed records moved');
  const fm = app.plain(app.get('config.finalMeta'));
  assert.equal(fm['x.mp4'].subject, 'lawn-mowing');
});

test('an empty selection changes nothing', async () => {
  seed({ a: 2, 'a-b': 2 });
  const r = await apply([]);
  assert.equal(r.ok, false);
  assert.equal(r.changed, 0);
});

test('⚠ shot-descriptions are surfaced but NOT merged away', async () => {
  // Merging cannot fix "talking-head" — it is not a spelling problem, it is the wrong KIND of name.
  // Saying so is useful; quietly folding them together would hide the real issue.
  seed({ 'talking-head': 8, 'lawn-mowing': 3 });
  const p = await plan();
  assert.ok(p.shotLike.some((x) => x.name === 'talking-head'), 'it is named as shot-like');
  assert.ok(!p.merges.some((m) => m.to === 'lawn-mowing' && m.from.includes('talking-head')),
    '⚠ and is not merged into an unrelated real subject');
});

// --- the UI contract: destructive, so it must ask, preview and be undoable ---
const people = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('⚠⚠ a save point is taken BEFORE the rewrite', async () => {
  const at = people.indexOf('async function showSubjectTidy');
  assert.ok(at > -1, 'the dialog exists');
  const body = people.slice(at, people.indexOf('\nfunction showEditSubjects', at));
  const saveAt = body.indexOf("saveVersionPoint('Before tidying subjects'");
  const applyAt = body.indexOf('window.api.applySubjectMerge');
  assert.ok(saveAt > -1 && applyAt > -1, 'both happen');
  assert.ok(saveAt < applyAt, '⚠ the save point precedes the rewrite — after it would be useless');
});

test('⚠⚠ nothing is pre-ticked', async () => {
  // A screen that arrives with 20 destructive changes already selected is one where "Apply" is a
  // mistake waiting to happen.
  const at = people.indexOf('async function showSubjectTidy');
  const body = people.slice(at, people.indexOf('\nfunction showEditSubjects', at));
  assert.match(body, /class="tidy-pick" data-i="\$\{i\}"/, 'checkboxes are rendered');
  assert.ok(!/class="tidy-pick"[^>]*checked/.test(body), '⚠ and none start checked');
  assert.match(body, /if \(!picked\.length\) \{ showToast\('Tick at least one'\); return; \}/,
    'and applying nothing is refused with a reason');
});

test('⚠ the confirmation names the scale, and the undo route', async () => {
  const at = people.indexOf('async function showSubjectTidy');
  const body = people.slice(at, people.indexOf('\nfunction showEditSubjects', at));
  assert.match(body, /affecting about \$\{clips\} clip/, 'it says how many clips');
  assert.match(body, /Version history/, 'and how to undo it');
});

test('⚠ a failed apply says so rather than looking like success', async () => {
  const at = people.indexOf('async function showSubjectTidy');
  const body = people.slice(at, people.indexOf('\nfunction showEditSubjects', at));
  assert.match(body, /Nothing was renamed/, 'the failure path has its own honest message');
});
