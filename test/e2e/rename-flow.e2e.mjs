// The scan → rename flow, driven end-to-end, then blind renderer fixes asserted on the LIVE screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, scanFolder, read, run } from './harness.mjs';
import { ensureClipFixtures, CLIP_COUNT } from './fixtures.mjs';

// Opt-in: E2E needs the real app + a display. `npm run test:e2e` sets RUN_E2E=1; the fast suite skips.
const RUN = process.env.RUN_E2E === '1';

let app;
const clipsDir = RUN ? ensureClipFixtures() : null;
before(async () => { if (RUN) { app = await launchApp(); await scanFolder(app.app, app.win, clipsDir); } });
after(async () => { if (app) await app.close(); });

test('a real folder scan populates the rename screen with a card per clip', { skip: !RUN }, async () => {
  const n = await read(app.win, 'state.scannedFiles.length');
  assert.equal(n, CLIP_COUNT, 'every fixture clip became a clip in state');
  const cards = await app.win.locator('#renameList .rename-card').count();
  assert.equal(cards, CLIP_COUNT, 'a card rendered for each');
});

test('#51 — "next unnamed" walks the on-screen (day-grouped) order and skips named clips', { skip: !RUN }, async () => {
  // Name the clip at VISUAL position 0, focus it, jump — we must land on the next UNNAMED card in DOM
  // order, not wherever raw array order would send us.
  const r = await app.win.evaluate(async () => {
    const cards = [...document.querySelectorAll('#renameList .rename-card')];
    const first = cards[0]; const firstI = Number(first.dataset.i);
    // eslint-disable-next-line no-undef
    state.scannedFiles[firstI].subject = 'named-one';            // mark it renamed
    first.querySelector('.f-subject').value = 'named-one';
    first.querySelector('.f-subject').focus();                    // start ON the named card
    // eslint-disable-next-line no-undef
    jumpNextUnnamed();
    await new Promise((res) => setTimeout(res, 300));            // focusClip focuses on a 160ms timeout
    const active = document.activeElement.closest('.rename-card');
    return {
      firstI,
      landedI: Number(active.dataset.i),
      landedPos: cards.indexOf(active),
      // eslint-disable-next-line no-undef
      landedNamed: !!state.scannedFiles[Number(active.dataset.i)].subject,
    };
  });
  assert.equal(r.landedPos, 1, 'jumped to the very next card in VISUAL order');
  assert.equal(r.landedNamed, false, 'and it is an unnamed clip');
});

test('#74 — the live final-name updates on the SAME tick as a keystroke (debounce didn’t delay text)', { skip: !RUN }, async () => {
  // recomputeVersions was moved off the per-keystroke path; the risk is that the visible name lagged.
  // Type into a subject field and read the live [data-final] pill with NO wait — it must already show
  // the new text. (Only the de-dup version SUFFIX is allowed to lag, and there's no collision here.)
  const r = await app.win.evaluate(() => {
    const card = document.querySelector('#renameList .rename-card');
    const i = Number(card.dataset.i);
    const subj = card.querySelector('.f-subject');
    subj.value = 'sunrise-shoot';
    subj.dispatchEvent(new Event('input', { bubbles: true }));
    const pill = document.querySelector(`[data-final="${i}"]`);   // read synchronously, same tick
    return { pillText: pill ? pill.textContent : null };
  });
  assert.match(r.pillText || '', /sunrise-shoot/, 'the final-name preview reflected the keystroke immediately');
});

test('#1-r — Select-All respects the active filter (never selects hidden/finished clips)', { skip: !RUN }, async () => {
  // The data-clobber this guards: filter to "Unnamed", Select-All, Apply — the old code selected ALL
  // clips (incl. the finished ones you'd hidden) and overwrote their names. Select-All must reach only
  // clips that match the active filter.
  const r = await app.win.evaluate(() => {
    // Name the even-indexed clips; leave the odd ones unnamed. Clear all selections first.
    // eslint-disable-next-line no-undef
    state.scannedFiles.forEach((c, i) => { c.subject = (i % 2 === 0) ? `named-${i}` : ''; c.selected = false; });
    // eslint-disable-next-line no-undef, no-global-assign
    clipFilterText = '';
    // eslint-disable-next-line no-undef, no-global-assign
    clipFilterMode = 'unnamed';
    // eslint-disable-next-line no-undef
    selectAllClips(true);
    // eslint-disable-next-line no-undef
    const named = state.scannedFiles.filter((c) => c.subject);
    // eslint-disable-next-line no-undef
    const unnamed = state.scannedFiles.filter((c) => !c.subject);
    // eslint-disable-next-line no-undef, no-global-assign
    clipFilterMode = 'all';   // reset for any later work
    return {
      namedSelected: named.filter((c) => c.selected).length,
      unnamedSelected: unnamed.filter((c) => c.selected).length,
      unnamedTotal: unnamed.length,
    };
  });
  assert.equal(r.namedSelected, 0, 'Select-All under an "unnamed" filter selects NONE of the finished/named clips');
  assert.ok(r.unnamedTotal > 0 && r.unnamedSelected === r.unnamedTotal, 'every unnamed clip IS selected');
});

test('#34 — a large batch-apply drops an automatic restore point first (real applyBatch)', { skip: !RUN }, async () => {
  const r = await app.win.evaluate(async () => {
    // Wrap the app's real saveVersionPoint to count calls, without changing behaviour.
    // eslint-disable-next-line no-undef
    const orig = saveVersionPoint;
    let calls = 0; let lastLabel = '';
    // eslint-disable-next-line no-undef, no-global-assign
    saveVersionPoint = async (label, auto) => { calls += 1; lastLabel = label; return orig(label, auto); };
    // eslint-disable-next-line no-undef
    uiPrefs.autoVersionOnAi = true;
    // Select every scanned clip (8 fixtures ≥ the threshold), type a batch subject, apply.
    // eslint-disable-next-line no-undef
    state.scannedFiles.forEach((c) => { c.selected = true; });
    document.querySelectorAll('.clip-check').forEach((cb) => { cb.checked = true; });
    const subj = document.getElementById('batchSubject'); subj.value = 'family-trip';
    // eslint-disable-next-line no-undef
    const selCount = selectedClips().length;
    // eslint-disable-next-line no-undef
    await applyBatch();
    // eslint-disable-next-line no-undef, no-global-assign
    saveVersionPoint = orig;   // restore
    return { selCount, calls, lastLabel };
  });
  assert.ok(r.selCount >= 8, `precondition: ${r.selCount} clips selected (≥8)`);
  assert.equal(r.calls, 1, 'applyBatch saved exactly one restore point before mutating');
  assert.match(r.lastLabel, /batch apply/i, 'labelled as a batch-apply save point');
});
