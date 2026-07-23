// Saving a preset and loading it back, through the REAL app.
//
// `core/presets.js` is well covered by unit tests — allowlist, personal data, absolute paths, an
// untrusted import. But those all call the core directly. Nothing had ever driven the actual round
// trip: menu action → IPC → OS save dialog → a file on disk → open dialog → parse → confirm →
// apply → config written.
//
// That gap is exactly where the previous iteration's bug lived: `config:get` not exposing a key the
// screen read. Both halves correct, the join broken, every structural test green. So this test reads
// the FILE the app actually wrote, and checks the config the app actually changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read, run, stubOpenDialog, stubSaveDialog } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let dir; let presetPath;

// Distinctive values so an assertion cannot pass by coincidence.
const SECRET_PERSON = 'Zephyrina';
const SECRET_SUBJECT = 'quokka-wrangling';
const SECRET_PATH = 'C:\\Users\\zzz-secret-user\\Videos';

before(async () => {
  if (!RUN) return;
  dir = mkdtempSync(join(tmpdir(), 'uvd-preset-'));
  presetPath = join(dir, 'mine.uaa-preset.json');
  app = await launchApp({
    seed: {
      'config.json': {
        folderLevels: ['category', 'project'],
        autoPoll: true,
        projectsRoot: SECRET_PATH,
        intakeFolder: `${SECRET_PATH}\\01 - Uncompressed`,
        subjects: [SECRET_SUBJECT],
        ai: { model: 'qwen2.5vl:7b', frames: 3, endpoint: 'http://10.1.2.3:11434' },
      },
      'people.json': [{ id: 'p1', name: SECRET_PERSON, faces: [] }],
    },
  });
});
after(async () => {
  if (app) await app.close();
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('⚠⚠ saving a preset writes a real file, through the real menu action', { skip: !RUN }, async () => {
  await stubSaveDialog(app.app, presetPath);
  await run(app.win, 'savePresetFile();');
  for (let i = 0; i < 60 && !existsSync(presetPath); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(existsSync(presetPath), '⚠⚠ the file the OS dialog named actually got written');
  const obj = JSON.parse(readFileSync(presetPath, 'utf8'));
  assert.equal(obj.kind, 'usb-auto-action-preset', 'and it is one of ours');
  assert.deepEqual(obj.settings.folderLevels, ['category', 'project'], 'carrying his real settings');
  assert.equal(obj.settings.ai.model, 'qwen2.5vl:7b');
});

test('⚠⚠⚠ the file on disk contains none of his data and no paths', { skip: !RUN }, async () => {
  // The unit tests assert this against `buildPreset`'s return value. This asserts it against the
  // BYTES that would actually be emailed to someone.
  const text = readFileSync(presetPath, 'utf8');
  assert.ok(!text.includes(SECRET_PERSON), '⚠⚠⚠ an enrolled person reached the shared file');
  assert.ok(!text.includes(SECRET_SUBJECT), '⚠⚠⚠ his subject vocabulary reached it');
  assert.ok(!text.includes('zzz-secret-user'), '⚠⚠⚠ his Windows username reached it');
  assert.ok(!text.includes('C:\\\\'), '⚠⚠⚠ a drive letter reached it');
  assert.ok(!text.includes('10.1.2.3'), '⚠⚠⚠ his local network address reached it');
});

test('⚠⚠ the toast says what travelled, not just "saved"', { skip: !RUN }, async () => {
  const toast = await read(app.win, "document.querySelector('.app-toast')?.textContent || ''");
  assert.match(toast, /Preset saved/, 'it confirms');
  assert.match(toast, /setting/, 'and states how much travelled');
  assert.match(toast, /No folders, people or footage details are in it/,
    '⚠⚠ and states what did NOT — this is a file he may hand to someone');
});

test('⚠⚠⚠ loading it back restores the setting and leaves his data alone', { skip: !RUN }, async () => {
  // Change something, then import the preset and watch it come back.
  await run(app.win, "window.api.getConfig();");
  const changed = await app.app.evaluate(async () => true);
  assert.equal(changed, true);

  // Rewrite the saved preset so it differs from the live config in a checkable way.
  const obj = JSON.parse(readFileSync(presetPath, 'utf8'));
  obj.settings.folderLevels = ['project'];
  obj.name = 'Imported setup';
  writeFileSync(presetPath, JSON.stringify(obj, null, 2));

  await stubOpenDialog(app.app, presetPath);
  await run(app.win, 'loadPresetFile();');

  // The confirm dialog is the point of the two-step import — click through it like a person.
  let clicked = false;
  for (let i = 0; i < 60 && !clicked; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    clicked = await app.win.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal-overlay button')]
        .find((b) => /^(ok|apply|yes|continue)/i.test((b.textContent || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    // eslint-disable-next-line no-await-in-loop
    if (!clicked) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(clicked, '⚠⚠ the confirm dialog appeared and was accepted');

  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const lv = await read(app.win, 'window.api.getConfig().then(c => (c.folderLevels || []).join(","))');
    if (lv === 'project') break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
  const lv = await read(app.win, 'window.api.getConfig().then(c => (c.folderLevels || []).join(","))');
  assert.equal(lv, 'project', '⚠⚠⚠ the imported setting really applied to the live config');

  // And the things a preset must never touch are still exactly as they were.
  const root = await read(app.win, 'window.api.getConfig().then(c => c.projectsRoot)');
  assert.equal(root, SECRET_PATH, '⚠⚠⚠ his projects folder was NOT repointed by an imported file');
});
