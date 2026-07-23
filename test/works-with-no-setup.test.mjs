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
