// #44 (AI-leak half) — renaming a person via clips:retagPerson rewrites finalMeta + drafts, but the
// per-clip OBSERVATION text in clipObs (fed back into naming, and re-embeddable) kept the OLD name,
// leaking it into future AI runs long after the retag. It's now swapped too, whole-word, on a rename.
// (versions.json snapshots are intentionally left — a restore point is a point-in-time record.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

test('retagPerson swaps the name in clipObs too (whole word only), and the record', async () => {
  const app = await loadMain();
  await app.invoke('finalMeta:save', {
    'a__1': { people: ['Bob'], subject: 'Bob mows', description: 'Bob in the yard' },
  });
  await app.invoke('clipObs:save', { key: 'a__1', obs: 'Bob waters the lawn while Bobby watches' });

  const r = app.plain(await app.invoke('clips:retagPerson', { from: 'Bob', to: 'Rob' }));
  assert.equal(r.ok, true);
  assert.ok(r.changed >= 1, 'at least the finalMeta record changed');

  const fm = app.plain(await app.invoke('finalMeta:get'));
  assert.deepEqual(fm['a__1'].people, ['Rob'], 'tag renamed on the record');
  assert.equal(fm['a__1'].subject, 'Rob mows', 'name swapped in subject text');

  const obs = app.plain(await app.invoke('clipObs:get'));
  assert.equal(obs['a__1'].obs, 'Rob waters the lawn while Bobby watches',
    'observation swapped whole-word — "Bob"→"Rob", "Bobby" left intact');
});

test('retagPerson removal (to="") drops the tag but does not scrub observation prose', async () => {
  const app = await loadMain();
  await app.invoke('finalMeta:save', { 'a__1': { people: ['Bob'], subject: 'Bob mows' } });
  await app.invoke('clipObs:save', { key: 'a__1', obs: 'Bob waters the lawn' });

  await app.invoke('clips:retagPerson', { from: 'Bob', to: '' });

  const fm = app.plain(await app.invoke('finalMeta:get'));
  assert.deepEqual(fm['a__1'].people, [], 'tag removed from the record');
  const obs = app.plain(await app.invoke('clipObs:get'));
  assert.equal(obs['a__1'].obs, 'Bob waters the lawn', 'prose untouched on a removal');
});
