// FEATURES.md item 91 in the real app: Ctrl+K finds a clip that is NOT on the current screen.
//
// This is the assertion the vm tests structurally cannot make. The whole defect was that the palette
// searched `state.scannedFiles` — so the only convincing proof is a library with clips in it, a
// screen with none of them loaded, and a search that finds them anyway.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run, waitFor } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;

before(async () => {
  if (!RUN) return;
  // A library of clips that will never be on screen — nothing is scanned in this test.
  const drafts = {
    'GX010042.MP4__11__11': { subject: 'lawn-mowing', description: 'dennis-front-yard', tags: ['grass'], date: '2026-05-31' },
    'GX010043.MP4__12__12': { subject: 'curling', observation: 'action-curler-sweeping-brooms', date: '2026-01-24' },
    'VID_9001.mp4__13__13': { subject: 'misc', description: 'b-roll-corgi-puppies-play-inside-crate', date: '2026-01-13' },
  };
  app = await launchApp({
    seed: {
      'config.json': { firstRun: false },
      'drafts.json': drafts,
      'final-meta.json': { '2026-05-31_lawn-mowing_dennis_v1.mp4': { subject: 'lawn-mowing', category: 'Client Work', project: 'Gourgess Lawns' } },
    },
  });
});
after(async () => { if (app) await app.close(); });

const openPalette = async (q) => {
  await run(app.win, "if (cmdPaletteOpen) { document.querySelector('.cmdp-overlay').remove(); cmdPaletteOpen = false; } showCommandPalette();");
  await waitFor(app.win, "!!document.querySelector('.cmdp-input')", { what: 'the palette' });
  await run(app.win, `
    const i = document.querySelector('.cmdp-input');
    i.value = ${JSON.stringify(q)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
  `);
};

test('⚠⚠ nothing is loaded, and the palette still finds the clip', { skip: !RUN }, async () => {
  const loaded = await read(app.win, '(state.scannedFiles || []).length');
  assert.equal(loaded, 0, 'the premise: no clips on screen, so the old palette could find nothing');

  await openPalette('corgi');
  await waitFor(app.win, "[...document.querySelectorAll('.cmdp-hint')].some((e) => e.textContent === 'library')",
    { what: 'a library result to arrive', timeout: 10000 });

  const rows = await read(app.win, `[...document.querySelectorAll('.cmdp-item')].map((b) => ({
    label: b.querySelector('.cmdp-label').firstChild.textContent,
    sub: (b.querySelector('.cmdp-sub') || {}).textContent || '',
    hint: (b.querySelector('.cmdp-hint') || {}).textContent || '',
  }))`);
  const lib = rows.filter((r) => r.hint === 'library');
  assert.equal(lib.length, 1, `exactly the one clip — got ${JSON.stringify(rows)}`);
  assert.equal(lib[0].label, 'VID_9001.mp4', '⚠ and its filename is shown as it is on disk');
  assert.match(lib[0].sub, /corgi/, 'with what he wrote about it');
});

test('⚠ the group header states the scale, so the result can be trusted', { skip: !RUN }, async () => {
  const head = await read(app.win, "(document.querySelector('.cmdp-group') || {}).textContent || ''");
  assert.match(head, /In your library/, 'it names the group');
  // "1 of 4 clips" — the denominator is the whole library, which is the number that was missing.
  // (When results are TRUNCATED the header switches to "showing N of TOTAL (searched M clips)";
  // that branch is pinned in the vm tests, since forcing it here would need 26+ matching clips.)
  assert.match(head, /1 of 4 clips/, '⚠ it says how many records it actually looked at');
});

test('⚠⚠ a query that matches nothing says so, and says how much it searched', { skip: !RUN }, async () => {
  // The bound that makes the whole feature worth having: it must be able to say "no", and be
  // believed. A fuzzy matcher over a real library never can.
  await openPalette('zzzqqq');
  await waitFor(app.win, "/Nothing in your library/.test((document.querySelector('.cmdp-empty') || document.querySelector('.cmdp-group') || {}).textContent || '')",
    { what: 'the honest empty state', timeout: 10000 });
  const txt = await read(app.win, "(document.querySelector('.cmdp-empty') || {}).textContent || ''");
  assert.match(txt, /searched 4 clips/, '⚠ "nothing" comes with the evidence');
});

test('⚠ a filed clip is found and offers where it lives', { skip: !RUN }, async () => {
  await openPalette('gourgess');
  await waitFor(app.win, "[...document.querySelectorAll('.cmdp-hint')].some((e) => e.textContent === 'library')",
    { what: 'the filed clip', timeout: 10000 });
  const labels = await read(app.win, "[...document.querySelectorAll('.cmdp-item .cmdp-label')].map((e) => e.firstChild.textContent)");
  assert.ok(labels.includes('2026-05-31_lawn-mowing_dennis_v1.mp4'), `found by its PROJECT, not its name — got ${JSON.stringify(labels)}`);
});

test('⚠⚠ typing fast never leaves an older query’s results on screen', { skip: !RUN }, async () => {
  // The stale-write bug this codebase has had before. Fire three queries back to back and assert the
  // list matches the LAST one once things settle.
  await run(app.win, "if (cmdPaletteOpen) { document.querySelector('.cmdp-overlay').remove(); cmdPaletteOpen = false; } showCommandPalette();");
  await waitFor(app.win, "!!document.querySelector('.cmdp-input')", { what: 'the palette' });
  await run(app.win, `
    const i = document.querySelector('.cmdp-input');
    for (const q of ['corgi', 'curling', 'lawn']) {
      i.value = q;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  await waitFor(app.win, "[...document.querySelectorAll('.cmdp-hint')].some((e) => e.textContent === 'library')",
    { what: 'results for the final query', timeout: 10000 });
  // Give any slower in-flight query time to (wrongly) overwrite.
  await waitFor(app.win, "document.querySelector('.cmdp-input').value === 'lawn'", { what: 'the box to settle' });
  const labels = await read(app.win, "[...document.querySelectorAll('.cmdp-item')].filter((b) => (b.querySelector('.cmdp-hint') || {}).textContent === 'library').map((b) => b.querySelector('.cmdp-label').firstChild.textContent)");
  assert.ok(labels.length, 'there are library results');
  assert.ok(!labels.includes('VID_9001.mp4'), '⚠ none of them are the corgi clip from the first query');
  assert.ok(labels.includes('GX010042.MP4'), 'and they are the lawn ones');
});

test('closing the palette leaves nothing behind', { skip: !RUN }, async () => {
  await run(app.win, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
  await waitFor(app.win, "!document.querySelector('.cmdp-overlay')", { what: 'the palette to close' });
  const open = await read(app.win, 'cmdPaletteOpen');
  assert.equal(open, false, 'and the flag is reset, so Ctrl+K works again');
});
