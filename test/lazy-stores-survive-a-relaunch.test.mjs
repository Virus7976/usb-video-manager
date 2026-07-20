// The app's OWN write must survive the app's OWN relaunch — for the four stores nobody can rebuild.
//
// `stores.test.mjs` covers laziness thoroughly: which sidecars are read at boot, that an accessor
// pulls one in on first touch, that a never-loaded store is never written over. But every one of those
// tests **seeds the file itself** and then reads it back. That proves the app can read a file we
// wrote. It does not prove the app persists what HE does.
//
// The difference is the whole failure mode for a lazy store: the value lives in memory under
// `config.ai.*`, the sidecar is only pulled in on first access, and a save has to land in the right
// place at the right time. A write that reaches memory but not disk, or disk but not the sidecar the
// next launch reads, looks perfectly healthy for the entire session — and is gone in the morning.
// (`usb-app-store-caps`: "an in-memory boot slim is a deferred disk write" — the same shape.)
//
// These four hold everything the app has learned that re-scanning cannot rebuild:
//   • ai.clipObs      — 1084 AI observations on his real store
//   • ai.facesPending — 458 half-reviewed face clusters
//   • ai.faceScenes   — 301 detected group shots
//   • ai.people       — 48 enrolled people, 226 confirmations of work
//
// Written after a round-trip probe (write → relaunch → read) found them all correct. Locking the
// property in while it is true, because nothing else was checking it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

// Two launches sharing one profile directory — `userData`, which is what the harness accepts.
// (An earlier probe passed `appData`, which is ignored, so launch 2 silently got a FRESH directory
// and read back nothing. That looked exactly like a persistence bug and was my fixture. Reproduce
// through the same door the app uses.)
const twoLaunches = async (write, read) => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-relaunch-'));
  try {
    const a = loadMain({ userData: base });
    assert.equal(a.storeDir, join(base, 'USB SD Auto-Action'), 'the profile really is shared');
    await write(a);
    a.dispose();
    const b = loadMain({ userData: base });
    const got = await read(b);
    b.dispose();
    return { got, base };
  } finally { rmSync(base, { recursive: true, force: true }); }
};

test('⚠ an AI observation survives a relaunch', async () => {
  const { got } = await twoLaunches(
    (a) => a.invoke('clipObs:save', { key: 'GX010042.MP4__1300__1', obs: 'liam skating at the park, wide' }),
    async (b) => b.plain(await b.invoke('clipObs:get')),
  );
  assert.equal(got['GX010042.MP4__1300__1'].obs, 'liam skating at the park, wide',
    `the observation is still there — got ${JSON.stringify(got)}`);
});

test('⚠⚠ a half-finished face review survives a relaunch', async () => {
  // His biggest pile of unfinished work. Losing it means re-reviewing 458 clusters.
  const { got } = await twoLaunches(
    (a) => a.invoke('faces:savePending', [
      { descriptor: [0.1], descriptors: [[0.1]], thumb: '', clipKeys: ['a.mp4__1__1'], done: false, skipped: false, rejected: false },
    ]),
    async (b) => b.plain(await b.invoke('faces:getPending')),
  );
  assert.equal(Array.isArray(got) && got.length, 1, `the pending cluster is still there — got ${JSON.stringify(got).slice(0, 120)}`);
  assert.deepEqual(got[0].clipKeys, ['a.mp4__1__1'], 'with the clip it belongs to');
});

test('a detected group shot survives a relaunch', async () => {
  // A scene needs `faces.length >= 2` and a crop that is a REAL file — `faces:saveScenes` drops
  // anything else as "not a group shot". My first fixture had neither and was correctly rejected,
  // which read as a persistence failure and was mine. The fixture has to be a thing the app accepts.
  const { got } = await twoLaunches(
    async (a) => {
      const crop = a.call('saveFaceCrop', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
      await a.invoke('faces:saveScenes', [{
        clipKey: 'a.mp4__1__1', img: crop, people: ['Liam', 'Karis'],
        faces: [{ descriptor: [0.1] }, { descriptor: [0.2] }],
      }]);
    },
    async (b) => b.plain(await b.invoke('faces:getScenes')),
  );
  assert.equal(Array.isArray(got) && got.length, 1, `the scene is still there — got ${JSON.stringify(got).slice(0, 160)}`);
});

test('⚠ an enrolled person survives a relaunch', async () => {
  // The most expensive data in the app to recreate — it needs him, one face at a time.
  const { got } = await twoLaunches(
    (a) => a.invoke('people:save', { name: 'Liam', faces: [{ descriptor: [0.1], t: '' }] }),
    async (b) => b.plain(await b.invoke('people:get')),
  );
  assert.ok(Array.isArray(got) && got.length >= 1, `the person is still there — got ${JSON.stringify(got).slice(0, 140)}`);
  assert.equal(got[0].name, 'Liam', 'by name');
});

test('the sidecar file is what carries it, not config.json', async () => {
  // The mechanism, checked once: these are SIDECAR stores, and saveConfig() strips every key whose
  // sidecar exists. A value that only reached config.json would be deleted on the next settings save.
  const base = mkdtempSync(join(tmpdir(), 'uvd-relaunch-side-'));
  try {
    const a = loadMain({ userData: base });
    await a.invoke('clipObs:save', { key: 'k__1__1', obs: 'observed' });
    const sidecar = join(a.storeDir, 'clip-observations.json');
    a.dispose();
    assert.equal(existsSync(sidecar), true, 'the sidecar exists');
    assert.match(readFileSync(sidecar, 'utf8'), /observed/, 'and holds the value');
    // config.json may not exist at all yet — nothing has saved settings in this profile. That is the
    // strongest possible version of the claim, so treat it as a pass rather than an error.
    const cfgPath = join(base, 'USB SD Auto-Action', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const inConfig = cfg && cfg.ai && cfg.ai.clipObs;
      assert.ok(!inConfig || !Object.keys(inConfig).length,
        'config.json does not also carry it — that copy would be stripped and is not the source of truth');
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a relaunch with NO prior writes starts clean rather than failing', async () => {
  // The first-run direction: absent is normal, and must not be confused with unreadable
  // (2026-07-20f). A fresh profile must simply read empty.
  const base = mkdtempSync(join(tmpdir(), 'uvd-relaunch-fresh-'));
  try {
    const a = loadMain({ userData: base });
    const obs = a.plain(await a.invoke('clipObs:get'));
    const pend = a.plain(await a.invoke('faces:getPending'));
    a.dispose();
    assert.deepEqual(obs, {}, 'no observations yet');
    assert.deepEqual(pend, [], 'and no pending faces');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
