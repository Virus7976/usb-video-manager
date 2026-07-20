// TIER 2 #19 — make the naming work FRONT-LOADABLE, measured against his real library.
//
// First, what already exists, because the backlog item was written without checking and ~1 in 3 such
// entries turn out to be built: the rename screen ALREADY groups by day and ALREADY offers
// "Select all" on each day divider (`selectDay`). Naming a whole shoot at once is a solved problem.
//
// What is NOT solved is WHICH shoot to do first. Days are laid out newest-first, and his unnamed
// clips break down like this:
//
//     4263 unnamed across 410 distinct days      median day: 4 clips
//     top  20 days →  30% of the unnamed
//     top  50 days →  52%
//     top 100 days →  73%
//
// So fifty decisions covers HALF his library — but those fifty days are scattered through 410,
// interleaved with days holding four clips each. Newest-first buries the wins.
//
// "Biggest shoots first" is therefore not a preference, it is the difference between a marathon and
// an afternoon. It is also the diagnosis's second rule made concrete: *payoff must move earlier*.
//
// Newest-first stays the DEFAULT — recent footage is what he usually came for, and changing that
// silently would be its own surprise. This is an option he can turn on when facing a backlog.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// Three days: an old BIG shoot, a recent tiny one, and a middling one.
async function seedClips(win) {
  await run(win, `
    state.scannedFiles = [];
    const add = (date, n) => { for (let i = 0; i < n; i += 1) state.scannedFiles.push({
      name: date + '_' + i + '.MP4', size: 10, mtimeMs: 1, date, subject: '', description: '',
      sourcePath: 'C:\\\\C\\\\' + date + '_' + i + '.MP4', selected: false }); };
    add('2024-01-05', 6);
    add('2026-07-11', 1);
    add('2025-03-02', 3);
    uiPrefs.dayDividers = true;
  `);
}
const dayOrder = (win) => read(win, `Array.from(document.querySelectorAll('#step1 .day-divider .day-divider-label')).map((e) => e.textContent)`);

test('by default the newest day is still first', { skip: !RUN }, async () => {
  // Guard the other direction FIRST: recent footage is usually what he came for.
  await seedClips(app.win);
  await run(app.win, `uiPrefs.dayBiggestFirst = false; buildRenameStep();`);
  const days = await dayOrder(app.win);
  assert.deepEqual(days, ['2026-07-11', '2025-03-02', '2024-01-05'], 'newest first, unchanged');
});

test('biggest-first puts the largest shoot at the top', { skip: !RUN }, async () => {
  await seedClips(app.win);
  await run(app.win, `uiPrefs.dayBiggestFirst = true; buildRenameStep();`);
  const days = await dayOrder(app.win);
  assert.deepEqual(days, ['2024-01-05', '2025-03-02', '2026-07-11'], 'most clips first, regardless of date');
});

test('every clip is still present, just reordered', { skip: !RUN }, async () => {
  // Reordering must never drop a clip — the cards carry their ORIGINAL indices, and losing one would
  // silently exclude footage from naming.
  await seedClips(app.win);
  await run(app.win, `uiPrefs.dayBiggestFirst = true; buildRenameStep();`);
  const cards = await read(app.win, `document.querySelectorAll('#step1 .rename-card').length`);
  assert.equal(cards, 10, 'all ten clips are on screen');
});

test('the card indices still match the real clips', { skip: !RUN }, async () => {
  // data-i is the index into state.scannedFiles; every per-row handler depends on it. A reorder that
  // renumbered them would edit the wrong clip — the worst possible outcome for a naming screen.
  await seedClips(app.win);
  await run(app.win, `uiPrefs.dayBiggestFirst = true; buildRenameStep();`);
  const ok = await read(app.win, `(() => {
    const cards = Array.from(document.querySelectorAll('#step1 .rename-card'));
    return cards.every((c) => {
      const i = Number(c.dataset.i);
      const clip = state.scannedFiles[i];
      return !!clip && c.textContent.indexOf(clip.name) >= 0;
    });
  })()`);
  assert.equal(ok, true, 'each card points at the clip it displays');
});

test('a day with no date sorts last either way', { skip: !RUN }, async () => {
  // Undated clips are the least useful to name in bulk; they must not lead the list.
  await seedClips(app.win);
  await run(app.win, `
    for (let i = 0; i < 4; i += 1) state.scannedFiles.push({ name: 'nodate' + i + '.MP4', size: 10, mtimeMs: 1,
      date: '', subject: '', description: '', sourcePath: 'C:\\\\C\\\\nodate' + i + '.MP4', selected: false });
    uiPrefs.dayBiggestFirst = true; buildRenameStep();
  `);
  const days = await dayOrder(app.win);
  assert.equal(days[days.length - 1], 'No date', `undated last — got ${JSON.stringify(days)}`);
});

test('the option is a real preference, offered in the menu', { skip: !RUN }, async () => {
  // A feature only reachable by editing a variable is not a feature. My first version of this test
  // referenced a `buildViewMenu` that does not exist, so the read threw — check the two things that
  // actually matter instead: the pref is real, and the menu offers it.
  const known = await read(app.win, `Object.prototype.hasOwnProperty.call(uiPrefs, 'dayBiggestFirst')`);
  assert.equal(known, true, 'it is a real, persisted preference');

  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const menus = readFileSync(join(process.cwd(), 'src', 'mod', '06-menus.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(menus, /Biggest shoots first/, 'the menu offers it');
  assert.match(menus, /togglePref\('dayBiggestFirst'\)/, 'and toggling it rebuilds the list');
});
