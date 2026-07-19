// Follow-up to making unnamed clips fileable: the LIST has to catch up with the new capability.
//
// Before, an unmatched clip (one the AI never described) was rendered deliberately inert — a
// `fin-check-spacer` where the checkbox would be, and a "no metadata" badge — because it genuinely
// could not be filed. Now that it can be, that row is wrong in three ways at once:
//
//  1. **No checkbox**, so he cannot untick it — while `finRenderList` defaults every clip returned by
//     `finMatched()` to `selected = true`. On his store that is 4263 clips silently armed for a run
//     with no way to deselect them individually. One click would sweep his whole library into
//     `_unsorted`. **A capability without a control is worse than no capability.**
//  2. **The badge says "no metadata"**, which reads as an error state — the row looks broken rather
//     than actionable.
//  3. **The summary line counts them as matched** once finMatched() returns everything, so it would
//     claim "4594 with metadata" when 331 have any.
//
// Fixed by: giving unmatched rows a real checkbox, defaulting them to UNSELECTED (he opts in — the
// named clips he has already worked on stay the default action), an honest badge that says where the
// clip will go, and a summary that counts the two groups separately.
//
// Driven through the real renderer: what matters is the DOM he actually clicks, and the vm harness
// cannot see it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// One named clip and one the AI never reached — his real mix, in miniature.
async function seedList(win) {
  await run(win, `
    finScan = { dir: 'C:\\\\Compressed', files: [
      { name: 'NAMED.MP4',   size: 100, matched: true,  matchType: 'saved',
        meta: { subject: 'mowing', description: 'front lawn', date: '2026-03-14' } },
      { name: 'UNNAMED.MP4', size: 200, matched: false, matchType: null, meta: null },
    ] };
    finQuery = '';
    uiPrefs.finMatchedOnly = false;
    finRenderList();
  `);
}

test('an unnamed clip can be ticked — it is no longer inert', { skip: !RUN }, async () => {
  await seedList(app.win);
  const boxes = await read(app.win, `document.querySelectorAll('#finList .fin-item.fin-unmatched .fin-check').length`);
  assert.equal(boxes, 1, 'the unmatched row has a real checkbox');
});

test('unnamed clips are NOT armed by default', { skip: !RUN }, async () => {
  // The safety property. 4263 clips selected-by-default with one Run button is a library-wide move he
  // never asked for; he opts in instead.
  await seedList(app.win);
  const sel = await read(app.win, `finScan.files.find((f) => f.name === 'UNNAMED.MP4').selected === true`);
  assert.equal(sel, false, 'the unnamed clip starts unticked');
});

test('named clips still default to selected', { skip: !RUN }, async () => {
  // Guard the other direction: the work he has already done stays the default action.
  await seedList(app.win);
  const sel = await read(app.win, `finScan.files.find((f) => f.name === 'NAMED.MP4').selected === true`);
  assert.equal(sel, true, 'the named clip is still ticked for him');
});

test('ticking an unnamed clip actually selects it', { skip: !RUN }, async () => {
  await seedList(app.win);
  await run(app.win, `document.querySelector('#finList .fin-item.fin-unmatched .fin-check').click();`);
  const sel = await read(app.win, `finScan.files.find((f) => f.name === 'UNNAMED.MP4').selected === true`);
  assert.equal(sel, true, 'his tick reaches the model, so Run will include it');
});

test('the row says where the clip will GO, not that it is broken', { skip: !RUN }, async () => {
  // "no metadata" reads as an error. It is not an error — it is a clip that will file by date.
  await seedList(app.win);
  const txt = await read(app.win, `document.querySelector('#finList .fin-item.fin-unmatched').textContent`);
  assert.match(String(txt), /date|unsorted/i, `the badge explains the destination — got: ${txt}`);
});

test('the summary does not claim unnamed clips have metadata', { skip: !RUN }, async () => {
  await seedList(app.win);
  const line = await read(app.win, `document.getElementById('finSummaryLine').textContent`);
  assert.match(String(line), /1 with metadata|1 named/i, `exactly one clip has metadata — got: ${line}`);
  assert.doesNotMatch(String(line), /2 with metadata/, 'it must not count the unnamed one as described');
});
