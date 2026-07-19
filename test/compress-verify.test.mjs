// Audit #6 — a compressed clip was trusted on ffmpeg's EXIT CODE alone.
//
// ffmpeg exiting 0 is not proof of a complete encode: given a source with a corrupt tail (or a read
// that ends early) it writes a short file and still exits 0. Nothing between there and the Compressed
// folder checked, so the staged file was renamed to its real name and organized as "done" — and
// because the delete gate only compares card↔intake, the card was then legitimately cleared. That
// can leave a SHORT clip as the only surviving copy of a shot.
//
// The dangerous direction of this fix is the false POSITIVE: a tolerance that's too tight would start
// rejecting Jake's genuine encodes. So this covers all three layers — the pure verdict, a real
// end-to-end ffmpeg encode that must PASS, and a really-truncated file that must FAIL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { HAVE_FFMPEG, tempDir, makeVideo } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const verdict = (srcSec, outSec) => app.plain(app.call('compressOutputVerdict', srcSec, outSec));

test('#6 an encode matching the source duration is accepted', () => {
  assert.equal(verdict(10, 10).ok, true);
});

test('#6 a hair-short encode is accepted (GOP/timebase rounding is not truncation)', () => {
  // Re-encoding can legitimately land a few ms short. Rejecting these would fail real work.
  assert.equal(verdict(10, 9.98).ok, true);
  assert.equal(verdict(120, 119.6).ok, true);
  assert.equal(verdict(1.0, 0.6).ok, true, 'a very short clip keeps an absolute floor of tolerance');
});

test('#6 a materially short encode is REJECTED', () => {
  const v = verdict(120, 60);
  assert.equal(v.ok, false, 'half the footage missing must not earn the real name');
  assert.match(v.error, /shorter than the source/i);
  assert.match(v.error, /60/, 'the error states the durations so the failure is diagnosable');
});

test('#6 an output with no readable duration is REJECTED', () => {
  // A file ffprobe cannot read a duration from is not a finished video, whatever ffmpeg's exit code.
  assert.equal(verdict(120, 0).ok, false);
  assert.equal(verdict(0, 0).ok, false);
});

test('#6 an unprobeable SOURCE does not fail a probeable output', () => {
  // We could not measure the source, so there is nothing to compare against. Failing the clip here
  // would reject good encodes just because ffprobe couldn't read the input's container.
  assert.equal(verdict(0, 42).ok, true);
});

test('#6 a REAL encode passes verification end-to-end (no false positive)', { skip: !HAVE_FFMPEG }, async () => {
  const { dir, cleanup } = tempDir('compress-ok-');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const src = makeVideo(dir, 'shot.mp4', { seconds: 2 });

  const r = await app.invoke('compress:run', {
    files: [{ name: 'shot.mp4', sourcePath: src }],
    outDir,
    settings: { codec: 'h264', crf: 30, preset: 'ultrafast', scale: 'source', audio: 'copy', skipExisting: false },
  });

  assert.equal(r.ok, true);
  const [res] = r.results;
  assert.equal(res.ok, true, `a genuine 2s encode must pass: ${res.error || ''}`);
  assert.equal(fs.existsSync(res.outPath), true, 'and it earns its real name in the Compressed folder');
  assert.equal(fs.existsSync(path.join(outDir, '.partial', 'shot.mp4')), false, 'no staged leftover');
  cleanup();
});

test('#6 a genuinely TRUNCATED file is rejected by the real probe + verdict', { skip: !HAVE_FFMPEG }, async () => {
  const { dir, cleanup } = tempDir('compress-trunc-');
  const full = makeVideo(dir, 'full.mp4', { seconds: 4 });

  // Read the real duration through the app's own uncached probe.
  const probeSec = async (p) => {
    const out = await app.call('runFfprobeJson', p);
    try { return parseFloat(JSON.parse(out || '{}').format?.duration) || 0; } catch { return 0; }
  };
  const srcSec = await probeSec(full);
  assert.ok(srcSec > 1, 'the fixture really is a multi-second video');

  // Truncate it the way a half-finished encode leaves a file: the bytes just stop.
  const cut = path.join(dir, 'cut.mp4');
  const buf = fs.readFileSync(full);
  fs.writeFileSync(cut, buf.subarray(0, Math.floor(buf.length * 0.3)));

  const cutSec = await probeSec(cut);
  const v = verdict(srcSec, cutSec);
  assert.equal(v.ok, false, `a 30%-truncated mp4 must be rejected (probed ${cutSec}s vs ${srcSec}s)`);
  cleanup();
});
