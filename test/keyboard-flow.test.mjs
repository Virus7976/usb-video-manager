// The keyboard sweep the app advertises ("rip through the list without the mouse") was broken in
// three places, and the batch dialog's field chain was outright dead code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (f) => readFileSync(join(ROOT, 'src', 'mod', f), 'utf8');

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'kb-')); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- Enter in the batch dialog ------------------------------------------------------------

test('Enter that ADVANCES a field is consumed — it no longer applies the batch', () => {
  // attachCombo's keydown is on the <input>; the batch dialog's is on the overlay (an ancestor, bubble
  // phase). Every Enter path here ends in advance() → closePopover(), so the overlay's guard
  // (`if (openPopover && ...) return`) was always checking a null openPopover and could NEVER fire.
  // Enter in the subject field therefore advanced to the description AND applied the batch, closing
  // the dialog with description/location/context empty. The whole subject→desc→location→context chain
  // wired into buildBatchDialog was dead code.
  const combo = mod('02-combo.js');
  const h = combo.slice(combo.indexOf("if (e.key === 'Enter') {"));
  const body = h.slice(0, h.indexOf("} else if ((e.key === 'ArrowRight'"));

  assert.match(body, /if \(next\) \{ next\.focus\(\); return true; \}/, 'advance() reports whether it moved on');
  assert.match(body, /input\.blur\(\);\s*return false;/, 'and reports when there is nowhere to go');
  assert.match(body, /if \(advance\(\)\) e\.stopPropagation\(\);/, 'an Enter that advanced is CONSUMED');

  // …but Enter on the LAST field still bubbles, so it submits the dialog. That's the sensible
  // terminal behaviour, and it's why the guard is `if (advance())` and not an unconditional stop.
  assert.equal(/advance\(\);\s*e\.stopPropagation\(\);/.test(body), false, 'it is not stopped unconditionally');
});

// --- Enter to the next clip ----------------------------------------------------------------

test('the next clip is the next one IN THE DOM, not the next array index', () => {
  // buildRenameStep renders GROUPED BY DAY, newest day first (dayDividers defaults on). With clips
  // 0-9 on the older day and 10-19 on the newer, the grid shows 10-19 first. Walking `data-i + 1`
  // meant Enter on the visually-last card of that group (index 19) looked for index 20, found nothing
  // and blurred — the sweep dead-ended mid-list. Enter on index 9 (the visually LAST card) jumped to
  // index 10 and scrolled back to the TOP.
  const combo = mod('02-combo.js');
  const fn = combo.slice(combo.indexOf('function nextClipField('));
  // The function has nested blocks, so slice to the NEXT top-level declaration rather than `\n}\n`.
  const body = fn.slice(0, fn.indexOf('\n// Meta (Category/Project)'));
  assert.ok(body.length > 200, 'the function body was extracted');
  // Strip comments — the comment here deliberately QUOTES the old selector to explain the bug, and
  // that is not the code doing it.
  const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  assert.equal(/data-i="\$\{i \+ 1\}"/.test(code), false, 'it no longer walks the array index');
  assert.match(body, /for \(let el = card\.nextElementSibling; el; el = el\.nextElementSibling\)/, 'it walks the DOM');
  assert.match(body, /if \(!el\.classList \|\| !el\.classList\.contains\('rename-card'\)\) continue;/, 'skipping day dividers');
  assert.match(body, /if \(!visible\(el\)\) continue;/, 'and skipping clips hidden by the filter — .focus() on them is a no-op');
  assert.match(body, /renameEnsureRendered\(i \+ 1\)/, 'and it renders the next chunk of the 100-card window first');
});

test('clicking a pop-out grid tile renders the chunk before jumping', () => {
  // The grid wall pushes EVERY in-scope clip, but the rename list renders 100 at a time. Clicking a
  // tile for clip #250 on the second monitor silently did nothing.
  const pre = mod('05-preview.js');
  const fn = pre.slice(pre.indexOf('function focusClipFromPreview('));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /renameEnsureRendered\(i\)/);
});

// --- destination filenames -------------------------------------------------------------------

test('a Windows reserved device name cannot be produced', () => {
  // A subject that slugs to `con`/`aux`/`nul`/`com1`… produced CON.mp4, which Windows cannot create.
  // slugFolder() has always defended the FOLDER path against this; the FILE path had no guard.
  const destNameFor = app.get('destNameFor');
  for (const bad of ['con', 'CON', 'aux', 'nul', 'com1', 'lpt1']) {
    const out = destNameFor({ name: 'GX010001.MP4', ext: '.MP4', newName: bad });
    assert.notEqual(out.toLowerCase(), `${bad.toLowerCase()}.mp4`, `${bad} must not survive as a bare device name`);
    assert.match(out, /_\.MP4$/i, 'it is suffixed so the file can actually be created');
  }
});

test('a very long name is clamped — it used to fail every clip with ENAMETOOLONG', () => {
  // The AI path caps its description at 12 words; the USER/batch path capped nothing. Paste a long
  // description into the batch bar, apply it to 200 clips, and every one fails at copy — or blows
  // Windows' 260-char MAX_PATH once <Category>/<Project>/ folders are prepended at organize time.
  const destNameFor = app.get('destNameFor');
  const out = destNameFor({ name: 'GX010001.MP4', ext: '.MP4', newName: 'a-very-long-name-'.repeat(40) });
  assert.ok(out.length <= 120 + '.MP4'.length, `clamped to ${out.length} chars`);
  assert.equal(/[-_ ]\.MP4$/.test(out), false, 'and not left ending mid-separator');
});

test('trailing dots and spaces are stripped — Windows strips them anyway, so they collide', () => {
  const destNameFor = app.get('destNameFor');
  assert.equal(destNameFor({ name: 'x.MP4', ext: '.MP4', newName: 'clip ' }), 'clip.MP4');
  assert.equal(destNameFor({ name: 'x.MP4', ext: '.MP4', newName: 'clip.' }), 'clip.MP4');
});

test('an ordinary name is left completely alone', () => {
  const destNameFor = app.get('destNameFor');
  assert.equal(destNameFor({ name: 'GX010001.MP4', ext: '.MP4', newName: '2026-07-12_snow-walking_wide-ridge' }),
    '2026-07-12_snow-walking_wide-ridge.MP4');
});

// --- the phone move must not overwrite -------------------------------------------------------

test('a phone video never renames over a DIFFERENT clip already staged there', async () => {
  // moveFileCrossDevice renames straight over its destination — organizeMove guards that with
  // uniqueDest; this path handed renderer-computed paths straight in. recomputeVersions() only
  // de-duplicates _v# within the CURRENT scan, so a second phone batch producing the same
  // subject/description restarts at _v1 and lands on the first batch's filename.
  const stage = join(dir, 'stage'); const intake = join(dir, 'intake');
  mkdirSync(stage, { recursive: true }); mkdirSync(intake, { recursive: true });

  const src = join(stage, 'new.mp4');
  writeFileSync(src, 'THE-NEW-CLIP');
  const dest = join(intake, 'snow-walking_v1.mp4');
  writeFileSync(dest, 'THE-EXISTING-CLIP-DO-NOT-DESTROY-ME');   // different content AND different size

  const r = await app.invoke('phone:copyVideos', { jobs: [{ src, dest, size: 'THE-NEW-CLIP'.length }] });

  assert.equal(r.copied, 1, 'the new clip is moved');
  assert.equal(readFileSync(dest, 'utf8'), 'THE-EXISTING-CLIP-DO-NOT-DESTROY-ME', 'the EXISTING clip is untouched');
  assert.match(r.okDests[0], /snow-walking_v1 \(1\)\.mp4$/, 'the new one is versioned aside instead of overwriting');
  assert.equal(readFileSync(r.okDests[0], 'utf8'), 'THE-NEW-CLIP');
});

test('phone:copyVideos stops reporting ok when videos actually failed', () => {
  const src = readFileSync(join(ROOT, 'main-mod', '05-windows-phone.js'), 'utf8');
  const h = src.slice(src.indexOf("ipcMain.handle('phone:copyVideos'"));
  const body = h.slice(0, h.indexOf('\n});'));
  assert.match(body, /return \{ ok: failed === 0,/, 'ok was hardcoded true — a failed move still showed a green tick');
});
