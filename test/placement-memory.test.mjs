// "It should be able to figure this out, or it only ever asks it once and then it knows." — Jake
//
// Nothing in the app did that. You'd confirm "these mowing clips go in Garden Reno", the clips would
// be filed, and the DECISION would evaporate — so next month it asked again. That is why its
// questions felt stupid: not because asking is wrong, but because asking the SAME thing twice is.
//
// Now every confirmation becomes a permanent rule, and a remembered answer never reaches the model at
// all — it's a dictionary lookup. Instant, free, and with exactly zero variability. The model is only
// ever consulted about footage it has genuinely never seen.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let app;

before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });
beforeEach(() => {
  const cfg = app.get('config');
  cfg.placementMemory = [];
  cfg.ai = { model: 'v', textModel: 'qwen3:8b' };
  cfg.projectLedger = [];
});

/** A model that MUST NOT be called. Any fetch to /api/chat fails the test. */
function forbidModel() {
  let called = false;
  app.get('globalThis').fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/chat')) { called = true; throw new Error('THE MODEL WAS CALLED — it should have just known'); }
    if (u.endsWith('/api/show')) return { ok: true, status: 200, json: async () => ({ capabilities: ['completion', 'tools'] }) };
    if (u.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return () => called;
}

// --- ask once ------------------------------------------------------------------------------

test('confirming a placement is REMEMBERED', async () => {
  const r = await app.invoke('ai:rememberPlacement', {
    subject: 'mowing', people: [], location: 'back garden', path: '2026/Personal/Garden Reno',
  });
  assert.equal(r.ok, true);
  const mem = app.get('config').placementMemory;
  assert.equal(mem.length, 1);
  assert.equal(mem[0].subject, 'mowing');
  assert.equal(mem[0].path, '2026/Personal/Garden Reno');
});

test('…and the SAME SHOOT is RECALLED next time, with no model call at all', async () => {
  const wasCalled = forbidModel();
  await app.invoke('ai:rememberPlacement', { date: '2026-06-01', subject: 'mowing', people: [], path: '2026/Personal/Garden Reno' });

  const r = await app.invoke('ai:placeGroup', { date: '2026-06-01', subject: 'mowing', people: [], count: 12 });

  assert.equal(wasCalled(), false, 'the model was never asked — this is the whole point');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'place');
  assert.equal(r.path, '2026/Personal/Garden Reno');
  assert.equal(r.recalled, true);
});

test('a NEW shoot with a familiar subject is never silently filed into the old project', async () => {
  // THE SILENT MIS-FILE. Recall used to match on SUBJECT alone and report `confidence: 'exact'`, and
  // the grid auto-files an exact recall with no card and no question. So: he files his 2026-06-01
  // lawn-mowing shoot into Josiah's project. A month later he mows a DIFFERENT property. Subject
  // matches → "exact" → the new shoot lands in Josiah's project. He is never asked, and never told.
  //
  // "Ask once and then it knows" means never re-asking about the SAME shoot. It does not mean
  // answering a question he was never asked.
  await app.invoke('ai:rememberPlacement', { date: '2026-06-01', subject: 'mowing', people: [], path: '2026/Clients/Josiah' });

  const r = await app.invoke('ai:recallPlacement', { date: '2026-07-20', subject: 'mowing', people: [] });
  assert.equal(r.confidence, 'likely', 'a different shoot is a SUGGESTION, never an exact answer');
  assert.equal(r.path, '2026/Clients/Josiah', 'the old project is still offered — one click to accept');
  assert.equal(r.from_shoot, '2026-06-01', 'and it says WHICH shoot that came from');
});

test('a legacy record with no date can never be "exact" — the safe direction', async () => {
  // Records written before placement was shoot-aware carry no date, so we cannot know which shoot they
  // were about. Worst case he is asked once more; the alternative is silently mis-filing.
  app.get('config').placementMemory = [{ subject: 'mowing', people: [], path: '2026/Old', count: 1, ts: 1 }];
  const r = await app.invoke('ai:recallPlacement', { date: '2026-06-01', subject: 'mowing', people: [] });
  assert.equal(r.confidence, 'likely');
});

test('a DIFFERENT subject is still a real question — it does not over-generalise', async () => {
  // The dangerous failure: remembering "mowing → Garden Reno" and then confidently filing skiing
  // footage there too. A decision is about a KIND of footage, not about everything.
  await app.invoke('ai:rememberPlacement', { subject: 'mowing', people: [], path: 'Garden Reno' });
  const hit = await app.invoke('ai:recallPlacement', { subject: 'skiing', people: [] });
  assert.equal(hit.known, false, 'skiing is not mowing');
});

test('changing your mind OVERWRITES — it does not leave two rules fighting', async () => {
  await app.invoke('ai:rememberPlacement', { subject: 'mowing', people: [], path: 'Old Place' });
  await app.invoke('ai:rememberPlacement', { subject: 'mowing', people: [], path: 'Garden Reno' });

  const mem = app.get('config').placementMemory;
  assert.equal(mem.length, 1, 'one subject, one decision');
  assert.equal(mem[0].path, 'Garden Reno', 'the latest answer wins');
  assert.equal(mem[0].count, 2, 'and we know you have confirmed it twice');
});

test('the same subject with DIFFERENT people is a different decision', async () => {
  // "skiing with Sam" going to Alps 2026 shouldn't force "skiing with a client" there too.
  await app.invoke('ai:rememberPlacement', { subject: 'skiing', people: ['sam'], path: 'Personal/Alps' });
  await app.invoke('ai:rememberPlacement', { subject: 'skiing', people: ['client-bob'], path: 'Client/Bob Ski Ad' });
  assert.equal(app.get('config').placementMemory.length, 2);

  const withSam = await app.invoke('ai:recallPlacement', { subject: 'skiing', people: ['sam'] });
  assert.equal(withSam.path, 'Personal/Alps');
});

test('recall survives a near-miss in wording — "mowing" vs "mow the lawn"', async () => {
  // Same lexical-prefix matcher that fixed the alpine/alps miss. A user's subject is rarely typed the
  // same way twice, and re-asking because of a suffix is exactly the "it forgot" feeling.
  await app.invoke('ai:rememberPlacement', { subject: 'mowing', people: [], path: 'Garden Reno' });
  const hit = await app.invoke('ai:recallPlacement', { subject: 'mowing-the-lawn', people: [] });
  assert.equal(hit.known === false, false, 'a near-miss still recalls');
  assert.equal(hit.path, 'Garden Reno');
  assert.equal(hit.confidence, 'likely', '…but flagged as "likely", not "exact"');
});

test('only an EXACT recall skips the model — a "likely" one is still confirmed', async () => {
  // Auto-filing on a fuzzy match is how footage silently ends up in the wrong project. Exact = act.
  // Likely = still show the user, pre-answered.
  const src = readFileSync(join(ROOT, 'main-mod', '10-ai-tools.js'), 'utf8');
  const h = src.slice(src.indexOf("ipcMain.handle('ai:placeGroup'"));
  assert.match(h.slice(0, 1200), /known\.confidence === 'exact'/, 'only an exact recall short-circuits the model');
});

// --- the model gets the tool too --------------------------------------------------------------

test('recall_decision is a tool the model can call', async () => {
  await app.invoke('ai:rememberPlacement', { subject: 'turf', people: [], path: 'Garden Reno' });
  const tool = app.get('AI_TOOLS').recall_decision;

  const known = await tool.run({ subject: 'turf', people: [] }, {});
  assert.equal(known.known, true);
  assert.equal(known.path, 'Garden Reno');

  const unknown = await tool.run({ subject: 'wedding', people: [] }, {});
  assert.equal(unknown.known, false);
  assert.match(unknown.note, /Search for a project/);
});

test('a REMEMBERED answer satisfies place_in_project — no pointless re-search', async () => {
  // place/create require a search, so the model cannot invent a destination. But if the user ALREADY
  // told us the answer, forcing a search is exactly the busywork this design exists to remove.
  const place = app.get('AI_TOOLS').place_in_project;
  assert.deepEqual(JSON.parse(JSON.stringify(place.requiresAny)), ['search_projects', 'recall_decision']);

  const create = app.get('AI_TOOLS').create_project;
  assert.deepEqual(JSON.parse(JSON.stringify(create.requires)), ['search_projects'],
    'creating, though, ALWAYS requires a search — you cannot create what you never looked for');
});

// --- the search must not be so literal that it forces a bad question ---------------------------

test('the search matches ALPINE to ALPS and SKINNING to SKIING', async () => {
  // Caught on a live run against the real qwen3:8b: footage described as "two people SKINNING up a
  // snowy ridge, ALPINE" scored ZERO against a project called "Alps 2026" (subjects: skiing, ski
  // touring), because the matcher was exact. So the model created "Alpine Skinning Ridge". The model
  // was not being stupid — the TOOL was, and a model can only be as good as what the tool tells it.
  const m = app.get('aiTokenMatch');
  assert.equal(m('alpine', 'alps'), true);
  assert.equal(m('skinning', 'skiing'), true);
  assert.equal(m('mowing', 'mow'), true);
  assert.equal(m('garden', 'gardening'), true);

  // …without becoming so loose it matches anything.
  assert.equal(m('skiing', 'mowing'), false);
  assert.equal(m('cat', 'car'), false, 'short words are not fuzzy-matched at all');
  assert.equal(m('wedding', 'welding'), false);
});

test('search_projects finds the Alps project from that exact failing description', async () => {
  const cfg = app.get('config');
  cfg.projectLedger = [{
    id: 'a', rel: '2026/Personal/Alps 2026', name: 'Alps 2026',
    subjects: ['skiing', 'ski touring'], people: ['jake', 'sam'], locations: [], dates: [], clips: 42,
  }];
  const search = app.get('AI_TOOLS').search_projects;
  const r = await search.run({ query: 'two people skinning up a snowy ridge, wide static shot, alpine' }, { folders: [] });
  assert.equal(r.matches.length, 1, 'the project it should obviously have found is now found');
  assert.equal(r.matches[0].path, '2026/Personal/Alps 2026');
});

test('a zero-match search steers to RETRY then ASK — not to inventing a project', async () => {
  const search = app.get('AI_TOOLS').search_projects;
  const r = await search.run({ query: 'zzz nothing' }, { folders: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(r.matches)), []);
  assert.match(r.note, /Search again with different words first/);
  assert.match(r.note, /call ask_user/);
  assert.match(r.note, /Only create a project when you are sure/);
});

// --- the renderer closes the loop ---------------------------------------------------------------

test('confirming a card in the review grid TEACHES it', () => {
  const src = readFileSync(join(ROOT, 'src', 'mod', '07-organize-map.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /aiRememberPlacement\(\{ date: g\.date, subject: g\.subject, people: g\.people, location: g\.location, path: p \}\)/,
    'his confirmation is the ground truth — and it is remembered against the SHOOT, not just the subject');
  assert.match(fn, /window\.api\.aiRecallPlacement/, 'and recall is checked BEFORE the model');
  assert.match(fn, /you filed this here before/, 'a recalled card says why it is already answered');
});

test('a different shoot NEVER reaches the model — measured: it assumes, 4 runs out of 4', async () => {
  // MEASURED ON THE REAL qwen3:8b. Handed a `likely` recall from an earlier shoot, with a note
  // spelling out "this may be a new job that happens to look the same; if you cannot tell, ask_user,
  // do not assume", it called place_in_project into the OLD project — 4 runs out of 4. It never once
  // asked. The prompt asked; the model placed.
  //
  // Which is this codebase's whole lesson restated: the prompt asks, the CODE decides. So the code
  // decides. A familiar subject on a new shoot comes back as action:'suggest' — a one-click yes/no
  // card naming the shoot the project came from — and the model is never consulted at all.
  const wasCalled = forbidModel();
  await app.invoke('ai:rememberPlacement', { date: '2026-06-01', subject: 'mowing', people: [], path: '2026/Clients/Josiah' });

  const r = await app.invoke('ai:placeGroup', { date: '2026-07-20', subject: 'mowing', people: [], count: 14 });

  assert.equal(wasCalled(), false, 'the model is NOT given the chance to assume');
  assert.equal(r.action, 'suggest', 'it is his call, not the model\'s');
  assert.equal(r.path, '2026/Clients/Josiah', 'the old project is offered — one click');
  assert.match(r.why, /2026-06-01/, 'and the card says which shoot that came from');
});

test('the review grid turns action:suggest into a card, not a silent file', () => {
  const src = readFileSync(join(ROOT, 'src', 'mod', '07-organize-map.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /r\.action === 'suggest'/, 'the grid handles it explicitly');
  assert.match(fn, /g\.suggest = r\.path;\n\s+g\.why = r\.why \|\| '';/, 'as a suggestion, with its reason');
});

// --- ⚠ UNDO HAS TO ACTUALLY UNDO ------------------------------------------------------------
//
// An `exact` recall files a shoot with NO card and NO question, so the Undo button on that
// auto-filed card is the ONLY way he can ever correct a placement the app got wrong. It used to clear
// `g.chosen` — the UI — and leave the memory that CAUSED the auto-file sitting in config. Undo it,
// close the review, and the same wrong project is chosen again next time. Silently. Forever. And the
// app got MORE confident each time, because `count` goes up.
//
// It only ever looked fine because re-picking updates the record in place: the bug needs him to undo
// and NOT immediately choose again — which is exactly what "undo" means.

test('undo FORGETS the placement — not just the tick in the UI', () => {
  const cfg = app.get('config');
  app.get('rememberPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [], path: 'Client Work/Josiah' });
  assert.equal(app.get('recallPlacement')({ date: '2026-06-01', subject: 'lawn-mowing' }).confidence, 'exact');

  const r = app.get('forgetPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [] });
  assert.equal(r.removed, 1);
  assert.deepEqual(cfg.placementMemory, [], 'the record is gone from config, not just from the screen');
});

test('⚠ after an undo, the next shoot is ASKED about — not silently auto-filed again', () => {
  // THE regression. `exact` is the one confidence that skips the question entirely.
  app.get('rememberPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [], path: 'Client Work/WRONG' });
  app.get('forgetPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [] });

  const again = app.get('recallPlacement')({ date: '2026-06-01', subject: 'lawn-mowing' });
  assert.equal(again, null, 'nothing is recalled, so the grid asks him instead of filing it');
});

test('undo forgets THAT shoot only — his other decisions survive', () => {
  const cfg = app.get('config');
  app.get('rememberPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [], path: 'Client Work/Josiah' });
  app.get('rememberPlacement')({ date: '2026-07-02', subject: 'lawn-mowing', people: [], path: 'Client Work/Charles' });
  app.get('rememberPlacement')({ date: '2026-06-01', subject: 'vlog', people: [], path: 'Personal/Vlog' });

  app.get('forgetPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [] });

  assert.equal(cfg.placementMemory.length, 2);
  assert.equal(app.get('recallPlacement')({ date: '2026-07-02', subject: 'lawn-mowing' }).path, 'Client Work/Charles',
    'the other lawn-mowing SHOOT is a different decision and is untouched');
  assert.equal(app.get('recallPlacement')({ date: '2026-06-01', subject: 'vlog' }).path, 'Personal/Vlog',
    'the same day, different subject, is a different decision too');
});

test('undo then re-pick lands the RIGHT project', () => {
  const cfg = app.get('config');
  app.get('rememberPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [], path: 'Client Work/WRONG' });
  app.get('forgetPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [] });
  app.get('rememberPlacement')({ date: '2026-06-01', subject: 'lawn-mowing', people: [], path: 'Client Work/Charles' });

  assert.equal(cfg.placementMemory.length, 1, 'one decision, not two');
  assert.equal(app.get('recallPlacement')({ date: '2026-06-01', subject: 'lawn-mowing' }).path, 'Client Work/Charles');
});

test('forget matches rememberPlacement identity EXACTLY — including people', () => {
  // If the two disagree about what identifies a shoot, undo deletes the wrong record — or, worse,
  // nothing at all while reporting success.
  const cfg = app.get('config');
  app.get('rememberPlacement')({ date: '2026-06-01', subject: 'vlog', people: ['Josiah'], path: 'A' });
  app.get('rememberPlacement')({ date: '2026-06-01', subject: 'vlog', people: [], path: 'B' });
  assert.equal(cfg.placementMemory.length, 2, 'people are part of the identity — two records');

  // Order/case must not matter: remember sorts and lowercases, so forget must too.
  const r = app.get('forgetPlacement')({ date: '2026-06-01', subject: 'vlog', people: ['josiah'] });
  assert.equal(r.removed, 1);
  assert.equal(cfg.placementMemory[0].path, 'B', 'the people-less record is the one left standing');
});

test('the review grid WIRES undo to forget — and cannot race the remember', () => {
  const src = readFileSync(join(ROOT, 'src', 'mod', '07-organize-map.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /const undo = \(i\) => \{/, 'undo is a real action, not an inline g.chosen reset');
  assert.match(fn, /window\.api\.aiForgetPlacement\(\{ date: g\.date, subject: g\.subject, people: g\.people \}\)/);
  assert.match(fn, /if \(t\.classList\.contains\('fgc-undo'\)\) return undo\(i\);/, 'the button calls it');
  // Both WRITE the same record: a pick immediately followed by an undo must not land in the other
  // order and leave the memory set.
  assert.match(fn, /memWrites = memWrites\.then\(fn\)\.catch\(\(\) => \{\}\)/, 'serialized, and a rejection cannot escape');
  assert.match(readFileSync(join(ROOT, 'preload.js'), 'utf8'), /aiForgetPlacement: \(p\) => ipcRenderer\.invoke\('ai:forgetPlacement', p\)/);
});

test('undo RE-ASKS rather than dumping him on an empty text box', () => {
  // `g.options` — the one-click chips — is only ever filled from the model's own search trace, and a
  // group that was auto-filed from memory never had one. So an undo with nothing behind it meant
  // typing a project path from memory to fix the app's own mistake. Re-asking AFTER the forget is what
  // makes it honest: the model calls recall_decision first, and now correctly finds nothing.
  const src = readFileSync(join(ROOT, 'src', 'mod', '07-organize-map.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function showPlacementReview('));
  assert.match(fn, /const askModel = async \(g\) => \{/, 'the ask is reusable, not trapped in the for-loop');
  assert.match(fn, /if \(!g\.options \|\| !g\.options\.length\) learn\(\(\) => queueAsk\(g\)\);/);
  // The forget is queued on the same chain BEFORE the re-ask, so the model's recall_decision cannot
  // hand back the very record we are in the middle of deleting.
  const u = fn.slice(fn.indexOf('const undo = (i) =>'));
  const body = u.slice(0, u.indexOf('\n    };'));
  assert.ok(body.indexOf('aiForgetPlacement') < body.indexOf('queueAsk'), 'forget is chained ahead of the re-ask');
  // …and the original loop drives every group through the same function (see placement-review for the
  // single-GPU queue that both callers share).
  assert.match(fn, /await queueAsk\(g\);/, 'the initial pass uses it too — one code path, not two');
});
