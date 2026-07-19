// Two ledger bugs (audit #41, #39): a placement into _Unsorted/misc was recorded as a first-class
// "project" (polluting search_projects + date-matching), and clip counts inflated on re-run /
// undo-then-reapply because every entry did rec.clips += 1 with no clip-identity dedupe.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });
beforeEach(() => { app.get('config').projectLedger = []; });

const rec = (entries) => app.invoke('ledger:record', { entries });
const ledger = () => app.get('config').projectLedger || [];

test('#41 a placement into _Unsorted is NOT recorded as a project', async () => {
  await rec([{ rel: '2026/2026 - Personal/_Unsorted', name: 'a.mp4', subject: 'misc' }]);
  assert.equal(ledger().length, 0, 'no _Unsorted project in the ledger');
  await rec([{ rel: '2026 - Personal/misc', name: 'b.mp4', subject: 'x' }]);
  assert.equal(ledger().length, 0, 'misc is excluded too');
});

test('a real project IS recorded', async () => {
  await rec([{ rel: '2026 - Personal/Ski', name: 'a.mp4', subject: 'ski' }]);
  assert.equal(ledger().length, 1);
  assert.equal(ledger()[0].clips, 1);
});

test('#39 re-recording the SAME clip does not inflate the count; a NEW clip does', async () => {
  await rec([{ rel: '2026 - Personal/Ski', name: 'a.mp4', subject: 'ski' }]);
  await rec([{ rel: '2026 - Personal/Ski', name: 'a.mp4', subject: 'ski' }]);   // retry / undo-reapply
  assert.equal(ledger()[0].clips, 1, 'same clip counted once, not twice');
  await rec([{ rel: '2026 - Personal/Ski', name: 'b.mp4', subject: 'ski' }]);   // a genuinely new clip
  assert.equal(ledger()[0].clips, 2, 'a new clip increments');
});
