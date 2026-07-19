// Cheap, cached, REAL media fixtures for the E2E flow. Generated once with system ffmpeg into a
// gitignored .fixtures dir and reused every run (that's the "faster over time" part — no regen).
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
export const CLIPS_DIR = join(HERE, '.fixtures', 'clips');
export const FACES_DIR = join(HERE, '.fixtures', 'faces');

// A clip the face detector genuinely finds people in: face-api ships demo photos with real faces
// (sample1.jpg has three), looped into a short video so faces:frames can sample it. Cached.
export function ensureFacesFixture() {
  mkdirSync(FACES_DIR, { recursive: true });
  const p = join(FACES_DIR, 'GROUP_0001.mp4');
  if (!existsSync(p)) {
    const srcImg = join(REPO, 'node_modules', '@vladmandic', 'face-api', 'demo', 'sample1.jpg');
    execFileSync('ffmpeg',
      ['-y', '-loop', '1', '-i', srcImg, '-t', '2', '-r', '10', '-pix_fmt', 'yuv420p', '-vf', 'scale=640:-2', p],
      { stdio: 'ignore' });
  }
  const t = Date.parse('2026-06-03T12:00:00Z') / 1000;
  utimesSync(p, t, t);
  return FACES_DIR;
}

// A handful of tiny (160x120, ~1s) real .mp4 clips across two days, so the rename screen has cards to
// group by day. mtime is pinned to the intended date so date-from-mtime is deterministic.
const SPECS = [
  { name: 'CLIP_0001.mp4', date: '2026-06-01' },
  { name: 'CLIP_0002.mp4', date: '2026-06-01' },
  { name: 'CLIP_0003.mp4', date: '2026-06-01' },
  { name: 'CLIP_0004.mp4', date: '2026-06-01' },
  { name: 'CLIP_0005.mp4', date: '2026-06-02' },
  { name: 'CLIP_0006.mp4', date: '2026-06-02' },
  { name: 'CLIP_0007.mp4', date: '2026-06-02' },
  { name: 'CLIP_0008.mp4', date: '2026-06-02' },
];

export function ensureClipFixtures() {
  mkdirSync(CLIPS_DIR, { recursive: true });
  for (const s of SPECS) {
    const p = join(CLIPS_DIR, s.name);
    if (!existsSync(p)) {
      execFileSync('ffmpeg',
        ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10', '-pix_fmt', 'yuv420p', p],
        { stdio: 'ignore' });
    }
    const t = Date.parse(`${s.date}T12:00:00Z`) / 1000;
    utimesSync(p, t, t);   // pin mtime → deterministic capture date
  }
  return CLIPS_DIR;
}

export const CLIP_COUNT = SPECS.length;
