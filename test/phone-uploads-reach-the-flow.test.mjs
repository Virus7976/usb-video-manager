// FEATURES.md item 14 — footage uploaded from his phone arrived and STOPPED.
//
// The resumable upload machinery is finished and good: `core/upload.js` and the server write
// completed transfers into `<storeDir>/phone-uploads`, `.part` renamed into place on `finish()`.
// Then nothing. Grepping `main-mod/`, `preload.js` and `src/mod/` for that directory returned ZERO
// hits — the clips were on his disk and invisible to every screen in the app.
//
// Same shape as the filing corridor: the hard part built, the last step unwalked.
//
// ⚠⚠ THIS MOVES FOOTAGE THAT MAY BE THE ONLY COPY. By the time an upload finishes, the clip may
// already be gone from the phone. So it COPIES through `copyFileVerified` — the app's staged,
// fsync'd, fingerprint-checked primitive — and only lets the staged original go once the copy has
// verified. A failure leaves the upload exactly where it was, still listed, still ingestable.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let staging; let intake;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

beforeEach(() => {
  staging = join(app.storeDir, 'phone-uploads');
  intake = join(app.dirs.userData, 'intake');
  for (const d of [staging, intake]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  mkdirSync(staging, { recursive: true });
  mkdirSync(intake, { recursive: true });
  app.get('config').intakeFolder = intake;
});

const upload = (name, body = 'PHONE-FOOTAGE-BYTES') => writeFileSync(join(staging, name), body);
const list = async () => app.plain(await app.invoke('uploads:list'));
const ingest = async (payload = {}) => app.plain(await app.invoke('uploads:ingest', payload));

test('⚠ CONTROL — with nothing uploaded, the list is empty and is not an error', async () => {
  const r = await list();
  assert.equal(r.ok, true, '⚠ an empty staging folder is a normal state, not a failure');
  assert.equal(r.total, 0);
});

test('⚠⚠ a completed upload is listed', async () => {
  upload('IMG_2201.MP4');
  const r = await list();
  assert.equal(r.total, 1, `⚠⚠ the clip his phone sent is visible — got ${r.total}`);
  assert.equal(r.files[0].name, 'IMG_2201.MP4');
  assert.ok(r.files[0].size > 0, 'with its real size');
});

test('⚠⚠ an in-flight upload is NOT offered', async () => {
  // `.part` is still transferring and `.json` is bookkeeping. Offering either would hand him a file
  // that is not there yet — and ingesting a partial clip is how a truncated copy reaches his archive.
  upload('half-sent.MP4.part');
  writeFileSync(join(staging, 'half-sent.MP4.json'), '{"id":"x"}');
  const r = await list();
  assert.equal(r.total, 0, '⚠⚠ nothing incomplete is ever offered');
});

test('⚠⚠⚠ ingesting copies it into the flow and verifies before letting go', async () => {
  upload('IMG_2202.MP4', 'REAL-FOOTAGE');
  const r = await ingest();
  assert.equal(r.ok, true, `⚠⚠⚠ it must land — got ${r.error}`);
  assert.equal(r.ingested, 1);

  const landed = readdirSync(intake);
  assert.deepEqual(landed, ['IMG_2202.MP4'], '⚠⚠⚠ the clip is in Uncompressed, where naming can see it');
  assert.equal(readFileSync(join(intake, 'IMG_2202.MP4'), 'utf8'), 'REAL-FOOTAGE',
    '⚠⚠⚠ byte-for-byte — this may be the only copy');
  assert.equal(existsSync(join(staging, 'IMG_2202.MP4')), false, 'and staging is released after verifying');
});

test('⚠⚠⚠ a name collision NEVER overwrites — this app has had that bug', async () => {
  // The ADB pull path once had two photos with one filename, and one was destroyed. Two phones, or
  // one phone twice, produce the same name routinely.
  writeFileSync(join(intake, 'IMG_2203.MP4'), 'ALREADY-HERE');
  upload('IMG_2203.MP4', 'NEWLY-UPLOADED');
  const r = await ingest();
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(intake, 'IMG_2203.MP4'), 'utf8'), 'ALREADY-HERE',
    '⚠⚠⚠ the file that was already there is untouched');
  const all = readdirSync(intake).sort();
  assert.equal(all.length, 2, `⚠⚠⚠ the new clip landed beside it — got ${JSON.stringify(all)}`);
});

test('⚠⚠ a failed copy leaves the upload where it was, still ingestable', async () => {
  // The rule that makes this safe to retry: a failure must never consume the staged original.
  upload('IMG_2204.MP4');
  // ⚠ A destination whose PARENT is a regular file — fails immediately with ENOTDIR. An
  // unwritable-looking path like `/proc/...` does not fail fast here: the copy primitive retries,
  // and the test hung for two minutes instead of failing. Pick a fixture that fails the way the
  // real thing fails, quickly.
  const blocker = join(app.dirs.userData, 'blocker');
  writeFileSync(blocker, 'not a directory');
  app.get('config').intakeFolder = join(blocker, 'nope');
  const r = await ingest();
  assert.ok(!r.ok || r.failed > 0, '⚠⚠ the failure is reported, not swallowed');
  assert.equal(existsSync(join(staging, 'IMG_2204.MP4')), true,
    '⚠⚠⚠ the only copy is still in staging — nothing was thrown away on a failed write');
});

test('⚠ he can ingest a chosen subset', async () => {
  upload('a.MP4'); upload('b.MP4');
  const r = await ingest({ names: ['a.MP4'] });
  assert.equal(r.ingested, 1);
  assert.deepEqual(readdirSync(intake), ['a.MP4']);
  assert.equal((await list()).total, 1, '⚠ the one he did not pick is still waiting');
});

test('⚠⚠ it is REACHABLE — a card on Home, wired to the real bridge', async () => {
  // This project's recurring failure is a correct feature nothing can call. Six capabilities were
  // built, shipped and unreachable; item 14 was the seventh until now.
  const core = readFileSync(new URL('../src/mod/01-core.js', import.meta.url), 'utf8');
  const pre = readFileSync(new URL('../preload.js', import.meta.url), 'utf8');
  assert.match(core, /id="pwUploads"/, 'the card exists');
  assert.match(core, /await window\.api\.listPhoneUploads\(\)/, '⚠⚠ driven by the real listing');
  assert.match(core, /window\.api\.ingestPhoneUploads\(/, '⚠⚠ and really ingests');
  assert.match(pre, /listPhoneUploads: \(\) => ipcRenderer\.invoke\('uploads:list'\)/, 'bridged');
  assert.match(core, /still waiting, try again/, '⚠ a partial failure says so rather than a bare tick');
});
