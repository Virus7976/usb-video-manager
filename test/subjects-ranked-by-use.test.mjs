// The subject dropdown offers his 396 remembered subjects ALPHABETICALLY, so the first thing he sees
// is "abby, adjusting-airsoft-gun, aiden, airplane-passenger…" — and the words he actually uses are
// nowhere near the top.
//
// `subjects:add` keeps the list `.sort((a, b) => a.localeCompare(b))` and `subjects:get` hands that
// straight back. The combobox's own comment is explicit that this matters: *"empty query keeps the
// caller's order (e.g. most-used descriptions first)"* — it is ALREADY designed to be handed a ranked
// list, and nothing ever ranked one.
//
// Measured on his real drafts: 112 distinct subjects in use, and the distribution is nothing like
// uniform — `talking-head` 28, `liam` 14, `vlog` 7, `talking-head-young` 7, `misc` 6 … with **88 of
// them used exactly once**. So an alphabetical list is close to worst-case: the 88 one-offs are
// scattered through the exact place his five real words should be.
//
// He typed 354 field entries in his click log. Ranking by use is the difference between typing a
// subject and picking one.
//
// Deliberately a READ-ORDER change only. The stored list stays alphabetical — it is fine for storage
// and for anything that displays the vocabulary itself — and the fuzzy scorer still wins the moment
// he types a character. This only decides what greets him when the field is empty.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

beforeEach(() => {
  const cfg = app.get('config');
  cfg.subjects = ['abby', 'aiden', 'liam', 'talking-head', 'vlog'];
  cfg.renameDrafts = {};
  cfg.finalMeta = {};
});
const useSubjects = (pairs) => {
  const d = {};
  let i = 0;
  for (const [subject, n] of pairs) {
    for (let k = 0; k < n; k += 1) { d[`c${i}.mp4__${i}__${i}`] = { subject, description: '', ts: Date.now() }; i += 1; }
  }
  app.get('config').renameDrafts = d;
};

test('the subjects he uses most come first', async () => {
  useSubjects([['talking-head', 28], ['liam', 14], ['vlog', 7]]);
  const list = await app.invoke('subjects:get');
  assert.deepEqual(list.slice(0, 3), ['talking-head', 'liam', 'vlog'], 'ranked by how often he uses them');
});

test('subjects he has never used are still offered, after the ones he has', async () => {
  // The vocabulary must not shrink — a subject he typed once last year is still his.
  useSubjects([['vlog', 3]]);
  const list = await app.invoke('subjects:get');
  assert.equal(list[0], 'vlog', 'the used one leads');
  assert.deepEqual(list.slice(1).sort(), ['abby', 'aiden', 'liam', 'talking-head'], 'the rest are all still there');
});

test('unused subjects stay in alphabetical order among themselves', async () => {
  // With no usage signal, alphabetical is the only sensible order — and it is what he is used to.
  useSubjects([['vlog', 3]]);
  const list = await app.invoke('subjects:get');
  assert.deepEqual(list.slice(1), ['abby', 'aiden', 'liam', 'talking-head'], 'alphabetical tail');
});

test('with no usage at all the list is unchanged', async () => {
  // Guard the other direction: a fresh install must behave exactly as before.
  const list = await app.invoke('subjects:get');
  assert.deepEqual(list, ['abby', 'aiden', 'liam', 'talking-head', 'vlog'], 'plain alphabetical');
});

test('filed work counts too, not just drafts', async () => {
  // finalMeta is where a filed clip's subject lives. Ignoring it would rank his finished work at zero
  // — exactly backwards, since finished work is the strongest signal of what he actually shoots.
  app.get('config').finalMeta = {
    'a.mp4': { subject: 'liam', done: true, ts: 1 },
    'b.mp4': { subject: 'liam', done: true, ts: 1 },
    'c.mp4': { subject: 'liam', done: true, ts: 1 },
  };
  const list = await app.invoke('subjects:get');
  assert.equal(list[0], 'liam', 'a subject he has FILED three times leads');
});

test('reading the list never reorders what is stored', async () => {
  // Ranking is a view. Rewriting config.subjects would make the stored vocabulary depend on when it
  // was last read, and every other consumer would inherit an order it never asked for.
  useSubjects([['vlog', 9]]);
  await app.invoke('subjects:get');
  const stored = app.plain(app.get('config').subjects);
  assert.deepEqual(stored, ['abby', 'aiden', 'liam', 'talking-head', 'vlog'], 'storage untouched');
});

test('a subject used only in drafts still outranks an unused one', async () => {
  useSubjects([['abby', 1]]);
  const list = await app.invoke('subjects:get');
  assert.equal(list[0], 'abby', 'one use beats none');
});
