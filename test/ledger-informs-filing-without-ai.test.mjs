// Tier 2 item 29 — "infer subject from the folder he last filed a same-date shoot into."
//
// The app already knew this. `maybeOfferLedgerProject` matches today's card against projects he has
// filed before — and it sits inside `aiAnalyzeSelected`, which opens with `if (!requireAi()) return;`.
// **So his own filing history only informed him while Ollama happened to be running**, even though
// the match is JSON arithmetic that needs no model at all.
//
// Third instance of the same axis in one session — value locked behind an unnecessary dependency:
//   • filing rules applied only if he opened the destination map (2026-07-20ad);
//   • the shoot question was gated on a flag latched by an unrelated render (2026-07-20o);
//   • his filing history, gated on the AI being up.
//
// ⚠ THE SAFETY OF THIS RUNG IS `related`, NOT THE DATE. `matchLedgerProjects` scores subject / people
// / location overlap and marks a result `related` only when something genuinely overlaps. Its own
// comment says why: *"so unrelated footage shot the same day isn't pulled into a project."* A
// date-only rung would file a birthday into a client job — the single worst thing a filing guess can
// do, because it is confident, wrong, and buried in a folder he trusts.
//
// The scoring was EXTRACTED rather than reimplemented: the suggestion he sees and the folder he gets
// must come from one function, or they drift — the bug class that produced a badge naming a folder
// that did not exist (2026-07-20u).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// A project he filed before: a lawn job for Gourgess, shot on 2026-05-16.
const PAST_PROJECT = {
  id: 'p1', rel: '2026/2026 - Client Work/Gourgess Lawns', name: 'Gourgess Lawns',
  clips: 12, clipNames: ['old.mp4'], dates: ['2026-05-16'],
  subjects: ['lawnmowing'], locations: ['depot'], people: ['Liam'], samples: [],
  firstSeen: 1, lastSeen: 2,
};

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-ledgerrung-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.finalMeta = {};
  cfg.ai = cfg.ai || {}; cfg.ai.routes = [];
  cfg.projectLedger = [JSON.parse(JSON.stringify(PAST_PROJECT))];
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const where = async (meta, extra = {}) => {
  const r = app.plain(await app.invoke('organize:previewDest', {
    items: [{ name: 'clip.mp4', sourcePath: join(box.dir, 'clip.mp4'), meta, ...extra }],
    folderLevels: ['category', 'project'],
  }));
  return r.dests[0].rel;
};

test('⚠⚠ footage from a shoot he has filed before goes back to that project — no AI involved', async () => {
  try {
    const rel = await where({ subject: 'lawnmowing', date: '2026-05-16', people: ['Liam'] });
    assert.equal(rel, '2026/2026 - Client Work/Gourgess Lawns', `his own history decided — got ${rel}`);
  } finally { box.cleanup(); }
});

test('⚠⚠ a SAME-DATE clip with nothing in common is NOT pulled in', async () => {
  // The birthday-into-a-client-job case. Same day, entirely different footage: the ledger must stay
  // out of it and the ordinary subject/date ladder must run.
  try {
    const rel = await where({ subject: 'birthday', date: '2026-05-16', description: 'cake' });
    assert.equal(rel, 'birthday/2026-05-16', `left to the normal ladder — got ${rel}`);
  } finally { box.cleanup(); }
});

test('a clip from a DIFFERENT date is unaffected even with the same subject', async () => {
  // The ledger match starts from a shared shoot date; without one there is nothing to infer from.
  try {
    const rel = await where({ subject: 'lawnmowing', date: '2026-09-09' });
    assert.equal(rel, 'lawnmowing/2026-09-09', `no shared date, no inference — got ${rel}`);
  } finally { box.cleanup(); }
});

test('⚠ his explicit placement still outranks his history', async () => {
  try {
    const rel = await where({ subject: 'lawnmowing', date: '2026-05-16' }, { rel: '2026 - Personal' });
    assert.equal(rel, '2026 - Personal', `what he just did wins — got ${rel}`);
  } finally { box.cleanup(); }
});

test('⚠ a standing RULE still outranks his history', async () => {
  // Order matters: a rule is a decision he made deliberately and expects to hold; the ledger is an
  // inference from what happened before.
  try {
    app.get('config').ai.routes = [{
      id: 'r1', name: 'Lawn care', kind: 'route',
      match: ['lawnmowing'], byDay: false, dest: '2026/2026 - Client Work/Rule Wins',
    }];
    const rel = await where({ subject: 'lawnmowing', date: '2026-05-16', people: ['Liam'] });
    assert.equal(rel, '2026/2026 - Client Work/Rule Wins', `the rule decides — got ${rel}`);
  } finally { box.cleanup(); }
});

test('with an EMPTY ledger nothing changes', async () => {
  // A fresh install, and his own state until this week. The ladder must behave exactly as before.
  try {
    app.get('config').projectLedger = [];
    const rel = await where({ subject: 'lawnmowing', date: '2026-05-16' });
    assert.equal(rel, 'lawnmowing/2026-05-16', `unchanged — got ${rel}`);
  } finally { box.cleanup(); }
});

test('⚠⚠ FILING agrees with the preview', async () => {
  // The preview is only worth showing if the run does the same thing — and both now read one ladder.
  try {
    const name = '2026-05-16_lawnmowing_liam_v1.mp4';
    writeFileSync(join(box.dir, name), 'FOOTAGE');
    const scan = await app.invoke('finalize:scan', { dir: box.dir });
    const items = Array.from(scan.files).map((f) => ({ ...f }));
    const s = await app.invoke('finalize:run', {
      dir: box.dir, items,
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
    });
    assert.equal(s.moved, 1, 'it filed');
    const rel = String((Array.from(s.filedRels || [])[0] || {}).rel || '');
    assert.equal(rel, '2026/2026 - Client Work/Gourgess Lawns', `filed by his history — got ${rel}`);
  } finally { box.cleanup(); }
});

test('there is exactly ONE ledger-matching implementation', () => {
  // The suggestion he sees and the folder he gets must come from one function. Two copies of this
  // scoring is how a preview starts promising a folder the run does not use.
  const ai = readFileSync(join(process.cwd(), 'main-mod', '03-ai-ollama.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const decls = (ai.match(/function matchLedgerProjects\(/g) || []).length;
  assert.equal(decls, 1, 'declared once');
  assert.match(ai, /ipcMain\.handle\('ledger:matchDates', \(_e, payload\) => matchLedgerProjects\(payload\)\)/,
    'the IPC delegates to it rather than keeping its own copy');
});

import { readFileSync } from 'node:fs';
