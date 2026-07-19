// Audit #50 — the clip filter's "X of total" counted only the cards the windowed grid had already
// rendered.
//
// The rename list renders in 100-clip chunks. `applyClipFilter` tallied `shown` by walking
// `.rename-card` elements, so on a 3000-clip card a filter matching 50 clips reported "2 of 3000" —
// whatever happened to be in the DOM. That is actively misleading: it tells Jake his search found
// almost nothing when it found plenty, which is exactly the kind of thing that makes him distrust
// the tool and check everything by hand (PROMPT.md §1).
//
// The count must come from STATE, which knows about every clip, not from the DOM, which knows about
// the ones that have scrolled into view.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// Put clips in state WITHOUT rendering any cards — the extreme form of the bug, and the honest test:
// the count must describe the data, not the DOM.
const seedClips = (subjects) => run(app.win, `
  state.scannedFiles = ${JSON.stringify(subjects.map((s, i) => ({ name: `clip${i}.mp4`, size: 100 + i, sourcePath: `/x/clip${i}.mp4`, subject: s })))};
  clipFilterText = '';
  clipFilterMode = 'all';
`);

const filterCount = async (text) => {
  await run(app.win, `
    clipFilterText = ${JSON.stringify(text)};
    if (!document.getElementById('clipFilterCount')) {
      const el = document.createElement('span'); el.id = 'clipFilterCount'; document.body.appendChild(el);
    }
    applyClipFilter();
  `);
  return read(app.win, "document.getElementById('clipFilterCount').textContent");
};

test('#50 the count reflects every matching clip, not just the rendered ones', { skip: !RUN }, async () => {
  await seedClips(['skiing', 'skiing', 'lawn mowing', 'skiing', 'wedding']);
  // No cards are rendered at all, so the old DOM-based tally would have said "0 of 5".
  assert.equal(await filterCount('ski'), '3 of 5', 'all three matches are counted');
});

test('#50 a filter that matches nothing says so honestly', { skip: !RUN }, async () => {
  await seedClips(['skiing', 'lawn mowing']);
  assert.equal(await filterCount('helicopter'), '0 of 2');
});

test('#50 the total is every clip, not the rendered subset', { skip: !RUN }, async () => {
  // 250 clips = more than two 100-clip chunks, so the DOM could never hold them all up front.
  await seedClips(Array.from({ length: 250 }, (_, i) => (i % 5 === 0 ? 'skiing' : 'lawn')));
  assert.equal(await filterCount('ski'), '50 of 250', 'a match deep past the render window is counted');
});

test('#50 no filter and no mode shows no count at all', { skip: !RUN }, async () => {
  // The dangerous direction: a count that appears when nothing is filtered is noise on every screen.
  await seedClips(['skiing', 'lawn']);
  assert.equal(await filterCount(''), '', 'silent when there is nothing to report');
});
