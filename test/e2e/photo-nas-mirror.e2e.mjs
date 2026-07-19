// Card photos were excluded from the NAS mirror that every clip on the same card gets.
//
// A video imported from a card is mirrored inside `copy:start`:
//     if (nasRoot) { const nasTarget = path.join(nasRoot, path.basename(destPath));
//                    await copyFileVerified(destPath, nasTarget); … }
// driven by `config.nasBackup.{enabled,path}` — the setting the setup wizard writes.
//
// Photos never reach `copy:start` at all (they are stripped from `filesToCopy()` and fanned out by
// `distributeFlowPhotos` instead), so they never touched `nasBackup`. Their only NAS route was a
// SEPARATE, separately-configured setting — `cfg.phoneDestNas` / `cfg.phoneNasFolder`, written in the
// phone-preferences panel.
//
// So: turn on NAS backup in the setup wizard, never open phone preferences, insert a card. Every
// video is mirrored off-machine. **Zero photos are.** And the completion line still says "Photos
// backed up", because it reports the destinations it was given, not the one it never had.
//
// The fix adds the card NAS to the CARD flow only. The phone flow keeps using its own
// `phoneNasFolder` — adding the card NAS there would copy every phone photo to two NAS folders.
//
// Tested through the REAL renderer because `buildPhotoJobs` is a renderer function the vm harness
// cannot reach — and asserting on the actual job list is worth far more here than a source match,
// since what matters is which destinations a photo really fans out to.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// One photo, and a config with the WIZARD's NAS backup on and phone preferences untouched — exactly
// the state a user lands in after running the setup wizard.
async function setup(win, extra = '') {
  await run(win, `
    cfg.nasBackup = { enabled: true, path: 'N:\\\\Backup' };
    cfg.phoneDestNas = false; cfg.phoneNasFolder = '';
    cfg.phoneDestComputer = false; cfg.phoneComputerFolder = '';
    ${extra}
    state.scannedFiles = [{ name: 'GOPR0042.JPG', size: 100, mtimeMs: 1, kind: 'photo',
                            sourcePath: 'E:\\\\DCIM\\\\GOPR0042.JPG', subject: 'mowing', description: '' }];
  `);
}
const destsOf = (jobs) => jobs.map((j) => String(j.dest || ''));

test('a CARD photo is mirrored to the wizard-configured NAS', { skip: !RUN }, async () => {
  await setup(app.win);
  const jobs = await read(app.win, `buildPhotoJobs(clipPhotos(), true).jobs`);
  assert.ok(jobs.length, 'the photo produced copy jobs');
  assert.ok(destsOf(jobs).some((d) => d.startsWith('N:\\Backup')),
    `the card NAS is one of the destinations — got ${JSON.stringify(destsOf(jobs))}`);
});

test('the PHONE flow is not given the card NAS', { skip: !RUN }, async () => {
  // It has its own phoneNasFolder; adding this one would copy every phone photo to two NAS folders.
  await setup(app.win);
  const jobs = await read(app.win, `buildPhotoJobs(clipPhotos(), false).jobs`);
  assert.ok(!destsOf(jobs).some((d) => d.startsWith('N:\\Backup')),
    `the phone flow keeps its own NAS setting — got ${JSON.stringify(destsOf(jobs))}`);
});

test('NAS backup switched OFF adds nothing', { skip: !RUN }, async () => {
  await setup(app.win, `cfg.nasBackup = { enabled: false, path: 'N:\\\\Backup' };`);
  const jobs = await read(app.win, `buildPhotoJobs(clipPhotos(), true).jobs`);
  assert.ok(!destsOf(jobs).some((d) => d.startsWith('N:\\Backup')),
    'a disabled backup is not a destination');
});

test('an enabled backup with no path adds nothing', { skip: !RUN }, async () => {
  // Half-configured must not produce a job whose destination is the drive root or an empty string.
  await setup(app.win, `cfg.nasBackup = { enabled: true, path: '' };`);
  const jobs = await read(app.win, `buildPhotoJobs(clipPhotos(), true).jobs`);
  assert.ok(jobs.every((j) => j.dest && j.dest.trim()), 'no empty destinations');
  assert.ok(!destsOf(jobs).some((d) => d.startsWith('\\')), 'and nothing rooted at a bare separator');
});

test('the photo still reaches its other destinations', { skip: !RUN }, async () => {
  // Guard the other direction: adding the NAS must not displace Photos Temp.
  await setup(app.win);
  const jobs = await read(app.win, `buildPhotoJobs(clipPhotos(), true).jobs`);
  assert.ok(jobs.length >= 2, 'Photos Temp plus the NAS, not one replacing the other');
});

test('the photo is not sent to the same NAS folder twice', { skip: !RUN }, async () => {
  // If the user ALSO configured the phone NAS at the same path, one photo must not be copied there
  // twice — the second job would collide with the first and version it into _v2.
  await setup(app.win, `cfg.phoneDestNas = true; cfg.phoneNasFolder = 'N:\\\\Backup';`);
  const jobs = await read(app.win, `buildPhotoJobs(clipPhotos(), true).jobs`);
  const nas = destsOf(jobs).filter((d) => d.startsWith('N:\\Backup'));
  assert.equal(nas.length, 1, `one job per destination folder — got ${JSON.stringify(nas)}`);
});
