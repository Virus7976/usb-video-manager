// Audit #95, verified against the REAL app — the half the vm suite cannot prove.
//
// The vm tests prove `isPathAllowed` decides correctly. They cannot prove the guard leaves the app
// usable, and that is the actual risk here: a path allowlist that is even slightly too tight breaks
// previews, posters and folder-opening for real footage, and it does so silently (a blank tile looks
// like a codec problem, not a refusal).
//
// It nearly slipped through. The whole 40-test e2e suite passed with the guard on, which looked like
// proof — but `scanFolder()` sets `state.drive` directly and `stubOpenDialog()` REPLACES
// `dialog.showOpenDialog`, destroying the wrapper that records consent. So neither consent path was
// exercised and no existing test asked for a preview URL. Green meant "nothing else broke", not
// "this works". These tests ask the question directly, from the renderer, over the real IPC bridge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
let allowedDir;
let outsideDir;

before(async () => {
  if (!RUN) return;
  // A folder configured as the intake IS an allowed root — this is the production shape: the user
  // set it in Settings, so everything under it is legitimate without further consent.
  allowedDir = mkdtempSync(join(tmpdir(), 'pg-allowed-'));
  writeFileSync(join(allowedDir, 'GX010023.MP4'), 'not-real-footage');
  // Somewhere the user never pointed the app at. Stands in for "the rest of the disk".
  outsideDir = mkdtempSync(join(tmpdir(), 'pg-outside-'));
  writeFileSync(join(outsideDir, 'private.mp4'), 'secret');
  app = await launchApp({ seed: { 'config.json': { intakeFolder: allowedDir, firstRun: false } } });
});
after(async () => { if (app) await app.close(); });

test('#95 the renderer CAN still get a media URL for a file in a configured folder', { skip: !RUN }, async () => {
  // If this ever goes red, previews are broken in the real app — that is the regression to fear.
  const url = await app.win.evaluate((p) => window.api.mediaUrl(p), join(allowedDir, 'GX010023.MP4'));
  assert.match(String(url), /^file:\/\//, 'an allowed clip still resolves to a file:// URL');
});

test('#95 the renderer CANNOT get a media URL for a file outside every allowed root', { skip: !RUN }, async () => {
  // The attack this closes: script in the webSecurity:false renderer minting a file:// URL for any
  // file the user can read, then fetching it.
  const url = await app.win.evaluate((p) => window.api.mediaUrl(p), join(outsideDir, 'private.mp4'));
  assert.equal(String(url), '', 'refused — no URL handed to the renderer');
});

test('#95 open:folder refuses an unapproved folder in the real app', { skip: !RUN }, async () => {
  const res = await app.win.evaluate((p) => window.api.openFolder(p), outsideDir);
  assert.equal(res.ok, false, 'refused');
  assert.equal(res.refused, true, 'carries the delete:source refusal shape');
});

// NOT RUNNABLE HERE, and skipped honestly rather than deleted. `shell.openPath` on a configured
// folder HANGS under headless WSL — there is no desktop file handler, so the IPC reply never comes
// and the call dies at the 30s timeout ("reply was never sent"). That is the environment, not the
// guard. The property it would prove — an allowed root is still reachable — is covered without the
// shell by the `path:exists(allowedDir) === true` assertion below, and by the media:url test above.
// If this is ever run on a real Windows desktop, drop the skip.
test('#95 open:folder still opens the configured intake folder', { skip: true }, async () => {
  const res = await app.win.evaluate((p) => window.api.openFolder(p), allowedDir);
  assert.equal(res.ok, true, 'the folder the user configured still opens');
});

test('#95 path:exists reports false for a real directory outside the roots', { skip: !RUN }, async () => {
  // The directory genuinely exists; `false` here is the guard refusing to act as a disk-mapping
  // oracle, not a missing-file result.
  assert.equal(await app.win.evaluate((p) => window.api.pathExists(p), outsideDir), false);
  assert.equal(await app.win.evaluate((p) => window.api.pathExists(p), allowedDir), true, 'allowed root still probes');
});
