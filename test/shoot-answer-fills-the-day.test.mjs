// Tier 2 item 20 — "default every clip in a day-group to the group's subject, and let him override
// the exceptions."
//
// The shoot question already asked once per day and remembered the answer forever. But remembering
// only fed the AI's naming CONTEXT — so on a day the model never reached, or with AI off entirely, he
// had just told the app what a 37-clip shoot was **and still faced 37 empty subject fields.** The
// question collected the answer and then did nothing visible with it.
//
// He shoots in batches: **20 of his 28 shoot days are a single subject.** That is the whole reason one
// question can settle a day, and the reason this is the highest-leverage line in the naming flow —
// 4594 clips × any per-clip interaction is the abandonment number.
//
// ⚠ A DEFAULT, NEVER AN OVERWRITE. Only clips whose subject is still empty get filled. A name he
// typed himself outranks anything the app infers, and silently replacing it would be the worst
// possible reward for answering the question — it would teach him that answering costs him work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '04-tasks-ai.js'), 'utf8').replace(/\/\/.*$/gm, '');

const pickFn = (() => {
  const at = src.indexOf('const pick = (i, sub) =>');
  assert.ok(at > -1, 'found the answer handler');
  const end = src.indexOf('\n    };', at);
  assert.ok(end > at, 'and its end');
  return src.slice(at, end);
})();

test('⚠ answering a shoot names that day\'s clips', () => {
  assert.match(pickFn, /for \(const c of groups\[i\]\.clips\)/, 'it walks the day\'s clips');
  assert.match(pickFn, /c\.subject = v;/, 'and sets the subject he chose');
});

test('⚠⚠ it never overwrites a subject he typed himself', () => {
  // The property that decides whether answering is safe. Without it, one answer could wipe names he
  // had already entered on that day.
  // Read per-path since 2026-07-20: on Organize the authoritative field is c.meta.subject, and
  // checking c.subject there would compare against a display mirror — i.e. it would think an
  // already-named clip was empty and overwrite it. The guard is the same; the field it reads is not.
  assert.match(pickFn, /const cur = organize \? \(\(c\.meta && c\.meta\.subject\) \|\| ''\) : \(c\.subject \|\| ''\);/,
    'the existing value is read from whichever field that screen persists');
  assert.match(pickFn, /if \(cur\.trim\(\)\) continue;/,
    'a clip that already has a subject is skipped entirely');
});

test('the answer is still remembered for future imports', () => {
  // The original behaviour must survive: the memory is what stops it asking about this shoot again,
  // and what lets a LATER import from the same day inherit the answer.
  assert.match(pickFn, /aiRememberShoot\(\{ date: groups\[i\]\.date, subject: v \}\)/, 'still recorded');
});

test('⚠ remembering happens even when no clip needed filling', () => {
  // If every clip on that day was already named, the answer must STILL be remembered — otherwise the
  // app asks about that shoot again next time, which is the one thing he said never to do.
  const rememberAt = pickFn.indexOf('aiRememberShoot');
  const guardAt = pickFn.indexOf('if (filled)');
  assert.ok(rememberAt > -1 && guardAt > rememberAt, 'the memory write is not inside the filled guard');
});

test('the clips are re-rendered so he sees it happen', () => {
  // Setting the field without repainting would look like the question did nothing.
  assert.match(pickFn, /refreshNames\(\)/, 'the list repaints');
});

test('and the names are persisted', () => {
  // These are drafts — the only place a name lives until the footage is copied. Filling them in
  // memory only would lose the whole day on the next launch.
  assert.match(pickFn, /scheduleDraftSave\(\)/, 'the draft save is scheduled');
});

test('⚠ it tells him what it just did, and that he can change it', () => {
  // A silent bulk edit of 37 clips is alarming even when it is right. The toast names the count, the
  // day and the subject, and says it is his to override.
  assert.match(pickFn, /showToast\(/, 'it says something');
  assert.match(pickFn, /change any of them if it is wrong/, 'and that the decision is still his');
});

test('a repaint failure never breaks the answer', () => {
  // The answer is already recorded by this point; a rendering problem must not lose it.
  assert.match(pickFn, /try \{ refreshNames\(\); \} catch/, 'the repaint is guarded');
  assert.match(pickFn, /try \{ scheduleDraftSave\(\); \} catch/, 'and so is the save');
});
