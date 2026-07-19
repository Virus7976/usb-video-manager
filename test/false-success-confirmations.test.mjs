// Two places told the user something worked when it hadn't. Same shape, different screens.
//
// 1. "🧠 AI learned N things from your edits" (src/mod/04-tasks-ai.js). The toast sat OUTSIDE the
//    try, and the in-memory update sat INSIDE it:
//        try { await window.api.aiAddMemories(notes); …; aiCfg.memories.push(...notes); } catch { }
//        showToast(`🧠 AI learned ${notes.length} thing…`);
//    So on a rejection nothing was learned anywhere — not on disk, not even in memory — and the user
//    was congratulated for it. `.ok` on the return was never read either. This is the app's headline
//    learning feature: he sees the confirmation, stops correcting, and the AI keeps making the same
//    mistake.
//
// 2. The face-review card renders a green ✓ "tagged" even when the ENROLMENT failed
//    (src/mod/08-people.js). `cl.done = true` was unconditional and `people:save`'s `{ok:false}`
//    was never read. The clip TAGS do survive — those are applied separately and are idempotent —
//    but the enrolment is what teaches the recognizer, and only confirmed descriptors vote. So the
//    user believes this person is now known and the app never suggests them again.
//
// Both matter more since store-write failures became reportable (2026-07-19al): a refused save now
// says so at the storage level, and these two screens would still have claimed success on top of it.
//
// Renderer-only, so asserted against the source — COMMENTS STRIPPED, naming the exact expressions,
// and bound to the line rather than a character window. Both rules were paid for repeatedly this
// session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '');
const tasks = strip(readFileSync(join(process.cwd(), 'src', 'mod', '04-tasks-ai.js'), 'utf8'));
const people = strip(readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8'));

// --- 1. the AI-learned toast ------------------------------------------------------------------
const learnStart = tasks.indexOf('aiLearnEdits');
const learn = tasks.slice(learnStart, tasks.indexOf('.catch(', learnStart));

test('the learned-something toast only fires when the save actually landed', () => {
  // The property is CONDITIONALITY, not position. An earlier version of this test asserted the
  // toast came before the catch, which encoded the old broken shape and failed against the fix.
  assert.ok(learnStart > 0, 'found the learn-edits block');
  const gate = learn.indexOf('if (learned)');
  const toast = learn.indexOf('AI learned ${notes.length}');
  assert.ok(gate > 0, 'the outcome of the save is captured and checked');
  assert.ok(toast > gate, 'and the congratulation sits inside that check');
});

test('the in-memory update is not lost with the disk write', () => {
  // The push was inside the same try as the IPC, so a rejection dropped it too — nothing was
  // learned anywhere. It must survive independently of the persistence result.
  assert.match(learn, /aiCfg\.memories\.push\(\.\.\.notes\)/, 'the in-memory list is still updated');
});

test('a failed learn is surfaced instead of silently congratulated', () => {
  // BOTH failure routes, named separately. A bare /logIssue\(/ matched either one, so deleting the
  // throw-path log left this green while half the reporting was gone.
  assert.match(learn, /logIssue\('AI', `Couldn.{1,3}t save what the AI learned/, 'a thrown save is recorded');
  assert.match(learn, /logIssue\('AI', `aiAddMemories did not persist/, 'and so is an ok:false return');
});

// --- 2. the face-review card ------------------------------------------------------------------
const assignStart = people.indexOf('async function assign(cl, name)');
const assign = people.slice(assignStart, people.indexOf('\n  function ', assignStart));

test('a clip is only marked done when the enrolment actually landed', () => {
  assert.ok(assignStart > 0, 'found assign()');
  assert.doesNotMatch(assign, /^\s*cl\.done = true;\s*cl\.assignedName/m,
    'done is no longer set unconditionally alongside the name');
  assert.match(assign, /if \(enrol\)|enrolOk|if \(!enrol\)/, 'the enrolment result gates it');
});

test('an enrolment failure tells the user, inside the branch that detects it', () => {
  // Slice the `if (!enrol)` BLOCK to its closing brace — not the line (the body is multi-line) and
  // not a character window (which reaches unrelated toasts further down).
  const i = assign.indexOf('if (!enrol)');
  assert.ok(i > 0, 'the failure branch exists');
  const block = assign.slice(i, assign.indexOf('\n    }', i));
  assert.match(block, /showToast\(/, 'the user is told');
  assert.match(block, /logIssue\(/, 'and it is recorded');
});

test('the clip TAGS are still applied when only the enrolment failed', () => {
  // The tags are separate, idempotent, and useful on their own — a failed enrolment must not throw
  // away the naming work the user just did.
  assert.match(assign, /tagClips\(cl, name\)/, 'tagging still happens');
});

test('the happy path is unchanged', () => {
  assert.match(assign, /cl\.assignedName = name/, 'a successful assign still records the name');
  assert.match(assign, /noteNameUsed\(name\)/, 'and still ranks the name for the session');
});
