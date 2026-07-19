// A store write could fail — or be deliberately REFUSED — for a whole session while every handler
// went on returning `{ ok: true }`. Nothing ever told the user.
//
// `saveStore` has three refusal branches and one catch (main-mod/01-core.js):
//     if (storeReadFailed[key]) { console.error(`Skipping save of store "${key}"…`); return; }
//     if (LAZY_STORES.has(key) && !storeLoaded[key]) { console.error(`Refusing to save store…`); return; }
//     …
//     catch (err) { console.error(`Could not save store ${key}:`, err.message); }
// and `saveConfig` matches it. All four are console-only.
//
// The refusals themselves are CORRECT and must stay: if people.json was present-but-unparseable at
// launch, the in-memory value is the empty default, and writing it would destroy the face DB. The
// defect is that the app then keeps accepting work it cannot keep.
//
// The failure that matters: a corrupt sidecar (or a full disk, or EPERM) latches `storeReadFailed`
// at launch. The user spends an evening naming faces and typing descriptions — `people:save` returns
// `{ok:true}`, `drafts:save` returns `true`, every card shows a ✓ — and on restart the lot is gone.
// The condition IS recorded, via logCrash into crash.log, which is exactly the place a videographer
// will never look. This is the app's north star inverted: he has to re-check its work.
//
// So the persistence layer now reports failures once per store, the renderer surfaces them, and the
// state is queryable at boot for a window that wasn't open when it happened.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// `storePersistFailed` is a const in the bundle, so clear its KEYS rather than reassigning it.
beforeEach(() => { app.get('Object.keys(storePersistFailed).forEach((k) => { delete storePersistFailed[k]; })'); });

const failures = () => app.plain(app.get('storePersistFailed')) || {};

test('a REFUSED save (unreadable store) is recorded, not just logged', async () => {
  app.get("storeReadFailed['renameDrafts'] = true");
  try {
    await app.invoke('drafts:save', { 'x.mp4__1__1': { subject: 'mowing', description: '' } });
    const f = failures();
    assert.ok(f.renameDrafts, 'the refusal is recorded against the store');
    assert.match(String(f.renameDrafts.why || ''), /read/i, 'and says why, in terms a person can act on');
  } finally { app.get("storeReadFailed['renameDrafts'] = false"); }
});

test('a THROWN write is recorded too', async () => {
  const real = app.get('writeJsonAtomic');
  app.get('writeJsonAtomic = function () { throw new Error("ENOSPC: no space left on device"); }');
  try {
    await app.invoke('drafts:save', { 'y.mp4__2__2': { subject: 'skating', description: '' } });
    const f = failures();
    assert.ok(f.renameDrafts, 'a disk failure is recorded');
    assert.match(String(f.renameDrafts.why || ''), /ENOSPC/, 'carrying the real reason');
  } finally { app.get(`writeJsonAtomic = ${String(real)}`); }
});

test('a healthy save records nothing', async () => {
  await app.invoke('drafts:save', { 'z.mp4__3__3': { subject: 'ok', description: '' } });
  assert.deepEqual(failures(), {}, 'no false alarm on the happy path');
});

test('it reports once per store, not on every save', async () => {
  // This fires on every keystroke-driven save. A toast per save would be unusable, and worse, would
  // train the user to dismiss the one warning that matters.
  app.get("storeReadFailed['renameDrafts'] = true");
  try {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await app.invoke('drafts:save', { [`n${i}.mp4__1__1`]: { subject: 's', description: '' } });
    }
    const f = failures().renameDrafts;
    assert.equal(f.seen, 5, 'all five failures were seen');
    assert.equal(f.notified, 1, 'but the user was told exactly once');
  } finally { app.get("storeReadFailed['renameDrafts'] = false"); }
});

test('the state is queryable, for a window that was not open when it happened', async () => {
  app.get("storeReadFailed['renameDrafts'] = true");
  try {
    await app.invoke('drafts:save', { 'q.mp4__4__4': { subject: 's', description: '' } });
    const r = await app.invoke('stores:persistFailures');
    assert.ok(Array.isArray(r), 'returns a list');
    assert.ok(r.some((x) => x.key === 'renameDrafts'), 'including the store that could not be saved');
  } finally { app.get("storeReadFailed['renameDrafts'] = false"); }
});

test('a refusal never becomes a write — the protection is untouched', async () => {
  // The whole point of the refusal is that the empty in-memory default must NOT reach disk. Reporting
  // it must not turn a safe no-op into a destructive save.
  app.get("storeReadFailed['renameDrafts'] = true");
  const real = app.get('writeJsonAtomic');
  let wrote = false;
  app.get('__wroteProbe = false');
  app.get('writeJsonAtomic = function () { __wroteProbe = true; }');
  try {
    await app.invoke('drafts:save', { 'r.mp4__5__5': { subject: 's', description: '' } });
    wrote = !!app.get('__wroteProbe');
    assert.equal(wrote, false, 'nothing was written over the unreadable file');
  } finally {
    app.get(`writeJsonAtomic = ${String(real)}`);
    app.get("storeReadFailed['renameDrafts'] = false");
  }
});

test('the renderer surfaces it instead of leaving it in crash.log', async () => {
  const pre = readFileSync(join(process.cwd(), 'preload.js'), 'utf8');
  assert.match(pre, /store:persist-failed/, 'the event is bridged to the renderer');
  const boot = readFileSync(join(process.cwd(), 'src', 'mod', '10-boot.js'), 'utf8');
  assert.match(boot, /onStorePersistFailed|storePersistFailures/, 'and the renderer listens for it');
  assert.match(boot, /logIssue/, 'recording it as an issue, per the codebase convention');
});
