// "Or it only ever asks it once and then it knows."
//
// The residual failure from the real-footage run: `2026-06-01_lawn-mowing_josiah_v23` is twelve
// minutes of two men SITTING ON THE GRASS repairing a mower. Nobody mows. He still calls it
// lawn-mowing, because the subject is what the footage is FOR — the job — not what is on screen. The
// label is not in the pixels; no vision model will ever find it, and the AI called it `vlog`.
//
// Guessing is wrong. Asking 37 times — once per clip of that shoot — is worse. He shoots in BATCHES,
// so ONE question settles the whole day, and the answer is kept forever.
//
// The invariant these protect: IT MUST NEVER ASK TWICE.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let app;

before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const seedLibrary = (map) => { app.get('config').finalMeta = map; app.call('saveStore', 'finalMeta'); };

beforeEach(() => {
  app.get('config').shootMemory = [];
  seedLibrary({});
});

test('an answered shoot is NEVER asked about again', async () => {
  const days = ['2026-06-01', '2026-06-01', '2026-06-12'];
  let r = await app.invoke('ai:shootsToAsk', days);
  assert.deepEqual(app.plain(r.shoots), ['2026-06-01', '2026-06-12'], 'both unknown, asked once each — not per clip');

  await app.invoke('ai:rememberShoot', { date: '2026-06-01', subject: 'lawn-mowing' });

  r = await app.invoke('ai:shootsToAsk', days);
  assert.deepEqual(app.plain(r.shoots), ['2026-06-12'], 'the answered shoot is gone for good');
});

test('37 clips from one shoot is ONE question, not 37', async () => {
  const days = Array.from({ length: 37 }, () => '2026-06-01');
  const r = await app.invoke('ai:shootsToAsk', days);
  assert.deepEqual(app.plain(r.shoots), ['2026-06-01']);
});

test('a shoot he has ALREADY named clips from is never asked about', async () => {
  // He named these himself, months ago. get_shoot_context already reads them. Asking would be the app
  // forgetting what he told it — the one thing he said must never happen.
  seedLibrary({ 'a.mp4': { date: '2026-06-01', subject: 'lawn-mowing' } });
  const r = await app.invoke('ai:shootsToAsk', ['2026-06-01', '2026-06-12']);
  assert.deepEqual(app.plain(r.shoots), ['2026-06-12']);
});

test('the answer survives a restart — it is written to config, not held in memory', async () => {
  await app.invoke('ai:rememberShoot', { date: '2026-06-01', subject: 'lawn-mowing' });
  const disk = JSON.parse(readFileSync(join(app.storeDir, 'config.json'), 'utf8'));
  assert.equal(disk.shootMemory[0].subject, 'lawn-mowing');
  assert.equal(disk.shootMemory[0].date, '2026-06-01');
});

test('answering the same shoot again REPLACES, never duplicates', async () => {
  await app.invoke('ai:rememberShoot', { date: '2026-06-01', subject: 'vlog' });
  await app.invoke('ai:rememberShoot', { date: '2026-06-01', subject: 'lawn-mowing' });
  const mem = app.getJSON('config').shootMemory;
  assert.equal(mem.length, 1, 'one entry per shoot day');
  assert.equal(mem[0].subject, 'lawn-mowing', 'his LATEST answer wins');
});

test('the answer is slugged, and junk is refused', async () => {
  const ok = await app.invoke('ai:rememberShoot', { date: '2026-06-01', subject: 'Lawn Mowing' });
  assert.equal(ok.subject, 'lawn-mowing');

  assert.equal((await app.invoke('ai:rememberShoot', { date: 'not-a-date', subject: 'vlog' })).ok, false);
  assert.equal((await app.invoke('ai:rememberShoot', { date: '2026-06-01', subject: '' })).ok, false);
  assert.equal(app.getJSON('config').shootMemory.length, 1, 'and junk never entered the memory');
});

test('get_shoot_context surfaces HIS answer above its own inference', async () => {
  await app.invoke('ai:rememberShoot', { date: '2026-06-01', subject: 'lawn-mowing' });
  const r = await app.get('AI_TOOLS').get_shoot_context.run({}, { date: '2026-06-01' });
  assert.equal(r.he_told_you_this_shoot_is, 'lawn-mowing');
});

test('…but it still shows the counts, so the observation can disagree', async () => {
  // 2026-06-01 really is 37 lawn-mowing AND 14 vlog. His answer is a strong prior, not a gag order:
  // a vlog clip shot on a lawn-mowing day must still be nameable as a vlog.
  await app.invoke('ai:rememberShoot', { date: '2026-06-01', subject: 'lawn-mowing' });
  seedLibrary({ a: { date: '2026-06-01', subject: 'vlog' } });
  const r = await app.get('AI_TOOLS').get_shoot_context.run({}, { date: '2026-06-01' });
  assert.equal(r.he_told_you_this_shoot_is, 'lawn-mowing');
  assert.equal(r.clips_you_already_named_from_this_shoot.vlog, 1, 'the contrary evidence is still there');
});

// --- the popup -------------------------------------------------------------------------------

test('it asks ONCE per shoot at the phase boundary — while the GPU is empty', () => {
  // Deliberate placement: vision is done, the reasoning model is not loaded yet. On a 6 GB card, a
  // human thinking is the one moment we can afford to hold no model at all. And his answer lands
  // before any clip from that shoot is named, rather than too late to matter.
  const src = read('src/mod/04-tasks-ai.js');
  // Match the CALL, not its argument list. This pinned `askAboutShoots(idxs)` and broke when the
  // function was changed to take clips so a second screen could share it (2026-07-20p) — the
  // placement this test actually cares about never moved. Fourth shape-pinned assertion this session.
  const at = src.indexOf('await askAboutShoots(');
  assert.ok(at > 0, 'the run actually asks');
  const evict = src.indexOf('await window.api.aiUseOnly(aiToolModelReady', at);
  assert.ok(evict > at, 'and it asks BEFORE the reasoning model is loaded');

  const p1 = src.indexOf('// PHASE 1');
  const p2 = src.indexOf('// PHASE 2');
  assert.ok(at > p1 && at > p2, 'i.e. after the vision phase, not during it');
});

test('the popup persists each answer AS IT IS GIVEN, not on close', () => {
  // Closing the window must never throw away what he already told it.
  const src = read('src/mod/04-tasks-ai.js');
  const fn = src.slice(src.indexOf('async function askAboutShoots('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const pick = body.slice(body.indexOf('const pick = (i, sub)'));
  assert.match(pick.slice(0, 400), /window\.api\.aiRememberShoot\(/, 'the answer is saved the moment it is picked');
});

test('it never asks when it has nothing to offer as an answer', () => {
  // Assert the CONTRACT — both preconditions are checked and each returns — not the exact line they
  // were once written on. This pinned `if (!aiToolModelReady || !subjectsCache.length) return;` and
  // broke when the tool-model check became a call instead of a flag read (2026-07-20o), even though
  // both guards still hold. Third time in this repo a test has failed for naming a shape rather than
  // a behaviour.
  const src = read('src/mod/04-tasks-ai.js');
  const fn = src.slice(src.indexOf('async function askAboutShoots('));
  const head = fn.slice(0, 900).replace(/\/\/.*$/gm, '');
  assert.match(head, /subjectsCache\.length\) return;/, 'no remembered subjects → no question');
  assert.match(head, /ensureToolModelKnown\(\)\)\) return;/, 'no tool-capable model → no question');
});

test('it reuses the faces grid he likes — same classes, not a new look', () => {
  // "I love the popup for when it asks me who is who in faces. That's really good."
  const src = read('src/mod/04-tasks-ai.js');
  const fn = src.slice(src.indexOf('async function askAboutShoots('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const cls of ['modal-overlay', 'face-grid', 'face-grid-card-item', 'fgc-chip', 'fgc-undo']) {
    assert.ok(body.includes(cls), `reuses .${cls}`);
  }
});
