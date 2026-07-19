// `organize:undo` put the files back but left `finalMeta.done = true`, so an undone clip became
// pending work wearing a filed badge — and eventually evictable.
//
// `finalize:run` ends with `markFinalMetaDone(filed)`, whose own comment is explicit about what the
// flag means: "Mark clips as FILED, so their metadata becomes evictable by the prune above… until
// then its metadata is pending work and the store must hold on to it however long that takes."
//
// `done` is the SOLE gate on that prune (main-mod/08-finalize-feedback.js):
//     const isDone = (v) => !!(v && v.done);
//     let entries = Object.entries(store).filter(([, v]) => v && (!isDone(v) || (now - (v.ts||0)) < MAX_AGE));
// and it is also what makes an entry shed first under the hard cap.
//
// `organize:undo` restores the files, reverses the ledger delta and clears `config.lastOrganize` —
// but never touches finalMeta. So after an undo the clip is unfiled while still flagged filed: it
// becomes age-evictable at 180 days and is thrown away first under the cap. Once evicted,
// `finalize:run` filters it out at the top of the loop (`it.meta` required) and it can NEVER be
// organized again. The comment at that filter describes this exact outcome — "the AI's work silently
// gone" — as the thing the guard exists to prevent; the undo path simply re-created it from the
// other side.
//
// Delayed and silent, which is why it needs a test rather than a spot-check: nothing is visibly
// wrong on the day you press Undo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// A real filed copy on disk, plus the lastOrganize record the undo replays.
function stageOrganize({ copied }) {
  const base = mkdtempSync(join(tmpdir(), 'uvd-undo-'));
  const src = join(base, 'intake'); const proj = join(base, 'Projects', '2026 - test');
  mkdirSync(src, { recursive: true }); mkdirSync(proj, { recursive: true });
  const from = join(src, 'GX010042.MP4');
  const to = join(proj, 'GX010042.MP4');
  if (copied) writeFileSync(from, 'ORIGINAL');    // a copy leaves the original in place
  writeFileSync(to, 'FILED');

  const cfg = app.get('config');
  cfg.finalMeta = { 'gx010042.mp4': { subject: 'mowing', description: 'front lawn', done: true, ts: 1 } };
  cfg.lastOrganize = { ts: Date.now(), moves: [{ from, to, copied: !!copied }] };
  return { base, from, to, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const meta = () => app.plain(app.get('config').finalMeta) || {};

test('undoing a COPY clears the filed flag it set', async () => {
  const s = stageOrganize({ copied: true });
  try {
    const r = await app.invoke('organize:undo');
    assert.equal(r.ok, true);
    assert.equal(r.undone, 1, 'the file was un-filed');
    assert.equal(meta()['gx010042.mp4'].done, false, 'and its metadata is pending work again');
  } finally { s.cleanup(); }
});

test('undoing a MOVE clears it too', async () => {
  const s = stageOrganize({ copied: false });
  try {
    await app.invoke('organize:undo');
    assert.equal(meta()['gx010042.mp4'].done, false, 'the moved-back clip is pending again');
  } finally { s.cleanup(); }
});

test('the AI metadata itself survives the undo', async () => {
  // Clearing `done` must not be mistaken for deleting the entry — the subject/description are the
  // work the store exists to carry across the copy -> Tdarr -> organize gap.
  const s = stageOrganize({ copied: true });
  try {
    await app.invoke('organize:undo');
    const rec = meta()['gx010042.mp4'];
    assert.equal(rec.subject, 'mowing', 'the AI subject is intact');
    assert.equal(rec.description, 'front lawn', 'and so is the description');
  } finally { s.cleanup(); }
});

test('a clip the undo could NOT restore keeps its filed flag', async () => {
  // If the filed file is gone, the undo counts it as failed and the clip is still filed somewhere.
  // Clearing the flag then would resurrect metadata for a clip that really was organized.
  const s = stageOrganize({ copied: true });
  try {
    rmSync(s.to, { force: true });          // the filed copy vanished
    const r = await app.invoke('organize:undo');
    assert.equal(r.undone, 0, 'nothing was undone');
    assert.equal(meta()['gx010042.mp4'].done, true, 'so the flag is left alone');
  } finally { s.cleanup(); }
});

test('an unrelated filed clip is not reopened', async () => {
  const s = stageOrganize({ copied: true });
  try {
    const cfg = app.get('config');
    cfg.finalMeta['other.mp4'] = { subject: 'skating', done: true, ts: 1 };
    await app.invoke('organize:undo');
    assert.equal(meta()['other.mp4'].done, true, 'only the clips in this run are reopened');
  } finally { s.cleanup(); }
});

test('a finalMeta failure never fails the undo', async () => {
  // The files are already back by then. Same rule the ledger reversal follows: "a ledger problem
  // must never fail the undo."
  const s = stageOrganize({ copied: true });
  try {
    const real = app.get('clearFinalMetaDone');
    app.get('clearFinalMetaDone = function () { throw new Error("boom"); }');
    try {
      const r = await app.invoke('organize:undo');
      assert.equal(r.ok, true, 'the undo still reports success');
      assert.ok(!existsSync(s.to), 'and the file really was un-filed');
    } finally { app.get('clearFinalMetaDone')  /* touch */; app.get(`clearFinalMetaDone = ${String(real)}`); }
  } finally { s.cleanup(); }
});
