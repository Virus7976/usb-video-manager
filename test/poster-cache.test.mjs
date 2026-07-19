// #72 — persistent, bounded poster cache. THUMB_DIR is nuked on boot, so posters used to be
// re-extracted with ffmpeg for every clip on each relaunch. getPoster now writes to a persistent
// POSTER_CACHE_DIR keyed by path+size+mtime and reuses hits; prunePosterCache() bounds its growth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

test('posterCacheName is deterministic and keyed on path+size+mtime', async () => {
  const app = await loadMain();
  const a = await app.call('posterCacheName', '/a/b.mp4', 1000, 12345);
  const a2 = await app.call('posterCacheName', '/a/b.mp4', 1000, 12345);
  assert.equal(a, a2, 'same inputs → same filename');
  assert.match(a, /^p_[0-9a-f]{16}\.jpg$/, 'stable p_<hash>.jpg shape');

  // Any of the three fields changing must yield a different name (so an edited/re-recorded
  // clip re-extracts instead of serving a stale poster).
  assert.notEqual(a, await app.call('posterCacheName', '/a/OTHER.mp4', 1000, 12345), 'path matters');
  assert.notEqual(a, await app.call('posterCacheName', '/a/b.mp4', 2000, 12345), 'size matters');
  assert.notEqual(a, await app.call('posterCacheName', '/a/b.mp4', 1000, 99999), 'mtime matters');
});

test('posterCachePrunePlan keeps the newest `cap` and deletes the rest', async () => {
  const app = await loadMain();
  const entries = [
    { nm: 'old1', m: 100 }, { nm: 'old2', m: 200 }, { nm: 'mid', m: 300 },
    { nm: 'new1', m: 400 }, { nm: 'new2', m: 500 },
  ];
  // Under/at the cap → nothing deleted.
  assert.deepEqual(app.plain(await app.call('posterCachePrunePlan', entries, 5)), []);
  assert.deepEqual(app.plain(await app.call('posterCachePrunePlan', entries, 9)), []);
  // Over the cap → the OLDEST (lowest mtime) are the ones dropped.
  const drop2 = app.plain(await app.call('posterCachePrunePlan', entries, 3));
  assert.deepEqual(drop2.sort(), ['old1', 'old2'], 'keeps the 3 newest, drops the 2 oldest');
  const drop4 = app.plain(await app.call('posterCachePrunePlan', entries, 1));
  assert.equal(drop4.length, 4);
  assert.ok(!drop4.includes('new2'), 'the single newest survives');
});

test('prunePosterCache is safe when the cache dir does not exist', async () => {
  const app = await loadMain();
  await app.call('prunePosterCache');   // readdir throws → swallowed; must not throw
});
