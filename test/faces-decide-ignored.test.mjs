// #46 — "Ignore" must suppress CLUSTERING, not only matching. The renderer's face-scan loop now
// does `if (m.ignored) continue`, so it depends on faceDecide flagging a query that is closest to an
// ignored face as { match:null, ignored:true }. Pin that contract here (faceDecide is pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

test('faceDecide flags a face nearest the ignore bin as ignored (no match)', async () => {
  const app = await loadMain();
  const confirmed = [{ id: 'p1', name: 'Al', d: [1, 0, 0] }];
  const ignored = [{ d: [0, 0, 0] }];   // a statue/TV/poster the user dismissed
  // Query sits right on top of the ignored descriptor, far from the real person.
  const r = app.plain(await app.call('faceDecide', [0.05, 0, 0], confirmed, ignored, 0.54));
  assert.equal(r.ignored, true, 'closest thing is an ignored face → ignored');
  assert.equal(r.match, null, 'an ignored face is never offered as a match');
});

test('faceDecide flags an ignored face even when NOBODY is enrolled yet (#46 early-return gap)', async () => {
  const app = await loadMain();
  // No confirmed people at all — the case the old early-return skipped, so a dismissed statue kept
  // re-clustering until you named someone. Found by the e2e test that ignores a face before any person.
  const r = app.plain(await app.call('faceDecide', [0.02, 0, 0], [], [{ d: [0, 0, 0] }], 0.54));
  assert.equal(r.ignored, true, 'ignored is flagged with an empty enrolled set');
  assert.equal(r.match, null);
  // A face NOT near the ignore bin, still nobody enrolled → plain unknown (not ignored).
  const u = app.plain(await app.call('faceDecide', [5, 5, 5], [], [{ d: [0, 0, 0] }], 0.54));
  assert.ok(!u.ignored, 'a far-away face is not falsely ignored');
});

test('faceDecide still matches a real person when the ignore bin is further away', async () => {
  const app = await loadMain();
  const confirmed = [{ id: 'p1', name: 'Al', d: [1, 0, 0] }];
  const ignored = [{ d: [0, 0, 0] }];
  const r = app.plain(await app.call('faceDecide', [0.98, 0, 0], confirmed, ignored, 0.54));
  assert.ok(!r.ignored, 'the real person is nearer than the ignored face');
  assert.ok(r.match && r.match.name === 'Al', 'matches the confirmed person');
});
