// Renaming a person onto an existing name created a DUPLICATE. Found by a create-vs-update sweep.
//
// Both CREATE paths dedup case-insensitively — people:save upserts via
//   people.find((x) => x.name.toLowerCase() === name.toLowerCase())
// and people:reassignFace does the same. people:rename wrote the name with no check at all, and the
// renderer caller only tested non-empty-and-changed.
//
// So the exact case the People dashboard invites — fixing a typo, "Sara" → "Sarah", when a "Sarah"
// already exists — produced TWO records with the same name. The dashboard then shows two
// indistinguishable cards; the enrolment faces stay SPLIT across both, so recognition of that person
// gets WORSE rather than better; and later people:save upserts land on whichever record `find` hits
// first, so confirmations silently go to only one of them.
//
// The fix REFUSES and reports the collision rather than silently merging: people:merge combines
// faces and deletes the source, which is not something to do behind the user's back on a typo fix.
// Main reports `{ ok:false, reason:'name-exists', existingId }` so the renderer can offer the merge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const desc = (v, i = 0) => { const d = new Array(128).fill(0); d[i] = v; return d; };
const people = () => app.plain(app.get('config').ai.people);

test('renaming onto an EXISTING name is refused, not silently duplicated', async () => {
  await app.invoke('people:save', { name: 'Sara', descriptors: [desc(1, 0)], thumb: '', confirmed: true });
  await app.invoke('people:save', { name: 'Sarah', descriptors: [desc(1, 5)], thumb: '', confirmed: true });
  const sara = people().find((p) => p.name === 'Sara');

  const r = app.plain(await app.invoke('people:rename', { id: sara.id, name: 'Sarah' }));
  assert.equal(r.ok, false, 'refused');
  assert.equal(r.reason, 'name-exists', 'and says why, so the caller can offer a merge');
  assert.ok(r.existingId, 'naming the record it would have collided with');

  const names = people().map((p) => p.name).sort();
  assert.deepEqual(names, ['Sara', 'Sarah'], 'still two DISTINCT people, no duplicate "Sarah"');
});

test('the collision check is case-insensitive, like the create path', async () => {
  // "sarah" and "Sarah" are the same person to every other part of this app; letting a rename
  // create both would split the enrolment set just as badly.
  await app.invoke('people:save', { name: 'Beth', descriptors: [desc(1, 9)], thumb: '', confirmed: true });
  const beth = people().find((p) => p.name === 'Beth');
  const r = app.plain(await app.invoke('people:rename', { id: beth.id, name: 'SARAH' }));
  assert.equal(r.ok, false, 'differing only in case still collides');
  assert.equal(r.reason, 'name-exists');
});

test('an ordinary rename to a FREE name still works', async () => {
  await app.invoke('people:save', { name: 'Jak', descriptors: [desc(1, 20)], thumb: '', confirmed: true });
  const jak = people().find((p) => p.name === 'Jak');
  const r = app.plain(await app.invoke('people:rename', { id: jak.id, name: 'Jake' }));
  assert.equal(r.ok, true, 'the normal typo fix is unaffected');
  assert.ok(people().some((p) => p.name === 'Jake'));
  assert.ok(!people().some((p) => p.name === 'Jak'));
});

test('renaming a person to its OWN name is a harmless no-op, not a self-collision', async () => {
  // The renderer guards this, but main must not refuse a person for colliding with itself.
  const jake = people().find((p) => p.name === 'Jake');
  const r = app.plain(await app.invoke('people:rename', { id: jake.id, name: 'Jake' }));
  assert.equal(r.ok, true, 'not treated as a clash with itself');
  assert.equal(people().filter((p) => p.name === 'Jake').length, 1);
});

test('a rename that only changes CASE of its own name is allowed', async () => {
  // "jake" → "Jake" is a legitimate correction of the same record, not a collision.
  const jake = people().find((p) => p.name === 'Jake');
  const r = app.plain(await app.invoke('people:rename', { id: jake.id, name: 'JAKE' }));
  assert.equal(r.ok, true);
  assert.ok(people().some((p) => p.name === 'JAKE'), 'the casing correction landed');
});
