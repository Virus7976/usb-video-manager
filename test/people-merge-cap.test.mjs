// #49 — the face-count caps on merge/reassign/save kept only the NEWEST N faces indiscriminately, so a
// person's original hand-CONFIRMED enrolment faces (the ones that actually vote in recognition) could be
// pushed out by a pile of unconfirmed auto-guesses. The cap must shed unconfirmed faces first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

function seedPeople(app, people) {
  const c = app.get('config');
  c.ai = { people, ignored: [], facesPending: [], faceScenes: [], clipObs: {} };
}

// The cap here was 60 while people:save / reassignFace / unignore all used 80. Merge is the ONE path
// that combines two already-enrolled sets, so it applied the tightest limit at the moment most likely
// to exceed it: merging a "Sara" and a "Sarah" with 40 confirmed faces each shed 20 hand-confirmed
// enrolments — and merging duplicates is exactly what people:rename tells him to do. Now 80 like its
// siblings. The old fixture (55 conf + 20 unconf = 75) no longer reaches an 80 cap at all, so it is
// widened below to keep actually exercising "shed unconfirmed first" rather than passing vacuously.
test('#49 — merging people keeps every CONFIRMED enrolment face, shedding unconfirmed first', async () => {
  const app = await loadMain();
  const conf = Array.from({ length: 70 }, (_, i) => ({ d: [i / 100, 0, 0], confirmed: true, t: '' }));
  const unconf = Array.from({ length: 30 }, (_, i) => ({ d: [9, i / 100, 0], confirmed: false, t: '' }));
  seedPeople(app, [
    { id: 'into', name: 'Alice', faces: conf, thumb: '' },
    { id: 'from', name: 'Al', faces: unconf, thumb: '' },
  ]);
  await app.invoke('people:merge', { intoId: 'into', fromId: 'from' });
  const people = app.plain(app.get('config.ai.people'));
  const into = people.find((p) => p.id === 'into');
  assert.ok(into, 'the target person survived');
  // 100 in, 80 out — the cap genuinely engages, which is the only way the next assertion means
  // anything. A fixture that fits under the cap proves nothing about shedding order.
  assert.equal(into.faces.length, 80, 'capped at 80, the same limit every other face path uses');
  const confKept = into.faces.filter((f) => f.confirmed).length;
  assert.equal(confKept, 70, 'all 70 confirmed enrolment faces survive the merge (unconfirmed shed first)');
});

test('⚠ merging two well-enrolled people destroys no confirmed face', async () => {
  // His actual case: one person split across two spellings, both properly enrolled. Under the old
  // cap of 60 this silently destroyed 20 confirmed enrolments — fixing a duplicate made that person
  // HARDER to recognise, with no undo and no message.
  const app = await loadMain();
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({ d: [i / 100, tag, 0], confirmed: true, t: '' }));
  seedPeople(app, [
    { id: 'into', name: 'Sarah', faces: mk(40, 1), thumb: '' },
    { id: 'from', name: 'Sara', faces: mk(40, 2), thumb: '' },
  ]);
  await app.invoke('people:merge', { intoId: 'into', fromId: 'from' });
  const into = app.plain(app.get('config.ai.people')).find((p) => p.id === 'into');
  assert.equal(into.faces.filter((f) => f.confirmed).length, 80,
    '⚠ all 80 confirmed faces survive — the old cap of 60 destroyed 20 of them');
});

test('#49 — reassigning faces into a full person keeps confirmed faces', async () => {
  const app = await loadMain();
  const conf = Array.from({ length: 78 }, (_, i) => ({ d: [i / 200, 1, 0], confirmed: true, t: '' }));
  const unconf = Array.from({ length: 10 }, (_, i) => ({ d: [7, i / 100, 0], confirmed: false, t: '' }));
  seedPeople(app, [
    { id: 'to', name: 'Bob', faces: [...conf, ...unconf], thumb: '' },
    { id: 'from', name: 'B', faces: [{ d: [3, 3, 3], confirmed: false, t: '' }], thumb: '' },
  ]);
  await app.invoke('people:reassignFace', { fromId: 'from', index: 0, toName: 'Bob' });
  const people = app.plain(app.get('config.ai.people'));
  const to = people.find((p) => p.id === 'to');
  assert.ok(to.faces.length <= 80, 'capped at 80');
  // 78 original confirmed + the reassigned face (which lands confirmed) = 79; unconfirmed shed to fit.
  // With the old newest-80 slice this dropped to 70 — original enrolment faces fell out of the window.
  assert.equal(to.faces.filter((f) => f.confirmed).length, 79, 'all confirmed faces kept (original + reassigned)');
});
