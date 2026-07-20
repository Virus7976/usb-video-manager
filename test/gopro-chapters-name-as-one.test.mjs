// Tier 2 item 28 — "collapse identical consecutive GoPro clips (chaptered recordings) into one row
// that names as one."
//
// A GoPro splits a long take at ~4 GB and names the pieces `GX{chapter}{fileid}`. So `GX016817`,
// `GX026817` … `GX066817` are **six pieces of one continuous shot**, and naming them was six
// identical typing jobs.
//
// Measured on his real card before building any of it — because "does he actually have chaptered
// takes?" is a question, not an assumption:
//
//     recording 6817 → 6 chapters
//     6813, 6820     → 3 each
//     6803, 6816, 6823, 6824 → 2 each
//     ≈13 of his 37 raw clips are chapters of a take he has already named
//
// **Filling rather than collapsing.** Merging rows in the list would hide clips, and a clip he cannot
// see is a clip he cannot check — the app's whole problem is him not trusting what it did. Naming one
// chapter now names its siblings, which gets the benefit with nothing hidden.
//
// The scope is *less* arguable than the shoot-day fill (2026-07-20af): a shoot-day shares a subject
// 88% of the time, but chapters of one recording ARE the same shot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '03-rename.js'), 'utf8').replace(/\/\/.*$/gm, '');

const fnBody = (name) => {
  const i = src.indexOf(`function ${name}`);
  assert.ok(i > -1, `found ${name}`);
  const end = src.indexOf('\n}', i);
  assert.ok(end > i, `and the end of ${name}`);
  return src.slice(i, end);
};

test('⚠ siblings are matched on camera prefix AND file id, with a different chapter', () => {
  // All three conditions matter. Without the file id, every GoPro clip is a "sibling" of every other
  // and one name would flood the card. Without the chapter difference, a clip is its own sibling.
  const fn = fnBody('chapterSiblings');
  // BOTH regexes must be anchored — there is one for the clip and one for each candidate. Asserting
  // "an anchored pattern appears" passed while the first was unanchored, because the second still
  // matched. Count them.
  const anchored = (fn.match(/\^\(G\[XHP\]\)\(\\d\{2\}\)\(\\d\{4\}\)\$/g) || []).length;
  assert.equal(anchored, 2, `both the clip and the candidate are matched anchored — found ${anchored}`);
  assert.match(fn, /n\[3\] === fileId/, 'same recording');
  assert.match(fn, /n\[2\] !== chapter/, 'different chapter');
  assert.match(fn, /n\[1\]\.toUpperCase\(\) === prefix\.toUpperCase\(\)/, 'same camera prefix');
});

test('⚠ a clip is never its own sibling', () => {
  const fn = fnBody('chapterSiblings');
  assert.match(fn, /c === clip/, 'itself is excluded');
});

test('a non-GoPro name matches nothing', () => {
  // His renamed clips (`2026-03-14_vlog_kitchen_v1`) and phone files must not be parsed as chapters.
  // The anchored regex is what guarantees it; this pins the early return.
  const fn = fnBody('chapterSiblings');
  assert.match(fn, /if \(!m\) return \[\];/, 'no match → no siblings');
});

test('⚠⚠ it fills only what is EMPTY — never overwrites a chapter he named differently', () => {
  const fn = fnBody('fillChapterSiblings');
  assert.match(fn, /!\(c\.subject \|\| ''\)\.trim\(\)/, 'subject only when empty');
  assert.match(fn, /!\(c\.description \|\| ''\)\.trim\(\)/, 'description only when empty');
});

test('and it only copies fields he has actually filled in', () => {
  // Copying an empty subject over a sibling would erase nothing but would also count as "touched",
  // producing a toast for work that did not happen.
  const fn = fnBody('fillChapterSiblings');
  assert.match(fn, /\(clip\.subject \|\| ''\)\.trim\(\) &&/, 'source subject must be non-empty');
  assert.match(fn, /\(clip\.description \|\| ''\)\.trim\(\) &&/, 'source description must be non-empty');
});

test('the names are persisted and the list repaints', () => {
  const fn = fnBody('fillChapterSiblings');
  assert.match(fn, /scheduleDraftSave\(\)/, 'drafts are the only place a name lives before the copy');
  assert.match(fn, /refreshNames\(\)/, 'and he sees it happen');
});

test('⚠ it tells him a take was split by the camera', () => {
  // Fields filling themselves is alarming unless the reason is stated — and "the camera split one
  // take" is information he may not have known.
  const fn = fnBody('fillChapterSiblings');
  assert.match(fn, /the camera split one take/, 'the reason is given');
});

test('it runs on commit, for both subject and description', () => {
  // `change`, not `input`: filling siblings on every keystroke would fight him as he types.
  assert.match(src, /recordAiEdit\(c0, 'subject', inp\.value\); rememberSubject\(inp\.value\); fillChapterSiblings\(c0\);/, 'subject');
  assert.match(src, /recordAiEdit\(c0, 'description', inp\.value\); rememberDescription\(inp\.value\); fillChapterSiblings\(c0\);/, 'description');
  // Count the call sites instead of trying to match across a multi-line handler: `[^)]*` stops at the
  // first `)`, so the negative match could never fire and adding a keystroke call left it green.
  // Exactly two calls exist, and the two assertions above pin both to `change`.
  const calls = (src.match(/fillChapterSiblings\(/g) || []).length;
  assert.equal(calls, 3, `two commit call sites plus the definition — found ${calls}`);
});

test('a repaint or save failure never loses what he typed', () => {
  const fn = fnBody('fillChapterSiblings');
  assert.match(fn, /try \{ refreshNames\(\); \} catch/, 'guarded');
  assert.match(fn, /try \{ scheduleDraftSave\(\); \} catch/, 'guarded');
});
