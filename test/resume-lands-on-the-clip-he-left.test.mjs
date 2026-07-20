// Tier 1 item 17 — "returning to a half-done card lands on the exact clip he stopped at."
//
// The session already reopened the right SCREEN. It did not remember where in it he was, so a
// relaunch mid-card dropped him at the top of the list and he had to find his place again. On 4594
// clips, with a workflow whose defining property is that he always walks away mid-batch, that search
// is paid on every single return — and it is the kind of friction that turns "I'll finish this later"
// into 4263 unnamed clips.
//
// Two decisions worth stating, because both have a wrong version that looks fine:
//
// **Stored by clipKeyV2, never by index.** A re-scan can list clips in a different order (a new file
// on the card, a changed filter). An index would then point at somebody else's clip and cheerfully
// scroll him to the wrong place — worse than the top of the list, because it looks deliberate.
//
// **Best-effort restore.** The clip may be gone by the time he returns: copied and cleared, filtered
// out, or a different card entirely. Landing at the top is exactly today's behaviour, so a miss must
// be a no-op and never an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '');
const core = strip(readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8'));
const rename = strip(readFileSync(join(process.cwd(), 'src', 'mod', '03-rename.js'), 'utf8'));

const fnBody = (src, name) => {
  const i = src.indexOf(`function ${name}`);
  assert.ok(i > -1, `found ${name}`);
  return src.slice(i, src.indexOf('\n}', i));
};

test('⚠ the session remembers WHICH CLIP, not just the screen', () => {
  assert.match(core, /let sessionState = \{[^}]*lastClipKey: ''/, 'lastClipKey is part of the session');
});

test('⚠ it is keyed by clipKeyV2, not by index', () => {
  // An index survives a re-scan and points at the wrong clip. That is worse than no memory at all,
  // because scrolling to the wrong place looks intentional.
  const fn = fnBody(core, 'noteClipPosition');
  assert.match(fn, /clipKeyV2\(clip\)/, 'the key is the stable fingerprint');
  assert.doesNotMatch(fn, /indexOf|\bidx\b/, 'no index is stored');
});

test('it only writes when the position actually changed', () => {
  // This fires on every field focus. Writing unconditionally would queue a session save per row he
  // tabs through.
  const fn = fnBody(core, 'noteClipPosition');
  assert.match(fn, /k !== sessionState\.lastClipKey/, 'unchanged position → no write');
});

test('⚠ the restore renders ahead before scrolling — the list is windowed', () => {
  // Only the first chunk exists in the DOM. Without renameEnsureRendered, querySelector finds nothing
  // for any clip past the first screenful and the restore silently does nothing — which is exactly
  // the bug it is meant to fix, hidden behind a function that appears to work.
  const fn = fnBody(core, 'restoreClipPosition');
  assert.match(fn, /renameEnsureRendered\(idx\)/, 'it renders ahead to the target');
  const renderAt = fn.indexOf('renameEnsureRendered');
  const queryAt = fn.indexOf('querySelector');
  assert.ok(renderAt > -1 && queryAt > renderAt, 'and does so BEFORE looking for the card');
});

test('⚠ a clip that is no longer there is a no-op, not an error', () => {
  const fn = fnBody(core, 'restoreClipPosition');
  assert.match(fn, /if \(!key\) return;/, 'no remembered position → nothing to do');
  assert.match(fn, /if \(idx < 0\) return;/, 'the clip is gone → land at the top, as before');
  assert.match(fn, /catch \{/, 'and a failed scroll never breaks the resume');
});

test('the flow resume actually calls it', () => {
  // The whole feature is one call site; without it everything above is dead code.
  const fn = fnBody(core, 'maybeResumeSession');
  assert.match(fn, /restoreClipPosition\(s\.lastClipKey\)/, 'the card flow restores the position');
  const startAt = fn.indexOf('await startFlow()');
  const restoreAt = fn.indexOf('restoreClipPosition');
  assert.ok(startAt > -1 && restoreAt > startAt, 'after the scan, so the clips exist to find');
});

test('position is recorded when he focuses a field', () => {
  const fn = fnBody(rename, 'wireRowEditing');
  assert.match(fn, /addEventListener\('focus'/, 'focus is the signal');
  assert.match(fn, /noteClipPosition\(c\)/, 'and it records that clip');
});

test('recording never throws into an edit', () => {
  // This runs on focus of a text field he is typing in. An exception here would be felt as the app
  // breaking mid-keystroke.
  const fn = fnBody(core, 'noteClipPosition');
  assert.match(fn, /try \{[\s\S]*catch \{/, 'wrapped');
});
