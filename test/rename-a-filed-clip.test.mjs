// FEATURES.md item 42 — rename a clip that is already filed.
//
// `rename:apply` existed, looked correct, and was unreachable. Wiring it AS IT STOOD would have
// shipped two bugs, and both are the shape this repo produces most often:
//
//  ⚠⚠ 1. NO PATH GUARD. It took a renderer-supplied path and renamed the file at it. Every other
//        handler that accepts a renderer path is guarded (#95); this one escaped because no live
//        call site existed to audit. It is also the most consequential of them — the others read a
//        file, this one MOVES it.
//
//  ⚠⚠ 2. IT LEFT THE METADATA BEHIND. `finalMeta` is keyed by lower-cased FILENAME, so renaming a
//        clip orphaned its subject, its people and its `done` flag under a key naming nothing. The
//        clip would reappear looking never-named and never-filed. Fixing a typo would have cost him
//        the record — strictly worse than living with the typo.
//
// So most of what follows tests the refusals and the metadata move, not the rename.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadMain } from './harness.mjs';

let app; let base; let intake;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'uvd-rn-'));
  intake = join(base, 'Compression', '01 - Uncompressed');
  mkdirSync(intake, { recursive: true });
  app = loadMain();
  app.get('config').intakeFolder = intake;
});
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

const clip = (name, body = 'x') => { const p = join(intake, name); writeFileSync(p, body); return p; };
const rename = async (destPath, newName) => app.plain(await app.invoke('rename:apply', { destPath, newName }));
const meta = () => app.plain(app.get('config.finalMeta')) || {};

beforeEach(() => {
  const cfg = app.get('config');
  cfg.finalMeta = {};
  app.get('storeReadFailed').finalMeta = false;
});

test('a clip is renamed on disk', async () => {
  const p = clip('GX010042.MP4');
  const r = await rename(p, '2026-06-01_lawn-mowing_v1.MP4');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.name, '2026-06-01_lawn-mowing_v1.MP4');
  assert.equal(existsSync(r.destPath), true, 'the new file is there');
  assert.equal(existsSync(p), false, 'and the old name is gone');
});

test('⚠⚠ the METADATA moves with the file', async () => {
  // The whole point of item 42. finalMeta is keyed by lower-cased filename; leaving the record
  // behind means the clip comes back looking never-named and never-filed.
  const p = clip('typo-nmae.mp4');
  app.get('config').finalMeta = { 'typo-nmae.mp4': { subject: 'lawn-mowing', people: ['dennis'], done: true } };
  const r = await rename(p, 'typo-name.mp4');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.movedMeta, true, 'and it says so');
  const fm = meta();
  assert.equal(fm['typo-nmae.mp4'], undefined, '⚠ the old key is gone');
  assert.deepEqual(fm['typo-name.mp4'], { subject: 'lawn-mowing', people: ['dennis'], done: true },
    '⚠ the subject, the people AND the filed flag all came across intact');
});

test('⚠ the record is keyed off the ACTUAL new name, not the one that was typed', async () => {
  // uniqueDest appends " (1)" when the name is taken. Keying the record off the requested name would
  // file the metadata under a filename that does not exist.
  clip('taken.mp4');
  const p = clip('source.mp4');
  app.get('config').finalMeta = { 'source.mp4': { subject: 'curling' } };
  const r = await rename(p, 'taken.mp4');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.name, 'taken (1).mp4', 'the collision was resolved');
  assert.equal(meta()['taken (1).mp4'].subject, 'curling', '⚠ and the record followed the REAL name');
  assert.equal(meta()['source.mp4'], undefined);
  assert.equal(existsSync(join(intake, 'taken.mp4')), true, '⚠ and the clip it collided with is untouched');
});

test('a clip with no metadata renames fine, and says the record did not move', async () => {
  const p = clip('plain.mp4');
  const r = await rename(p, 'renamed.mp4');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.movedMeta, false, 'honest about there being nothing to carry');
});

// --- the refusals ------------------------------------------------------------------------------

test('⚠⚠ a path outside every allowed root is REFUSED', async () => {
  // The guard that was missing. This handler renames a file at a path the renderer supplies, in a
  // `webSecurity:false` window — see audit #95.
  for (const p of ['/etc/passwd', 'C:\\Windows\\System32\\config\\SAM', join(base, '..', 'elsewhere.mp4')]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rename(p, 'owned.mp4');
    assert.equal(r.ok, false, `⚠ ${p} must be refused`);
    assert.equal(r.refused, true, 'and refused BY THE GUARD, not by a stat failure');
  }
});

test('⚠⚠ HONESTY: there are TWO path guards and the test above proves only that ONE survives', () => {
  // I broke each in turn rather than assuming. Deleting EITHER `isPathAllowed(destPath)` or
  // `isPathAllowed(target)` leaves the behavioural test above GREEN, because the other one catches
  // the same input: uniqueDest always resolves inside `path.dirname(destPath)`, so a refused source
  // can only ever produce a refused target and vice versa. No input separates them. (Deleting BOTH
  // does fail it — which is what that test actually pins.)
  //
  // They both stay. The source check refuses before uniqueDest probes the disk with fsp.access in a
  // folder the app was never given; the target check is what would still hold if the source path
  // ever became something derived rather than passed in. Defence in depth is fine — silently
  // relying on a layer no test names is not, and that is the whole reason this test exists.
  const src = readFileSync(join(process.cwd(), 'main-mod', '09-ipc-boot.js'), 'utf8');
  assert.match(src, /if \(!isPathAllowed\(destPath\)\) return refusePath\('rename:apply', destPath\);/,
    'the source-side guard is present');
  assert.match(src, /if \(!isPathAllowed\(target\)\) return refusePath\('rename:apply', target\);/,
    'and so is the destination-side one');
});

test('⚠⚠ a new name cannot climb out of the folder', async () => {
  // `..` survives the character filter — it contains no illegal characters — so the directory part
  // is stripped BEFORE that filter runs. Both separators, by hand: path.basename is
  // platform-specific and would leave a Windows-style `..\..\x.mp4` intact on Linux.
  for (const [attempt, want] of [['../../escaped.mp4', 'escaped.mp4'], ['..\\..\\escaped2.mp4', 'escaped2.mp4']]) {
    const p = clip(`here-${want}`);
    // eslint-disable-next-line no-await-in-loop
    const r = await rename(p, attempt);
    assert.equal(r.ok, true, `${attempt} renames rather than erroring`);
    assert.equal(r.destPath, join(intake, want), '⚠ INSIDE the clip’s own folder, and readably named');
    assert.equal(existsSync(join(base, want)), false, '⚠ nothing landed above it');
  }
});

test('⚠⚠ it refuses entirely when finalMeta could not be READ this launch', async () => {
  // An unreadable store leaves an empty default in memory: we could not SEE the record to move it,
  // and renaming anyway would orphan metadata we cannot even read. Same contract as the rest of the
  // app — refuse rather than half-do it.
  const p = clip('careful.mp4');
  app.get('storeReadFailed').finalMeta = true;
  const r = await rename(p, 'careful-2.mp4');
  app.get('storeReadFailed').finalMeta = false;
  assert.equal(r.ok, false, 'it refuses');
  assert.match(r.error, /could not be read/i, 'and says why');
  assert.equal(existsSync(p), true, '⚠ and the file is exactly where it was');
});

test('⚠ a name with nothing nameable in it is refused', async () => {
  // `/` and `???` sanitize to punctuation, which would rename his footage to `_.mp4` — findable by
  // nobody. Refusing with a reason beats renaming successfully to something useless.
  const p = clip('keep.mp4');
  for (const junk of ['', '   ', '/', '..', '???', '...', null]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await rename(p, junk);
    assert.equal(r.ok, false, `"${junk}" is refused`);
  }
  assert.equal(existsSync(p), true, 'and the clip is untouched');
  const r = await rename(p, '???');
  assert.match(r.error, /letters or numbers/, 'and the reason is actionable');
});

test('renaming to the name it already has is refused rather than counted as work', async () => {
  const p = clip('same.mp4');
  const r = await rename(p, 'same.mp4');
  assert.equal(r.ok, false);
  assert.match(r.error, /already its name/i);
});

test('the extension is preserved when he does not type one', async () => {
  // The scanners find clips by extension. A rename that dropped it would make the clip vanish from
  // every list in the app while sitting right there on disk.
  const p = clip('extless.MP4');
  const r = await rename(p, 'now-named');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.name, 'now-named.MP4', 'his extension is kept, case and all');
});

test('a missing file reports the error instead of throwing', async () => {
  const r = await rename(join(intake, 'not-here.mp4'), 'x.mp4');
  assert.equal(r.ok, false);
  assert.ok(r.error, 'with a message');
});

// --- the UI contract ---------------------------------------------------------------------------

const fin = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('⚠⚠ the rename is reachable — the handler finally has a caller', () => {
  assert.match(fin, /\{ label: 'Rename this clip…', action: \(\) => renameClipDialog\(f\) \}/,
    'it is on the Organize row’s right-click menu');
  const at = fin.indexOf('async function renameClipDialog');
  assert.ok(at > -1, 'the dialog exists');
  const body = fin.slice(at, fin.indexOf('\nfunction keyChoiceDialog', at));
  assert.match(body, /await window\.api\.applyRename\(f\.sourcePath, wanted \+ ext\)/,
    '⚠ and invokes rename:apply — the handler that had no caller');
});

test('⚠⚠ a FILED clip is told what renaming does NOT reach', () => {
  // Filing COPIES. So renaming the clip in Compressed leaves the copy in his Projects tree under the
  // old name — and letting him believe otherwise is how a "fixed" typo turns up again months later.
  const at = fin.indexOf('async function renameClipDialog');
  const body = fin.slice(at, fin.indexOf('\nfunction keyChoiceDialog', at));
  assert.match(body, /f\.filed\s*\n?\s*\? 'This clip is already filed/, 'the filed case gets its own wording');
  assert.match(body, /keeps its old name/, '⚠ and says the filed copy is not renamed');
});

test('⚠ the extension is shown but not editable', () => {
  const at = fin.indexOf('async function renameClipDialog');
  const body = fin.slice(at, fin.indexOf('\nfunction keyChoiceDialog', at));
  assert.match(body, /<span class="muted small rc-ext"><\/span>/, 'it is rendered outside the input');
  assert.match(body, /inp\.value = stem;/, '⚠ and the input holds only the stem');
  assert.match(body, /window\.api\.applyRename\(f\.sourcePath, wanted \+ ext\)/, 'so it is re-attached, unedited');
});

test('⚠ the row is updated from what MAIN returned, not from what was typed', () => {
  // uniqueDest may have changed it. A row showing the requested name while the disk holds
  // "name (1).mp4" means every later action on that row targets a file that is not there.
  const at = fin.indexOf('async function renameClipDialog');
  const body = fin.slice(at, fin.indexOf('\nfunction keyChoiceDialog', at));
  assert.match(body, /const renamedTo = r\.name;/, 'the real name is taken from the result');
  assert.match(body, /f\.sourcePath = r\.destPath;/, '⚠ and so is the path');
  assert.match(body, /finRenderList\(\);/, 'then the list re-renders');
});

test('⚠ whether the metadata moved is REPORTED, not assumed', () => {
  const at = fin.indexOf('async function renameClipDialog');
  const body = fin.slice(at, fin.indexOf('\nfunction keyChoiceDialog', at));
  assert.match(body, /r\.movedMeta\s*\n?\s*\?/, 'the two cases differ');
  assert.match(body, /its name, people and filing history came with it/, 'and the good case says what came across');
  assert.match(body, /Couldn’t rename — /, 'a failure says so rather than looking like success');
});

test('⚠ cancelling, or retyping the same name, does nothing at all', () => {
  const at = fin.indexOf('async function renameClipDialog');
  const body = fin.slice(at, fin.indexOf('\nfunction keyChoiceDialog', at));
  assert.match(body, /if \(typed === null\) return;/, 'Cancel returns early');
  assert.match(body, /if \(!wanted \|\| wanted === stem\) return;/, '⚠ and so does an unchanged name');
  const guardAt = body.indexOf('if (!wanted || wanted === stem) return;');
  assert.ok(guardAt < body.indexOf('window.api.applyRename'), 'both precede the call');
});
