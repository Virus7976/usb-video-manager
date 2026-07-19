// TIER 1: the Organize screen never used the Projects folder he had already configured.
//
// `finEffectiveDest()` is `finDestMode === 'custom' ? finCustomDest : finScan.dir`, and the screen
// opens with `finDestMode = 'inplace'` — so the DEFAULT destination is **the folder the clips are
// already in**. With his `folderLevels` of [category, project] mostly empty, that produces no
// subfolders at all, `organizeMove` reports "in-place", and a Run that looked like it worked filed
// nothing. main-mod's own comment describes exactly this: *"the file was already sitting in the
// destination, so organizeMove said 'in-place' and Run reported '0 moved' while looking like it had
// worked."*
//
// Meanwhile his config has had `projectsRoot: C:\Users\jakeg\Videos\02 - Projects\2026` all along —
// and this screen never read it. A previous session already diagnosed the empty-projectsRoot version
// of this ("there was literally nowhere to file anything, which is the real reason organizing
// sucks"), fixed the config, and the screen still ignored it.
//
// So: when he has a Projects root and has not chosen otherwise, the screen opens pointed AT it. That
// is toolness item 66 ("stop asking questions the app can answer") and 77 ("match his real tree").
//
// SCOPE, deliberately narrow: this changes a DEFAULT, not a meaning. "Organize in place" still means
// in place; it is simply no longer the pre-selection when a better answer is known. Filing remains a
// COPY by default, the free-space preflight still runs, and the Run confirmation still states the
// destination — so he sees where it is going before anything moves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// Open the Organize screen the way the app does, with a given config.
async function openWith(win, { projectsRoot, organizeDest }) {
  // finScan is set AFTER openFinalize: the open path rebuilds it, so seeding it first is simply
  // discarded — my first version did that and every case read back an empty destination.
  await run(win, `
    cfg.projectsRoot = ${JSON.stringify(projectsRoot)};
    organizeDest = ${JSON.stringify(organizeDest)};
    openFinalize();
  `);
  await run(win, `finScan = finScan || {}; finScan.dir = 'L:\\\\Compression\\\\02 - Compressed'; finScan.files = finScan.files || [];`);
}

test('it opens pointed at his Projects folder, not at the Compressed folder', { skip: !RUN }, async () => {
  await openWith(app.win, { projectsRoot: 'C:\\Projects\\2026', organizeDest: '' });
  const dest = await read(app.win, `finEffectiveDest()`);
  assert.equal(dest, 'C:\\Projects\\2026', 'the destination is his real Projects tree');
});

test('a destination he has explicitly set still wins', { skip: !RUN }, async () => {
  // His own choice outranks the inferred default — always.
  await openWith(app.win, { projectsRoot: 'C:\\Projects\\2026', organizeDest: 'D:\\Elsewhere' });
  const dest = await read(app.win, `finEffectiveDest()`);
  assert.equal(dest, 'D:\\Elsewhere', 'the saved destination is used');
});

test('with NO projects root it still behaves as before', { skip: !RUN }, async () => {
  // Guard the other direction: nothing is invented when there is no better answer.
  await openWith(app.win, { projectsRoot: '', organizeDest: '' });
  const dest = await read(app.win, `finEffectiveDest()`);
  assert.equal(dest, 'L:\\Compression\\02 - Compressed', 'falls back to in-place, exactly as it did');
});

test('the radio reflects where files will actually go', { skip: !RUN }, async () => {
  // The screen must not say "in place" while filing to C:. If the destination is elsewhere, the
  // "separate folder" mode is the one selected, and the path field shows it.
  await openWith(app.win, { projectsRoot: 'C:\\Projects\\2026', organizeDest: '' });
  const mode = await read(app.win, `finDestMode`);
  assert.equal(mode, 'custom', 'the separate-folder mode is selected');
  const checked = await read(app.win, `document.querySelector('input[name="finDestMode"][value="custom"]').checked === true`);
  assert.equal(checked, true, 'and the radio agrees with the state');
  const shown = await read(app.win, `document.getElementById('finDestPath').value`);
  assert.equal(shown, 'C:\\Projects\\2026', 'the path field shows the real destination');
});

test('he can still switch back to organizing in place', { skip: !RUN }, async () => {
  // A default, not a lock.
  await openWith(app.win, { projectsRoot: 'C:\\Projects\\2026', organizeDest: '' });
  await run(app.win, `
    const r = document.querySelector('input[name="finDestMode"][value="inplace"]');
    r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  const dest = await read(app.win, `finEffectiveDest()`);
  assert.equal(dest, 'L:\\Compression\\02 - Compressed', 'in place still means in place');
});
