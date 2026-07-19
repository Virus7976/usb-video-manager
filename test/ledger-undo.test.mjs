// Audit #37 — `organize:undo` reversed the file MOVES but not the project LEDGER.
// Undoing a mis-filed run therefore left a phantom project behind: a record that still
// carried the clip counts, dates and subjects of footage that is no longer filed there.
// That is not cosmetic — `ledger:matchDates` / `search_projects` keep scoring FUTURE
// imports against those phantom dates/subjects, so one bad Organize permanently poisons
// placement. Undo has to reverse the memory as well as the files.
//
// The reversal must be a PRECISE DIFF, not a snapshot-restore: `ledger:summarize` writes
// summary/keywords onto the record AFTER filing, and restoring a pre-filing snapshot would
// silently throw that summary away. So we reverse only what THIS run actually added.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMain } from './harness.mjs';

let app;
let tmp;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

beforeEach(() => {
  app.get('config').projectLedger = [];
  app.get('config').lastOrganize = null;
  app.get('config').lastLedger = null;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-undo-'));
});

const rec = (entries) => app.invoke('ledger:record', { entries });
const ledger = () => app.plain(app.get('config').projectLedger || []);
const find = (key) => ledger().find((p) => p.rel === key) || null;

// Stage a real filed COPY so organize:undo runs its true path (it removes the copy while
// the original is verifiably present) rather than a stubbed one.
function stageFiledCopy(name = 'a.mp4') {
  const from = path.join(tmp, `src-${name}`);
  const to = path.join(tmp, `filed-${name}`);
  fs.writeFileSync(from, 'footage');
  fs.writeFileSync(to, 'footage');
  app.get('config').lastOrganize = { ts: Date.now(), moves: [{ from, to, copied: true }] };
  return { from, to };
}

test('#37 undo removes a project this run CREATED (no phantom record left behind)', async () => {
  // Real ordering: the files are filed (lastOrganize stamped) and THEN the renderer records
  // the ledger — so the delta always carries the later timestamp.
  stageFiledCopy();
  await rec([{ rel: '2026/2026 - Client Work/Acme Shoot', name: 'a.mp4', subject: 'acme', date: '2026-07-18' }]);
  assert.ok(find('2026/2026 - Client Work/Acme Shoot'), 'project recorded by the filing run');

  const r = await app.invoke('organize:undo');
  assert.equal(r.ok, true);

  assert.equal(find('2026/2026 - Client Work/Acme Shoot'), null,
    'a project that only existed because of the undone run must be gone, not left as a phantom');
});

test('#37 undo decrements a PRE-EXISTING project instead of deleting it', async () => {
  // An earlier session filed one clip here.
  await rec([{ rel: '2026/2026 - Personal/Ski', name: 'old.mp4', subject: 'skiing', date: '2026-01-02' }]);
  app.get('config').lastLedger = null;   // that earlier run is not what we're undoing

  // This run files two more.
  stageFiledCopy();
  await rec([
    { rel: '2026/2026 - Personal/Ski', name: 'new1.mp4', subject: 'snowboarding', date: '2026-07-18' },
    { rel: '2026/2026 - Personal/Ski', name: 'new2.mp4', subject: 'snowboarding', date: '2026-07-18' },
  ]);
  assert.equal(find('2026/2026 - Personal/Ski').clips, 3, 'three clips filed in total');

  await app.invoke('organize:undo');

  const p = find('2026/2026 - Personal/Ski');
  assert.ok(p, 'the project survives — it existed before this run');
  assert.equal(p.clips, 1, 'only the two clips from the undone run are subtracted');
  assert.deepEqual(p.clipNames, ['old.mp4'], 'the undone run\'s clip names are forgotten');
  assert.deepEqual(p.dates, ['2026-01-02'], 'the date this run introduced is reversed');
  assert.deepEqual(p.subjects, ['skiing'], 'the subject this run introduced is reversed');
});

test('#37 undo does NOT strip values that were already there before the run', async () => {
  await rec([{ rel: '2026/2026 - Personal/Ski', name: 'old.mp4', subject: 'skiing', date: '2026-07-18' }]);
  app.get('config').lastLedger = null;

  // The new run re-uses the SAME date and subject. Undo must leave them — the earlier
  // clip still justifies them; only the genuinely-new additions get reversed.
  stageFiledCopy();
  await rec([{ rel: '2026/2026 - Personal/Ski', name: 'new.mp4', subject: 'skiing', date: '2026-07-18' }]);

  await app.invoke('organize:undo');

  const p = find('2026/2026 - Personal/Ski');
  assert.deepEqual(p.dates, ['2026-07-18'], 'a date the previous clip also had is kept');
  assert.deepEqual(p.subjects, ['skiing'], 'a subject the previous clip also had is kept');
  assert.equal(p.clips, 1, 'but the undone clip is still uncounted');
});

test('#37 undo preserves a summary written AFTER filing (diff, not snapshot-restore)', async () => {
  await rec([{ rel: '2026/2026 - Personal/Ski', name: 'old.mp4', subject: 'skiing' }]);
  app.get('config').lastLedger = null;
  stageFiledCopy();
  await rec([{ rel: '2026/2026 - Personal/Ski', name: 'new.mp4', subject: 'snowboarding' }]);

  // ledger:summarize runs after filing and writes onto the same record.
  const live = app.get('config').projectLedger.find((p) => p.rel === '2026/2026 - Personal/Ski');
  live.summary = 'A ski trip in the Rockies.';
  live.keywords = ['ski', 'snow'];

  await app.invoke('organize:undo');

  const p = find('2026/2026 - Personal/Ski');
  assert.equal(p.summary, 'A ski trip in the Rockies.', 'the AI summary survives an undo');
  assert.deepEqual(p.keywords, ['ski', 'snow']);
});

test('#37 undo ignores a ledger delta that predates the run being undone', async () => {
  await rec([{ rel: '2026/2026 - Personal/Ski', name: 'old.mp4', subject: 'skiing' }]);
  const staleTs = app.get('config').lastLedger.ts;

  // A LATER organize run that recorded no ledger entries at all. Undoing it must not
  // reach back and reverse an unrelated earlier ledger write.
  stageFiledCopy();
  app.get('config').lastOrganize.ts = staleTs + 60000;

  await app.invoke('organize:undo');

  assert.ok(find('2026/2026 - Personal/Ski'), 'the earlier run\'s project is untouched');
  assert.equal(find('2026/2026 - Personal/Ski').clips, 1);
});

test('#37 the ledger delta is consumed once — a second undo cannot double-reverse', async () => {
  await rec([{ rel: '2026/2026 - Personal/Ski', name: 'old.mp4', subject: 'skiing' }]);
  app.get('config').lastLedger = null;
  stageFiledCopy();
  await rec([{ rel: '2026/2026 - Personal/Ski', name: 'new.mp4', subject: 'x' }]);

  await app.invoke('organize:undo');
  assert.equal(find('2026/2026 - Personal/Ski').clips, 1);

  // lastOrganize is cleared, so this is a no-op — but assert the ledger didn't move again.
  await app.invoke('organize:undo');
  assert.equal(find('2026/2026 - Personal/Ski').clips, 1, 'clips did not go negative on a repeat undo');
});
