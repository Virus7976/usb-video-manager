// Deleting a person left their name on every already-filed clip.
//
// Rename and merge both finish by calling `offerRetagAffectedClips` → `clips:retagPerson`, which
// reaches `finalMeta`, `renameDrafts` and `ai.clipObs`. Delete did neither:
//
//     main.querySelector('.pd-del').addEventListener('click', async () => {
//       removeClipPersonName(d.name); await window.api.deletePerson(selId); await reloadPeople(false); });
//
// and `removeClipPersonName` (src/mod/08-people.js) mutates ONLY in-memory arrays — no
// `flushDraftSave()`, and it filters `people` but not `peopleAuto`, unlike its twin
// `updateClipPeopleName` which fixes both.
//
// `clips:retagPerson` has always supported removal — `to === ''` → `fixArr` filters the falsy value
// out (main-mod/08-finalize-feedback.js:1218-1224). The machinery existed; delete just never called
// it.
//
// Consequence: you delete a person because they shouldn't exist — a bad name, a wrong split — the
// dashboard goes clean, and every filed and pending clip still carries the name. It then gets
// embedded into the file as PersonInImage/keywords at the next organize, and fed back into AI naming
// context through clipObs.
//
// The removal is OFFERED, not silent, matching rename/merge exactly ("Always asks; never changes
// silently"). That is the point of the fix: the two paths should behave the same way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('retagPerson with an empty target removes the name from BOTH people and peopleAuto', async () => {
  await app.invoke('drafts:save', {
    'a.mp4__1__1': { subject: 'mowing', description: '', people: ['Ada', 'Grace'], peopleAuto: ['Ada'] },
  });
  const r = await app.invoke('clips:retagPerson', { from: 'Ada', to: '' });
  assert.ok(r.ok);
  const d = app.plain(app.get('config').renameDrafts)['a.mp4__1__1'];
  assert.deepEqual(d.people, ['Grace'], 'the deleted person is gone from people');
  assert.deepEqual(d.peopleAuto, [], 'and from peopleAuto — the twin the in-memory path missed');
});

test('a removal leaves the written prose alone', async () => {
  // fixText only runs when there is a replacement name. Blanking a name out of a sentence would
  // corrupt it ("skating with  at the park"), so a removal deliberately edits arrays only.
  await app.invoke('drafts:save', {
    'b.mp4__2__2': { subject: 'skating with Linus', description: 'Linus at the park', people: ['Linus'] },
  });
  await app.invoke('clips:retagPerson', { from: 'Linus', to: '' });
  const d = app.plain(app.get('config').renameDrafts)['b.mp4__2__2'];
  assert.deepEqual(d.people, [], 'the tag is gone');
  assert.equal(d.subject, 'skating with Linus', 'but the typed subject is untouched');
  assert.equal(d.description, 'Linus at the park', 'and so is the description');
});

test('a clip that never had the person is not rewritten', async () => {
  await app.invoke('drafts:save', { 'c.mp4__3__3': { subject: 'keep', description: '', people: ['Edsger'] } });
  const before = JSON.stringify(app.plain(app.get('config').renameDrafts)['c.mp4__3__3']);
  await app.invoke('clips:retagPerson', { from: 'Nobody', to: '' });
  assert.equal(JSON.stringify(app.plain(app.get('config').renameDrafts)['c.mp4__3__3']), before, 'untouched');
});

test('deleting a person offers to remove the tag from stored clips', async () => {
  // Source assertion bound to the CALL, not a bare identifier — a previous test in this repo stayed
  // green when the call it checked was made unreachable.
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8');
  const i = src.indexOf(".pd-del')");
  assert.ok(i > 0, 'found the delete wiring');
  const handler = src.slice(i, src.indexOf('\n', i));
  assert.match(handler, /deletePerson/, 'still deletes the person');
  assert.match(handler, /offerRetagAffectedClips\s*\(/, 'and offers the stored-clip removal, as rename and merge do');
});

test('the in-memory removal matches its rename twin', async () => {
  // removeClipPersonName filtered `people` only and never flushed, so even the in-memory half was
  // half-done next to updateClipPeopleName.
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8');
  const i = src.indexOf('function removeClipPersonName');
  const body = src.slice(i, src.indexOf('\n}', i));
  // Name the TWO COLLECTIONS separately. Two weaker versions of this assertion failed to catch a
  // real break: `/peopleAuto/` matched while one of the two lines was deleted, and so did a
  // "count >= 2" check, because the surviving line mentions `f.meta.peopleAuto` twice. A structural
  // assertion has to name the thing that would actually go missing.
  assert.match(body, /c\.peopleAuto\s*=/, 'clears peopleAuto on the scanned clips');
  assert.match(body, /f\.meta\.peopleAuto\s*=/, 'and on the finalize scan — both, like updateClipPeopleName');
  assert.match(body, /flushDraftSave/, 'and persists the in-memory edit instead of dropping it');
});

test('the offer wording handles a REMOVAL rather than saying \'re-tag as ""\'', async () => {
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8');
  const i = src.indexOf('async function offerRetagAffectedClips');
  const body = src.slice(i, src.indexOf('\n}', i));
  assert.match(body, /!to|to === ''|removal/i, 'the empty-target case is handled explicitly');
});
