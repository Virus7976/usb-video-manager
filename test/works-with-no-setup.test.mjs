// ⚠⚠ A FRESH INSTALL MUST DO SOMETHING USEFUL, NOT ANSWER "No folder chosen".
//
// Jake, 2026-07-22: *"you should build it as if it was an application that worked without all the
// compression folders and stuff and just worked and then can be mega customized to the point where I
// have it."* (PROMPT.md §8i.)
//
// Measured on a clean profile before this change:
//
//     intakeFolder     "<Videos>/USB Auto-Action/01 - Uncompressed"   ← has a sensible default
//     compressedFolder  undefined
//     finalizeSource    ""
//     finalize:scan    {"ok":false,"error":"No folder chosen"}        ← the Organize screen dead-ends
//
// So the whole back half of the app was gated on a folder layout only Jake has. Compression is
// OPTIONAL — plenty of people never encode at all — and a missing Compressed folder must not mean
// "you cannot organize". This is also the root cause of a measured bug in HIS install: his 203
// photos live in `01 - Uncompressed`, photos are never compressed, so they never reach
// `02 - Compressed` and Organize has never been able to see them.
//
// ⚠ THE FALLBACK IS REPORTED, NOT SILENT. Scanning a different folder than he believes is configured
// would be its own bug — `usedFallback` travels back so the screen can say which folder it is
// showing and why.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base;
before(() => { app = loadMain({ userData: mkdtempSync(join(tmpdir(), 'nosetup-')) }); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

const mk = (name) => { const d = join(base, name); mkdirSync(d, { recursive: true }); return d; };
const clip = (dir, name) => writeFileSync(join(dir, name), 'x'.repeat(64));

beforeEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  base = mkdtempSync(join(tmpdir(), 'nosetup-dirs-'));
  const cfg = app.get('config');
  cfg.finalizeSource = '';
  cfg.compressedFolder = '';
  cfg.intakeFolder = '';
});

const scan = async (arg) => app.plain(await app.invoke('finalize:scan', arg));

test('⚠⚠ with NOTHING configured, Organize scans the intake folder instead of refusing', async () => {
  const intake = mk('01 - Uncompressed');
  clip(intake, '2026-06-01_lawn-mowing_front_v1.mp4');
  app.get('config').intakeFolder = intake;

  const r = await scan({});
  assert.equal(r.ok, true, `⚠⚠ a fresh install must not dead-end — got ${r.error}`);
  assert.equal(r.dir, intake, 'it scans where the footage actually is');
  assert.equal(r.total, 1, 'and finds the clip');
});

test('⚠⚠ it SAYS it fell back, so he is not silently looking at a different folder', async () => {
  const intake = mk('01 - Uncompressed');
  app.get('config').intakeFolder = intake;
  const r = await scan({});
  assert.equal(r.usedFallback, 'intake',
    '⚠⚠ the screen must be able to explain which folder this is and why');
});

test('⚠ a configured Compressed folder still wins over intake', async () => {
  // The fallback is a LAST resort, not a preference. Someone who does compress must keep getting
  // their compressed clips.
  const intake = mk('01 - Uncompressed');
  const compressed = mk('02 - Compressed');
  clip(intake, 'a.mp4');
  clip(compressed, 'b.mp4');
  const cfg = app.get('config');
  cfg.intakeFolder = intake;
  cfg.compressedFolder = compressed;

  const r = await scan({});
  assert.equal(r.dir, compressed, '⚠ the compressed folder is preferred when it exists');
  assert.equal(r.usedFallback, 'compressed', 'and it still reports which one it used');
});

test('⚠⚠ an explicitly chosen folder always wins, and is NOT reported as a fallback', async () => {
  // The case that must not regress: he picks a folder by hand. Nothing may override that, and
  // labelling it a fallback would put a misleading explanation on screen.
  const intake = mk('01 - Uncompressed');
  const chosen = mk('Some Other Folder');
  clip(chosen, 'c.mp4');
  const cfg = app.get('config');
  cfg.intakeFolder = intake;
  cfg.finalizeSource = intake;

  const r = await scan({ dir: chosen });
  assert.equal(r.dir, chosen, '⚠⚠ an explicit choice is honoured');
  assert.equal(r.usedFallback, '', '⚠⚠ and is not described as a fallback');
});

test('⚠ a saved finalizeSource beats both fallbacks', async () => {
  const intake = mk('01 - Uncompressed');
  const saved = mk('Saved Source');
  clip(saved, 'd.mp4');
  const cfg = app.get('config');
  cfg.intakeFolder = intake;
  cfg.compressedFolder = mk('02 - Compressed');
  cfg.finalizeSource = saved;

  const r = await scan({});
  assert.equal(r.dir, saved, '⚠ his saved choice is still the first thing consulted');
  assert.equal(r.usedFallback, '', 'and it is not a fallback');
});

test('⚠ with genuinely nowhere to look, it still says so plainly', async () => {
  // The fallback must not turn a real "you have not set anything up" into a confusing empty list.
  const r = await scan({});
  assert.equal(r.ok, false, '⚠ no folders at all is still an honest refusal');
  assert.match(r.error, /No folder chosen/i);
});

// --- ONE PLACE THAT ANSWERS "IS THIS SET UP RIGHT?" ----------------------------------------------
//
// Settings → "Folders & setup". Its job is not to add settings — they already exist, spread across
// Preferences, the Setup wizard, Filing rules and an AI health card. Its job is to show every folder
// the app uses and whether it is REALLY on disk, which none of those screens did. That gap was not
// cosmetic: both of his filing rules pointed at a folder that was never there and nothing told him.

const readSrc = async (p) => {
  const { readFileSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  return readFileSync(j(process.cwd(), p), 'utf8').replace(/\/\/.*$/gm, '');
};

test('⚠⚠ the screen exists, is in the Settings hub, and asks the DISK', async () => {
  const menus = await readSrc('src/mod/06-menus.js');
  assert.match(menus, /title: 'Folders & setup'/, 'it is a card in the existing hub');
  assert.match(menus, /go: showFoldersAndSetup/, 'wired to the real function');
  assert.match(menus, /async function showFoldersAndSetup/, 'which exists');

  const at = menus.indexOf('async function showFoldersAndSetup');
  const body = menus.slice(at);
  assert.match(body, /await window\.api\.pathExists\(/,
    '⚠⚠ it checks whether each folder is really there — a CONFIGURED path proves nothing');
  assert.match(body, /await window\.api\.validateRouteDests\(\)/,
    '⚠⚠ and reuses the same validator the health check runs, rather than a second opinion');
});

test('⚠ it is a NINTH card, not a second settings screen', async () => {
  // The duplication this codebase warns about: Settings is a container, and a screen that lists its
  // own siblings makes the same thing reachable two ways with two behaviours.
  const menus = await readSrc('src/mod/06-menus.js');
  const at = menus.indexOf('function showSettingsHub');
  const hub = menus.slice(at, menus.indexOf('function showSetupWizard', at));
  const count = (hub.match(/\{ ic: /g) || []).length;
  assert.equal(count, 9, `⚠ the hub gained exactly one card — found ${count}`);
});

test('⚠⚠ the preset controls are on it, wired to the real functions', async () => {
  const menus = await readSrc('src/mod/06-menus.js');
  const at = menus.indexOf('async function showFoldersAndSetup');
  const body = menus.slice(at);
  assert.match(body, /savePresetFile\(\)/, 'save is reachable from here');
  assert.match(body, /loadPresetFile\(\)/, 'and load');
});

test('⚠ a broken filing rule offers the fix in place, and re-reads afterwards', async () => {
  // "Make errors actionable in place" — a screen that reports a problem and makes him go elsewhere
  // to fix it is where the pipeline stalls.
  const menus = await readSrc('src/mod/06-menus.js');
  const at = menus.indexOf('async function showFoldersAndSetup');
  const body = menus.slice(at);
  assert.match(body, /window\.api\.repairRouteDests\(\)/, 'the fix is on this screen');
  assert.match(body, /r\.repaired/, 'and it reports the real count');
  assert.match(body, /Nothing needed fixing/, 'including when it changed nothing');
  assert.match(body, /close\(\); showFoldersAndSetup\(\);/, '⚠ and the screen re-reads rather than showing stale status');
});
