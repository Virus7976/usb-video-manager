// "Ignore this face" is advertised as reversible in three places and was not reversible at all.
//
// `faces:ignore` moves a face OFF a person:
//     if (p && p.faces && idx < p.faces.length) { ig.push(p.faces[idx]); p.faces.splice(idx, 1); … }
// and the record it pushes is the bare `{d, t, confirmed}` — it carries NO owner id.
//
// `faces:unignore` only removes it from the bin:
//     const ig = aiIgnoredFaces(); const i = Number(idx); if (i >= 0 && i < ig.length) { ig.splice(i, 1); saveConfig(); }
// Nothing puts the face back on the person — and because the ignored entry never recorded which
// person it came from, nothing COULD.
//
// The UI insists otherwise. Three separate affordances promise restoration:
//   "Restore all ignored"                (src/mod/08-people.js, the Ignored group context menu)
//   "↩ Not ignored — restore"            (the per-face button in the Ignored view)
//   "Restore (not ignored)"              (the per-face context menu)
// So "ignore" reads as "hide this", the un-ignore is right there, and the person quietly loses a
// CONFIRMED enrolment face — the only kind that votes in faceDecide — permanently. Recognition of
// that person gets weaker with no visible cause.
//
// Fix: the ignored record now remembers its owner (`from`, plus `fromName` as a human fallback), and
// unignore restores the face to that person when it still exists. Additive optional fields, so
// entries ignored before this simply can't be restored — reported honestly rather than pretended.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// The ignored bin is a shared array on one app instance and it ACCUMULATES across tests — the same
// merge trap the harness notes warn about for store handlers. Without this, `faces:unignore(0)` in a
// later test pops the entry an earlier one left behind and the assertion fails on the wrong face.
beforeEach(() => { const ai = app.get('config').ai; if (Array.isArray(ai.ignored)) ai.ignored.length = 0; });

const D = (v) => Array.from({ length: 128 }, (_, i) => (i === 0 ? v : 0.5));
const people = () => app.plain(app.get('config').ai.people || []);
const ignored = () => app.plain(app.get('config').ai.ignored || []);
const person = (name) => people().find((p) => p.name === name);

async function enrol(name, ...vals) {
  for (const v of vals) await app.invoke('people:save', { name, descriptors: [D(v)], thumb: '' });
  return person(name);
}

test('ignoring a face records which person it came from', async () => {
  const p = await enrol('Ada', 0.1, 0.9);
  await app.invoke('faces:ignore', { id: p.id, index: 0 });
  const ig = ignored();
  assert.equal(ig.length, 1, 'the face is in the bin');
  assert.equal(ig[0].from, p.id, 'and it remembers its owner, so it can go back');
  assert.equal(ig[0].fromName, 'Ada', 'with the name as a human-readable fallback');
  assert.equal(person('Ada').faces.length, 1, 'and it really did leave the person');
});

test('un-ignoring puts the face BACK on the person', async () => {
  const p = await enrol('Grace', 0.2, 0.8);
  await app.invoke('faces:ignore', { id: p.id, index: 0 });
  assert.equal(person('Grace').faces.length, 1, 'one face left');
  const r = await app.invoke('faces:unignore', 0);
  assert.equal(r.restoredTo, 'Grace', 'the restore is reported, not silent');
  assert.equal(person('Grace').faces.length, 2, 'the enrolment face is back');
  assert.equal(ignored().length, 0, 'and it left the bin');
});

test('a restored face keeps its CONFIRMED status', async () => {
  // The whole point: only confirmed faces vote in faceDecide. Restoring it as unconfirmed would
  // return the picture and not the recognition.
  const p = await enrol('Linus', 0.3, 0.7);
  await app.invoke('faces:ignore', { id: p.id, index: 0 });
  await app.invoke('faces:unignore', 0);
  const restored = person('Linus').faces.find((f) => f.d[0] === 0.3);
  assert.ok(restored, 'the exact face came back');
  assert.equal(restored.confirmed, true, 'and it still votes');
});

test('restoring is a no-op when the person is gone', async () => {
  // Deleting the person after ignoring one of their faces leaves nothing to restore to. It must
  // still leave the bin cleanly rather than throwing or resurrecting a deleted person.
  const p = await enrol('Edsger', 0.4, 0.6);
  await app.invoke('faces:ignore', { id: p.id, index: 0 });
  await app.invoke('people:delete', p.id);
  const r = await app.invoke('faces:unignore', 0);
  assert.equal(r.ok, true);
  assert.equal(r.restoredTo, '', 'nothing to restore to, and it says so');
  assert.equal(ignored().length, 0, 'the bin entry is still cleared');
  assert.equal(person('Edsger'), undefined, 'the deleted person is NOT resurrected');
});

test('a pre-existing ignored entry with no owner is handled honestly', async () => {
  // Everything ignored before this fix has no `from`. It cannot be restored; it must not throw and
  // must not silently claim success.
  app.get('config').ai.ignored.push({ d: D(0.55), t: '', confirmed: true });   // legacy shape
  const r = await app.invoke('faces:unignore', 0);
  assert.equal(r.ok, true);
  assert.equal(r.restoredTo, '', 'reported as un-restorable rather than pretended');
  assert.equal(ignored().length, 0, 'and still removed from the bin');
});

test('a face ignored straight from a scan has no owner and still works', async () => {
  // The descriptor-only branch: a face ignored during review never belonged to a person.
  await app.invoke('faces:ignore', { descriptor: D(0.65), thumb: '' });
  assert.equal(ignored().length, 1, 'binned');
  assert.equal(ignored()[0].from, undefined, 'with no owner, correctly');
  const r = await app.invoke('faces:unignore', 0);
  assert.equal(r.ok, true);
  assert.equal(ignored().length, 0, 'and un-ignoring just drops it');
});

test('restoring twice does not duplicate the face', async () => {
  const p = await enrol('Barbara', 0.45, 0.95);
  await app.invoke('faces:ignore', { id: p.id, index: 0 });
  await app.invoke('faces:unignore', 0);
  await app.invoke('faces:unignore', 0);   // the bin is empty now — must be a no-op
  assert.equal(person('Barbara').faces.length, 2, 'still two faces, not three');
});
