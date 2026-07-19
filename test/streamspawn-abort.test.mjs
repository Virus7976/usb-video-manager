// Cancel on the MTP pull did nothing: the PowerShell copy batch loops over every file with no flag
// check, and streamSpawn had no way to interrupt it. streamSpawn now takes an abortCheck() poller
// that kills the child when it flips true (the MTP caller passes () => phoneAbort). A killed
// mid-copy file is truncated, which the phone:pull staging gate declines — so cancel is now real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('abortCheck kills a long-running child promptly and reports aborted', async () => {
  const t0 = Date.now();
  let cancel = false;
  // Flip the abort flag shortly after launch; the ~400ms poller should then tear the child down.
  setTimeout(() => { cancel = true; }, 150);
  const r = await app.call('streamSpawn', 'sleep', ['30'], { abortCheck: () => cancel });
  const ms = Date.now() - t0;
  assert.equal(r.aborted, true, 'the run reports it was aborted, not timed out');
  assert.equal(r.timedOut, false, 'a user cancel is NOT a timeout');
  assert.ok(ms < 5000, `child was killed promptly, took ${ms}ms (not the full 30s sleep)`);
});

test('with no abortCheck, a quick child still completes normally (no regression)', async () => {
  const r = await app.call('streamSpawn', 'sh', ['-c', 'echo hi'], {});
  assert.equal(r.aborted, false);
  assert.equal(r.code, 0);
  assert.match(r.out, /hi/);
});
