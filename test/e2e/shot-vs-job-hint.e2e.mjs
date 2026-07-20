// FEATURES.md item 31 in the real app: type a shot-description into a subject field and the
// shot-vs-job note appears; type a real subject and it does not.
//
// The vm test proves the wiring is present; only the live app proves the note actually renders, on
// the right card, and clears when the name is corrected. The whole feature is a renderer surface for
// data main already had, so a structural test cannot see whether it reaches the screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, scanFolder, read, run, waitFor } from './harness.mjs';
import { ensureClipFixtures } from './fixtures.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
const clipsDir = RUN ? ensureClipFixtures() : null;
before(async () => { if (RUN) { app = await launchApp({ seed: { "config.json": { firstRun: false } } }); await scanFolder(app.app, app.win, clipsDir); } });
after(async () => { if (app) await app.close(); });

// Type into the first card's subject field and commit (blur fires `change`).
const typeSubject = (win, value) => run(win, `
  const inp = document.querySelector('#renameList .rename-card .f-subject');
  if (!inp) throw new Error('no subject field');
  inp.value = ${JSON.stringify(value)};
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
`);

const hintVisible = (win) => read(win, `(() => {
  const h = document.querySelector('#renameList .rename-card .subject-hint');
  return !!h && !h.hidden;
})()`);

test('⚠⚠ a shot description raises the note', { skip: !RUN }, async () => {
  await typeSubject(app.win, 'talking-head');
  await waitFor(app.win, `(() => {
    const h = document.querySelector('#renameList .rename-card .subject-hint');
    return !!h && !h.hidden;
  })()`, { what: 'the shot-vs-job note to appear', timeout: 8000 });
  const txt = await read(app.win, "document.querySelector('#renameList .rename-card .subject-hint .shot-tx').textContent");
  assert.match(txt, /on screen/, 'it says the name describes the shot');
  assert.match(txt, /Filing groups clips by subject/, 'and why that blocks filing');
});

test('⚠⚠ a REAL subject clears the note', { skip: !RUN }, async () => {
  // The bound. If it stayed up for "lawn-mowing" it would be noise, and he would learn to ignore it.
  await typeSubject(app.win, 'lawn-mowing');
  await waitFor(app.win, `(() => {
    const h = document.querySelector('#renameList .rename-card .subject-hint');
    return !h || h.hidden;
  })()`, { what: 'the note to clear for a real subject', timeout: 8000 });
  assert.equal(await hintVisible(app.win), false, 'gone');
});

test('⚠ dismissing it keeps it dismissed for that spelling', { skip: !RUN }, async () => {
  await typeSubject(app.win, 'person-sitting-couch');
  await waitFor(app.win, `(() => {
    const h = document.querySelector('#renameList .rename-card .subject-hint');
    return !!h && !h.hidden;
  })()`, { what: 'the note', timeout: 8000 });
  await run(app.win, "document.querySelector('#renameList .rename-card .subject-hint .shot-x').click();");
  assert.equal(await hintVisible(app.win), false, 'clicking × hides it');
  // Re-commit the SAME spelling — it must stay quiet.
  await typeSubject(app.win, 'person-sitting-couch');
  // Give the async round-trip a moment; the assertion is that it does NOT reappear.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await hintVisible(app.win), false, '⚠ re-typing the dismissed spelling stays quiet');
});

test('⚠ the note never blocks — it raises NO dialog of its own', { skip: !RUN }, async () => {
  // It is advisory. A shot name is common (nearly half his clips), so it must never interrupt.
  // (There may already be an unrelated modal on screen — the "name as a batch?" scan prompt — so the
  // assertion is that typing a shot name adds NONE, not that none exist.)
  const before = await read(app.win, "document.querySelectorAll('.modal-overlay').length");
  await typeSubject(app.win, 'vlog-young-man');
  await waitFor(app.win, `(() => {
    const h = document.querySelector('#renameList .rename-card .subject-hint');
    return !!h && !h.hidden;
  })()`, { what: 'the note', timeout: 8000 });
  const after = await read(app.win, "document.querySelectorAll('.modal-overlay').length");
  assert.equal(after, before, '⚠ no NEW dialog — the note sits inline and the field keeps focus');
});
