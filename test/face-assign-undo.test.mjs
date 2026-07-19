// Face-review "Undo" reversed the clip tags but not the ENROLMENT, so a mis-named face stayed
// trained onto that person forever.
//
// `assign()` (src/mod/08-people.js) performs three persisted writes:
//     await window.api.savePerson({ name, descriptors: cl.descriptors, thumb: cl.thumb });
//     tagClips(cl, name);          // -> finalMeta + renameDrafts
//     rememberSubject && rememberSubject(name);
// The Undo handler called only `untagClips`. The tag half was already fixed once (#26 — "without
// this the undo only removed the name from clips that happen to be in memory"); the enrolment half
// never was.
//
// Why it matters more than a stale tag: **only CONFIRMED descriptors vote** in `faceDecide`
// ("an unconfirmed guess never drives a match"). Naming a face confirms it. So mis-naming a face and
// immediately pressing Undo left the recognizer permanently taught that this face is that person —
// every later scan re-suggests the wrong name, and "Confirm all suggestions" then propagates it in
// bulk. The only repair was `people:removeFace`, buried behind a right-click in the People dashboard.
//
// The inverse cannot be guessed after the fact, because `people:save` does one of THREE things per
// descriptor: create the person, append a new face, or PROMOTE an existing near-duplicate from
// unconfirmed to confirmed (#28). Undoing a promotion by deleting the face would destroy an
// enrolment that existed before the assign. So the save now returns a receipt naming exactly what it
// did, and the undo replays it backwards. Faces carry an additive `fid` for this — a new optional
// field, so an old people.json still reads fine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const D = (v) => Array.from({ length: 128 }, (_, i) => (i === 0 ? v : 0.5));
const people = () => app.plain(app.get('config').ai.people || []);
const person = (name) => people().find((p) => p.name === name);

test('people:save returns a receipt describing what it changed', async () => {
  const r = await app.invoke('people:save', { name: 'Ada', descriptors: [D(0.1)], thumb: '' });
  assert.equal(r.ok, true);
  assert.ok(r.receipt, 'a receipt is returned so the undo does not have to guess');
  assert.ok(r.receipt.personId, 'names the person it touched');
  assert.equal(r.receipt.createdPerson, true, 'and records that this save CREATED the person');
  assert.equal((r.receipt.addedFids || []).length, 1, 'one face was appended');
});

test('undoing an assign that created a person removes the person', async () => {
  const r = await app.invoke('people:save', { name: 'Grace', descriptors: [D(0.2)], thumb: '' });
  assert.ok(person('Grace'), 'enrolled');
  await app.invoke('people:undoAssign', r.receipt);
  assert.equal(person('Grace'), undefined, 'the person the mis-assign invented is gone');
});

test('undoing an assign onto an EXISTING person keeps their earlier faces', async () => {
  // The critical safety property. Undo must remove only what this assign added — never unpick an
  // enrolment the user built earlier.
  await app.invoke('people:save', { name: 'Linus', descriptors: [D(0.3)], thumb: '' });
  const r = await app.invoke('people:save', { name: 'Linus', descriptors: [D(0.9)], thumb: '' });
  assert.equal(person('Linus').faces.length, 2, 'two distinct faces enrolled');
  await app.invoke('people:undoAssign', r.receipt);
  const p = person('Linus');
  assert.ok(p, 'the person survives — they existed before this assign');
  assert.equal(p.faces.length, 1, 'only the face this assign added was removed');
  assert.equal(p.faces[0].d[0], 0.3, 'and it is the ORIGINAL face that remains');
});

test('undoing a PROMOTION demotes the face instead of deleting it', async () => {
  // people:save promotes an existing near-duplicate to confirmed rather than appending. Deleting it
  // on undo would destroy a face that predates the assign, so the receipt records the promotion and
  // the undo reverses only the confirmed flag.
  await app.invoke('people:save', { name: 'Edsger', descriptors: [D(0.4)], thumb: '', confirmed: false });
  const before = person('Edsger');
  assert.equal(before.faces.length, 1);
  assert.equal(before.faces[0].confirmed, false, 'starts unconfirmed');

  const r = await app.invoke('people:save', { name: 'Edsger', descriptors: [D(0.4)], thumb: '' });
  assert.equal(person('Edsger').faces.length, 1, 'the near-duplicate was promoted, not appended');
  assert.equal(person('Edsger').faces[0].confirmed, true, 'and it is now confirmed — so it VOTES');
  assert.equal((r.receipt.promotedFids || []).length, 1, 'the receipt records the promotion');

  await app.invoke('people:undoAssign', r.receipt);
  const after = person('Edsger');
  assert.equal(after.faces.length, 1, 'the face still exists — it predates this assign');
  assert.equal(after.faces[0].confirmed, false, 'but it no longer votes, which is what the undo owed');
});

test('a replayed or bogus receipt cannot damage the store', async () => {
  // Undo is a UI button; a double-click must not remove a second face.
  await app.invoke('people:save', { name: 'Barbara', descriptors: [D(0.5)], thumb: '' });
  const r = await app.invoke('people:save', { name: 'Barbara', descriptors: [D(0.95)], thumb: '' });
  await app.invoke('people:undoAssign', r.receipt);
  await app.invoke('people:undoAssign', r.receipt);   // replayed
  await app.invoke('people:undoAssign', { personId: 'nope', addedFids: ['x'] });
  const p = person('Barbara');
  assert.ok(p, 'still present');
  assert.equal(p.faces.length, 1, 'the replay was a no-op, not a second removal');
});

test('the renderer Undo reverses the enrolment, not just the tags', async () => {
  // Positive assertion against the source; the handler is unreachable from the vm harness. Sliced to
  // the end of the handler body, not a fixed character window.
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8');
  const i = src.indexOf("const undo = card.querySelector('.fgc-undo')");
  assert.ok(i > 0, 'found the Undo wiring');
  const handler = src.slice(i, src.indexOf('\n', i));
  // Bind the CALL to its GUARD, not just the presence of the identifier. A first version of this
  // asserted `/undoAssign/` and stayed green when the call was made unreachable with `if (false)` —
  // the text was still there. This still cannot prove reachability in general (the handler is a DOM
  // listener, so the vm harness cannot invoke it and the e2e faces fixture has no enrolled person to
  // undo); it proves the call sits behind the receipt check and nothing else.
  assert.match(handler, /if\s*\(\s*cl\._enrol\s*\)[\s\S]{0,160}undoAssignPerson/,
    'Undo reverses the enrolment, guarded only by whether a receipt exists');
});
