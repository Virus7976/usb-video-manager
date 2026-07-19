// Sweep finding — "Undo" on a confirmed face never untagged the clips.
//
// `assign()` sets done/assignedName and calls tagClips(), which tags every clip in the cluster. The
// Undo handler then untagged only `if (cl.autoMatched && cl.assignedName)` — and **autoMatched is
// read in three places and never SET anywhere**. So the condition could not be true: Undo reset the
// card and left the person tagged on all of their clips. The user sees the face go back to
// unnamed and reasonably believes the tag is gone.
//
// Audit #26 made the consequence worse rather than causing it: tagging now also writes through to
// finalMeta/renameDrafts, so an un-reversed tag is PERSISTED. Adding the write side without the
// reverse side is the gap this closes — `clips:tagPerson` needed a sibling.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const finalMeta = () => app.plain(app.get('config').finalMeta);
const drafts = () => app.plain(app.get('config').renameDrafts);
const untag = (name, keys) => app.invoke('clips:untagPerson', { name, keys });

beforeEach(() => {
  const cfg = app.get('config');
  cfg.finalMeta = {
    'a.mp4__1': { subject: 'ski', people: ['josiah', 'dad'] },
    'b.mp4__2': { subject: 'ski', people: ['josiah'] },
    'c.mp4__3': { subject: 'lawn', people: ['josiah'] },
  };
  cfg.renameDrafts = { 'a.mp4__1': { subject: 'ski', people: ['josiah'] } };
});

test('undo removes the person from exactly the cluster\'s clips', async () => {
  const r = await untag('josiah', ['a.mp4__1', 'b.mp4__2']);
  assert.equal(r.ok, true);
  assert.deepEqual(finalMeta()['a.mp4__1'].people, ['dad'], 'the other person is left alone');
  assert.deepEqual(finalMeta()['b.mp4__2'].people, []);
  assert.deepEqual(finalMeta()['c.mp4__3'].people, ['josiah'], 'a clip outside the cluster keeps the tag');
});

test('the persisted DRAFT is reversed too', async () => {
  await untag('josiah', ['a.mp4__1']);
  assert.deepEqual(drafts()['a.mp4__1'].people, []);
});

test('untagging is idempotent', async () => {
  await untag('josiah', ['b.mp4__2']);
  const r2 = await untag('josiah', ['b.mp4__2']);
  assert.equal(r2.untagged, 0, 'a second undo reports nothing changed');
  assert.deepEqual(finalMeta()['b.mp4__2'].people, []);
});

test('a nameless or keyless call is refused', async () => {
  assert.equal((await untag('', ['a.mp4__1'])).ok, false);
  assert.equal((await untag('josiah', [])).ok, false);
  assert.deepEqual(finalMeta()['a.mp4__1'].people, ['josiah', 'dad'], 'nothing was touched');
});

test('an unknown key is ignored, never created', async () => {
  const r = await untag('josiah', ['never-seen.mp4__9']);
  assert.equal(r.untagged, 0);
  assert.equal(finalMeta()['never-seen.mp4__9'], undefined);
});

test('the Undo handler no longer gates on the never-set autoMatched flag', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(ROOT, 'src/mod/08-people.js'), 'utf8');
  const undoLine = src.split('\n').find((l) => l.includes('.fgc-undo'));
  assert.ok(undoLine, 'the undo handler still exists');
  assert.equal(/if \(cl\.autoMatched && cl\.assignedName\) untagClips/.test(undoLine), false,
    'the dead autoMatched gate is gone — it made Undo a no-op for every real confirmation');
  assert.match(undoLine, /untagClips\(cl, cl\.assignedName\)/, 'undo untags whenever a name was applied');
});
