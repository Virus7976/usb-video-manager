// Naming, measured against Jake's REAL archive.
//
// His 310 compressed clips are named DATE_SUBJECT_DESCRIPTION_vN, and the subjects he actually uses
// are: vlog (129), lawn-mowing (68), pov (26), calisthenics (17), lawnmowing (15), timelapse (13).
//
// Note lawn-mowing AND lawnmowing. His archive is ALREADY fragmented by a near-duplicate subject —
// this exact bug has already happened to him, permanently, and nothing in the app prevented it.
//
// Two things were learned by running the real models on his real footage:
//
//  1. His subjects are KINDS OF SHOOT, not objects. A vision model describes objects, so the namer
//     invented `car-door`, `computertime`, `skateboarding`, `table-setup` as subjects. Asking nicely
//     in a prompt did nothing. A schema-level ENUM makes it impossible.
//  2. His descriptions are 1-7 words. Handed a rich observation, the model wrote 20+. Capping that in
//     a prompt is unreliable; capping it in code is not.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let app;
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

// Jake's real subjects, mined from his real archive.
const REAL_SUBJECTS = ['vlog', 'lawn-mowing', 'pov', 'calisthenics', 'timelapse'];

before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });
beforeEach(() => {
  const cfg = app.get('config');
  cfg.ai = { model: 'qwen2.5vl:7b', textModel: 'qwen3:8b', memories: [], styleExamples: [] };
});

// --- the subject cannot be invented ------------------------------------------------------------

test('the user\'s real subjects become a hard ENUM in the tool schema', () => {
  // This is the difference between "please reuse an existing subject" — advice a 7B model ignores —
  // and "there is no other option", which is a fact the runtime enforces.
  const schemas = app.get('toolSchemas')(['set_clip_name'], { set_clip_name: { subject: REAL_SUBJECTS } });
  const subj = schemas[0].function.parameters.properties.subject;
  assert.deepEqual(plain(subj.enum), REAL_SUBJECTS, 'the model can only choose from what he actually uses');
});

test('the enum does not leak into the shared tool definition', () => {
  // A mutated global schema would silently pin the NEXT user to this user's subjects.
  app.get('toolSchemas')(['set_clip_name'], { set_clip_name: { subject: REAL_SUBJECTS } });
  const clean = app.get('toolSchemas')(['set_clip_name']);
  assert.equal(clean[0].function.parameters.properties.subject.enum, undefined, 'the base schema is untouched');
  assert.equal(app.get('AI_TOOLS').set_clip_name.parameters.properties.subject.enum, undefined);
});

test('with no known subjects, nothing is constrained — a first run still works', () => {
  const schemas = app.get('toolSchemas')(['set_clip_name'], {});
  assert.equal(schemas[0].function.parameters.properties.subject.enum, undefined);
});

// --- the near-duplicate that already broke his archive -------------------------------------------

test('"lawnmowing" is REFUSED when "lawn-mowing" already exists', async () => {
  // The bug that has already happened to him: 68 clips under lawn-mowing, 15 under lawnmowing. Two
  // folders, one subject, permanently split. The enum stops set_clip_name inventing it; this stops
  // the model routing AROUND the enum via propose_new_subject.
  const propose = app.get('AI_TOOLS').propose_new_subject;
  const r = await propose.run(
    { subject: 'lawnmowing', why: 'the footage shows mowing', description: 'mowing the front lawn' },
    { subjects: REAL_SUBJECTS },
  );
  assert.ok(r.error, 'refused');
  assert.match(r.error, /same subject as the existing "lawn-mowing"/);
  assert.match(r.error, /permanently splits the archive/);
});

test('…and so is any other rewording of an existing subject', async () => {
  const propose = app.get('AI_TOOLS').propose_new_subject;
  for (const dupe of ['vlogs', 'vlogging', 'lawn-mow', 'povs', 'calisthenic']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await propose.run({ subject: dupe, why: 'x', description: 'y' }, { subjects: REAL_SUBJECTS });
    assert.ok(r.error, `"${dupe}" must be refused as a duplicate`);
  }
});

test('a GENUINELY new kind of shoot is allowed through', async () => {
  // The guard must not be so tight that a real new subject is impossible — that would just push the
  // user back to naming everything by hand.
  const propose = app.get('AI_TOOLS').propose_new_subject;
  const r = await propose.run(
    { subject: 'wedding', why: 'none of vlog/pov/lawn-mowing/calisthenics describe a wedding shoot', description: 'bride walking down the aisle' },
    { subjects: REAL_SUBJECTS },
  );
  assert.equal(r.error, undefined);
  assert.equal(r.subject, 'wedding');
  assert.equal(r.newSubject, true, 'and it is flagged, so the user can see a new subject was created');
});

// --- the description has to be a usable FILENAME -------------------------------------------------

test('a 20-word description is cut down to a filename', async () => {
  // What the real model actually produced from a real observation, verbatim.
  const setName = app.get('AI_TOOLS').set_clip_name;
  const r = await setName.run({
    subject: 'vlog',
    description: 'a young boy moving through his cluttered bedroom standing near the bed sitting on the floor and standing again',
  }, {});
  const words = r.description.split('-');
  assert.ok(words.length <= 8, `${words.length} words — his own are 1-7`);
  // The leading article is gone. This used to assert `a-young-boy-moving-…`, which is the very filler
  // the naming rules forbid — the cap was pinning a filename that STARTED with "a-".
  assert.equal(r.description, 'young-boy-moving-through-his-cluttered-bedroom-standing');
  assert.ok(!/^(a|an|the)-/.test(r.description), 'a filename never starts with an article');
});

test('a short description is left exactly alone', async () => {
  // His real ones must survive untouched.
  const setName = app.get('AI_TOOLS').set_clip_name;
  for (const d of ['josiah', 'josiah-cleanroom-timelapse', 'still-static-grid-dark-rooms']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await setName.run({ subject: 'vlog', description: d }, {});
    assert.equal(r.description, d, `"${d}" is already a good name`);
  }
});

test('the 7-word real description survives the cap', async () => {
  const setName = app.get('AI_TOOLS').set_clip_name;
  const r = await setName.run({ subject: 'pov', description: 'headcam getting into truck and checking trailer' }, {});
  assert.equal(r.description, 'headcam-getting-into-truck-and-checking-trailer', 'his actual name is not truncated');
});

// --- learning feeds in as a TOOL RESULT, not a wall of prompt text --------------------------------

test('get_naming_style hands over his real style and subjects', async () => {
  const cfg = app.get('config');
  cfg.ai.styleExamples = ['vlog / josiah-cleanroom-timelapse', 'pov / wood-cleanup-fairview'];
  cfg.ai.memories = [{ text: 'keep descriptions short' }];

  const style = app.get('AI_TOOLS').get_naming_style;
  const r = await style.run({}, { subjects: REAL_SUBJECTS, clipText: 'a boy in a bedroom' });

  assert.deepEqual(plain(r.known_subjects), REAL_SUBJECTS);
  assert.equal(r.examples.length, 2, 'real few-shot pairs — the thing that actually moves a 7B model');
  assert.deepEqual(plain(r.preferences), ['keep descriptions short']);
});

test('the naming loop refuses to run on a model that cannot call tools', async () => {
  const cfg = app.get('config');
  cfg.ai = { model: 'llava-llama3:latest', textModel: '' };
  app.get('globalThis').fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'llava-llama3:latest' }] }) };
    return { ok: true, status: 200, json: async () => ({ capabilities: ['completion', 'vision'] }) };
  };
  const r = await app.invoke('ai:nameFromObservation', { observation: 'a boy in a bedroom' });
  assert.equal(r.ok, false);
  assert.match(r.error, /tool-capable/i);
});

// --- ⚠ THE DESCRIPTION WAS A TRUNCATED SENTENCE. MEASURED ON THE REAL qwen3:8b. ----------------
//
// `set_clip_name`'s description field said only "What is HAPPENING — concrete and specific. This is
// where the detail goes." Handed a rich observation, the real model answered with an English SENTENCE
// and the 8-word cap truncated it:
//
//     two-men-sit-on-a-cut-lawn-beside        ← severed at a preposition. An unusable filename.
//
// The rules it needed were not new — the LEGACY giant prompt already had them ("2-6 keywords… no
// articles/filler… no sentences") and the tool path had DROPPED them. On this one field the redesign
// was worse than the thing it replaced. With them restored, on his real observation, 3 runs of 3:
//
//     men-working-on-mower                    ← baseline
//     men-repairing-mower                     ← with his correction in the few-shot (it picked up
//                                               "repairing" from the pair HE typed)

test('the cap never severs a description at a preposition', () => {
  const cap = app.get('aiCapWords');
  // The exact string the real model produced, at the exact cap the tool uses.
  assert.equal(cap('Two men sit on a cut lawn beside a ride-on mower', 8), 'two-men-sit-on-a-cut-lawn');
  assert.equal(cap('a man mowing the front lawn', 8), 'man-mowing-the-front-lawn', 'leading article dropped');
});

test('⚠ interior filler is KEPT — his own style depends on it', () => {
  // A blanket stopword strip would rewrite his names rather than enforce them: this is a real filename
  // he wrote himself, and it needs its `into` and its `and`. Only the EDGES are stripped.
  const cap = app.get('aiCapWords');
  assert.equal(cap('headcam-getting-into-truck-and-checking-trailer', 8),
    'headcam-getting-into-truck-and-checking-trailer');
});

test('the description schema demands keywords, not a sentence', () => {
  // The strings are load-bearing and MEASURED — see the header above. If you change them, re-measure
  // against his footage.
  const src = readFileSync(join(ROOT, 'main-mod', '10-ai-tools.js'), 'utf8');
  const tool = src.slice(src.indexOf("defineTool('set_clip_name'"));
  const body = tool.slice(0, tool.indexOf('\n});'));
  assert.match(body, /2-6 keywords for WHAT IS HAPPENING/);
  assert.match(body, /NEVER a sentence/);
  assert.match(body, /no articles or filler/);
  assert.match(body, /pushups-on-grass/, 'real examples in his own style');
});

// --- ⚠ FACE RECOGNITION BELONGS IN THE NAME ---------------------------------------------------
//
// Owner, on reading the output: "I don't like those descriptions. It should also be using the face
// recognition."
//
// He was right, and the gap was not in the face code — that already ran, already recognised Josiah,
// and already handed the name to this loop. The model still wrote `men-working-on-mower`. Of course it
// did: the VISION model cannot know that man is Josiah, so nothing in the observation says so, and
// nothing told the reasoning model that the name it was handed outranks what the camera saw. His own
// archive is `josiah-front-lawn`, `liam-mowing-front-lawn`, `josiah` — THE PERSON'S NAME IS THE
// DESCRIPTION.
//
// Measured on the real qwen3:8b, same clip, 4 runs of 4:
//     men-working-on-mower       →       josiah-repairing-mower

test('get_naming_style tells the model WHO face recognition found', async () => {
  const style = app.get('AI_TOOLS').get_naming_style;
  const r = plain(await style.run({}, { subjects: REAL_SUBJECTS, people: ['Josiah'], clipText: '' }));
  assert.deepEqual(r.people_recognised_in_this_clip, ['Josiah']);
  assert.match(r.people_note, /Use their NAMES in the description/);
  assert.match(r.people_note, /Never "men", "a boy" or "someone"/);
});

test('…and says NOTHING when nobody was recognised', async () => {
  // An empty list is not neutral — it invites "no people visible" into the description. The keys are
  // simply absent when face recognition found nobody.
  const style = app.get('AI_TOOLS').get_naming_style;
  const r = plain(await style.run({}, { subjects: REAL_SUBJECTS, people: [], clipText: '' }));
  assert.equal('people_recognised_in_this_clip' in r, false);
  assert.equal('people_note' in r, false);
});

test('the recognised people are actually PASSED to the loop', async () => {
  // The names reached the handler and stopped there — the tool context never carried them, so the one
  // tool the model always calls could not mention them.
  const src = readFileSync(join(ROOT, 'main-mod', '10-ai-tools.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('ai:nameFromObservation'");
  const h = src.slice(start, src.indexOf('\n});', start));
  assert.match(h, /people: \(p\.people \|\| \[\]\)\.filter\(Boolean\)/, 'ctx carries them');
  assert.match(h, /NAME them in the description/, 'and the system prompt says to use them');
});

test('the description schema forbids "men" when it knows the name — and forbids restating the subject', () => {
  // ⚠ These strings are MEASURED. `josiah-lawn-mowing` (the subject, restated) was the last flaw; the
  // filename already carries the subject. Re-measure against his footage if you touch them.
  const src = readFileSync(join(ROOT, 'main-mod', '10-ai-tools.js'), 'utf8');
  const tool = src.slice(src.indexOf("defineTool('set_clip_name'"));
  const body = tool.slice(0, tool.indexOf('\n});'));
  assert.match(body, /LEAD with their name/);
  assert.match(body, /never "men", "a boy" or "someone" when you know who it is/);
  assert.match(body, /do not just restate it/);
});
