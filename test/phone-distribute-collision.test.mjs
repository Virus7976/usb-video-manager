// A photo backup could silently OVERWRITE a different photo. Found by sweeping for sibling-path gaps.
//
// `phone:copyVideos` guards this explicitly (main-mod/05-windows-phone.js ~975): if something already
// occupies the destination it FULL-hashes it, treats a byte-identical file as "already there", and
// otherwise calls uniqueDest so a DIFFERENT clip is never overwritten. Its comment spells out why it
// really collides: `recomputeVersions()` only de-duplicates `_v#` within the CURRENT scan, so a
// second batch producing the same subject/description restarts at `_v1` and lands on the first
// batch's filename.
//
// `phone:distribute` — the PHOTO twin — just called `copyFileVerified(j.src, j.dest)`. And
// copyFileVerified deliberately overwrites a differing destination (it assumes a differing file is a
// truncated copy of the SAME clip that needs repairing; its own comment notes it cannot tell that
// apart from "a good copy of a DIFFERENT clip that collided on basename").
//
// So batch 2's Sunset_v1.jpg overwrote batch 1's already-backed-up, different Sunset_v1.jpg — and
// distribute fans out to the computer folder, the NAS folder AND the routed Projects folder, so all
// three copies died at once, reported as a successful backup. That is lost photos, and it directly
// contradicts "photos are as first-class as video".
import { test, before, after } from 'node:test';
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
const write = (dir, name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };

test('a DIFFERENT photo colliding on name is versioned, never overwritten', async () => {
  const src = mk('pd-src-'); const dest = mk('pd-dest-');
  const first = write(dest, 'Sunset_v1.jpg', 'BATCH-ONE-PHOTO');      // already backed up
  const incoming = write(src, 'Sunset_v1.jpg', 'BATCH-TWO-PHOTO');    // a different picture, same name

  const r = app.plain(await app.invoke('phone:distribute', {
    jobs: [{ src: incoming, dest: path.join(dest, 'Sunset_v1.jpg') }],
  }));

  assert.equal(r.results[0].ok, true, 'the copy still succeeds');
  assert.equal(fs.readFileSync(first, 'utf8'), 'BATCH-ONE-PHOTO', 'the FIRST photo survives untouched');
  const landed = fs.readdirSync(dest).sort();
  assert.equal(landed.length, 2, 'both photos are on disk, not one');
  const other = landed.find((n) => n !== 'Sunset_v1.jpg');
  assert.equal(fs.readFileSync(path.join(dest, other), 'utf8'), 'BATCH-TWO-PHOTO', 'the new one landed beside it');
});

test('a byte-IDENTICAL photo is treated as already there, not duplicated', async () => {
  // A genuine re-run must be idempotent, or every retry litters the backup with _v2, _v3, _v4…
  const src = mk('pd-same-src-'); const dest = mk('pd-same-dest-');
  write(dest, 'Beach.jpg', 'SAME-BYTES');
  const incoming = write(src, 'Beach.jpg', 'SAME-BYTES');

  const r = app.plain(await app.invoke('phone:distribute', { jobs: [{ src: incoming, dest: path.join(dest, 'Beach.jpg') }] }));
  assert.equal(r.results[0].ok, true);
  assert.deepEqual(fs.readdirSync(dest), ['Beach.jpg'], 'no duplicate created for an identical file');
});

test('a fresh destination is unaffected — the ordinary case still just copies', async () => {
  const src = mk('pd-new-src-'); const dest = mk('pd-new-dest-');
  const incoming = write(src, 'New.jpg', 'NEW-PHOTO');
  const r = app.plain(await app.invoke('phone:distribute', { jobs: [{ src: incoming, dest: path.join(dest, 'New.jpg') }] }));
  assert.equal(r.results[0].ok, true);
  assert.equal(fs.readFileSync(path.join(dest, 'New.jpg'), 'utf8'), 'NEW-PHOTO');
});

test('the reported dest is the file actually written, so the caller can find it', async () => {
  // distribute's results feed the finalMeta/ledger bookkeeping downstream; reporting the requested
  // path while writing a versioned one would point that bookkeeping at a file that does not exist.
  const src = mk('pd-rep-src-'); const dest = mk('pd-rep-dest-');
  write(dest, 'Clash.jpg', 'ORIGINAL');
  const incoming = write(src, 'Clash.jpg', 'DIFFERENT');
  const r = app.plain(await app.invoke('phone:distribute', { jobs: [{ src: incoming, dest: path.join(dest, 'Clash.jpg') }] }));
  assert.ok(fs.existsSync(r.results[0].dest), 'the reported destination exists on disk');
  assert.equal(fs.readFileSync(r.results[0].dest, 'utf8'), 'DIFFERENT', 'and holds the incoming photo');
});
