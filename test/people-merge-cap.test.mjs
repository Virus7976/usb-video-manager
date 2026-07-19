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

test('#49 — merging people keeps every CONFIRMED enrolment face, shedding unconfirmed first', async () => {
  const app = await loadMain();
  const conf = Array.from({ length: 55 }, (_, i) => ({ d: [i / 100, 0, 0], confirmed: true, t: '' }));
  const unconf = Array.from({ length: 20 }, (_, i) => ({ d: [9, i / 100, 0], confirmed: false, t: '' }));
  seedPeople(app, [
    { id: 'into', name: 'Alice', faces: conf, thumb: '' },
    { id: 'from', name: 'Al', faces: unconf, thumb: '' },
  ]);
  await app.invoke('people:merge', { intoId: 'into', fromId: 'from' });
  const people = app.plain(app.get('config.ai.people'));
  const into = people.find((p) => p.id === 'into');
  assert.ok(into, 'the target person survived');
  assert.ok(into.faces.length <= 60, 'still capped');
  const confKept = into.faces.filter((f) => f.confirmed).length;
  assert.equal(confKept, 55, 'all 55 confirmed enrolment faces survive the merge (unconfirmed shed first)');
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
