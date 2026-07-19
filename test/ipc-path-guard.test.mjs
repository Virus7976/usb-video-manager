// Audit #95 — the fs/shell IPC surface took any path the renderer handed it.
//
// `open:folder` passed its argument straight to `shell.openPath`; `path:exists`, `disk:freeSpace`,
// `media:url` and `poster:get` were equally open. That is only as safe as the renderer, and this
// renderer runs with `webSecurity: false` (deliberate — Chromium's file loader seeks HEVC over
// file://), rendering filenames and AI-generated text that the app does not control. One XSS was
// therefore arbitrary local read ("what's in C:\Users\<me>\Documents") and arbitrary shell-open.
//
// The fix mirrors `delete:source`, the one handler that already got this right: decide in main,
// fail CLOSED, and refuse with a reason rather than silently doing the dangerous thing.
//
// THE NON-OBVIOUS HALF is consent. A pure config-roots allowlist would be secure and useless: the
// app is full of folder pickers, and Jake points them at arbitrary disks. So a path the USER chose
// — through a native showOpenDialog, or by picking a card the app itself enumerated — is allowed.
// Consent is what makes an arbitrary folder legitimate; the renderer asking on its own is not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const dirs = [];
const mk = (prefix) => { const d = tempDir(prefix); dirs.push(d); return d.dir; };

test('#95 a path under no allowed root is refused', () => {
  const outsider = mk('pg-outside-');
  assert.equal(app.call('isPathAllowed', path.join(outsider, 'secrets.txt')), false);
});

test('#95 a configured root and everything under it is allowed', () => {
  const intake = mk('pg-intake-');
  const cfg = app.get('config');
  cfg.intakeFolder = intake;
  assert.equal(app.call('isPathAllowed', intake), true, 'the root itself');
  assert.equal(app.call('isPathAllowed', path.join(intake, 'a', 'GX010023.MP4')), true, 'nested under it');
});

test('#95 a sibling whose name merely PREFIXES an allowed root is refused', () => {
  // Naive prefix matching lets "/tmp/intake-evil" pass as "under" "/tmp/intake". The boundary has
  // to be a path separator, not a string prefix.
  const intake = mk('pg-prefix-');
  app.get('config').intakeFolder = intake;
  assert.equal(app.call('isPathAllowed', `${intake}-evil/loot.txt`), false);
});

test('#95 `..` traversal out of an allowed root is refused', () => {
  const intake = mk('pg-trav-');
  app.get('config').intakeFolder = intake;
  const escaped = path.join(intake, '..', '..', 'etc', 'passwd');
  assert.equal(app.call('isPathAllowed', escaped), false, 'resolved, not taken at face value');
});

test('#95 a path the user picked in a native dialog becomes allowed', () => {
  const picked = mk('pg-picked-');
  assert.equal(app.call('isPathAllowed', picked), false, 'not allowed before the user picks it');
  app.call('rememberApprovedRoot', picked);
  assert.equal(app.call('isPathAllowed', path.join(picked, 'clip.MP4')), true, 'allowed after consent');
});

test('#95 a card the app enumerated is allowed (drives are picked on the home screen, not a dialog)', () => {
  const card = mk('pg-card-');
  app.call('rememberApprovedRoot', card);
  assert.equal(app.call('isPathAllowed', path.join(card, 'DCIM', '100GOPRO', 'GX010001.MP4')), true);
});

test('#95 empty / non-string paths are refused rather than throwing', () => {
  for (const bad of ['', null, undefined, 0, {}, []]) {
    assert.equal(app.call('isPathAllowed', bad), false, `refused: ${JSON.stringify(bad)}`);
  }
});

test('#95 open:folder REFUSES an outside path and does not shell-open it', async () => {
  const outsider = mk('pg-openf-');
  const r = await app.invoke('open:folder', outsider);
  assert.equal(r.ok, false, 'refused');
  assert.equal(r.refused, true, 'flagged as a refusal, matching delete:source');
  assert.match(String(r.error), /refused/i);
});

test('#95 open:folder still opens an allowed folder', async () => {
  const intake = mk('pg-openok-');
  app.get('config').intakeFolder = intake;
  const r = await app.invoke('open:folder', intake);
  assert.equal(r.ok, true);
});

test('#95 path:exists refuses to probe outside the allowed roots', async () => {
  const outsider = mk('pg-exists-');
  // The directory really does exist — a `false` here is the guard, not a missing file. That is the
  // point: the renderer must not be able to use this handler to map the disk.
  assert.equal(await app.invoke('path:exists', outsider), false);
  app.call('rememberApprovedRoot', outsider);
  assert.equal(await app.invoke('path:exists', outsider), true, 'allowed once approved');
});

test('#95 disk:freeSpace refuses an outside path', async () => {
  const outsider = mk('pg-free-');
  const r = await app.invoke('disk:freeSpace', outsider);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /refused/i);
});

test('#95 media:url refuses to mint a file:// URL for an outside path', async () => {
  const outsider = mk('pg-media-');
  const outside = path.join(outsider, 'private.mp4');
  assert.equal(await app.invoke('media:url', outside), '', 'no URL handed back');
  app.call('rememberApprovedRoot', outsider);
  assert.match(String(await app.invoke('media:url', outside)), /^file:\/\//, 'allowed once approved');
});

test('#95 poster:get refuses an outside path instead of running ffmpeg on it', async () => {
  const outsider = mk('pg-poster-');
  const r = await app.invoke('poster:get', path.join(outsider, 'private.mp4'));
  assert.equal(r, '', 'no poster produced for an unapproved path');
});
