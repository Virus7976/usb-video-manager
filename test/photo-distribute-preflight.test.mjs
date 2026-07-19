// The photo fan-out had no free-space preflight anywhere, while video has two layers of one.
//
// Video: the renderer checks `spaceTargets` before starting, and `copy:start` does a PER-DESTINATION
// `statfs` with 2 GB of headroom and refuses the import outright. `phone:pull` has the same.
// `phone:distribute` — which every card still goes through — has no `statfs` at all. It goes straight
// from the embed loop to `copyFileVerified` per job.
//
// And a photo fans out further than a clip: Photos Temp + the computer folder + the phone NAS + the
// card NAS + a routed Projects folder. That is up to five writes per still, so a card of stills can
// run a disk to ENOSPC mid-fan-out with no advance refusal — the exact failure the other three paths
// were hardened against. (The card-NAS destination was added in 2026-07-19au, which made this worse,
// not better.)
//
// ⚠ DELIBERATE DIVERGENCE FROM THE VIDEO TWIN: `copy:start` refuses the WHOLE run when any
// destination is short. Doing that here would mean a full NAS blocks the Photos Temp and computer
// copies too — strictly worse than making the copies that fit. So this refuses PER DESTINATION: jobs
// whose destination cannot hold them are failed with a clear reason and skipped, and the rest proceed.
//
// That is safe because of how the caller already works: `distributeFlowPhotos` builds `landed` from
// per-job results and only adds a photo to `state.copied` if at least one destination verified. A
// photo that fits nowhere therefore never becomes eligible for deletion from the card.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

function stage() {
  const base = mkdtempSync(join(tmpdir(), 'uvd-pre-'));
  const src = join(base, 'DCIM');
  const roomy = join(base, 'PhotosTemp');
  const tight = join(base, 'NAS');
  for (const d of [src, roomy, tight]) mkdirSync(d, { recursive: true });
  const photo = join(src, 'GOPR0042.JPG');
  writeFileSync(photo, Buffer.alloc(4 * 1024 * 1024, 7));   // 4 MB
  app.get('isOnRemovableVolume = function () { return Promise.resolve(false); }');
  app.get('getExifTool = function () { return { write: async () => {} }; }');
  return { base, photo, roomy, tight, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// Report `tight` as nearly full and everything else as roomy.
function withTightVolume(s, fn) {
  const fsp = app.get('fsp');
  const real = fsp.statfs;
  fsp.statfs = async (p) => (String(p).includes('NAS')
    ? { bavail: 1024, bsize: 1 }
    : { bavail: 500e9, bsize: 1 });
  return fn().finally(() => { fsp.statfs = real; });
}

const distribute = (s) => app.invoke('phone:distribute', {
  jobs: [
    { src: s.photo, dest: join(s.roomy, 'mowing.JPG'), meta: { subject: 'mowing' } },
    { src: s.photo, dest: join(s.tight, 'mowing.JPG'), meta: { subject: 'mowing' } },
  ],
});

test('a destination without room is refused instead of filled', async () => {
  const s = stage();
  try {
    const r = await withTightVolume(s, () => distribute(s));
    assert.ok(!existsSync(join(s.tight, 'mowing.JPG')), 'nothing was written to the full volume');
    const tightRow = r.results.find((x) => String(x.dest).includes('NAS'));
    assert.equal(tightRow.ok, false, 'and that job is reported as failed');
    assert.match(String(tightRow.error), /Not enough room/, 'with a reason the user can act on');
  } finally { s.cleanup(); }
});

test('the destinations that DO fit are still written', async () => {
  // The reason this diverges from copy:start: a full NAS must not block the Photos Temp copy.
  const s = stage();
  try {
    const r = await withTightVolume(s, () => distribute(s));
    assert.ok(existsSync(join(s.roomy, 'mowing.JPG')), 'the roomy destination got its copy');
    const okRow = r.results.find((x) => String(x.dest).includes('PhotosTemp'));
    assert.equal(okRow.ok, true, 'and is reported as landed');
  } finally { s.cleanup(); }
});

test('a photo that landed SOMEWHERE is still reported, so it stays deletable', async () => {
  // distributeFlowPhotos builds `landed` from ok results and only then lets a photo be cleared off
  // the card. A partial fan-out must still produce one ok row, or a safely-backed-up photo can never
  // be deleted.
  const s = stage();
  try {
    const r = await withTightVolume(s, () => distribute(s));
    assert.ok(r.results.some((x) => x.ok && x.src === s.photo), 'one verified destination is enough');
  } finally { s.cleanup(); }
});

test('plenty of room means nothing is refused', async () => {
  const s = stage();
  try {
    const fsp = app.get('fsp');
    const real = fsp.statfs;
    fsp.statfs = async () => ({ bavail: 500e9, bsize: 1 });
    try {
      const r = await distribute(s);
      assert.equal(r.failed, 0, 'no job was refused');
      assert.ok(existsSync(join(s.tight, 'mowing.JPG')), 'and both destinations were written');
    } finally { fsp.statfs = real; }
  } finally { s.cleanup(); }
});

test('an unreadable volume does not block the backup', async () => {
  // Fail OPEN, exactly like the video preflight: refusing to back up because statfs threw would turn
  // a diagnostic into a data-safety problem.
  const s = stage();
  try {
    const fsp = app.get('fsp');
    const real = fsp.statfs;
    fsp.statfs = async () => { throw new Error('ENOTSUP'); };
    try {
      const r = await distribute(s);
      assert.equal(r.failed, 0, 'the backup proceeded');
      assert.ok(existsSync(join(s.roomy, 'mowing.JPG')), 'and really copied');
    } finally { fsp.statfs = real; }
  } finally { s.cleanup(); }
});

test('a source that cannot be sized is not counted as blocking', async () => {
  // An unstattable source counts as 0 bytes rather than refusing the run — the same choice
  // projects:move makes.
  const s = stage();
  try {
    const r = await app.invoke('phone:distribute', {
      jobs: [{ src: join(s.base, 'gone.JPG'), dest: join(s.roomy, 'ghost.JPG'), meta: {} }],
    });
    // The copy itself fails (no such file), but NOT with a space complaint.
    const row = r.results[0];
    assert.ok(!/Not enough room/.test(String(row.error || '')), 'not refused for space');
  } finally { s.cleanup(); }
});
