// Audit #89 — items ADB could not pull were silently dropped instead of retried over MTP.
//
// `mtpCopyToDest` is ADB-first with an MTP fallback, and the code even comments "falling back to
// MTP". But the gate is `if (r && r.ok) return r`, and `adbPullToDest` returns `{ ok: true }`
// UNCONDITIONALLY — it records failure per FILE (`status: 'FAIL'`) while always reporting batch
// success. So the fallback was unreachable: whatever ADB failed on never got its second chance on
// the slower-but-working path, and the pull reported done.
//
// Irreplaceable phone media, not pulled, with the UI saying it finished.
//
// Per §8 the transports cannot be driven in WSL, so the DECISION is extracted and tested directly:
// which items deserve a retry, and how the two passes' results combine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const retryList = (items, results) => app.plain(app.call('adbRetryList', items, results));
const merge = (a, b) => app.plain(app.call('mergePullResults', a, b));

test('#89 files ADB FAILED on are selected for the MTP retry', () => {
  const items = [{ name: 'a.mp4' }, { name: 'b.mp4' }, { name: 'c.mp4' }];
  const results = [{ name: 'a.mp4', status: 'OK' }, { name: 'b.mp4', status: 'FAIL' }, { name: 'c.mp4', status: 'FAIL' }];
  assert.deepEqual(retryList(items, results).map((i) => i.name), ['b.mp4', 'c.mp4']);
});

test('#89 a fully successful ADB pull retries NOTHING', () => {
  // The fallback must not re-pull gigabytes that already landed.
  const items = [{ name: 'a.mp4' }, { name: 'b.mp4' }];
  const results = [{ name: 'a.mp4', status: 'OK' }, { name: 'b.mp4', status: 'SKIP' }];
  assert.deepEqual(retryList(items, results), [], 'OK and SKIP both mean "it is on disk"');
});

test('#89 an item missing from the results is retried, not assumed done', () => {
  // A crash or an abort mid-batch leaves later items unreported. Treating "no news" as success is
  // how a file goes missing quietly — the whole shape of this bug.
  const items = [{ name: 'a.mp4' }, { name: 'b.mp4' }];
  const results = [{ name: 'a.mp4', status: 'OK' }];
  assert.deepEqual(retryList(items, results).map((i) => i.name), ['b.mp4']);
});

test('#89 an empty ADB result retries everything', () => {
  const items = [{ name: 'a.mp4' }, { name: 'b.mp4' }];
  assert.deepEqual(retryList(items, []).map((i) => i.name), ['a.mp4', 'b.mp4']);
  assert.deepEqual(retryList(items, null).map((i) => i.name), ['a.mp4', 'b.mp4']);
});

test('#89 the retry outcome REPLACES the failed first attempt', () => {
  // If MTP rescues b.mp4, the caller must see it as OK — otherwise the count of "didn't transfer"
  // (audit #87) reports a loss that did not happen.
  const first = [{ name: 'a.mp4', status: 'OK' }, { name: 'b.mp4', status: 'FAIL' }];
  const second = [{ name: 'b.mp4', status: 'OK' }];
  const m = merge(first, second);
  assert.deepEqual(m.find((x) => x.name === 'b.mp4').status, 'OK', 'the rescue wins');
  assert.deepEqual(m.find((x) => x.name === 'a.mp4').status, 'OK', 'the first pass is preserved');
  assert.equal(m.length, 2, 'no duplicate rows');
});

test('#89 a still-failing item stays FAIL after both passes', () => {
  const m = merge([{ name: 'b.mp4', status: 'FAIL' }], [{ name: 'b.mp4', status: 'FAIL' }]);
  assert.equal(m[0].status, 'FAIL', 'an honest failure survives — it must still be reported');
});

test('#89 the ADB-first gate no longer returns on a batch that failed files', () => {
  const src = app.get('mtpCopyToDest');
  assert.equal(/if \(r && r\.ok\) return r;/.test(String(src)), false,
    'the always-true batch flag must not gate the fallback');
  assert.match(String(src), /adbRetryList\(/, 'the fallback is decided per FILE');
});
