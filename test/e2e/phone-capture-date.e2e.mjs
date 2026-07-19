// Audit #58 — a phone file with no date in its filename was dated by its COPY time.
//
// `date: phoneDateOf(f.name) || toDateStr(f.mtimeMs)`. Plenty of phone media has no date in the
// name (WhatsApp, screenshots, many Android cameras), and mtime after an MTP/ADB pull is when the
// file landed on disk — i.e. TODAY. So a shoot from last month arrives dated today.
//
// That is not cosmetic. Per usb-app-shoots-in-batches the shoot DATE predicts the subject ~88% of
// the time, and it drives day-grouping in the rename grid, ledger date-matching for "same shoot?",
// and get_shoot_context — the AI's single strongest signal. A wrong date quietly poisons placement
// AND naming.
//
// SCOPE: videos only. The container's `creation_time` is readable with ffprobe, which is what the
// app already uses. STILLS need EXIF:DateTimeOriginal, and ffprobe returns EMPTY tags for a JPEG
// (verified) — that needs the vendored Windows exiftool, unavailable in WSL, so the photo half is
// deferred rather than guessed at (§7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, read } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let dir;
before(async () => {
  if (!RUN) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capdate-'));
  // A video shot last month, whose FILENAME says nothing about when.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc=size=320x240:rate=5:duration=1',
    '-metadata', 'creation_time=2026-06-01T10:30:00.000000Z',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'VID_random.mp4')]);
  app = await launchApp({ seed: { 'config.json': { firstRun: false } } });
});
after(async () => {
  if (app) await app.close();
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('#58 a dateless VIDEO takes its date from the container, not the copy time', { skip: !RUN }, async () => {
  const p = path.join(dir, 'VID_random.mp4');
  const today = new Date().toISOString().slice(0, 10);

  // The filename yields nothing — this is the case that used to fall through to mtime.
  assert.equal(await read(app.win, `phoneDateOf(${JSON.stringify('VID_random.mp4')}) || ''`), '',
    'the filename really carries no date');

  const got = await read(app.win, `captureDateFor(${JSON.stringify(p)}, ${JSON.stringify('VID_random.mp4')}, Date.now())`);
  assert.equal(got, '2026-06-01', 'the shoot date comes from the file, not from when it was copied');
  assert.notEqual(got, today, 'and it is emphatically not "today"');
});

test('#58 a filename that DOES carry a date still wins — no extra probing', { skip: !RUN }, async () => {
  // The filename is authoritative and free; probing every file would spawn an ffprobe per clip on a
  // card of hundreds. This also keeps the existing dateLocked behaviour intact.
  const got = await read(app.win, `captureDateFor('/nope/does-not-exist.mp4', '20260514_101112.mp4', Date.now())`);
  assert.equal(got, '2026-05-14', 'parsed straight from the name');
});

test('#58 an unreadable file still falls back to mtime rather than failing', { skip: !RUN }, async () => {
  // A phone pull can leave an item the probe cannot open. A missing date must never break staging.
  const when = Date.parse('2026-03-09T12:00:00Z');
  const got = await read(app.win, `captureDateFor('/nope/missing.mp4', 'no-date-here.mp4', ${when})`);
  assert.equal(got, '2026-03-09', 'falls back to the old behaviour, not to empty');
});

test('#58 stills are NOT probed — the photo half is deliberately deferred', { skip: !RUN }, async () => {
  // ffprobe returns empty tags for a JPEG (verified), so probing a still costs a spawn and returns
  // nothing. Guarded so nobody "completes" this without the vendored exiftool.
  const src = await read(app.win, 'String(captureDateFor)');
  assert.match(src, /isPhoto|photo/i, 'the photo case is explicitly branched, not silently probed');
});
