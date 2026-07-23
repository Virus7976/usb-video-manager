// Settings → "Folders & setup", driven against the REAL app.
//
// Everything verified about this screen so far has been STRUCTURAL — reading `06-menus.js` and
// asserting it contains the right calls. That is exactly the kind of verification this project
// already has a scar from: the e2e harness exists because source-shape tests passed while the guard
// they described had been deleted, eight times in one session. A screen is not verified until
// something has actually opened it.
//
// So this seeds a config with one folder that EXISTS, one that does NOT, and a filing rule whose
// destination is stale in exactly the way his real rules were — then opens the screen in Electron and
// reads the live DOM.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let base; let projectsRoot; let intake;

before(async () => {
  if (!RUN) return;
  base = mkdtempSync(join(tmpdir(), 'uvd-fs-'));
  // His real shape: the root IS the year folder, with the project directly under it.
  projectsRoot = join(base, '02 - Projects', '2026');
  mkdirSync(join(projectsRoot, '2026 - Client Work', 'Gourgess Lawns'), { recursive: true });
  intake = join(base, '01 - Uncompressed');
  mkdirSync(intake, { recursive: true });

  app = await launchApp({
    seed: {
      'config.json': {
        intakeFolder: intake,
        // Deliberately points at a folder that is NOT there — the case the screen exists to surface.
        compressedFolder: join(base, 'Compressed That Never Existed'),
        projectsRoot,
        ai: {
          routes: [
            // Stale in exactly the way his two real rules were: the dest re-prefixes the root's own
            // name, because the root moved a level deeper after the rule was saved.
            { id: 'r1', name: 'Lawn care', kind: 'route', match: ['lawn'], dest: '2026/2026 - Client Work/Gourgess Lawns' },
          ],
        },
      },
    },
  });
});
after(async () => {
  if (app) await app.close();
  if (base) { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
});

const openScreen = async (win) => {
  await run(win, 'showFoldersAndSetup();');
  // The screen fills itself in asynchronously — it stats every path and asks main to validate the
  // filing rules — so wait for the placeholder to be replaced rather than racing it.
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const txt = await read(win, "document.querySelector('.fs-body')?.textContent || ''");
    if (txt && !txt.includes('Checking…')) return txt;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the screen never finished loading');
};

test('⚠⚠ it opens, and distinguishes a folder that EXISTS from one that does not', { skip: !RUN }, async () => {
  const txt = await openScreen(app.win);
  assert.match(txt, /Footage lands here/, 'the intake folder is listed');
  assert.match(txt, /Projects folder/, 'and the projects folder');

  // The whole point of the screen: configured is not the same as present.
  const ok = await read(app.win, "document.querySelectorAll('.fs-ok').length");
  const bad = await read(app.win, "document.querySelectorAll('.fs-bad').length");
  assert.ok(ok >= 2, `⚠⚠ the two real folders read as found — got ${ok}`);
  assert.ok(bad >= 1, `⚠⚠ the missing Compressed folder is flagged — got ${bad}`);
  assert.match(txt, /not on disk/, '⚠⚠ and says so in words, not just a colour');
});

test('⚠⚠ a stale filing rule is shown as broken, with a fix offered in place', { skip: !RUN }, async () => {
  const txt = await read(app.win, "document.querySelector('.fs-body')?.textContent || ''");
  assert.match(txt, /Lawn care/, 'the rule is listed by name');
  assert.match(txt, /points at a folder that is not there/, '⚠⚠ and its status is stated plainly');
  const hasFix = await read(app.win, "!!document.querySelector('.fs-fix')");
  assert.equal(hasFix, true, '⚠⚠ the repair is on this screen, not somewhere he has to go find');
});

test('⚠⚠⚠ clicking the fix really repairs the stored rule', { skip: !RUN }, async () => {
  // The assertion that source-reading cannot make: that the button, wired through preload and main,
  // changes the value on disk.
  const before0 = await read(app.win, 'window.api.getRoutes().then(r => r[0].dest)');
  assert.equal(before0, '2026/2026 - Client Work/Gourgess Lawns', 'setup: still stale');

  await app.win.click('.fs-fix');
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const d = await read(app.win, 'window.api.getRoutes().then(r => r[0].dest)');
    if (d !== before0) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
  const after = await read(app.win, 'window.api.getRoutes().then(r => r[0].dest)');
  assert.equal(after, '2026 - Client Work/Gourgess Lawns',
    '⚠⚠⚠ the stored rule now names the folder he actually has');
});

test('⚠ the preset controls are on the screen and clickable', { skip: !RUN }, async () => {
  await openScreen(app.win);
  const save = await read(app.win, "!!document.querySelector('.fs-preset-save')");
  const load = await read(app.win, "!!document.querySelector('.fs-preset-load')");
  assert.equal(save, true, 'save is here');
  assert.equal(load, true, 'and load');
});
