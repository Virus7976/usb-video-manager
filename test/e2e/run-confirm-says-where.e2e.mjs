// TIER 1 #8 — say where the clips will actually GO, before he commits.
//
// The Run confirmation describes one destination: `Files move into <dest>\category\project\…`. That
// was true when only described clips could be filed. Now that an unnamed clip files to
// `<date>/_unsorted` (2026-07-19bj), a mixed selection has TWO destinations and the dialog mentions
// one — so the sentence he reads before pressing Run understates what the run will do.
//
// This matters more than a wording nit because of what changed around it: unnamed clips became
// fileable AND selectable in the same session. The first time he ticks a few hundred of them, the
// confirmation is the only place the app can tell him they are going somewhere different. If it
// stays silent there, he finds out by looking at his Projects tree afterwards — which is exactly the
// "I have to re-check its work" failure the whole toolness effort is aimed at.
//
// Driven through the real DOM: `confirmDialog` is a function declaration in the shared bundle scope,
// so a test can replace it, capture the exact sentence, and answer "Cancel" — asserting on the words
// he actually reads without running anything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// Capture what the confirm dialog is asked to say, and always answer Cancel so no filing happens.
async function armDialogCapture(win) {
  await run(win, `
    window.__confirmSeen = [];
    confirmDialog = function (title, body) {
      window.__confirmSeen.push({ title: String(title || ''), body: String(body || '') });
      return Promise.resolve(false);
    };
  `);
}

// `named` described clips + `plain` clips the AI never reached, all ticked.
async function seedSelection(win, { named, plain }) {
  await run(win, `
    const files = [];
    for (let i = 0; i < ${named}; i += 1) files.push({ name: 'NAMED' + i + '.MP4', size: 10, sourcePath: 'C:\\\\C\\\\NAMED' + i + '.MP4',
      matched: true, matchType: 'saved', selected: true, meta: { subject: 'mowing', date: '2026-03-14' } });
    for (let i = 0; i < ${plain}; i += 1) files.push({ name: 'PLAIN' + i + '.MP4', size: 10, sourcePath: 'C:\\\\C\\\\PLAIN' + i + '.MP4',
      matched: false, matchType: null, selected: true, meta: null });
    finScan = { dir: 'C:\\\\Compressed', files };
    organizeDest = 'C:\\\\Projects';
    finDestMode = 'default';
    document.getElementById('finOrganize').checked = true;
    document.getElementById('finEmbed').checked = false;
    document.getElementById('finCsv').checked = false;
    document.getElementById('finNas').checked = false;
  `);
}

const lastBody = (win) => read(win, `(window.__confirmSeen.slice(-1)[0] || {}).body || ''`);

test('a mixed run says how many clips will file by date', { skip: !RUN }, async () => {
  await armDialogCapture(app.win);
  await seedSelection(app.win, { named: 3, plain: 7 });
  await run(app.win, `document.getElementById('finRunBtn').click();`);
  const body = await lastBody(app.win);
  assert.match(String(body), /7/, `the count of unnamed clips appears — got: ${body}`);
  assert.match(String(body), /date|unsorted/i, `and where they go — got: ${body}`);
});

test('an all-named run does NOT mention _unsorted', { skip: !RUN }, async () => {
  // Guard the other direction: the ordinary case must not gain a confusing extra sentence.
  await armDialogCapture(app.win);
  await seedSelection(app.win, { named: 4, plain: 0 });
  await run(app.win, `document.getElementById('finRunBtn').click();`);
  const body = await lastBody(app.win);
  assert.doesNotMatch(String(body), /unsorted/i, `no stray warning — got: ${body}`);
});

test('the existing destination sentence survives', { skip: !RUN }, async () => {
  // This must ADD to the confirmation, not replace what it already told him.
  await armDialogCapture(app.win);
  await seedSelection(app.win, { named: 2, plain: 2 });
  await run(app.win, `document.getElementById('finRunBtn').click();`);
  const body = await lastBody(app.win);
  // Not asserting a specific path: finEffectiveDest resolves from the dest MODE, and this fixture
  // lands on the scan dir. What matters is that the destination sentence is still there.
  assert.match(String(body), /Files move into/, 'it still names where files go');
  assert.match(String(body), /Re-running is safe/, 'and still says re-running is safe');
});

test('the count is of SELECTED unnamed clips, not all of them', { skip: !RUN }, async () => {
  // He unticks most of them; the sentence must describe the run he is about to make.
  await armDialogCapture(app.win);
  await seedSelection(app.win, { named: 1, plain: 5 });
  await run(app.win, `finScan.files.filter((f) => !f.matched).slice(2).forEach((f) => { f.selected = false; });`);
  await run(app.win, `document.getElementById('finRunBtn').click();`);
  const body = await lastBody(app.win);
  assert.match(String(body), /\b2\b/, `only the 2 still ticked are counted — got: ${body}`);
});

test('cancelling really does cancel', { skip: !RUN }, async () => {
  // The capture answers false; nothing should have run.
  await armDialogCapture(app.win);
  await seedSelection(app.win, { named: 1, plain: 1 });
  await run(app.win, `document.getElementById('finRunBtn').click();`);
  const disabled = await read(app.win, `document.getElementById('finRunBtn').disabled === true`);
  assert.equal(disabled, false, 'the run never started');
});
