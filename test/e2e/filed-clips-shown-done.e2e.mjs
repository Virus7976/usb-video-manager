// The UI half of "what's left": a filed clip must LOOK finished and must not be re-armed.
//
// Filing copies, so his clips stay in the Compressed folder and this list shows them again. Without a
// visible difference, completed work is indistinguishable from work still to do — and "Select all →
// Run" would re-file everything he already did. The scan now reports `filed`/`filedIn` from the
// project ledger; this is the part he actually sees.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// One clip already filed into `vlog`, one still to do.
async function seedList(win) {
  await run(win, `
    finScan = { dir: 'L:\\\\Compressed', files: [
      { name: 'DONE.MP4', size: 10, matched: true, matchType: 'saved', filed: true, filedIn: 'vlog',
        meta: { subject: 'vlog', date: '2026-03-14' } },
      { name: 'TODO.MP4', size: 10, matched: true, matchType: 'saved', filed: false, filedIn: '',
        meta: { subject: 'vlog', date: '2026-03-14' } },
    ] };
    finQuery = '';
    uiPrefs.finMatchedOnly = false;
    finRenderList();
  `);
}

test('a filed clip is not armed for another run', { skip: !RUN }, async () => {
  // The one that matters: the obvious next action must only touch what is left.
  await seedList(app.win);
  const done = await read(app.win, `finScan.files.find((f) => f.name === 'DONE.MP4').selected === true`);
  assert.equal(done, false, 'the finished clip starts unticked');
});

test('the clip still to do IS armed', { skip: !RUN }, async () => {
  await seedList(app.win);
  const todo = await read(app.win, `finScan.files.find((f) => f.name === 'TODO.MP4').selected === true`);
  assert.equal(todo, true, 'the remaining work is ready to go');
});

test('the row says it is filed, and where', { skip: !RUN }, async () => {
  await seedList(app.win);
  // Bind to the BADGE, not to the row text: "vlog" also appears in the metadata chips and other
  // words in the row match /filed/i loosely, so suppressing the badge entirely left a looser
  // assertion green.
  const badge = await read(app.win, `(document.querySelector('#finList .fin-item .fin-src-badge.done') || {}).textContent || ''`);
  assert.match(String(badge), /filed/i, `the finished clip carries a filed badge — got: ${badge}`);
  assert.match(String(badge), /vlog/, 'and the badge names the project it went into');
});

test('the summary counts done vs left', { skip: !RUN }, async () => {
  // The counter that must never lie — this is the number he watches shrink.
  await seedList(app.win);
  const line = await read(app.win, `document.getElementById('finSummaryLine').textContent`);
  assert.match(String(line), /1 already filed/, `says how many are done — got: ${line}`);
  assert.match(String(line), /1 left/, 'and how many remain');
});

test('a filed clip can still be re-selected by hand', { skip: !RUN }, async () => {
  // Not armed by default is not the same as forbidden — he may re-file after renaming.
  await seedList(app.win);
  await run(app.win, `
    const rows = Array.from(document.querySelectorAll('#finList .fin-item'));
    const row = rows.find((li) => li.textContent.indexOf('DONE.MP4') >= 0);
    row.querySelector('.fin-check').click();
  `);
  const done = await read(app.win, `finScan.files.find((f) => f.name === 'DONE.MP4').selected === true`);
  assert.equal(done, true, 'he can still choose to re-file it');
});

test('with nothing filed the summary stays quiet', { skip: !RUN }, async () => {
  // Guard the other direction: no "0 already filed" noise on a fresh folder.
  await run(app.win, `
    finScan = { dir: 'L:\\\\Compressed', files: [
      { name: 'A.MP4', size: 10, matched: true, matchType: 'saved', filed: false, meta: { subject: 'vlog' } },
    ] };
    finRenderList();
  `);
  const line = await read(app.win, `document.getElementById('finSummaryLine').textContent`);
  assert.doesNotMatch(String(line), /already filed/, `no stray counter — got: ${line}`);
});
