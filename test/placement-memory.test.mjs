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

test('…and next time it is RECALLED, with no model call at all', async () => {
  const wasCalled = forbidModel();
  await app.invoke('ai:rememberPlacement', { subject: 'mowing', people: [], path: '2026/Personal/Garden Reno' });

  const r = await app.invoke('ai:placeGroup', { subject: 'mowing', people: [], count: 12 });

  assert.equal(wasCalled(), false, 'the model was never asked — this is the whole point');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'place');
  assert.equal(r.path, '2026/Personal/Garden Reno');
  assert.equal(r.recalled, true);
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
  assert.match(fn, /window\.api\.aiRememberPlacement\(\{ subject: g\.subject, people: g\.people, location: g\.location, path: p \}\)/,
    'the user\'s confirmation is the ground truth, and it is what gets remembered');
  assert.match(fn, /window\.api\.aiRecallPlacement/, 'and recall is checked BEFORE the model');
  assert.match(fn, /you filed this here before/, 'a recalled card says why it is already answered');
});
