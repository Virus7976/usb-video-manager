// The ten-second path, driven the way he would drive it: a real right-click on a real row, a real
// click on the real menu item, and then a look at the disk.
//
// The vm tests for this feature prove the two halves separately — that `finalize:run` files one clip
// and reports where, and that the renderer's handler reads the right checkboxes and defers to the
// ladder. Neither proves the halves are CONNECTED. That gap is not hypothetical here: the whole
// reason this feature exists is that a filing capability which was never watched to succeed sat
// unused for months, and three separate bugs this week were "a second entry point wired to the wrong
// context". A structural test cannot see any of that.
//
// So this one clicks. The only stub is `confirmDialog` — this path does not currently open one, and
// stubbing it means a future confirmation cannot silently hang the test instead of failing it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read, run, waitFor } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let box;

function makeWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'uvd-e2e-fileone-'));
  const compressed = join(base, 'Compressed');
  const projects = join(base, 'Projects');
  mkdirSync(compressed, { recursive: true });
  mkdirSync(projects, { recursive: true });
  // Deliberately an UNNAMED clip: the case where the destination comes from the ladder rather than
  // from anything the caller sent, which is the case the report was built for.
  const clip = join(compressed, 'GX010099.MP4');
  writeFileSync(clip, Buffer.alloc(2048, 3));
  const when = new Date('2026-04-11T09:00:00Z');
  utimesSync(clip, when, when);
  return { base, compressed, projects, clip };
}

const walk = (root) => {
  const out = [];
  const rec = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(d, e.name), r); else out.push(r);
    }
  };
  rec(root, '');
  return out;
};

before(async () => {
  if (!RUN) return;
  box = makeWorkspace();
  app = await launchApp({
    seed: {
      'config.json': {
        firstRun: false,
        finalizeSource: box.compressed,
        projectsRoot: box.projects,
        organizeDest: '',
        folderLevels: ['category', 'project'],
        nasBackup: { enabled: false, path: '' },
      },
    },
  });
});
after(async () => {
  if (app) await app.close();
  if (box) rmSync(box.base, { recursive: true, force: true });
});

test('right-click a row, click "File this clip now", and the clip is in the Projects tree', { skip: !RUN }, async () => {
  await run(app.win, `confirmDialog = function () { return Promise.resolve(true); };`);
  await run(app.win, `openFinalize();`);
  // Bare `finScan`, not `window.finScan` — it is a top-level `let` in the bundle, so it lives in
  // script scope and is never a window property. And `waitFor`, not page.waitForFunction, which
  // uses eval internally and is blocked by the app's CSP. Both learned the hard way (harness.mjs).
  await waitFor(app.win, `typeof finScan !== 'undefined' && finScan.files && finScan.files.length > 0`,
    { what: 'the Organize scan to list the clip' });

  // A REAL right-click on the row. Dispatching the event rather than calling the handler is the
  // point: it proves the listener is attached to the element that is actually rendered.
  await run(app.win, `
    const row = document.querySelector('#finList .fin-item');
    if (!row) throw new Error('no row rendered');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  `);
  await waitFor(app.win, `!!document.querySelector('.context-flyout')`, { what: 'the row context menu to open' });

  const labels = await read(app.win, `[...document.querySelectorAll('.context-flyout .flyout-label')].map((e) => e.textContent)`);
  assert.ok(labels.includes('File this clip now'), `the menu offers it — got ${JSON.stringify(labels)}`);

  // Click it for real.
  await run(app.win, `
    const b = [...document.querySelectorAll('.context-flyout .flyout-item')]
      .find((e) => (e.textContent || '').includes('File this clip now'));
    if (!b) throw new Error('menu item not found');
    b.click();
  `);

  // The clip lands on disk. Poll the renderer's own view of it rather than sleeping — the run is a
  // real exiftool/move round trip through main.
  await waitFor(app.win, `(finScan.files || []).some((f) => f && f.filed)`, { what: 'the clip to be marked filed', timeout: 30000 });

  // The footage AND its sidecar. The .xmp is supposed to follow the clip — leaving it behind in the
  // Compressed folder was a fixed bug, and asserting "exactly one file" would re-break it.
  const landed = walk(box.projects);
  const vids = landed.filter((f) => /\.MP4$/i.test(f));
  assert.equal(vids.length, 1, `exactly one clip arrived in the Projects tree — got ${JSON.stringify(landed)}`);
  assert.ok(vids[0].endsWith('GX010099.MP4'), `and it is the clip — got ${vids[0]}`);
  assert.ok(vids[0].includes('/'), `filed into a FOLDER, never the bare root — got ${vids[0]}`);
  assert.ok(landed.some((f) => /\.xmp$/i.test(f)), `its sidecar came with it — got ${JSON.stringify(landed)}`);
});

test('the row now says where it went, and the folder is the real one', { skip: !RUN }, async () => {
  // "Filed ✓" with no destination is the re-check-its-work loop this feature exists to remove.
  const filedIn = await read(app.win, `((finScan.files || []).find((f) => f && f.filed) || {}).filedIn || ''`);
  assert.ok(filedIn.length > 0, 'the row records the folder it landed in');
  const landed = walk(box.projects)[0];
  assert.ok(landed.startsWith(filedIn), `the folder shown is the folder on disk — shown ${filedIn}, on disk ${landed}`);
  // An unnamed clip files by date. This is the ladder's answer, not anything the caller sent.
  assert.match(filedIn, /_unsorted/, `an unnamed clip files by date into _unsorted — got ${filedIn}`);
});

test('the original is still in the Compressed folder', { skip: !RUN }, async () => {
  // Organize COPIES. The one absolute that must survive every new filing entry point.
  assert.equal(existsSync(box.clip), true, 'his only other copy is untouched');
});

test('an _unsorted clip teaches the ledger NOTHING', { skip: !RUN }, async () => {
  // My first version asserted the opposite and failed — correctly. `recordLedgerEntries` has a
  // holding-pen rule: a dated `_unsorted` folder is not a project, so filing an unnamed clip there
  // must not create a ledger entry the app would later offer as a destination. The vm suite covers
  // the positive case with a NAMED clip; this is the negative one, and it is the case this screen
  // hits most often on his real store (4263 of 4594 clips have no name).
  const led = await read(app.win, `(async () => { const r = await window.api.ledgerGet(); const l = (r && r.projects) || r || []; return Array.isArray(l) ? l.length : 0; })()`);
  assert.equal(led, 0, `a holding pen is not a project — got ${led} ledger entries`);
});
