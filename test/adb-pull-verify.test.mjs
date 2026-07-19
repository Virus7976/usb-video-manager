// Audit #17 — an `adb pull` was judged successful by `size > 0`.
//
// A cancelled pull, an unplugged cable, or a phone that sleeps mid-transfer leaves a SHORT file
// sitting under its final name. `size > 0` accepts it, so the pull reports OK.
//
// Why that is footage loss and not just a wrong number: a file reported OK is not retried (the #89
// per-file retry only chases stragglers), and the staging gate later deletes it for being short. So
// the clip is dropped from the pull AND from the retry list — it silently never arrives, while the
// UI says the backup finished.
//
// The correct gate already existed THREE LINES ABOVE, in the resume check: `have.size ===
// Number(it.size)`. The MTP sibling has the same rule with the same reasoning
// (`main-mod/05-windows-phone.js:312-320`), including deleting the truncated file so a re-pull is
// clean. This just applies it to the success test too.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const dirs = [];
const mk = (p) => { const d = tempDir(p); dirs.push(d); return d.dir; };

// `runAdb` is a top-level function declaration in the bundle, so the binding is assignable inside
// the vm context — which lets us drive the real adbPullToDest against a phone that misbehaves.
function stubAdb(writeBytes) {
  app.get(`runAdb = function (args) {
    var dest = args[args.length - 1];
    require('node:fs').writeFileSync(dest, ${JSON.stringify(writeBytes)});
    return Promise.resolve({ code: 0, out: '', err: '' });
  }`);
}

beforeEach(() => { /* each test re-stubs */ });

test('#17 a TRUNCATED pull is reported FAIL, not OK', async () => {
  const dest = mk('adb-trunc-');
  stubAdb('short');                                   // 5 bytes...
  const items = [{ name: 'GX010042.MP4', rel: '', size: 5000 }];   // ...of a 5000-byte clip
  const res = app.plain(await app.call('adbPullToDest', 'SERIAL', items, dest, null));
  assert.equal(res.results[0].status, 'FAIL', 'a short file is not a successful pull');
});

test('#17 the truncated file is REMOVED so it cannot be adopted later', async () => {
  const dest = mk('adb-unlink-');
  stubAdb('short');
  await app.call('adbPullToDest', 'SERIAL', [{ name: 'GX010043.MP4', rel: '', size: 5000 }], dest, null);
  const left = fs.readdirSync(dest);
  assert.deepEqual(left, [], 'nothing left wearing a real clip name');
});

test('#17 a COMPLETE pull still reports OK', async () => {
  const dest = mk('adb-ok-');
  const body = 'x'.repeat(5000);
  stubAdb(body);
  const res = app.plain(await app.call('adbPullToDest', 'SERIAL', [{ name: 'GX010044.MP4', rel: '', size: 5000 }], dest, null));
  assert.equal(res.results[0].status, 'OK', 'an exact-size pull succeeds');
  assert.equal(fs.statSync(path.join(dest, 'GX010044.MP4')).size, 5000, 'and the file is kept');
});

test('#17 when the source size is UNKNOWN it falls back to the old non-empty check', async () => {
  // Some devices report no size. Requiring an exact match there would refuse every pull, so the
  // old behaviour is kept for that case only — same concession the MTP gate makes.
  const dest = mk('adb-nosize-');
  stubAdb('anything');
  const res = app.plain(await app.call('adbPullToDest', 'SERIAL', [{ name: 'IMG_1.JPG', rel: '', size: 0 }], dest, null));
  assert.equal(res.results[0].status, 'OK', 'no known size → non-empty is the best we can do');
});
