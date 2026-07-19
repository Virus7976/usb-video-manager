// Proves the E2E harness itself: the real app launches, the renderer's internals are reachable from a
// test, and a previously "inspection-only" renderer fix (#90 modal dialog semantics) can now be
// asserted against the LIVE DOM. If this file is green, renderer changes are no longer blind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

// E2E launches the real Electron app (needs a display) — opt-in so the fast vm suite (`npm test`)
// never drags it in even if node --test globs this file. `npm run test:e2e` sets RUN_E2E=1.
const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp(); });
after(async () => { if (app) await app.close(); });

test('the real app boots to the home screen', { skip: !RUN }, async () => {
  const title = await app.win.title();
  assert.match(title, /USB|SD/i);
  assert.equal(await app.win.isVisible('#manualPickBtn'), true, 'the "Choose drive…" button is present');
});

test('a test can read the renderer’s own state and call its functions (no mocks)', { skip: !RUN }, async () => {
  // This is the whole point: `state`, `uiPrefs`, `jumpNextUnnamed` are the renderer's real top-level
  // bindings, referenced directly from page eval — so assertions are on the actual thing under test.
  assert.equal(await read(app.win, 'typeof state'), 'object');
  assert.equal(await read(app.win, 'Array.isArray(state.scannedFiles)'), true);
  assert.equal(await read(app.win, 'typeof jumpNextUnnamed'), 'function');
  assert.equal(await read(app.win, 'typeof uiPrefs'), 'object');
});

test('#90 — every modal is stamped role="dialog"/aria-modal for screen readers (LIVE DOM)', { skip: !RUN }, async () => {
  // Open one of the app's real modals and let the MutationObserver stamp it, then read the live DOM.
  await run(app.win, "confirmDialog('E2E dialog', 'body', 'OK', 'Cancel');");
  await app.win.waitForSelector('.modal-overlay .modal-card', { timeout: 5000 });
  const card = app.win.locator('.modal-overlay .modal-card').first();
  assert.equal(await card.getAttribute('role'), 'dialog', 'observer stamped role=dialog');
  assert.equal(await card.getAttribute('aria-modal'), 'true', 'observer stamped aria-modal');
  // Tear down via the DOM, not a click — a stray overlay can intercept pointer events and flake.
  await run(app.win, "document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());");
});
