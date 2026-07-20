// FEATURES.md item 42, driven the way he would drive it: a real right-click on a real row, a real
// click on the real menu item, real typing, and then a look at the disk AND at the metadata store.
//
// The vm tests prove the two halves separately — that `rename:apply` renames and carries the record,
// and that the dialog reads the result rather than what was typed. Neither proves the halves are
// CONNECTED, and `rename:apply` sat correct-and-unreachable for months precisely because nothing
// ever exercised the connection. A structural test cannot see a menu item wired to the wrong row.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read, run, waitFor } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let box;

before(async () => {
  if (!RUN) return;
  const base = mkdtempSync(join(tmpdir(), 'uvd-e2e-rename-'));
  const compressed = join(base, 'Compressed');
  mkdirSync(compressed, { recursive: true });
  writeFileSync(join(compressed, 'typo-nmae.MP4'), Buffer.alloc(2048, 7));
  box = { base, compressed };
  app = await launchApp({
    seed: {
      'config.json': { firstRun: false, finalizeSource: compressed, nasBackup: { enabled: false, path: '' } },
      // A clip that is already NAMED and FILED — the case item 42 is about. Its record is keyed by
      // the lower-cased filename, which is exactly what the rename changes.
      //
      // ⚠ The file is `final-meta.json`, NOT `finalMeta.json`. Seeding the wrong name gives an EMPTY
      // store, and then "the old key is gone" passes vacuously — the first draft of this test did
      // exactly that and only the positive assertion below caught it. Store keys and store FILENAMES
      // are different namespaces (STORE_FILES in main-mod/01-core.js is the list).
      'final-meta.json': { 'typo-nmae.mp4': { subject: 'lawn-mowing', people: ['dennis'], done: true, ts: 1 } },
    },
  });
});
after(async () => {
  if (app) await app.close();
  if (box) rmSync(box.base, { recursive: true, force: true });
});

test('⚠⚠ right-click → Rename renames the file on disk AND carries its metadata', { skip: !RUN }, async () => {
  await run(app.win, 'openFinalize();');
  await waitFor(app.win, "typeof finScan !== 'undefined' && finScan.files && finScan.files.length > 0",
    { what: 'the Organize scan to list the clip' });

  // A REAL right-click on the rendered row — this is what proves the listener is on the element that
  // actually exists, not on one a refactor left behind.
  await run(app.win, `
    const row = document.querySelector('#finList .fin-item');
    if (!row) throw new Error('no row rendered');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  `);
  await waitFor(app.win, "!!document.querySelector('.context-flyout')", { what: 'the row context menu to open' });

  const labels = await read(app.win, "[...document.querySelectorAll('.context-flyout .flyout-label')].map((e) => e.textContent)");
  assert.ok(labels.includes('Rename this clip…'), `the menu offers it — got ${JSON.stringify(labels)}`);

  await run(app.win, `
    const b = [...document.querySelectorAll('.context-flyout .flyout-item')]
      .find((e) => (e.textContent || '').includes('Rename this clip…'));
    if (!b) throw new Error('menu item not found');
    b.click();
  `);
  await waitFor(app.win, "!!document.querySelector('.rc-name')", { what: 'the rename dialog to open' });

  // ⚠ The input holds ONLY the stem — the extension is displayed beside it and never editable.
  const pre = await read(app.win, "({ v: document.querySelector('.rc-name').value, ext: document.querySelector('.rc-ext').textContent })");
  assert.equal(pre.v, 'typo-nmae', 'the field is pre-filled with the stem, ready to correct');
  assert.equal(pre.ext, '.MP4', 'and the extension is shown separately');

  // Type the fix and press the real button.
  await run(app.win, `
    const inp = document.querySelector('.rc-name');
    inp.value = 'typo-name';
    document.querySelector('.rc-ok').click();
  `);
  await waitFor(app.win, "(finScan.files || []).some((f) => f && f.name === 'typo-name.MP4')",
    { what: 'the row to show the new name', timeout: 15000 });

  // The disk.
  const files = readdirSync(box.compressed);
  assert.deepEqual(files.sort(), ['typo-name.MP4'], '⚠ renamed on disk, and no stray copy left behind');
  assert.equal(existsSync(join(box.compressed, 'typo-nmae.MP4')), false, 'the old name is gone');

  // ⚠⚠ And the metadata, read back through the REAL bridge. This is the assertion that matters:
  // finalMeta is keyed by filename, so a rename that did not move the record would leave this clip
  // looking never-named and never-filed.
  const fm = await read(app.win, 'window.api.getFinalMeta()');
  assert.ok(fm && Object.keys(fm).length, 'the store is not empty — otherwise everything below passes vacuously');
  assert.equal(fm['typo-nmae.mp4'], undefined, '⚠ the old key is gone');
  assert.ok(fm['typo-name.mp4'], '⚠ and the record is under the new name');
  assert.equal(fm['typo-name.mp4'].subject, 'lawn-mowing', 'with his subject');
  assert.deepEqual(fm['typo-name.mp4'].people, ['dennis'], 'his people');
  assert.equal(fm['typo-name.mp4'].done, true, 'and the filed flag intact');
});

test('⚠ the row now points at the NEW path, so the next action on it works', { skip: !RUN }, async () => {
  // A row still holding the old sourcePath is the bug that turns one rename into "everything I do to
  // this clip now fails" — and it looks like an unrelated defect when it happens.
  const p = await read(app.win, "(finScan.files.find((f) => f.name === 'typo-name.MP4') || {}).sourcePath");
  assert.ok(String(p).endsWith('typo-name.MP4'), `the row tracks the renamed file — got ${p}`);
  const exists = await read(app.win, `window.api.pathExists(${JSON.stringify(String(p))})`);
  assert.equal(exists, true, '⚠ and that path is really there');
});

test('⚠ cancelling the dialog changes nothing', { skip: !RUN }, async () => {
  await run(app.win, `
    const row = document.querySelector('#finList .fin-item');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  `);
  await waitFor(app.win, "!!document.querySelector('.context-flyout')", { what: 'the menu' });
  await run(app.win, `
    [...document.querySelectorAll('.context-flyout .flyout-item')]
      .find((e) => (e.textContent || '').includes('Rename this clip…')).click();
  `);
  await waitFor(app.win, "!!document.querySelector('.rc-name')", { what: 'the dialog' });
  await run(app.win, `
    document.querySelector('.rc-name').value = 'something-else';
    document.querySelector('.rc-cancel').click();
  `);
  await waitFor(app.win, "!document.querySelector('.rc-name')", { what: 'the dialog to close' });
  assert.deepEqual(readdirSync(box.compressed).sort(), ['typo-name.MP4'], '⚠ nothing on disk moved');
});
