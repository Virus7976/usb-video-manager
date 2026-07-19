// Audit #75 — people:match rebuilt the enrolled set on EVERY call, one IPC per detected face.
//
// The renderer detects several faces per clip and awaited a separate match for each, so a scan of a
// few thousand clips rebuilt the flattened confirmed set thousands of times and paid a bridge
// round-trip per face. Two changes: cache the set (invalidated where people are PERSISTED, so all
// eleven mutating handlers are covered by one hook), and add a batch handler.
//
// THE POINT OF THIS FILE IS EQUIVALENCE. Face matching accuracy is not something to change by
// accident while making it faster, so these assert that batching and caching return exactly what
// the one-at-a-time path returned — same verdict, same distance — and that the cache cannot go
// stale after a person changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// A 128-float descriptor, mostly zeros, with one axis set — far enough apart to be unambiguous.
const desc = (v, i = 0) => { const d = new Array(128).fill(0); d[i] = v; return d; };

async function enrol(name, d) {
  await app.invoke('people:save', { name, descriptors: [d], thumb: '', confirmed: true });
}

test('#75 batch results are IDENTICAL to one-at-a-time results', async () => {
  await enrol('Josiah', desc(1.0, 0));
  await enrol('Beth', desc(1.0, 5));
  const probes = [desc(1.0, 0), desc(1.0, 5), desc(1.0, 90)];   // Josiah, Beth, a stranger

  const single = [];
  for (const d of probes) single.push(app.plain(await app.invoke('people:match', { descriptor: d })));
  const batch = app.plain(await app.invoke('people:matchBatch', { descriptors: probes }));

  assert.equal(batch.results.length, single.length, 'one result per descriptor, in order');
  for (let i = 0; i < single.length; i += 1) {
    assert.deepEqual(batch.results[i], single[i], `descriptor ${i} decided identically`);
  }
});

test('#75 the cache does not go stale when a person changes', async () => {
  const probe = desc(1.0, 42);
  const before = app.plain(await app.invoke('people:match', { descriptor: probe }));
  assert.equal(before.match, null, 'nobody enrolled on that axis yet');

  await enrol('Newcomer', probe);           // persists → saveStore('ai.people') → invalidate
  const after = app.plain(await app.invoke('people:match', { descriptor: probe }));
  assert.ok(after.match && after.match.name === 'Newcomer',
    'the newly enrolled person is matchable immediately — a stale cache would still say null');
});

test('#75 the batch handler tolerates junk entries without dropping the rest', async () => {
  await enrol('Josiah', desc(1.0, 0));
  const r = app.plain(await app.invoke('people:matchBatch', { descriptors: [desc(1.0, 0), null, 'nonsense', desc(1.0, 0)] }));
  assert.equal(r.results.length, 4, 'positions are preserved so the caller can zip results to faces');
  assert.equal(r.results[1].match, null);
  assert.equal(r.results[2].match, null);
  assert.ok(r.results[0].match && r.results[3].match, 'the real descriptors still matched');
});

test('#75 an empty batch is a no-op, not an error', async () => {
  const r = app.plain(await app.invoke('people:matchBatch', { descriptors: [] }));
  assert.deepEqual(r, { ok: true, results: [] });
});
