// Synthetic test footage. The repo ships no binary fixtures on purpose — we generate
// real, decodable media with ffmpeg at test time instead, so the copy/verify/probe paths
// are exercised against actual files rather than mocks.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const HAVE_FFMPEG = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** A throwaway directory, auto-cleanable. */
export function tempDir(prefix = 'uvd-fx-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  return { dir: d, cleanup: () => { try { rmSync(d, { recursive: true, force: true }); } catch {} } };
}

/**
 * Write a real, decodable video. `seconds` controls size; `creation` stamps the
 * container's creation_time so date-extraction paths have something true to read.
 */
export function makeVideo(dir, name, { seconds = 1, size = '320x240', fps = 24, creation } = {}) {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  const args = [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ];
  if (creation) args.push('-metadata', `creation_time=${creation}`);
  args.push(out);
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
  return out;
}

/** A real JPEG. */
export function makeImage(dir, name, { size = '320x240' } = {}) {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, name);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc=size=${size}:rate=1:duration=1`, '-frames:v', '1', out], { stdio: 'ignore' });
  return out;
}

/** A fake SD-card layout: DCIM/100GOPRO/... with a few clips and a photo. */
export function makeCard(root, { clips = 3 } = {}) {
  const dcim = join(root, 'DCIM', '100GOPRO');
  mkdirSync(dcim, { recursive: true });
  const made = [];
  for (let i = 1; i <= clips; i += 1) {
    made.push(makeVideo(dcim, `GX01000${i}.MP4`, { seconds: 1, creation: `2026-07-0${i}T10:0${i}:00Z` }));
  }
  made.push(makeImage(dcim, 'GOPR0001.JPG'));
  return { dcim, files: made };
}

export { existsSync };
