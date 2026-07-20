// FEATURES.md item 31 — flag a subject that describes the SHOT, not the JOB, at the moment he types
// it. The detection was DONE and RETURNED all along (core/subjects.js classifySubject, surfaced by
// subjects:canonicalize as { shotLike, why }); nothing showed it. So a shot description was accepted
// in silence, and 46% of his named clips became names filing can never group — because the subject
// IS the group, and "talking-head" is fifty different jobs.
//
// This is the LIVE surface: the moment of typing, which is where a name can still be changed before
// it multiplies. The retroactive surface (the Tidy screen's shotLike list) already existed.
//
// ⚠ It is ADVISORY and must STAY advisory — nearly half his names hit this, so a blocking dialog
// would be a wall he clicks through. The tests below pin that it explains-and-leaves rather than
// asks, and that it never fires on a programmatic write.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const tasks = readFileSync(join(process.cwd(), 'src', 'mod', '04-tasks-ai.js'), 'utf8');
const tasksNoComments = tasks.replace(/\/\/.*$/gm, '');
const rename = readFileSync(join(process.cwd(), 'src', 'mod', '03-rename.js'), 'utf8').replace(/\/\/.*$/gm, '');

const hint = tasksNoComments.slice(
  tasksNoComments.indexOf('async function updateSubjectShotHint'),
  tasksNoComments.indexOf('async function canonicalSubject'),
);

// --- the engine still classifies correctly (the fact the UI depends on) ------------------------

test('the handler returns shotLike + why for a shot description', async () => {
  const r = app.plain(await app.invoke('subjects:canonicalize', 'talking-head-young'));
  assert.equal(r.shotLike, true, 'flagged');
  assert.match(r.why, /on screen|talking|head/, 'and says which words, so the note is actionable');
});

test('⚠ a REAL subject is NOT flagged — the bound that keeps the hint credible', async () => {
  for (const s of ['lawn-mowing', 'dennis-front-yard', 'curling', 'gourgess-promo']) {
    // eslint-disable-next-line no-await-in-loop
    const r = app.plain(await app.invoke('subjects:canonicalize', s));
    assert.equal(r.shotLike, false, `⚠ "${s}" must pass silently`);
  }
});

// --- the live surface ---------------------------------------------------------------------------

test('⚠⚠ the hint exists and asks the handler, per clip', () => {
  const at = rename.indexOf('data-shot="${i}"');
  assert.ok(at > -1, 'a hint slot is rendered on every card');
  assert.ok(hint.length > 0, 'the updater exists');
  assert.match(hint, /await window\.api\.canonicalizeSubject\(val\)/, '⚠ it asks the same handler that already knew');
  assert.match(hint, /if \(!c \|\| !c\.ok \|\| !c\.shotLike\) \{ hide\(\); return; \}/,
    'and shows nothing unless the answer is shotLike');
});

test('⚠⚠ it is ADVISORY — it explains and leaves, it does not ask', () => {
  // The distinction from the canonical-variant offer, which DOES ask (there is a real choice there).
  // Here there is nothing to decide, only something to know, so a confirmDialog would be wrong.
  assert.ok(!/confirmDialog|keyChoiceDialog/.test(hint), '⚠ no dialog — it never blocks');
  assert.match(hint, /describes what’s <b>on screen<\/b>, not what the footage is <b>for<\/b>/,
    'it states the problem');
  assert.match(hint, /Filing groups clips by subject, so a shot name never forms a group/,
    'and WHY it matters for him specifically');
  assert.match(hint, /the job is what to name it after/, 'and what to do instead');
});

test('⚠ it fires only on a deliberate change, never on a programmatic write', () => {
  // rememberSubject is also called by code paths that set a subject without him typing. The hint,
  // like the canonical offer beside it, must only follow a keystroke — the same rule, for the same
  // reason: the app must not appear to talk over him.
  const at = rename.indexOf("inp.addEventListener('change'");
  const body = rename.slice(at, rename.indexOf('wireEditPlay', at));
  assert.match(body, /updateSubjectShotHint\(Number\(inp\.dataset\.subject\)\)/, 'called from the change handler');
  const combo = readFileSync(join(process.cwd(), 'src', 'mod', '02-combo.js'), 'utf8');
  assert.ok(!combo.includes('updateSubjectShotHint'),
    '⚠ NOT inside rememberSubject, which is called programmatically');
  // And it runs AFTER the canonical offer, so the hint reflects the name that actually landed.
  const offerAt = body.indexOf('offerCanonicalSubject');
  const hintAt = body.indexOf('updateSubjectShotHint');
  assert.ok(offerAt > -1 && offerAt < hintAt, '⚠ after the offer resolves, not before');
});

test('⚠⚠ a stale async result cannot paint the wrong clip', () => {
  // The windowed renderer recycles rows, and he keeps typing. After the await the field may hold a
  // different value — or the row may now be a different clip. Painting the old answer is the
  // "labelled row 3 with row 3's OLD destination" bug this codebase has had more than once.
  assert.match(hint, /const now = String\(\(\(state\.scannedFiles \|\| \[\]\)\[i\] \|\| \{\}\)\.subject \|\| ''\)\.trim\(\);/,
    'it re-reads the live value after the await');
  assert.match(hint, /if \(now !== val\) return;/, '⚠ and bails if it changed');
});

test('⚠ dismissing is remembered per (clip, spelling), not globally', () => {
  // Dismiss "talking-head" on this clip and it stays quiet — but a genuinely new shot name later
  // still speaks up once. A global "never show again" would silence the one useful nudge.
  assert.match(hint, /dismissedShotHints\.has\(`\$\{i\}:\$\{normSubj\(val\)\}`\)/, 'keyed by clip AND spelling on read');
  assert.match(hint, /dismissedShotHints\.add\(`\$\{i\}:\$\{normSubj\(val\)\}`\)/, 'and on dismiss');
});

test('an empty subject shows nothing', () => {
  assert.match(hint, /if \(!val \|\| dismissedShotHints\.has/, 'empty is hidden before any round-trip');
});

test('⚠ the AI prompt is untouched — this is all post-return', () => {
  // MEASURED INPUT. A cosmetic rename of a tool RESULT once cost 20 points of accuracy here. The
  // hint reads what the model already produced; it tells the model nothing.
  const ollama = readFileSync(join(process.cwd(), 'main-mod', '03-ai-ollama.js'), 'utf8');
  const promptStart = ollama.indexOf('You are');
  assert.ok(!/shotLike|on screen|describes the shot/i.test(ollama.slice(promptStart, promptStart + 4000)),
    '⚠ no shot-vs-job instruction leaked into the naming prompt');
});
