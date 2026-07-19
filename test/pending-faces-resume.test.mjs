// TIER 1 of the toolness backlog: the home screen cannot see the work he actually abandoned.
//
// Measured on his real store: **458 face clusters sitting in `faces-pending`**, a face review
// started and walked away from. `pending:work` — the handler that drives the home screen's "you have
// work waiting" cards — counts only FILES IN FOLDERS (the uncompressed intake, the compressed
// ready-to-organize folder). It has no idea the face review exists, so the one piece of half-done
// work he has the most of is invisible every time he opens the app.
//
// That is the shape of the whole diagnosis in miniature: he does the work (267 face confirmations in
// his click log), stops partway, and the app never tells him there is a partly-finished job to walk
// back into. Nothing on any screen says "458 waiting".
//
// DELIBERATELY NOT SURFACED HERE: the 4263 clips with no typed name. Naming 4263 clips is exactly the
// marathon he already refuses, and putting that number on the home screen is a nag, not a tool — it
// tells him he is behind without offering a step he'd actually take. Faces are different: the work is
// already half done, each answer is one keystroke, and every answer permanently improves recognition.
// **Surface resumable work, not a backlog.**
//
// Only UNREVIEWED clusters count. A cluster he already named (`done`), dismissed (`skipped`) or
// rejected is finished business — counting those would make the number never go down, which is the
// fastest way to teach him to ignore it.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

beforeEach(() => {
  const cfg = app.get('config');
  cfg.ai = cfg.ai || {};
  cfg.ai.facesPending = [];
  // Keep the folder-scanning half out of the way — this test is about the store.
  cfg.intakeFolder = ''; cfg.finalizeSource = ''; cfg.organizeDest = '';
});
const setPending = (list) => { app.get('config').ai.facesPending = list; };

test('the home screen is told how many faces are waiting', async () => {
  setPending([
    { descriptor: [0.1], clipKeys: ['a__1'] },
    { descriptor: [0.2], clipKeys: ['b__2'] },
    { descriptor: [0.3], clipKeys: ['c__3'] },
  ]);
  const r = await app.invoke('pending:work');
  assert.equal(r.facesPending, 3, 'all three unreviewed clusters are counted');
});

test('faces he has already dealt with do NOT count', async () => {
  // If the number never drops, he learns to ignore it — which is worse than not showing it.
  setPending([
    { descriptor: [0.1], clipKeys: ['a__1'], done: true },
    { descriptor: [0.2], clipKeys: ['b__2'], skipped: true },
    { descriptor: [0.3], clipKeys: ['c__3'], rejected: true },
    { descriptor: [0.4], clipKeys: ['d__4'] },
  ]);
  const r = await app.invoke('pending:work');
  assert.equal(r.facesPending, 1, 'only the genuinely unreviewed one is waiting');
});

test('an empty review reports zero, so the card can stay hidden', async () => {
  setPending([]);
  const r = await app.invoke('pending:work');
  assert.equal(r.facesPending, 0, 'nothing waiting');
});

test('the lazy store is LOADED from disk before it is counted', async () => {
  // ai.facesPending is LAZY: unloaded it reads as undefined and would silently report 0 — the same
  // bug class that let the face-crop GC delete every crop (2026-07-19ae).
  //
  // This has to be behavioural, and a first version wasn't: asserting `typeof === 'number'` passed
  // whether or not ensureStore ran. So boot a SEPARATE app with the store seeded on DISK, clear the
  // in-memory copy, and count — with the load it finds 2, without it finds nothing.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = mkdtempSync(join(tmpdir(), 'uvd-pw-'));
  mkdirSync(join(base, 'USB SD Auto-Action'), { recursive: true });
  writeFileSync(join(base, 'USB SD Auto-Action', 'faces-pending.json'), JSON.stringify([
    { descriptor: [0.9], clipKeys: ['z__9'] },
    { descriptor: [0.8], clipKeys: ['y__8'] },
  ]));
  writeFileSync(join(base, 'USB SD Auto-Action', 'config.json'), JSON.stringify({ intakeFolder: '' }));

  let cold;
  try {
    cold = loadMain({ userData: base });
    cold.get("config.ai = config.ai || {}; delete config.ai.facesPending; storeLoaded['ai.facesPending'] = false;");
    const r = await cold.invoke('pending:work');
    assert.equal(r.facesPending, 2, 'the handler loaded the store from disk rather than trusting memory');
  } finally {
    try { cold && cold.dispose(); } catch { /* ignore */ }
    rmSync(base, { recursive: true, force: true });
  }
});

test('a broken faces store never breaks the home screen', async () => {
  // The home screen must render even if this store is unreadable. Nothing here is worth failing a
  // launch over.
  app.get('config').ai.facesPending = null;
  const r = await app.invoke('pending:work');
  assert.equal(r.ok, true, 'the handler still succeeds');
  assert.equal(r.facesPending, 0, 'and reports nothing waiting');
});

test('the existing folder counts still work', async () => {
  // Guard the other direction: this must add to pending:work, not replace what it already reports.
  setPending([{ descriptor: [0.1], clipKeys: ['a__1'] }]);
  const r = await app.invoke('pending:work');
  assert.equal(r.ok, true);
  assert.equal(typeof r.uncompressed, 'number', 'intake count still reported');
  assert.equal(typeof r.ready, 'number', 'ready-to-organize count still reported');
});

test('the home screen renders a resumable card for it', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const i = src.indexOf('async function renderPendingWork');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.ok(i > 0, 'found renderPendingWork');
  assert.match(fn, /facesPending/, 'it reads the waiting-faces count');
  assert.match(fn, /if \(facesWaiting\)/, 'and only shows a card when there is work to resume');
});
