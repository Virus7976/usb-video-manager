// FEATURES.md item 29, wired: the AI's proposed subject is snapped onto one he already uses.
//
// The engine (core/subjects.js) was landed separately with its behaviour pinned. This is the wiring,
// and the wiring is where the "1 clip filed out of 4,594" number should actually move.
//
// ⚠ WHY THIS IS NOT A NEW SNAPPING PATH. The renderer already had `matchKnownSubject`, which matched
// only EXACTLY after slugging — it caught `snow-walking` vs `snowwalking` and never `car-driving` vs
// `car`. That is why he has 112 distinct subjects across 206 named clips. The fix upgrades what
// that path can reach rather than adding a second one beside it; a twin would drift, which is the
// failure this codebase produces most often.
//
// ⚠⚠ AND THE PROMPT IS UNTOUCHED. The AI's instructions are MEASURED INPUT — a cosmetic rename of a
// tool RESULT once cost 20 points of accuracy here, 4/4 deterministic. So nothing tells the model to
// behave differently; its answer is canonicalised AFTER it returns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const tasks = readFileSync(join(process.cwd(), 'src', 'mod', '04-tasks-ai.js'), 'utf8').replace(/\/\/.*$/gm, '');
const canon = async (s) => app.plain(await app.invoke('subjects:canonicalize', s));

const seed = (subjectCounts) => {
  const cfg = app.get('config');
  cfg.subjects = [];
  cfg.renameDrafts = {};
  let i = 0;
  for (const [name, n] of Object.entries(subjectCounts)) {
    for (let k = 0; k < n; k += 1) { cfg.renameDrafts[`c${i += 1}.mp4__1__1`] = { subject: name }; }
  }
};

test('⚠⚠ a fragment of an existing subject snaps onto it', async () => {
  // His actual fragmentation: car / car-driving / car-driving-down are one subject spelled four ways,
  // and filing groups by subject, so four names means four groups means nothing files.
  seed({ 'lawn-mowing': 12 });
  const r = await canon('lawn-mowing-dennis-yard');
  assert.equal(r.ok, true);
  assert.equal(r.canonical, 'lawn-mowing', `⚠ snapped onto the existing subject — got ${r.canonical}`);
  assert.equal(r.matched, true);
});

test('⚠⚠ a genuinely NEW shoot is NOT forced onto an old name', async () => {
  // The failure that would make this hated: the first clip of a new job filed under an old one.
  seed({ 'lawn-mowing': 12, curling: 5 });
  const r = await canon('wedding-fieldhouse');
  assert.equal(r.matched, false, '⚠ a new shoot stays new');
  assert.equal(r.canonical, 'wedding-fieldhouse');
});

test('⚠ two different shoots sharing a generic word stay apart', async () => {
  // Over-merging is worse than fragmentation: unfiled clips are recoverable, a personal vlog filed
  // into a client job is the failure this repo already had and reverted.
  seed({ vlog: 7, 'kitchen-vlog': 4 });
  const r = await canon('bedtime-vlog');
  assert.notEqual(r.canonical, 'vlog', '⚠ "vlog" must not swallow a different shoot');
});

test('the vocabulary is built from everything he has already named', async () => {
  // Not just the remembered-subjects list — his drafts hold 4,594 records and that is where the real
  // vocabulary lives.
  seed({ 'deer-butcher': 3 });
  const r = await canon('deer-butchering');
  assert.equal(r.canonical, 'deer-butcher', 'a draft-only subject still counts');
  assert.ok(r.known >= 1, 'and the count of known subjects is reported');
});

test('⚠ a shot-description is flagged rather than accepted silently', async () => {
  seed({ 'lawn-mowing': 5 });
  const r = await canon('talking-head-young');
  assert.equal(r.shotLike, true, 'it says this describes the shot');
  assert.match(r.why, /on screen/, 'and why, so he can act on it');
});

test('⚠⚠ the AI path canonicalises BEFORE applying, and only the AI’s proposal', async () => {
  // A subject Jake typed himself must never be rewritten — that is his work, and silently renaming
  // it is the same mistake as an AI that decides instead of proposes.
  const at = tasks.indexOf('const c = await canonicalSubject(res.subject);');
  assert.ok(at > -1, 'the AI result is canonicalised');
  const applyAt = tasks.indexOf('return applyAiResult(i, res, mode);', at);
  assert.ok(applyAt > at, '⚠ before it is applied, not after');
  const body = tasks.slice(at, applyAt);
  assert.match(body, /if \(c && c\.canonical && c\.matched\) res\.subject = c\.canonical;/,
    'only a real match replaces it — an unmatched proposal is left alone');
  assert.match(body, /catch \{/, 'and tidy-up can never fail a naming run');
});

test('⚠ it upgrades the EXISTING snapper rather than adding a twin', async () => {
  // A second matching path would drift from the first, which is the failure this codebase produces
  // most often. canonicalSubject consults matchKnownSubject and then goes through the shared module.
  const at = tasks.indexOf('async function canonicalSubject');
  assert.ok(at > -1, 'found it');
  const body = tasks.slice(at, tasks.indexOf('\n}', at));
  assert.match(body, /matchKnownSubject\(raw\)/, 'the existing exact matcher is still used first');
  assert.match(body, /window\.api\.canonicalizeSubject\(raw\)/, 'and the shared module does the rest');
  assert.match(body, /catch \{[^}]*\}\s*\n\s*return \{ subject: raw, canonical: known \|\| raw/,
    'with a fallback, so an older main or a missing handler degrades instead of breaking naming');
});

test('⚠⚠ the AI PROMPT is untouched', () => {
  // Measured input. A cosmetic rename of a tool RESULT cost 20 points of accuracy here, 4/4
  // deterministic. Nothing about this change tells the model to behave differently.
  const before = readFileSync(join(process.cwd(), 'main-mod', '03-ai-ollama.js'), 'utf8');
  assert.ok(!/canonical|vocabulary/i.test(before.slice(before.indexOf('You are'), before.indexOf('You are') + 4000)),
    '⚠ no vocabulary instruction leaked into the naming prompt');
});

test('an empty or missing subject is handled quietly', async () => {
  seed({ 'lawn-mowing': 3 });
  for (const junk of ['', '   ', null]) {
    const r = await canon(junk);
    assert.equal(r.canonical, '', `"${junk}" yields nothing rather than throwing`);
  }
});

// --- the other half: catching fragmentation as HE types it ---

test('⚠⚠ typing a variant OFFERS the canonical spelling — it never rewrites silently', () => {
  // Snapping the AI's proposals stops the machine inventing subjects. This stops him doing it. But it
  // must ASK: silently renaming what he typed is the one thing a naming tool cannot do and keep his
  // trust, and some shoots genuinely ARE a variant of another.
  const at = tasks.indexOf('async function offerCanonicalSubject');
  assert.ok(at > -1, 'the offer exists');
  const body = tasks.slice(at, tasks.indexOf('\nfunction normSubj', at));
  assert.match(body, /if \(!c \|\| !c\.ok \|\| !c\.matched\) return raw;/,
    '⚠ a genuinely new subject is returned untouched');
  assert.match(body, /await confirmDialog\(/, 'a variant is offered, not applied');
  assert.match(body, /'Keep mine'/, '⚠ and keeping his own word is a real choice');
  assert.match(body, /return ok \? c\.canonical : raw;/, 'declining leaves exactly what he typed');
});

test('⚠ the offer states HOW MANY clips already use the canonical name', () => {
  // "You have used this on 12 clips" is a reason; "this is similar" is not. The count is what makes
  // the choice obvious, so it is fetched deliberately rather than left out.
  const at = tasks.indexOf('async function offerCanonicalSubject');
  const body = tasks.slice(at, tasks.indexOf('\nfunction normSubj', at));
  assert.match(body, /c\.knownCounts\[c\.canonical\]/, 'the count is read');
  assert.match(body, /on \$\{used\} clip/, 'and shown');
  const tools = readFileSync(join(process.cwd(), 'main-mod', '10-ai-tools.js'), 'utf8');
  assert.match(tools, /knownCounts\[e\.name\] = e\.count;/, 'and main actually supplies it');
});

test('⚠ the prompt fires on a deliberate keystroke, not on programmatic writes', () => {
  // rememberSubject is also called by code paths that set a subject without him typing. A dialog
  // appearing from a background action would be the app talking over him.
  const rename = readFileSync(join(process.cwd(), 'src', 'mod', '03-rename.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const at = rename.indexOf("inp.addEventListener('change'");
  assert.ok(at > -1, 'it is on the change handler');
  const body = rename.slice(at, rename.indexOf('});', at));
  assert.match(body, /await offerCanonicalSubject\(inp\.value\)/, 'the offer runs on commit');
  assert.match(body, /if \(chosen !== inp\.value\)/, 'and the field only changes if he accepted');
  const combo = readFileSync(join(process.cwd(), 'src', 'mod', '02-combo.js'), 'utf8');
  assert.ok(!combo.includes('offerCanonicalSubject'),
    '⚠ NOT inside rememberSubject — that is called programmatically and would pop a dialog at him');
});
