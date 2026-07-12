// Sidecar-store durability.
//
// These stores hold irreplaceable user data: people.json is the confirmed face DB,
// drafts.json is every rename the user has typed. They were split out of config.json in
// 0.4.20/0.4.26 for write-amplification reasons — which quietly took them OUT from behind
// the `config_readFailed` guard that protects config.json. A corrupt sidecar then read as
// "absent", defaulted to []/{}, and the next saveStore() wrote that empty default over
// the user's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const PEOPLE = [{ name: 'Alice', faces: [{ d: new Array(128).fill(0.5), t: 'data:image/png;base64,AAA' }] }];
const DRAFTS = { 'clip1.mp4': { subject: 'wedding' } };

/** A userData dir pre-seeded with a healthy config + sidecars. */
function seed(overrides = {}) {
  const base = mkdtempSync(join(tmpdir(), 'uvd-stores-'));
  const storeDir = join(base, 'USB SD Auto-Action');
  mkdirSync(storeDir, { recursive: true });
  const files = {
    'config.json': JSON.stringify({ intakeFolder: '/x' }, null, 2),
    'people.json': JSON.stringify(PEOPLE, null, 2),
    'drafts.json': JSON.stringify(DRAFTS, null, 2),
    ...overrides,
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(storeDir, name), body);
  return { base, storeDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');

test('healthy sidecars load into config', () => {
  const { base, storeDir, cleanup } = seed();
  try {
    const m = loadMain({ userData: base });
    assert.deepEqual(m.plain(m.get('config').renameDrafts), DRAFTS, 'drafts load eagerly');
    // people.json is deferred; the accessor pulls it in.
    assert.equal(m.call('aiPeople').length, 1);
    assert.equal(read(storeDir, 'people.json').includes('Alice'), true);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Deferred loading. people.json holds face descriptors AND their base64 thumbnails and
// grows without bound; parsing it synchronously at module load (before the window exists)
// made startup permanently slower the more the app was used.
// ---------------------------------------------------------------------------
test('the heavy AI/face stores are NOT read at boot', () => {
  const { base, cleanup } = seed();
  try {
    const m = loadMain({ userData: base });
    const loaded = m.plain(m.get('storeLoaded'));
    for (const key of ['ai.people', 'ai.clipObs', 'ai.facesPending']) {
      assert.notEqual(loaded[key], true, `${key} must not be read on the launch path`);
    }
    // ...while the small stores the app needs immediately still are.
    assert.equal(loaded.renameDrafts, true);
    assert.equal(loaded.finalMeta, true);
  } finally { cleanup(); }
});

test('a deferred store loads on first access through its accessor', () => {
  const { base, cleanup } = seed();
  try {
    const m = loadMain({ userData: base });
    assert.notEqual(m.plain(m.get('storeLoaded'))['ai.people'], true);
    assert.equal(m.call('aiPeople')[0].name, 'Alice', 'accessor pulls the sidecar in');
    assert.equal(m.plain(m.get('storeLoaded'))['ai.people'], true);
    // clipObs + facesPending have accessors of their own.
    m.call('clipObsStore'); m.call('aiFacesPending');
    assert.equal(m.plain(m.get('storeLoaded'))['ai.clipObs'], true);
    assert.equal(m.plain(m.get('storeLoaded'))['ai.facesPending'], true);
  } finally { cleanup(); }
});

test('a never-loaded deferred store is never written over', () => {
  // The nightmare case for lazy loading: saving without having read. Nothing can have
  // mutated the value (every path runs the accessor first), so the write must be refused
  // rather than stamping an empty default onto a real face DB.
  const { base, storeDir, cleanup } = seed();
  try {
    const m = loadMain({ userData: base });
    m.call('saveStore', 'ai.people');
    assert.equal(read(storeDir, 'people.json').includes('Alice'), true, 'face DB untouched');
  } finally { cleanup(); }
});

test('a corrupt sidecar is never overwritten with the empty default', () => {
  // Truncated mid-write, the classic crash/power-loss shape.
  const { base, storeDir, cleanup } = seed({
    'people.json': JSON.stringify(PEOPLE, null, 2).slice(0, 120),
    'drafts.json': '{"clip1.mp4": {"subj',
  });
  try {
    const m = loadMain({ userData: base });

    // drafts.json is eager: corruption is latched at boot.
    assert.deepEqual(m.plain(m.get('config').renameDrafts), {});
    assert.equal(m.get('storeReadFailed').renameDrafts, true);

    // people.json is deferred: the accessor both loads it and latches the corruption,
    // and the session runs on the empty default so the app still works.
    assert.deepEqual(m.plain(m.call('aiPeople')), [], 'in-memory falls back to the default');
    assert.equal(m.get('storeReadFailed')['ai.people'], true);

    m.call('saveStore', 'ai.people');
    m.call('saveStore', 'renameDrafts');

    // The bytes on disk are untouched — the user's data is still recoverable.
    assert.notEqual(read(storeDir, 'people.json'), '[]', 'face DB must survive a corrupt read');
    assert.equal(read(storeDir, 'people.json').includes('Alice'), true);
    assert.notEqual(read(storeDir, 'drafts.json'), '{}', 'saved renames must survive a corrupt read');
  } finally { cleanup(); }
});

test('an ABSENT sidecar is still writable (first run must not be blocked)', () => {
  const { base, storeDir, cleanup } = seed();
  try {
    rmSync(join(storeDir, 'people.json'));
    const m = loadMain({ userData: base });
    m.call('aiPeople');                                   // first access: file is absent
    assert.notEqual(m.get('storeReadFailed')['ai.people'], true, 'absent != corrupt');
    m.call('saveStore', 'ai.people');
    assert.equal(read(storeDir, 'people.json'), '[]', 'a fresh install writes its default');
  } finally { cleanup(); }
});

test('repairing the file on disk clears the latch and re-enables saving', () => {
  const { base, storeDir, cleanup } = seed({ 'people.json': '[{"name":"Ali' });
  try {
    const m = loadMain({ userData: base });
    assert.deepEqual(m.plain(m.call('aiPeople')), []);    // loads + latches the corruption
    assert.equal(m.get('storeReadFailed')['ai.people'], true);

    // User restores a good backup. freshStore() sees a newer mtime and re-reads.
    writeFileSync(join(storeDir, 'people.json'), JSON.stringify(PEOPLE, null, 2));
    const val = m.call('freshStore', 'ai.people');

    assert.equal(val.length, 1, 'repaired data is picked up');
    assert.equal(m.get('storeReadFailed')['ai.people'], false, 'latch clears');
    m.call('saveStore', 'ai.people');
    assert.equal(read(storeDir, 'people.json').includes('Alice'), true);
  } finally { cleanup(); }
});

test('migrateStores still re-homes a legacy in-config value for a deferred store', () => {
  // Pre-0.4.26 shape: the face DB lives INSIDE config.json and has no sidecar yet.
  const { base, storeDir, cleanup } = seed();
  try {
    rmSync(join(storeDir, 'people.json'));
    writeFileSync(join(storeDir, 'config.json'),
      JSON.stringify({ intakeFolder: '/x', ai: { people: PEOPLE } }, null, 2));

    const m = loadMain({ userData: base });
    m.call('migrateStores');

    assert.equal(read(storeDir, 'people.json').includes('Alice'), true,
      'legacy in-config face DB is written to its new home, not lost to deferral');
  } finally { cleanup(); }
});

test('a corrupt sidecar does not get stripped out of config.json into nowhere', () => {
  // stripStoresForWrite() only strips a key whose sidecar EXISTS. A corrupt file exists,
  // so the key is stripped — that is fine ONLY because we never overwrite the sidecar.
  // Guard the invariant that matters: the data lives in at least one file.
  const { base, storeDir, cleanup } = seed({ 'people.json': '[{"name":"Ali' });
  try {
    const m = loadMain({ userData: base });
    m.call('saveConfig');
    const cfgOnDisk = JSON.parse(read(storeDir, 'config.json'));
    const peopleInConfig = cfgOnDisk.ai && cfgOnDisk.ai.people;
    const peopleFileStillHasData = read(storeDir, 'people.json').includes('Ali');
    assert.ok(peopleInConfig !== undefined || peopleFileStillHasData,
      'face data must survive in config.json or people.json — never zero files');
  } finally { cleanup(); }
});

test('writeJsonAtomic writes the value and leaves no temp file behind', () => {
  const { base, storeDir, cleanup } = seed();
  try {
    const m = loadMain({ userData: base });
    m.call('writeJsonAtomic', join(storeDir, 'atomic-probe.json'), { a: 1 });
    assert.deepEqual(JSON.parse(read(storeDir, 'atomic-probe.json')), { a: 1 });
    assert.deepEqual(readdirSync(storeDir).filter((f) => f.endsWith('.tmp')), []);
  } finally { cleanup(); }
});

test('writeJsonAtomic cleans up its temp file when the write fails', () => {
  const { base, storeDir, cleanup } = seed();
  try {
    const m = loadMain({ userData: base });
    // A value JSON.stringify cannot serialize -> throws inside the try, after openSync.
    const circular = {}; circular.self = circular;
    assert.throws(() => m.call('writeJsonAtomic', join(storeDir, 'will-fail.json'), circular));
    assert.deepEqual(readdirSync(storeDir).filter((f) => f.endsWith('.tmp')), [],
      'no .tmp turds left on a failed write');
  } finally { cleanup(); }
});
