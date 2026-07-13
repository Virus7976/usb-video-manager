// The tool layer: deterministic scripts the model CHOOSES between.
//
// The thesis (Jake's): "the AI shouldn't have to think that much, it should just be choosing when to
// use the tools it's given." So the tools do the work — searching the tree, reading what's really in
// a project, slugging, building paths — and the model only picks. That's what removes the
// variability: a CHOICE from a list is something a 7B model is good at; holding a folder tree, a
// rules list and a JSON schema in its head simultaneously is not.
//
// Most of these tests are ADVERSARIAL. A local model will hallucinate tool names, send junk args,
// answer in prose, and loop. The tools have to survive all of it — and it has to be impossible for a
// model to talk them into writing outside the projects tree.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'aitools-')); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Drive the loop with a scripted sequence of model turns. */
function scriptModel(turns) {
  let i = 0;
  app.get('globalThis').fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/show')) return { ok: true, status: 200, json: async () => ({ capabilities: ['completion', 'tools'] }) };
    if (u.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) };
    const turn = turns[Math.min(i, turns.length - 1)];
    i += 1;
    const msg = turn.prose
      ? { content: turn.prose }
      : { content: '', tool_calls: [{ function: { name: turn.tool, arguments: turn.args || {} } }] };
    return { ok: true, status: 200, json: async () => ({ message: msg }) };
  };
  return { calls: () => i };
}

/** A projects tree on disk, with real clips in it. */
function projectsTree() {
  const root = join(dir, `proj-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, '2026', '2026 - Personal', 'Garden Reno'), { recursive: true });
  mkdirSync(join(root, '2026', '2026 - Personal', 'Alps 2026', '2026-02-11'), { recursive: true });
  mkdirSync(join(root, '2026', '2026 - Client', 'Acme Advert'), { recursive: true });
  writeFileSync(join(root, '2026', '2026 - Personal', 'Garden Reno', '2026-06-01_mowing_ride-on-mower_v1.mp4'), 'x');
  writeFileSync(join(root, '2026', '2026 - Personal', 'Garden Reno', '2026-06-01_turf_laying-turf_v1.mp4'), 'x');
  writeFileSync(join(root, '2026', '2026 - Personal', 'Alps 2026', '2026-02-11_skiing_ridge-line_v1.mp4'), 'x');
  return root;
}

beforeEach(() => {
  const cfg = app.get('config');
  cfg.ai = { model: 'vision:1b', textModel: 'qwen3:8b', memories: [], styleExamples: [] };
  cfg.projectLedger = [];
});

// --- the loop itself ------------------------------------------------------------------------

test('a terminal tool ENDS the loop and returns its result', async () => {
  scriptModel([
    { tool: 'search_projects', args: { query: 'x' } },
    { tool: 'place_in_project', args: { path: 'x/y' } },
  ]);
  const r = await app.get('runToolLoop')({
    model: 'qwen3:8b', system: 's', user: 'u',
    tools: ['search_projects', 'place_in_project'], ctx: { folders: [] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.tool, 'place_in_project');
  assert.deepEqual(plain(r.result), { action: 'place', path: 'x/y' });
});

test('a model that DECIDES WITHOUT LOOKING is refused, and told to look', async () => {
  // The single most valuable guard in the loop, and it comes from a real observed failure: given a
  // clip it could not identify, the real qwen3:8b did not ask — it invented a project called
  // "Client - Grey Object" and justified it confidently. A model will always rather act than admit
  // ignorance, and no amount of "only as a last resort" in a prompt reliably stops that. So the
  // protocol is enforced in CODE: you cannot file into, or create, a project you never looked for.
  const m = scriptModel([
    { tool: 'create_project', args: { name: 'Invented Project' } },   // straight to inventing
    { tool: 'search_projects', args: { query: 'grey object' } },      // …refused, so it looks
    { tool: 'ask_user', args: { question: 'What is this?', options: ['a', 'b'] } },
  ]);
  const r = await app.get('runToolLoop')({
    model: 'qwen3:8b', system: 's', user: 'u',
    tools: ['search_projects', 'create_project', 'ask_user'], ctx: { folders: [] },
  });
  assert.equal(m.calls(), 3);
  assert.match(r.trace[0].error, /requires search_projects/, 'the invention was refused');
  assert.equal(r.tool, 'ask_user', 'and having looked and found nothing, it ASKED instead of inventing');
});

test('a lookup tool feeds its result back and the model chooses again', async () => {
  const m = scriptModel([
    { tool: 'search_projects', args: { query: 'mowing lawn' } },
    { tool: 'place_in_project', args: { path: '2026/2026 - Personal/Garden Reno' } },
  ]);
  const r = await app.get('runToolLoop')({
    model: 'qwen3:8b', system: 's', user: 'u',
    tools: ['search_projects', 'place_in_project'],
    ctx: { root: projectsTree(), folders: ['2026/2026 - Personal/Garden Reno'] },
  });
  assert.equal(m.calls(), 2, 'two model turns: search, then decide');
  assert.equal(r.tool, 'place_in_project');
  assert.equal(r.trace.length, 2, 'the whole path is traceable');
});

test('PROSE instead of a tool call is an honest "I do not know" — not a parse error', async () => {
  // The old parseJsonLoose ALWAYS returned an object, so a total model failure was indistinguishable
  // from an empty answer. This is the whole reason the AI could fail silently.
  scriptModel([{ prose: 'I think this might belong somewhere but I am not sure.' }]);
  const r = await app.get('runToolLoop')({ model: 'qwen3:8b', system: 's', user: 'u', tools: ['place_in_project'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_tool_call');
  assert.match(r.content, /not sure/);
});

test('a HALLUCINATED tool name is corrected in-band, not fatal', async () => {
  // A 7B model will invent `file_clip` or `move_to`. Crashing the run on that would make the feature
  // feel broken; telling it what actually exists costs one turn.
  const m = scriptModel([
    { tool: 'file_the_clip_somewhere', args: {} },
    { tool: 'search_projects', args: { query: 'x' } },
    { tool: 'place_in_project', args: { path: 'a/b' } },
  ]);
  const r = await app.get('runToolLoop')({ model: 'qwen3:8b', system: 's', user: 'u', tools: ['search_projects', 'place_in_project'], ctx: { folders: [] } });
  assert.equal(m.calls(), 3);
  assert.equal(r.ok, true);
  assert.equal(r.trace[0].error, 'unknown tool');
});

test('a model offered a tool it was NOT given cannot call it', async () => {
  // The registry has create_project, but this loop only offers place_in_project. Calling it must be
  // refused — otherwise a prompt-injected filename could reach a tool the caller deliberately withheld.
  const m = scriptModel([
    { tool: 'create_project', args: { name: 'Sneaky' } },
    { tool: 'search_projects', args: { query: 'x' } },
    { tool: 'place_in_project', args: { path: 'a/b' } },
  ]);
  const r = await app.get('runToolLoop')({ model: 'qwen3:8b', system: 's', user: 'u', tools: ['search_projects', 'place_in_project'], ctx: { folders: [] } });
  assert.equal(r.trace[0].error, 'unknown tool', 'a withheld tool is not callable');
  assert.equal(r.tool, 'place_in_project');
  assert.equal(m.calls(), 3);
});

test('a model that never decides is STOPPED — it cannot spin forever', async () => {
  scriptModel([{ tool: 'search_projects', args: { query: 'x' } }]);   // searches forever
  const r = await app.get('runToolLoop')({
    model: 'qwen3:8b', system: 's', user: 'u',
    tools: ['search_projects', 'place_in_project'], ctx: { folders: [] }, maxSteps: 3,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'max_steps');
  assert.equal(r.trace.length, 3);
});

test('a tool that THROWS is reported back to the model, not crashed out', async () => {
  scriptModel([
    { tool: 'inspect_project', args: { path: 'nope' } },
    { tool: 'search_projects', args: { query: 'x' } },
    { tool: 'place_in_project', args: { path: 'a' } },
  ]);
  const r = await app.get('runToolLoop')({
    model: 'qwen3:8b', system: 's', user: 'u',
    tools: ['inspect_project', 'search_projects', 'place_in_project'], ctx: { root: '', folders: [] },
  });
  assert.equal(r.ok, true, 'the run survives');
  assert.ok(r.trace[0].result.error, 'and the model was told what went wrong');
});

// --- the tools cannot be talked into doing damage --------------------------------------------

test('PATH TRAVERSAL is refused', async () => {
  // The single most important property here. A model that emits "../../../Windows/System32" must not
  // get a destination back. The path is built by code from a validated relative path — never taken
  // as a string from the model.
  const place = app.get('AI_TOOLS').place_in_project;
  for (const bad of ['../../etc', 'a/../../b', '../secret', '/abs/path/../..']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await place.run({ path: bad }, { root: dir });
    assert.ok(r.error, `"${bad}" must be refused`);
  }
});

test('inspect_project cannot read outside the projects root', async () => {
  const inspect = app.get('AI_TOOLS').inspect_project;
  const r = await inspect.run({ path: '../../../' }, { root: projectsTree() });
  assert.ok(r.error, 'traversal refused');
});

test('create_project cannot produce a Windows-unopenable folder', async () => {
  // safeFolderName is the app's OWN folder-naming primitive — reserved device names and illegal
  // characters are handled once, by code, not hoped for in a prompt. It preserves case and spaces
  // (his tree is `2026 - Client Work / Gourgess Lawns`), so a proposed project sits in there looking
  // like his own work rather than like it came from a different program.
  const create = app.get('AI_TOOLS').create_project;
  const r = await create.run({ parent: '2026', name: 'CON' }, {});
  assert.equal(r.error, undefined);
  assert.equal(/\/con$/.test(r.path), false, 'a reserved device name never reaches the filesystem');
  assert.match(r.path, /^2026\//);

  const empty = await create.run({ parent: '', name: '!!!' }, {});
  assert.ok(empty.error, 'punctuation is not a name — rejected, not silently created as "!!!"');

  // …but a real name keeps its shape. `charles-wedding` in a tree of Title-Case folders looks foreign.
  const real = await create.run({ parent: '2026 - Client Work', name: 'Charles Wedding' }, {});
  assert.equal(real.path, '2026 - Client Work/Charles Wedding', 'his capitals and spaces survive');
});

test('set_clip_name slugs deterministically — the model supplies meaning, code supplies form', async () => {
  const setName = app.get('AI_TOOLS').set_clip_name;
  const r = await setName.run({
    subject: '  Ride-On MOWER!! ', description: 'Cutting The Lawn', shot_type: 'Handheld Follow',
    tags: ['Garden', ' SUMMER ', ''],
  }, {});
  assert.equal(r.subject, 'ride-on-mower');
  assert.equal(r.description, 'cutting-the-lawn');
  assert.equal(r.shotType, 'handheld-follow');
  assert.deepEqual(plain(r.tags), ['garden', 'summer']);

  const bad = await setName.run({ subject: '???', description: 'x' }, {});
  assert.ok(bad.error, 'an empty subject is an error the model is told about — not a clip named ""');
});

// --- the tools return REAL data ---------------------------------------------------------------

test('search_projects returns what is actually IN each project, not just its name', async () => {
  // The old prompt handed the model up to 80 bare folder-name strings and asked it to group footage
  // it could not see. This is the fix: it gets clip counts, subjects, people, dates.
  const cfg = app.get('config');
  cfg.projectLedger = [{
    id: 'p1', rel: '2026/2026 - Personal/Garden Reno', name: 'Garden Reno',
    subjects: ['mowing', 'turf'], people: [], locations: ['back garden'],
    dates: ['2026-06-01'], clips: 12, lastSeen: Date.now(),
  }];
  const search = app.get('AI_TOOLS').search_projects;
  const r = await search.run({ query: 'mowing the lawn with the ride-on mower' }, { folders: [] });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, '2026/2026 - Personal/Garden Reno');
  assert.equal(r.matches[0].clips, 12, 'it can see how much is already in there');
  assert.deepEqual(plain(r.matches[0].subjects), ['mowing', 'turf']);
});

test('search_projects also finds folders we have NEVER filed into', async () => {
  // The case the old design was completely blind to: an existing library. The ledger is empty for it,
  // and the prompt still insisted "PAST FILING MEMORY WINS".
  const search = app.get('AI_TOOLS').search_projects;
  const r = await search.run(
    { query: 'skiing in the alps' },
    { folders: ['2026/2026 - Personal/Alps 2026', '2026/2026 - Client/Acme Advert'] },
  );
  assert.ok(r.matches.some((m) => /Alps 2026/.test(m.path)), 'an un-filed folder on disk is still findable');
});

test('search_projects with no match says so — it does not invent one', async () => {
  const search = app.get('AI_TOOLS').search_projects;
  const r = await search.run({ query: 'zzzz nothing like this exists' }, { folders: ['a/b'] });
  assert.deepEqual(plain(r.matches), []);
  assert.match(r.note, /Search again with different words first/);
  assert.match(r.note, /call ask_user/);
});

test('inspect_project reads the real clips off disk', async () => {
  const root = projectsTree();
  const inspect = app.get('AI_TOOLS').inspect_project;
  const r = await inspect.run({ path: '2026/2026 - Personal/Garden Reno' }, { root });
  assert.equal(r.clips_here.length, 2);
  assert.ok(r.clips_here.some((n) => /mowing/.test(n)));

  const alps = await inspect.run({ path: '2026/2026 - Personal/Alps 2026' }, { root });
  assert.deepEqual(plain(alps.subfolders), ['2026-02-11'], 'it can see the per-day scheme and continue it');
});

test('place_in_project builds the DATED path itself — the model never writes a path', async () => {
  const place = app.get('AI_TOOLS').place_in_project;
  const r = await place.run({ path: 'A/B', by_day: true }, { date: '2026-07-12' });
  assert.equal(r.path, 'A/B/2026-07-12');
  const flat = await place.run({ path: 'A/B', by_day: false }, { date: '2026-07-12' });
  assert.equal(flat.path, 'A/B');
});

// --- the ledger backfill: the model can finally SEE an existing library ------------------------

test('backfill learns the existing tree — projects, clips, subjects and dates', async () => {
  const root = projectsTree();
  const r = await app.get('backfillLedgerFromTree')(root);
  assert.equal(r.ok, true);

  // Exactly the two folders that actually CONTAIN clips. "Acme Advert" is empty, so it is not a
  // project we can learn anything about — and it doesn't need to be in the ledger to be usable:
  // search_projects still finds it from the on-disk folder list (see the test above). The ledger is
  // for what we KNOW about a project, not a duplicate of the directory listing.
  assert.equal(r.learned, 2, `learned ${r.learned} projects that actually hold footage`);

  const led = app.get('config').projectLedger;
  const garden = led.find((p) => /Garden Reno$/.test(p.rel));
  assert.ok(garden, 'Garden Reno is in the ledger now');
  assert.equal(garden.clips, 2);
  assert.ok(garden.subjects.includes('mowing'), 'it read the subject out of the FILENAMES');
  assert.ok(garden.dates.includes('2026-06-01'));
});

test('backfill is IDEMPOTENT and never clobbers what we really know', async () => {
  const root = projectsTree();
  const cfg = app.get('config');
  // A project we have genuinely filed into: it knows about people, which no filename parse can.
  cfg.projectLedger = [{
    id: 'p1', rel: '2026/2026 - Personal/Garden Reno', name: 'Garden Reno',
    subjects: ['hedging'], people: ['jake'], locations: [], dates: [], clips: 99,
    samples: [], summary: 'the back garden rebuild', lastSeen: Date.now(),
  }];

  await app.get('backfillLedgerFromTree')(root);
  await app.get('backfillLedgerFromTree')(root);   // twice — must not duplicate

  const hits = cfg.projectLedger.filter((p) => /Garden Reno$/.test(p.rel));
  assert.equal(hits.length, 1, 'no duplicate record');
  assert.deepEqual(plain(hits[0].people), ['jake'], 'real knowledge survives');
  assert.equal(hits[0].summary, 'the back garden rebuild');
  assert.equal(hits[0].clips, 99, 'a real count is not lowered by a shallow re-scan');
  assert.ok(hits[0].subjects.includes('hedging') && hits[0].subjects.includes('mowing'), 'enriched, not replaced');
});

test('backfill on a missing root fails cleanly', async () => {
  const r = await app.get('backfillLedgerFromTree')(join(dir, 'does-not-exist'));
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/i);
});

test('backfill ignores container folders with no clips in them', async () => {
  const root = projectsTree();
  await app.get('backfillLedgerFromTree')(root);
  const led = app.get('config').projectLedger;
  assert.equal(led.some((p) => p.rel === '2026'), false, '"2026" is a container, not a project');
});

// --- the handlers refuse to run on a model that cannot do the job -----------------------------

test('placement REFUSES to run on a vision model instead of producing mush', async () => {
  // This is the failure that made the AI feel gimmicky: a text task silently running on a vision
  // model that cannot call tools. Say so, don't limp.
  const cfg = app.get('config');
  cfg.ai = { model: 'llava:7b', textModel: '' };
  app.get('globalThis').fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'llava:7b' }] }) };
    return { ok: true, status: 200, json: async () => ({ capabilities: ['completion', 'vision'] }) };
  };
  const r = await app.invoke('ai:placeGroup', { subject: 'mowing' });
  assert.equal(r.ok, false);
  assert.match(r.error, /tool-capable|vision model cannot/i);
});

test('create_project may invent a PROJECT, never a CATEGORY', async () => {
  // A new project is a reasonable thing to invent. A new category is not. His are `2026 - Client Work`,
  // `2026 - Personal`, `2026 - Social Media` — and a model that answers `Client Work` (dropping the
  // year, which is exactly the kind of near-miss an 8B model makes) would have us create a SECOND
  // category folder beside the real one and split his project tree in half. Creating a project is
  // allowed; creating the shelf it sits on is not.
  const create = app.get('AI_TOOLS').create_project;
  const ctx = { folders: ['2026 - Client Work', '2026 - Client Work/Gourgess Lawns', '2026 - Personal'] };

  const bad = await create.run({ parent: 'Client Work', name: 'Charles Wedding' }, ctx);
  assert.ok(bad.error, 'a category he does not have is refused');
  assert.match(bad.error, /not a folder he has/);
  assert.match(bad.error, /2026 - Client Work/, 'and it is told what he DOES have');

  const good = await create.run({ parent: '2026 - client work', name: 'Charles Wedding' }, ctx);
  assert.equal(good.error, undefined);
  assert.equal(good.path, '2026 - Client Work/Charles Wedding',
    'the right category, in HIS spelling — not the one the model happened to type');
});
