// Tier 2 item 32 — "remove the confirm dialogs from non-destructive actions; they cost a click and
// teach nothing."
//
// **Surveyed all 16, and the premise does not hold in this app.** Every single one guards footage,
// his metadata, or a job long enough that starting it by accident matters:
//
//   delete gate ×2 · cancel a running copy · low disk space before a big import
//   file N clips into Projects · organize N clips · "these clips aren't on your map" (the guard that
//   stops a root dump) · undo last organize · restore a save point (overwrites current names) ·
//   clear ALL save points · re-analyse from scratch (overwrites AI names he may have edited) ·
//   retry failed clips · merge into an existing person · remove a tag from saved clips · re-tag
//   affected clips · start a face detection pass
//
// So this is a backlog item **rejected on measurement**, and the useful output is a guard against a
// future session "cleaning them up" in the name of that same backlog line. The audit assumed some
// were gratuitous; reading them says otherwise.
//
// The ones pinned below are the subset where removal would cost him footage or metadata rather than
// just a surprise. A confirm is not clutter when the sentence it shows is the only warning he gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f) => readFileSync(join(process.cwd(), 'src', 'mod', f), 'utf8').replace(/\/\/.*$/gm, '');
const fin = read('09-phone-finalize.js');
const boot = read('10-boot.js');
const map = read('07-organize-map.js');
const core = read('01-core.js');
const people = read('08-people.js');

test('⚠⚠ deleting from the card still asks, and says how many are VERIFIED', () => {
  // The one irreversible act. The count in the sentence is the whole point: it tells him the gate
  // checked them, and how many survived that check.
  assert.match(fin, /confirmDialog\(\s*`Delete \$\{verifiedIdx\.length\} verified file/, 'the delete confirm names the verified count');
  assert.match(fin, /'Can’t safely delete'/, 'and refusing is its own dialog, not a silent no-op');
});

test('⚠ filing into his Projects tree still asks, and says where', () => {
  // Moving footage into his archive. "N clips into <root> across M folders" is the sentence that lets
  // him catch a wrong destination BEFORE it happens rather than afterwards.
  assert.match(map, /confirmDialog\(\s*`File \$\{moves\.length\} clip/, 'the map Apply confirms');
  assert.match(boot, /confirmDialog\(\s*`Organize \$\{matched\.length\} clip/, 'and so does Run');
});

test('⚠ the "not on your map" guard is a dialog, not a silent skip', () => {
  // This one exists because filing without it dumped 310 clips loose in his Projects root. Removing
  // the dialog would restore a silent misfile.
  assert.match(boot, /confirmDialog\(\s*\n?\s*'These clips aren’t on your Organize map'/, 'still asks');
});

test('⚠ cancelling a copy and undoing an organize both still ask', () => {
  assert.match(fin, /confirmDialog\('Cancel the copy\?'/, 'cancel names what survives');
  assert.match(map, /confirmDialog\(\s*'Undo last organize\?'/, 'undo says how many move back');
});

test('⚠ actions that OVERWRITE his own work still ask', () => {
  // Not "destructive" in the delete sense, which is why the backlog line would have caught them — but
  // each one replaces something he typed or the AI produced.
  assert.match(core, /confirmDialog\('Restore this save point\?'/, 'restore overwrites current names');
  assert.match(core, /confirmDialog\(\s*'Clear all save points\?'/, 'clearing is unrecoverable');
  assert.match(fin, /confirmDialog\('All selected clips are already analyzed'/, 're-analysis overwrites AI names');
  assert.match(people, /confirmDialog\(\s*'Remove the tag from saved clips\?'/, 'un-tagging edits saved metadata');
});

test('the low-space warning still fires before a big import', () => {
  // Not a confirmation of intent — a warning that the copy may not finish. Removing it turns a
  // predictable failure into a half-finished import.
  assert.match(fin, /confirmDialog\(\s*\n?\s*`Low space on \$\{t\.label\}`/, 'still warns');
});

test('⚠ the count of confirmations has not quietly dropped', () => {
  // The real protection against a future "tidy-up": if someone removes one, this fails and they have
  // to say which, and why it was safe. 16 today, every one justified above.
  const all = [fin, boot, map, core, people, read('04-tasks-ai.js')]
    .map((s) => (s.match(/await confirmDialog\(/g) || []).length)
    .reduce((a, b) => a + b, 0);
  // 17 since 2026-07-20. The new one is the subject-canonicalisation offer ("Use 'lawn-mowing'
  // instead?"), and it earns its place by the same rule as the rest: it guards his METADATA.
  //
  // He has 112 distinct subjects across 206 named clips, 20 of them variants of each other. Filing
  // groups by subject, so every variant is a group that never reaches a size worth filing — one clip
  // filed out of 4,594. The alternative to asking was silently rewriting what he typed, which is the
  // one thing a naming tool must never do. So: a dialog, with "Keep mine" as a real option, at the
  // single point where a new subject enters his vocabulary.
  //
  // If this count changes again, say which and why — that is the whole point of pinning it.
  // 18 since 2026-07-20. The eighteenth is "Rename these subjects?" — the bulk subject tidy, and it
  // is the most destructive thing in this list: it REWRITES the subject on up to 4,594 clips at once.
  //
  // It earns its place three times over. The dialog names the number of merges AND the number of
  // clips, so the scale is visible before he commits. A save point is taken BEFORE the rewrite, so
  // Edit → Version history undoes it. And nothing is pre-ticked, so "Apply" on an untouched screen
  // does nothing at all.
  //
  // 19 since 2026-07-20. The nineteenth is "Stop using this wireless backup folder?" (FEATURES.md
  // item 10 — the handler existed and nothing could reach it). It is the odd one out on this list
  // because it destroys NOTHING: it forgets a path. It asks anyway, and the wording is the reason —
  // the folder it names is a NAS folder full of his footage, so "stop using this folder?" without
  // further words is a question a careful person answers "no" to. The dialog says "Nothing in the
  // folder is deleted or moved" precisely so the answer can be yes.
  //
  // Its sibling controls landed in the same commit and deliberately do NOT ask: turning fast
  // transfer off flips a transport flag, and forgetting an autocomplete entry offers an inline Undo.
  // A confirmation on either would be the app asking permission to do nothing.
  //
  // 20 since 2026-07-23. The twentieth is "Apply <preset name>?" — importing a preset.
  //
  // It earns its place for a reason none of the others have: the input came from OUTSIDE this app.
  // Every other confirmation guards his data against something HE just asked for; this one guards
  // his configuration against a file that may have been emailed to him. It rewrites how filing,
  // naming and the AI behave, all at once.
  //
  // And it is not a bare "are you sure": the dialog LISTS every setting that would change, states
  // that footage, folders, people and typed names are untouched, and says how many keys the file
  // tried to set that a preset is not allowed to set. Cancel is the default. The alternative was
  // applying an outside file's settings and letting him discover the difference later, which is the
  // shape this project has already been burned by (a stale filing rule silently forking his tree).
  assert.equal(all, 20, `20 confirmations, each guarding footage, metadata or a long job — found ${all}`);
});

test('⚠⚠ importing a preset asks, and the dialog says what it will NOT touch', () => {
  // The twentieth confirmation. Unlike every other one in this file, its input came from outside the
  // app — so the dialog has to do more than ask: it must show the scope, and it must say plainly
  // which of his things are safe, because "settings" and "my footage" are not obviously different
  // categories to someone about to click OK on a file a stranger sent.
  assert.match(core, /await confirmDialog\(\s*\n?\s*`Apply “\$\{r\.name\}”\?`/, 'importing a preset asks first');
  assert.match(core, /This changes \$\{r\.changes\.length\} setting/, '⚠ and states the scope');
  assert.match(core, /Your footage, folders, people and typed names are not touched/,
    '⚠⚠ and says explicitly what is NOT affected');
  const at = core.indexOf('async function loadPresetFile');
  const body = core.slice(at, core.indexOf('\n// ---', at));
  const askAt = body.indexOf('confirmDialog');
  const applyAt = body.indexOf('window.api.applyPreset');
  assert.ok(askAt > -1 && applyAt > askAt, '⚠⚠ the ask precedes the apply');
  assert.match(body, /if \(!ok\) return;/, '⚠⚠ and declining does nothing');
});
