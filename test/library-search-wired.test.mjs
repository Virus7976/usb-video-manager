// FEATURES.md item 91, wired: the handler, and the Ctrl+K contract.
//
// The engine is pinned in library-search.test.mjs. This is the part that decides whether the feature
// is TRUSTWORTHY, and almost all of it is about what the palette must not do:
//
//   · it must never report "no matches" when a store could not be read;
//   · it must never show results for a query he has stopped typing;
//   · it must never claim to open a clip whose location it does not know.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const menus = readFileSync(join(process.cwd(), 'src', 'mod', '06-menus.js'), 'utf8').replace(/\/\/.*$/gm, '');
const palette = menus.slice(menus.indexOf('function showCommandPalette'), menus.indexOf('async function openLibraryHit'));
const search = async (query, limit) => app.plain(await app.invoke('library:search', { query, limit }));

beforeEach(() => {
  const cfg = app.get('config');
  cfg.renameDrafts = {
    'GX010042.MP4__1__1': { subject: 'lawn-mowing', description: 'dennis-front-yard' },
    'GX010043.MP4__2__2': { subject: 'curling', tags: ['ice'] },
  };
  cfg.finalMeta = { '2026-05-31_lawn-mowing_dennis_v1.mp4': { subject: 'lawn-mowing', category: 'Client Work', project: 'Gourgess Lawns' } };
  const failed = app.get('storeReadFailed');
  failed.renameDrafts = false;
  failed.finalMeta = false;
});

test('the handler searches both stores and reports the scale', async () => {
  const r = await search('lawn');
  assert.equal(r.ok, true);
  assert.equal(r.total, 2, 'the draft and the filed record');
  assert.equal(r.searched, 3, 'and it says how many it looked at');
});

test('⚠⚠ it NEVER reports "no matches" when it could not read the library', async () => {
  // The single most misleading thing a search can do. An unreadable store leaves an empty default in
  // memory, so the search would return zero results — with total confidence — and he would conclude
  // the clip does not exist.
  app.get('storeReadFailed').renameDrafts = true;
  const r = await search('lawn');
  assert.equal(r.partial, true, '⚠ it flags the answer as incomplete');
  assert.deepEqual(r.unavailable, ['your named clips'], 'and names what is missing, in his words');
});

test('⚠ both stores failing is reported, not just the first', async () => {
  const failed = app.get('storeReadFailed');
  failed.renameDrafts = true; failed.finalMeta = true;
  const r = await search('lawn');
  assert.deepEqual(r.unavailable, ['your named clips', 'your filed clips']);
});

test('a healthy search is not flagged as partial', async () => {
  // The bound: a warning that is always on is a warning he learns to ignore.
  const r = await search('lawn');
  assert.equal(r.partial, undefined);
});

test('an empty query costs nothing', async () => {
  const r = await search('');
  assert.equal(r.total, 0);
  assert.deepEqual(r.results, []);
});

// --- the palette contract ----------------------------------------------------------------------

test('⚠⚠ the palette actually asks the library — the loaded screen is no longer the whole search', () => {
  assert.match(palette, /await window\.api\.searchLibrary\(q, 25\)/, 'it calls the bridge');
  assert.match(palette, /filtered = \[\.\.\.localMatches\(q\), \.\.\.libResults\];/,
    'and library hits join the list rather than replacing it — what is on screen still ranks first');
});

test('⚠⚠ ONLY THE NEWEST QUERY MAY WRITE', () => {
  // Type "lawn" quickly and four searches are in flight. Without the sequence guard the slowest one
  // wins and the list shows results for a prefix he has stopped typing. This codebase has had this
  // exact bug before — previewDestinations labelling row 3 with row 3's OLD destination.
  const at = palette.indexOf('async function runLibrarySearch');
  assert.ok(at > -1, 'the search function exists');
  const body = palette.slice(at, palette.indexOf('\n  function onKey', at));
  assert.match(body, /const seq = \(libSeq \+= 1\);/, 'each call takes a ticket');
  assert.match(body, /if \(seq !== libSeq \|\| !cmdPaletteOpen\) return;/,
    '⚠ a stale result is dropped, and so is one arriving after the palette closed');
  assert.match(body, /if \(input\.value\.trim\(\)\.toLowerCase\(\) !== q\) return;/,
    'and one whose query no longer matches the box');
});

test('⚠ closing the palette cancels the search rather than letting it render into nothing', () => {
  const at = palette.indexOf('const close = () => {');
  const body = palette.slice(at, palette.indexOf('function render()', at));
  assert.match(body, /clearTimeout\(libTimer\);/, 'the debounce is cancelled');
  assert.match(body, /libSeq \+= 1;/, 'and any in-flight result is invalidated');
});

test('⚠⚠ "No matches" is never shown while the library is still being asked', () => {
  // Saying "nothing" and then quietly filling the list a moment later trains him to stop reading it.
  const at = palette.indexOf('function render()');
  const body = palette.slice(at, palette.indexOf('function highlight', at));
  assert.match(body, /const empty = libNote\s*\n?\s*\?/, 'the empty state defers to what the library said');
  assert.match(body, /'<div class="cmdp-empty muted small">No matches<\/div>'/, 'and only falls back to "No matches"');
});

test('⚠ the library group is visually separated and states the true total', () => {
  // "showing 25 of 312" is the difference between a search he can trust and one that silently
  // truncates — the same defect as only covering the loaded screen.
  assert.match(palette, /showing \$\{shown\} of \$\{r\.total\}/, 'it says how many it is showing');
  assert.match(palette, /searched \$\{r\.searched\} clips/, 'and how many it looked at');
  assert.match(palette, /class="cmdp-group muted small"/, 'the group has its own header');
  assert.match(palette, /Nothing in your library matches/, 'and an honest empty message');
});

test('⚠ a partial result says so IN THE LIST, not just in the payload', () => {
  assert.match(palette, /could not be read this launch — this is not the whole library/,
    'the warning reaches the screen');
});

test('⚠ a clip already on screen is not listed twice', () => {
  // The same clip once as "clip" and once as "library" reads as two clips.
  assert.match(palette, /const onScreen = new Set\(\(state\.scannedFiles \|\| \[\]\)\.map\(\(c\) => String\(c\.name \|\| ''\)\.toLowerCase\(\)\)\);/,
    'what is loaded is collected');
  assert.match(palette, /\.filter\(\(h\) => !onScreen\.has\(String\(h\.name \|\| ''\)\.toLowerCase\(\)\)\)/,
    'and excluded from the library group');
});

test('⚠ the search is debounced and skips one-character queries', () => {
  assert.match(palette, /if \(!q \|\| q\.length < 2\) \{ libResults = \[\]; libNote = ''; filtered = localMatches\(q\); render\(\); return; \}/,
    'a single character does not fire a library scan');
  assert.match(palette, /libTimer = setTimeout\(\(\) => runLibrarySearch\(q\), 180\);/, 'and typing is debounced');
});

test('⚠⚠ picking a library clip never PRETENDS to open something it cannot find', () => {
  // The honest-limits part. A draft record is keyed by name+size and carries NO path, so the app
  // genuinely does not know where every library clip is. Three tiers, each stated to him.
  const at = menus.indexOf('async function openLibraryHit');
  assert.ok(at > -1, 'the handler exists');
  const body = menus.slice(at, menus.indexOf('\ndocument.addEventListener', at));
  assert.match(body, /if \(i >= 0\) \{ jumpToClip\(i\); return; \}/, 'tier 1 — it is on screen after all');
  assert.match(body, /if \(hit\.filed && hit\.where && hit\.where !== 'filed'\)/, 'tier 2 — a FILED clip has a folder');
  assert.match(body, /await window\.api\.openFolder\(rel \? `\$\{root\}\/\$\{rel\}` : root\)/, 'which is opened');
  assert.match(body, /clipboardWrite\(hit\.name\)/, 'tier 3 — otherwise the name is copied');
  assert.match(body, /it is not on this screen/, '⚠ and he is TOLD that, rather than left wondering');
});

test('⚠ a failure to open the folder falls through instead of dead-ending', () => {
  const at = menus.indexOf('async function openLibraryHit');
  const body = menus.slice(at, menus.indexOf('\ndocument.addEventListener', at));
  const catchAt = body.indexOf('} catch {');
  assert.ok(catchAt > -1 && catchAt < body.indexOf('clipboardWrite'),
    'the catch precedes the clipboard tier, so a failed open still does something useful');
});
