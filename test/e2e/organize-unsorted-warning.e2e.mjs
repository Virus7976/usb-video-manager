// Audit #40 — the "these clips have no real home" warning on the Apply dialog was DEAD CODE.
//
// It counted `clips.filter((c) => !placement[c.key])` — clips with NO placement at all. But
// recomputeAuto always assigns one: a clip it can't place gets `<category>/_Unsorted`. So the count
// was always 0, the warning never rendered, and low-confidence clips filed silently into real
// _Unsorted folders in his Projects tree with no call-out.
//
// That's a TRUST bug, not a cosmetic one: PROMPT.md §1 says the app has failed if Jake has to
// re-check every clip. Silently doing the thing it promised to warn about is exactly what forces him
// to. The fix counts what actually happens — the _Unsorted placements — and says so.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// Call the renderer's own helper with synthetic input.
const counts = (clips, placement) =>
  read(app.win, `JSON.stringify(unplacedCounts(${JSON.stringify(clips)}, ${JSON.stringify(placement)}))`)
    .then((s) => JSON.parse(s));

test('#40 an _Unsorted placement is COUNTED (this is what the old check missed)', { skip: !RUN }, async () => {
  const clips = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const placement = {
    a: '2026 - Personal/Ski Trip',
    b: '2026 - Personal/_Unsorted',
    c: '2026 - Client Work/_Unsorted',
  };
  const r = await counts(clips, placement);
  assert.equal(r.unsorted, 2, 'both _Unsorted clips are counted');
  assert.equal(r.misc, 0, 'none of them are unplaced');
  assert.equal(r.total, 2, 'two clips have no real home');
});

test('#40 a genuinely unplaced clip is still counted (the original case)', { skip: !RUN }, async () => {
  const r = await counts([{ key: 'a' }, { key: 'b' }], { a: '2026 - Personal/Ski Trip' });
  assert.equal(r.misc, 1, 'the clip with no placement goes to misc');
  assert.equal(r.total, 1);
});

test('#40 a fully-placed plan warns about nothing', { skip: !RUN }, async () => {
  // The dangerous direction: a warning that fires on every normal run is noise, and noise is how a
  // real warning stops being read.
  const r = await counts([{ key: 'a' }, { key: 'b' }], { a: '2026 - Personal/Ski', b: '2026 - Client Work/Acme' });
  assert.equal(r.total, 0, 'a clean plan is silent');
});

test('#40 the match is anchored — a project merely NAMED "Unsorted Beach" is not swept up', { skip: !RUN }, async () => {
  const r = await counts([{ key: 'a' }], { a: '2026 - Personal/Unsorted Beach Day' });
  assert.equal(r.total, 0, 'only a trailing /_Unsorted leaf counts, not a name containing it');
});

test('#40 the Apply dialog surfaces the count', { skip: !RUN }, async () => {
  // Guards the WIRING: the helper is useless if the dialog still asks the dead question.
  const src = await read(app.win, 'String(showDestinationMap)');
  assert.match(src, /unplacedCounts\(/, 'the dialog uses the helper');
  assert.equal(/clips\.filter\(\(c\) => !placement\[c\.key\]\)\.length/.test(src), false,
    'the dead unplaced-only count is gone');
});
