// Audit #64 — compression only ever ran libx265/libx264 on the CPU, despite an RTX 3060.
//
// This is the slowest step in the whole pipeline: 4K GoPro footage through x265 `medium` is minutes
// per clip, and NVENC is typically 5-20x faster.
//
// SHIPPED OPT-IN, DEFAULT OFF, deliberately. The CRF→CQ mapping decides the quality of his PERMANENT
// compressed archive, and visual quality cannot be validated from WSL (no NVIDIA device here). The
// probe, the plumbing and the CPU fallback ARE verifiable, so those are what land; turning it on by
// default needs one real comparison encode on his machine first. #6's duration verdict catches an
// INCOMPLETE encode but says nothing about whether the quality is right.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { HAVE_FFMPEG, tempDir, makeVideo } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// Mirror the real compress loop: probe when GPU is requested, then build the args with that result.
const args = async (s) => {
  const enc = s.gpu ? app.plain(await app.call('probeEncoders')) : null;
  return app.plain(app.call('buildCompressArgs', '/in.mp4', '/out.mp4', s, enc));
};
const has = (a, flag, val) => { const i = a.indexOf(flag); return i >= 0 && (val === undefined || a[i + 1] === val); };

beforeEach(() => { app.call('resetEncoderProbe'); app.get('config').compressGpu = false; });

// --- REACHABILITY ------------------------------------------------------------------------------
// The feature is opt-in, which is only meaningful if there is a way to opt IN. When first written
// `s.gpu` was read in three places and set NOWHERE — the renderer sends {preset, skipExisting} — so
// the whole thing was dead code, the exact shape audit #40 was about. These pin the switch.

test('#64 there IS a way to turn it on — config.compressGpu reaches the settings', async () => {
  app.get('config').compressGpu = true;
  const s = app.plain(await app.invoke('compress:defaults'));
  void s;
  const settings = app.plain(app.call('compressSettings', { preset: 'balanced' }));
  assert.equal(settings.gpu, true, 'the config flag arrives as s.gpu — without this #64 is unreachable');
});

test('#64 it is OFF unless the config says otherwise', async () => {
  const settings = app.plain(app.call('compressSettings', { preset: 'balanced' }));
  assert.equal(settings.gpu, false, 'default install encodes exactly as before');
});

test('#64 an explicit override still wins over the config flag', async () => {
  app.get('config').compressGpu = true;
  const settings = app.plain(app.call('compressSettings', { preset: 'balanced', overrides: { gpu: false } }));
  assert.equal(settings.gpu, false, 'a per-run override can force CPU');
});

test('#64 default is unchanged — CPU x265, no GPU flags', async () => {
  // The whole point of opt-in: an existing install must encode EXACTLY as before.
  const a = await args({ codec: 'h265', crf: 28, preset: 'medium' });
  assert.ok(has(a, '-c:v', 'libx265'), 'still libx265');
  assert.ok(has(a, '-crf', '28'), 'still CRF');
  assert.equal(a.some((x) => String(x).includes('nvenc')), false, 'no GPU encoder');
});

test('#64 with GPU requested AND available, it uses hevc_nvenc', async () => {
  app.call('setEncoderProbeForTest', { hevc_nvenc: true, h264_nvenc: true });
  const a = await args({ codec: 'h265', crf: 28, preset: 'medium', gpu: true });
  assert.ok(has(a, '-c:v', 'hevc_nvenc'), 'hardware encoder');
  assert.ok(has(a, '-tag:v', 'hvc1'), 'still QuickTime-compatible — Resolve/Finder need this tag');
  assert.ok(has(a, '-cq', '28'), 'NVENC takes -cq; -crf is silently IGNORED by it');
  assert.equal(has(a, '-crf'), false, 'so -crf must not be sent at all');
});

test('#64 GPU requested but NOT available falls back to CPU', async () => {
  // The direction that must never break: no NVIDIA, a laptop, a driver update — encoding continues.
  app.call('setEncoderProbeForTest', { hevc_nvenc: false, h264_nvenc: false });
  const a = await args({ codec: 'h265', crf: 28, preset: 'medium', gpu: true });
  assert.ok(has(a, '-c:v', 'libx265'), 'falls back to CPU');
  assert.ok(has(a, '-crf', '28'), 'and back to CRF');
});

test('#64 h264 uses h264_nvenc and keeps its pixel format', async () => {
  app.call('setEncoderProbeForTest', { hevc_nvenc: true, h264_nvenc: true });
  const a = await args({ codec: 'h264', crf: 23, preset: 'medium', gpu: true });
  assert.ok(has(a, '-c:v', 'h264_nvenc'));
  assert.ok(has(a, '-pix_fmt', 'yuv420p'), 'yuv420p is what makes it play everywhere');
});

test('#64 a partial probe result is respected per-codec', async () => {
  // Some drivers expose h264_nvenc but not hevc_nvenc. Asking for h265 must not silently emit an
  // encoder ffmpeg does not have — that fails the whole batch.
  app.call('setEncoderProbeForTest', { hevc_nvenc: false, h264_nvenc: true });
  const a = await args({ codec: 'h265', crf: 28, preset: 'medium', gpu: true });
  assert.ok(has(a, '-c:v', 'libx265'), 'h265 falls back');
  const b = await args({ codec: 'h264', crf: 23, preset: 'medium', gpu: true });
  assert.ok(has(b, '-c:v', 'h264_nvenc'), 'h264 still accelerates');
});

test('#64 the probe TEST-ENCODES rather than trusting `ffmpeg -encoders`', async () => {
  // Verified on this WSL box: `ffmpeg -encoders` lists 5 nvenc encoders and NONE of them work.
  // A listing-based probe would pick a hardware encoder on a machine with no NVIDIA driver and fail
  // every clip, so availability must come from a real encode's exit code.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(ROOT, 'main-mod/09-ipc-boot.js'), 'utf8');
  const probe = src.slice(src.indexOf('async function canEncode('), src.indexOf('function buildCompressArgs('));
  assert.match(probe, /canEncode\(/, 'availability comes from a functional encode');
  assert.match(probe, /code === 0/, 'success is the exit code, not the presence of a name in a list');
  assert.match(probe, /320x240/, 'and the probe frame clears NVENC minimum dimensions');
  assert.equal(/'-encoders'/.test(probe), false, 'the encoder LISTING is not used as availability');
});

test('#64 a FAILED probe is not cached as "no GPU"', async () => {
  // The latch lesson from the AI work (AGENTS §7a): caching a failure sentinel turns one transient
  // blip into a permanent wrong answer for the whole session.
  app.get('globalThis').__ffmpegEncoderProbe = null;   // simulated probe failure
  const first = app.plain(await app.call('probeEncoders'));
  assert.equal(first.hevc_nvenc, false, 'this run reports no GPU');
  app.get('globalThis').__ffmpegEncoderProbe = { hevc_nvenc: true, h264_nvenc: true };
  const second = app.plain(await app.call('probeEncoders'));
  assert.equal(second.hevc_nvenc, true, 'and a later probe can still discover it');
});

test('#64 END-TO-END: enabling the flag on a machine with NO usable GPU still encodes correctly',
  { skip: !HAVE_FFMPEG }, async () => {
  // This box is the perfect adversarial case: `ffmpeg -encoders` LISTS nvenc, but no encode works.
  // A listing-based probe would have selected hardware here and failed. With the functional probe,
  // turning the flag on must silently fall back and produce a real, complete file.
  const { dir, cleanup } = tempDir('gpu-e2e-');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const src = makeVideo(dir, 'shot.mp4', { seconds: 2 });

  app.get('config').compressGpu = true;          // the opt-in, on a machine that cannot honour it
  app.call('resetEncoderProbe');

  const r = await app.invoke('compress:run', {
    files: [{ name: 'shot.mp4', sourcePath: src }],
    outDir,
    settings: { preset: 'balanced', skipExisting: false },
  });

  assert.equal(r.ok, true);
  const [res] = r.results;
  assert.equal(res.ok, true, `the encode must still succeed: ${res.error || ''}`);
  assert.equal(fs.existsSync(res.outPath), true, 'and produce a real file');
  cleanup();
});
