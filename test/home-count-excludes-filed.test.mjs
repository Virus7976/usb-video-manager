// The home screen's "clips ready to organize" counts raw folder contents, so it never goes down.
//
// `pending:work` sets `ready = (await listVideosShallow(readyDir)).length` — every video in the
// Compressed folder. But filing COPIES, so those files stay exactly where they are. He files all 310,
// returns to the home screen, and it still says **310 clips ready to organize**, forever.
//
// This is the same principle the Organize list just got (2026-07-19br) applied one screen earlier,
// and it matters more here: the home screen is where he decides whether there is anything worth
// doing. A number that never moves is a number he stops reading — and then the card that was meant to
// pull him into the work becomes wallpaper.
//
// The project ledger knows which clips are filed (`clipNames`), and since 2026-07-19bq it is
// populated by his ordinary no-plan runs. Same source of truth as the list, so the two screens can
// never disagree.
//
// `ready` stays the count of what is LEFT. The raw folder total is still reported separately, because
// "310 in the folder, 12 left to do" is a more useful thing to be able to say than either number
// alone.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-home-'));
  const intake = join(base, 'Uncompressed');
  const ready = join(base, 'Compressed');
  mkdirSync(intake, { recursive: true }); mkdirSync(ready, { recursive: true });
  for (const n of ['a_v1.mp4', 'b_v1.mp4', 'c_v1.mp4']) writeFileSync(join(ready, n), 'FOOTAGE');
  const cfg = app.get('config');
  cfg.intakeFolder = intake;
  cfg.finalizeSource = ready;
  cfg.organizeDest = '';
  cfg.projectLedger = [];
  cfg.ai = cfg.ai || {}; cfg.ai.facesPending = [];
  box = { base, intake, ready, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});
const ledgerWith = (names) => {
  app.get('config').projectLedger = [{
    id: 'p1', rel: 'vlog', name: 'vlog', clipNames: names, clips: names.length,
    dates: [], subjects: [], locations: [], people: [], samples: [], firstSeen: 1, lastSeen: 1,
  }];
};

test('clips he has already filed stop counting as work to do', async () => {
  try {
    ledgerWith(['a_v1.mp4', 'b_v1.mp4']);
    const r = await app.invoke('pending:work');
    assert.equal(r.ready, 1, 'only the unfiled clip is still "ready to organize"');
  } finally { box.cleanup(); }
});

test('the raw folder total is still available', async () => {
  // "310 in the folder, 12 left" is more useful than either number on its own.
  try {
    ledgerWith(['a_v1.mp4', 'b_v1.mp4']);
    const r = await app.invoke('pending:work');
    assert.equal(r.readyTotal, 3, 'the folder still holds three');
  } finally { box.cleanup(); }
});

test('filing everything empties the card', async () => {
  // The point of the whole exercise: finishing the work makes the prompt go away.
  try {
    ledgerWith(['a_v1.mp4', 'b_v1.mp4', 'c_v1.mp4']);
    const r = await app.invoke('pending:work');
    assert.equal(r.ready, 0, 'nothing left to organize');
  } finally { box.cleanup(); }
});

test('before he files anything the count is unchanged', async () => {
  // Guard the other direction: this must not quietly hide work on a fresh install.
  try {
    const r = await app.invoke('pending:work');
    assert.equal(r.ready, 3, 'all three are waiting');
    assert.equal(r.readyTotal, 3);
  } finally { box.cleanup(); }
});

test('a broken ledger never hides work', async () => {
  // Fail toward SHOWING work: under-reporting is how a card silently stops pulling him in.
  try {
    app.get('config').projectLedger = null;
    const r = await app.invoke('pending:work');
    assert.equal(r.ready, 3, 'everything still counted');
  } finally { box.cleanup(); }
});

test('the home screen reads the remaining count, not the folder total', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const i = src.indexOf('async function renderPendingWork');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.match(fn, /w\.ready\b/, 'it uses the remaining count');
});

test('a filed clip is matched regardless of CASE', async () => {
  // Windows paths are case-insensitive, so the ledger can hold `A_V1.MP4` while the folder listing
  // yields `a_v1.mp4` (or the reverse, after a rename or a copy through a different tool). Matching
  // case-sensitively would quietly count filed work as still-to-do.
  //
  // My other fixtures are all lowercase, so they cannot see this: breaking the `.toLowerCase()` left
  // every one of them green. **A fixture that cannot distinguish the two behaviours is not a test of
  // the property.**
  try {
    ledgerWith(['A_V1.MP4', 'B_v1.Mp4']);
    const r = await app.invoke('pending:work');
    assert.equal(r.ready, 1, 'both filed clips recognised despite the case difference');
  } finally { box.cleanup(); }
});
