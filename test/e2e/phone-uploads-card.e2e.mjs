// The phone-upload card, driven against the REAL app.
//
// The unit tests cover `uploads:list` and `uploads:ingest` thoroughly. What they cannot cover is the
// JOIN: does the card actually appear, does clicking it reach main, and does the footage end up
// somewhere the rest of the app can see?
//
// That gap is not hypothetical here. The last two features I verified structurally each had a bug an
// e2e found on its first run — `config:get` not exposing a key the setup screen read, and the
// Organize screen giving up before asking. Both sides correct, the join broken, every source-level
// test green.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read, run, storeDirFor } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let base; let intake; let staging;

before(async () => {
  if (!RUN) return;
  base = mkdtempSync(join(tmpdir(), 'uvd-uploads-'));
  intake = join(base, '01 - Uncompressed');
  mkdirSync(intake, { recursive: true });

  app = await launchApp({ seed: { 'config.json': { intakeFolder: intake } } });

  // Write the uploads where the SERVER would put them, into the app's real store dir — so the path
  // under test is the one main computes, not one the test told it about.
  staging = join(storeDirFor(app.appData), 'phone-uploads');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'IMG_9001.MP4'), 'PHONE-CLIP-ONE');
  writeFileSync(join(staging, 'IMG_9002.MP4'), 'PHONE-CLIP-TWO');
  writeFileSync(join(staging, 'still-sending.MP4.part'), 'HALF');
});
after(async () => {
  if (app) await app.close();
  if (base) { try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('⚠⚠ the card appears, counting only the COMPLETED uploads', { skip: !RUN }, async () => {
  await run(app.win, 'goHome && goHome();');
  let txt = '';
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    txt = await read(app.win, "document.querySelector('#pwUploads')?.textContent || ''");
    if (txt) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(txt, '⚠⚠ the card is on Home');
  assert.match(txt, /2 clips uploaded from your phone/,
    `⚠⚠ two completed, the .part one not counted — got "${txt.slice(0, 80)}"`);
});

test('⚠⚠ it is offered ABOVE filing — an un-ingested upload is not in the pipeline yet', { skip: !RUN }, async () => {
  const ids = await read(app.win, "[...document.querySelectorAll('.pw-card')].map(c => c.id)");
  assert.equal(ids[0], 'pwUploads', `⚠⚠ first in the list — got ${JSON.stringify(ids)}`);
});

test('⚠⚠⚠ clicking it really brings the footage into the flow', { skip: !RUN }, async () => {
  // The assertion source-reading cannot make: the click travels through preload and main, the
  // verified copy runs, and the bytes land where naming can see them.
  await app.win.click('#pwUploads');
  for (let i = 0; i < 80; i += 1) {
    if (readdirSync(intake).length >= 2) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  const landed = readdirSync(intake).sort();
  assert.deepEqual(landed, ['IMG_9001.MP4', 'IMG_9002.MP4'], '⚠⚠⚠ both clips reached Uncompressed');
  assert.equal(readFileSync(join(intake, 'IMG_9001.MP4'), 'utf8'), 'PHONE-CLIP-ONE',
    '⚠⚠⚠ byte-for-byte — this may be the only copy');
});

test('⚠⚠ staging is released, but the in-flight upload is untouched', { skip: !RUN }, async () => {
  assert.equal(existsSync(join(staging, 'IMG_9001.MP4')), false, 'the ingested clip left staging');
  assert.equal(existsSync(join(staging, 'still-sending.MP4.part')), true,
    '⚠⚠ a transfer still in progress was not consumed');
});

test('⚠ the toast says what landed, and the card goes away', { skip: !RUN }, async () => {
  const toast = await read(app.win, "document.querySelector('.app-toast')?.textContent || ''");
  assert.match(toast, /2 clips brought into Uncompressed/, `⚠ it reports the real count — got "${toast}"`);
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const still = await read(app.win, "!!document.querySelector('#pwUploads')");
    if (!still) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail('⚠ the card should disappear once nothing is waiting');
});
