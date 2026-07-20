// FEATURES.md item 28, driven against the REAL app: forgetting a remembered field value.
//
// `fieldHistory:remove` had a handler and a bridge method and no caller, so every value he had ever
// typed into a custom organizing field — including every typo — was offered back to him forever.
//
// The source tests pin the wiring. This one exists because the fix is a click target INSIDE another
// click target: the × sits within the suggestion row's own <button>, whose mousedown fills the input.
// That interaction cannot be verified by reading code — the assertion that matters is that clicking
// the × does NOT type the value it just deleted into the field, and only a real browser can say.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => {
  if (!RUN) return;
  // Seed the history through the store rather than by typing: this test is about removal.
  app = await launchApp({ seed: { 'config.json': { fieldHistory: { category: ['promo', 'pormo', 'wedding'] } } } });
});
after(async () => { if (app) await app.close(); });

// Build a throwaway field combo on the live page and open its dropdown.
const openFieldCombo = (win) => win.evaluate(async () => {
  document.querySelectorAll('#e2eForget').forEach((n) => n.remove());
  const host = document.createElement('div');
  host.id = 'e2eForget';
  const input = document.createElement('input');
  host.appendChild(input);
  document.body.appendChild(host);
  // eslint-disable-next-line no-undef
  await refreshFields();               // load fieldHistoryCache from the seeded store
  // eslint-disable-next-line no-undef
  attachFieldCombo(input, 'category');
  input.focus();
  await new Promise((r) => setTimeout(r, 50));
  const rows = [...document.querySelectorAll('.subject-combo .flyout-item')];
  return { values: rows.map((r) => r.dataset.value), hasForget: rows.every((r) => !!r.querySelector('.flyout-forget')) };
});

test('the dropdown offers every remembered value, each with a way to forget it', { skip: !RUN }, async () => {
  const r = await openFieldCombo(app.win);
  assert.deepEqual(r.values.sort(), ['pormo', 'promo', 'wedding'], 'the seeded history is offered');
  assert.equal(r.hasForget, true, 'and every row carries a × — the control that did not exist');
});

test('⚠⚠ clicking × forgets the value WITHOUT typing it into the field', { skip: !RUN }, async () => {
  // The whole point. The × is a child of the row button; without stopPropagation the row's own
  // mousedown fires too and fills the input with the very typo being deleted.
  await openFieldCombo(app.win);
  const r = await app.win.evaluate(async () => {
    const row = [...document.querySelectorAll('.subject-combo .flyout-item')].find((x) => x.dataset.value === 'pormo');
    const input = document.querySelector('#e2eForget input');
    row.querySelector('.flyout-forget').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 250));
    // eslint-disable-next-line no-undef
    return { typed: input.value, saved: await window.api.getFieldHistory() };
  });
  assert.equal(r.typed, '', '⚠ the field is still empty — the row handler never ran');
  assert.deepEqual(r.saved.category.sort(), ['promo', 'wedding'], '⚠ and the typo is gone from the store');
});

test('⚠ it is gone from the next dropdown too, not just from disk', { skip: !RUN }, async () => {
  // The local cache and the store drifting apart would mean the typo kept reappearing until restart,
  // which reads as the removal not working at all.
  const r = await app.win.evaluate(async () => {
    const input = document.querySelector('#e2eForget input');
    input.blur();
    input.focus();
    await new Promise((res) => setTimeout(res, 50));
    return [...document.querySelectorAll('.subject-combo .flyout-item')].map((x) => x.dataset.value);
  });
  assert.deepEqual(r.sort(), ['promo', 'wedding'], 'the reopened list matches the store');
});

test('⚠⚠ Undo really puts it back', { skip: !RUN }, async () => {
  // No confirmation was added deliberately — this is the thing that makes that the right call, so it
  // is asserted against the real toast, not against the source.
  const r = await app.win.evaluate(async () => {
    const btn = document.querySelector('.app-toast .toast-action');
    if (!btn) return { noToast: true };
    const label = btn.textContent;
    btn.click();
    await new Promise((res) => setTimeout(res, 300));
    // eslint-disable-next-line no-undef
    return { label, saved: await window.api.getFieldHistory() };
  });
  assert.equal(r.noToast, undefined, 'the toast offering Undo is still on screen');
  assert.equal(r.label, 'Undo', 'and its action says Undo');
  assert.deepEqual(r.saved.category.sort(), ['pormo', 'promo', 'wedding'], '⚠ the value came back');
});

test('⚠ the × does not appear on subject/description combos', { skip: !RUN }, async () => {
  // Those lists include values from clips in the CURRENT session, where "forget" has no meaning, and
  // they have their own management screens. Offering a delete there would be a lie.
  const r = await app.win.evaluate(async () => {
    // ⚠ Tear the previous combo down FIRST. Without this the earlier flyout is still mounted on
    // <body> and `.subject-combo .flyout-item` matched ITS rows — the test failed against correct
    // code and looked like a leak of the × into subject combos.
    document.querySelectorAll('#e2eForget, #e2eForget2').forEach((n) => n.remove());
    // eslint-disable-next-line no-undef
    closePopover();
    const host = document.createElement('div');
    host.id = 'e2eForget2';
    const input = document.createElement('input');
    host.appendChild(input);
    document.body.appendChild(host);
    // eslint-disable-next-line no-undef
    await refreshSubjectOptions();
    // eslint-disable-next-line no-undef
    attachSubjectCombo(input);
    input.focus();
    await new Promise((res) => setTimeout(res, 50));
    const rows = [...document.querySelectorAll('.subject-combo .flyout-item')];
    return { rows: rows.length, forgets: rows.filter((x) => x.querySelector('.flyout-forget')).length };
  });
  assert.equal(r.forgets, 0, '⚠ no × on a subject suggestion');
});
