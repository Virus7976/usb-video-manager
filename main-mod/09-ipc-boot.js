// ---------------------------------------------------------------------------
// Finalize / Organize — point at the Compressed folder, match files to their
// stored records, embed XMP, write a Resolve CSV, and file them into folders.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// IN-APP COMPRESSION — actually compress the Uncompressed intake clips with the
// bundled ffmpeg into the Compressed folder (so the app's "Compress" promise is
// real, not a handoff). Per-file H.264/H.265 transcode with live progress, skip
// of already-done outputs, cancellation, and partial-file cleanup.
// ---------------------------------------------------------------------------
const COMPRESS_PRESETS = {
  balanced:  { codec: 'h264', crf: 23, preset: 'medium', scale: '1080', audio: 'aac' },
  smaller:   { codec: 'h265', crf: 28, preset: 'medium', scale: '1080', audio: 'aac' },
  hq:        { codec: 'h264', crf: 20, preset: 'slow',   scale: 'source', audio: 'aac' },
};
function compressSettings(s) {
  const base = COMPRESS_PRESETS[(s && s.preset) || 'balanced'] || COMPRESS_PRESETS.balanced;
  // GPU encode is opt-in and CONFIG-ONLY (audit #64): set `"compressGpu": true` in config.json to
  // try NVENC. Deliberately not a default and deliberately not a checkbox — the CRF→CQ mapping
  // decides the quality of a permanent archive and wants one side-by-side encode before it is
  // recommended to anyone. This matches how the other advanced knobs work here (numCtx/numCtxMax):
  // a tool for a tool-user (PROMPT.md §1), not a settings screen for everything.
  //
  // Without this line the whole #64 feature was UNREACHABLE — read in three places, set nowhere.
  // Exactly the dead-code shape audit #40 was about, so it gets a test that it stays reachable.
  const gpu = !!(config && config.compressGpu);
  return { ...base, gpu, ...(s && s.overrides ? s.overrides : {}), skipExisting: !(s && s.skipExisting === false) };
}
// --- HARDWARE ENCODING (audit #64) ------------------------------------------------------------
//
// Compression is the slowest step in the pipeline: 4K GoPro footage through x265 `medium` is minutes
// per clip on a CPU, while the NVENC block on his RTX 3060 is typically 5-20x faster.
//
// SHIPPED OPT-IN, DEFAULT OFF (`s.gpu`). The CRF→CQ mapping decides the quality of his PERMANENT
// compressed archive, and visual quality cannot be validated from WSL — there is no NVIDIA device
// here. So the probe, the plumbing and the CPU fallback land now; switching the default on needs one
// real side-by-side encode on his machine. Note #6's duration verdict catches an INCOMPLETE encode
// but says nothing about whether the quality is right, so it is not a substitute for that check.
let _encoderProbe = null;
function resetEncoderProbe() { _encoderProbe = null; }                 // tests
function setEncoderProbeForTest(v) { _encoderProbe = v; }             // tests
// LISTING IS NOT AVAILABILITY. `ffmpeg -encoders` lists hevc_nvenc/h264_nvenc whenever ffmpeg was
// BUILT with them — verified on this WSL box, which reports 5 nvenc encoders and cannot use any of
// them. Trusting the list would select a hardware encoder on a machine with no NVIDIA driver and
// fail every single clip. So probe FUNCTIONALLY: run a tiny real encode and see whether it exits 0.
// (320x240 because NVENC refuses frames below its minimum dimensions — a 64x64 probe fails for the
// wrong reason and would report "no GPU" on a machine that has one.)
async function canEncode(name) {
  try {
    const r = await streamSpawn(config.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1:duration=0.1',
      '-c:v', name, '-f', 'null', '-',
    ], { timeoutMs: 20000 });
    return !!r && r.code === 0 && !r.timedOut;
  } catch { return false; }
}
async function probeEncoders() {
  if (_encoderProbe) return _encoderProbe;
  // Test seam: { hevc_nvenc: bool, h264_nvenc: bool } to stand in for the real encodes.
  const stub = globalThis.__ffmpegEncoderProbe;
  let found; let trustworthy = true;
  if (stub && typeof stub === 'object') {
    found = { hevc_nvenc: !!stub.hevc_nvenc, h264_nvenc: !!stub.h264_nvenc };
  } else if (stub === null) {
    found = { hevc_nvenc: false, h264_nvenc: false };   // simulated probe failure
    trustworthy = false;
  } else {
    const [hevc, h264] = await Promise.all([canEncode('hevc_nvenc'), canEncode('h264_nvenc')]);
    found = { hevc_nvenc: hevc, h264_nvenc: h264 };
  }
  // Only CACHE a probe we trust. Caching a failure would latch one transient blip into "this machine
  // has no GPU" for the whole session — the mistake the AI capability cache made with its null
  // sentinel (AGENTS §7a).
  if (trustworthy) _encoderProbe = found;
  return found;
}
function buildCompressArgs(src, out, s, enc) {
  const a = ['-y', '-i', src];
  // `scale` is interpolated into ONE -vf element, so a value like "720,transpose=1" would
  // append an extra filter to the graph. Not a shell injection (spawn takes an argv array,
  // no shell), but the height must still be a plain positive integer — anything else is
  // ignored rather than passed through to the filtergraph.
  const scaleH = Number(s.scale);
  // NEVER upscale: `scale=-2:720` on a 480p clip re-renders it to 720p — a bigger file with no
  // added detail (and slower). Clamp the target height to the source height via ffmpeg's own
  // expression min(target, ih); the comma inside the expression is escaped (\,) so the filtergraph
  // parser reads it as one argument, not a second filter. The argv is passed to spawn (no shell),
  // so the backslash reaches ffmpeg literally and it unescapes to a real comma.
  if (s.scale && s.scale !== 'source' && Number.isInteger(scaleH) && scaleH > 0) a.push('-vf', `scale=-2:min(${scaleH}\\,ih)`);
  // Hardware path only when explicitly asked for AND the probe saw that exact encoder. A partial
  // driver (h264_nvenc present, hevc_nvenc missing) is common, so this is decided per-codec —
  // emitting an encoder ffmpeg doesn't have fails the whole batch.
  const gpu = !!(s.gpu && enc);
  const wantHevc = s.codec === 'h265';
  const hw = gpu && ((wantHevc && enc.hevc_nvenc) || (!wantHevc && enc.h264_nvenc));
  if (hw && wantHevc) {
    // NVENC ignores -crf; quality comes from -cq. Same number is a deliberate STARTING point, not a
    // validated equivalence — see the note above buildCompressArgs before turning this on by default.
    a.push('-c:v', 'hevc_nvenc', '-tag:v', 'hvc1', '-cq', String(s.crf ?? 28));
  } else if (hw) {
    a.push('-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p', '-cq', String(s.crf ?? 23));
  } else if (wantHevc) {
    a.push('-c:v', 'libx265', '-tag:v', 'hvc1', '-crf', String(s.crf ?? 28));
  } else {
    a.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(s.crf ?? 23));
  }
  a.push('-preset', s.preset || 'medium');
  if (s.audio === 'copy') a.push('-c:a', 'copy'); else a.push('-c:a', 'aac', '-b:a', '160k');
  a.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out);
  return a;
}
// Is a finished encode actually COMPLETE? ffmpeg exiting 0 is NOT proof: given a source with a
// corrupt tail (or a read that ends early) it writes a short file and still exits 0. Nothing else
// between here and the Compressed folder checks anything — the staged file is renamed to its real
// name and organized as "done" — and because the delete gate only compares card↔intake, the card is
// then legitimately cleared. That can leave a SHORT clip as the only surviving copy of a shot.
//
// Durations are ffprobe seconds. The tolerance exists because a re-encode can legitimately land a
// hair short (GOP/timebase rounding); it stays far tighter than any real truncation. Erring the
// other way matters too — too tight a bound would start rejecting genuine encodes.
function compressOutputVerdict(srcSec, outSec) {
  if (!(outSec > 0)) return { ok: false, error: 'the compressed file has no readable video duration — the encode did not finish' };
  // Source duration unknown (ffprobe couldn't read the input container) → nothing to compare
  // against. A probeable output is all we can honestly assert; failing here would reject good work.
  if (!(srcSec > 0)) return { ok: true };
  const shortfall = srcSec - outSec;
  const tol = Math.max(0.5, srcSec * 0.02);
  if (shortfall > tol) {
    return { ok: false, error: `compressed clip is ${shortfall.toFixed(1)}s shorter than the source (${outSec.toFixed(1)}s vs ${srcSec.toFixed(1)}s) — the encode did not finish` };
  }
  return { ok: true };
}
function ffmpegLastError(err) {
  const lines = String(err || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}
let compressProc = null;
let compressAborted = false;
ipcMain.handle('compress:cancel', () => { compressAborted = true; if (compressProc) treeKill(compressProc); return true; });
ipcMain.handle('compress:defaults', () => {
  let outDir = config.finalizeSource || '';
  if (!outDir && config.intakeFolder) outDir = config.intakeFolder.replace(/01 - Uncompressed[\\/]?$/i, '02 - Compressed');
  return { intake: config.intakeFolder || '', outDir, presets: Object.keys(COMPRESS_PRESETS), mode: config.compressMode || 'external' };
});
ipcMain.handle('compress:list', async (_e, dir) => {
  const d = dir || config.intakeFolder;
  if (!d) return { ok: false, error: 'No source folder' };
  try { return { ok: true, dir: d, files: await listVideosShallow(d) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
let compressRunning = false;
ipcMain.handle('compress:run', async (evt, payload) => {
  const { files, outDir } = payload || {};
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'No files to compress' };
  // ⚠ RE-ENTRANCY GUARD, the same one copy:start decided it needed. Two concurrent runs share the
  // `compressProc` and `compressAborted` globals, and this handler ends with an unconditional
  // `fsp.rm(join(out, '.partial'), { recursive: true, force: true })` — so run A's sweep would delete
  // run B's in-flight staged encode, and compress:cancel would kill whichever process happened to be
  // current. The renderer's `cmpState.running` plus the modal make a second invocation hard to reach,
  // which is why this was never hit; but "hard to reach from the UI" is not a guarantee for a handler
  // that spawns processes and deletes a directory.
  if (compressRunning) return { ok: false, error: 'A compression run is already going' };
  const out = outDir || config.finalizeSource;
  if (!out) return { ok: false, error: 'No output (Compressed) folder set' };
  try { await ensureDir(out); } catch (e) { return { ok: false, error: `Cannot create output folder: ${e.message}` }; }
  const s = compressSettings(payload && payload.settings);
  compressAborted = false;
  // Set AFTER the validation early-returns above, so a rejected call never claims the slot. Released
  // in the finally at the end: leaking it would disable compression until the app restarts, which is
  // a worse failure than the double-run it prevents.
  compressRunning = true;
  try {
  const results = [];
  const produced = new Set();   // output paths created THIS run, to avoid collisions
  const send = (p) => { try { evt.sender.send('compress:progress', p); } catch { /* ignore */ } };
  for (let i = 0; i < files.length; i += 1) {
    if (compressAborted) break;
    const f = files[i];
    const src = f.sourcePath || f.src || f.path;
    if (!src) { results.push({ name: f.name, ok: false, error: 'No source path' }); continue; }
    const base = path.basename(f.name || src).replace(/\.[^.]+$/, '');
    let outPath = path.join(out, `${base}.mp4`);
    if (pathsEqual(outPath, src)) outPath = path.join(out, `${base}_compressed.mp4`);
    // Two source clips that share a stem but differ in container (clip.mov + clip.mp4)
    // would map to the same output — disambiguate so neither is lost/overwritten. Keyed
    // case-insensitively so Clip.mp4/clip.mp4 collide on Windows (they're one file).
    let cn = 1;
    while (produced.has(pathKey(outPath))) { outPath = path.join(out, `${base} (${cn}).mp4`); cn += 1; }
    produced.add(pathKey(outPath));
    let inBytes = 0; try { inBytes = (await fsp.stat(src)).size; } catch { /* ignore */ }
    let durationSec = 0; try { durationSec = (await probeMeta(src)).durationSec || 0; } catch { /* ignore */ }
    // `skipExisting` (default ON) used to accept ANY non-empty file at outPath as "already done".
    // ffmpeg wrote straight to outPath, and the rm-the-partial cleanup below only runs when ffmpeg
    // exits cleanly with a non-zero code — so a crash, a power cut, or just quitting the app
    // mid-encode left a plausible, truncated .mp4 sitting there. The next run skipped it, reported
    // ok, and it was organized into Projects. The delete gate only compares card↔intake, so the card
    // was legitimately cleared: the truncated compressed clip could end up the ONLY surviving copy.
    //
    // Now the encode is STAGED. A partial can only ever be a file inside .partial/, which
    // listVideosShallow never sees (it lists files, not directories, at the top level only). So a
    // .mp4 at outPath can only exist because an encode actually finished, and skipping it is safe.
    if (s.skipExisting) { try { const st = await fsp.stat(outPath); if (st.size > 0) { results.push({ name: f.name, ok: true, skipped: true, outPath, inBytes, outBytes: st.size }); send({ index: i, total: files.length, name: f.name, pct: 100, phase: 'skipped' }); continue; } } catch { /* not there */ } }
    send({ index: i, total: files.length, name: f.name, pct: 0, phase: 'starting', inBytes });
    // Keep the .mp4 extension — ffmpeg picks its muxer from it, so a bare ".part" would break the
    // container. The DIRECTORY is what hides it.
    const partDir = path.join(out, '.partial');
    await ensureDir(partDir);
    const partPath = path.join(partDir, path.basename(outPath));
    try { await fsp.rm(partPath, { force: true }); } catch { /* no leftover */ }
    // Probe once per run; a machine without NVENC just gets the CPU path (audit #64).
    // eslint-disable-next-line no-await-in-loop
    const enc = s.gpu ? await probeEncoders() : null;
    const args = buildCompressArgs(src, partPath, s, enc);
    // eslint-disable-next-line no-await-in-loop
    const res = await new Promise((resolve) => {
      let errBuf = '';
      let wedged = false;
      const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
      compressProc = proc;
      // Idle watchdog — every other ffmpeg call in the app has one; compress didn't. ffmpeg streams
      // `out_time=` progress ~1/sec, so 10 min of TOTAL silence means it's wedged inside a bad-codec
      // clip (the killAfter comment warns these "stall forever"). Kill it so one bad input can't hang
      // the whole batch; the .part is discarded and the clip is reported failed, not stuck.
      let idle = null;
      const bump = () => { clearTimeout(idle); idle = setTimeout(() => { wedged = true; try { treeKill(proc); } catch { /* ignore */ } }, 10 * 60 * 1000); };
      bump();
      proc.stdout.on('data', (d) => {
        bump();
        const m = String(d).match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (!m) return;
        if (durationSec) {
          const sec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          send({ index: i, total: files.length, name: f.name, pct: Math.max(1, Math.min(99, Math.round((sec / durationSec) * 100))), phase: 'compressing', inBytes });
        } else {
          // ffprobe couldn't read a duration → no %; show that it's working, not stuck at 0%.
          send({ index: i, total: files.length, name: f.name, phase: 'compressing', indeterminate: true, inBytes });
        }
      });
      proc.stderr.on('data', (d) => { bump(); errBuf += String(d); if (errBuf.length > 6000) errBuf = errBuf.slice(-6000); });
      proc.on('error', (e) => { clearTimeout(idle); compressProc = null; resolve({ ok: false, error: e.message }); });
      proc.on('close', (code) => { clearTimeout(idle); compressProc = null; resolve(code === 0 ? { ok: true } : { ok: false, error: wedged ? 'stalled — no progress for 10 min (skipped)' : (compressAborted ? 'cancelled' : (ffmpegLastError(errBuf) || `ffmpeg exited ${code}`)) }); });
    });
    if (res.ok) {
      // ffmpeg exited 0 — which is NOT the same as "the encode is complete" (see
      // compressOutputVerdict). Measure the staged file BEFORE it earns its real name, so nothing
      // that isn't a finished clip can ever appear in the Compressed folder.
      //
      // Probe via runFfprobeJson, NOT probeMeta: probeMeta memoises by path, and the staged path is
      // deterministic (out/.partial/<name>.mp4), so a cached duration from an earlier clip or an
      // earlier run would be compared instead of this file's.
      let outSec = 0;
      // eslint-disable-next-line no-await-in-loop
      try { const j = JSON.parse((await runFfprobeJson(partPath)) || '{}'); outSec = parseFloat(j.format && j.format.duration) || 0; } catch { /* unprobeable → the verdict below fails it */ }
      const verdict = compressOutputVerdict(durationSec, outSec);
      if (!verdict.ok) {
        // Discard the staged file. The SOURCE is untouched, so this clip is simply reported failed
        // and can be retried — far better than filing a short clip and clearing the card behind it.
        try { await fsp.rm(partPath, { force: true }); } catch { /* ignore */ }
        results.push({ name: f.name, ok: false, error: verdict.error });
        send({ index: i, total: files.length, name: f.name, pct: 0, phase: 'error', error: verdict.error });
        continue;
      }
      let outBytes = 0;
      try {
        await flushToDisk(partPath);
        await fsp.rename(partPath, outPath);
        outBytes = (await fsp.stat(outPath)).size;
      } catch (err) {
        try { await fsp.rm(partPath, { force: true }); } catch { /* ignore */ }
        results.push({ name: f.name, ok: false, error: `Could not finish ${path.basename(outPath)}: ${err.message}` });
        send({ index: i, total: files.length, name: f.name, pct: 0, phase: 'error', error: err.message });
        continue;
      }
      results.push({ name: f.name, ok: true, outPath, inBytes, outBytes });
      send({ index: i, total: files.length, name: f.name, pct: 100, phase: 'done', inBytes, outBytes });
    } else {
      try { await fsp.rm(partPath, { force: true }); } catch { /* ignore */ }   // never leave a half-written file
      results.push({ name: f.name, ok: false, error: res.error });
      send({ index: i, total: files.length, name: f.name, pct: 0, phase: 'error', error: res.error });
      if (compressAborted) break;
    }
  }
  // Sweep the staging dir: an encode killed by a crash or a power cut leaves a file here, and it
  // would otherwise sit around forever. It was never visible to the Organize scan, so this is
  // housekeeping, not a safety fix — the safety came from it never being at outPath in the first place.
  try { await fsp.rm(path.join(out, '.partial'), { recursive: true, force: true }); } catch { /* ignore */ }
  // Point Finalize at where we just wrote, so "Organize" continues seamlessly.
  if (out && out !== config.finalizeSource) { config.finalizeSource = out; saveConfig(); }
  const okCount = results.filter((r) => r.ok && !r.skipped).length;
  // Only claim completion when something actually encoded. `ok: !compressAborted` meant a run in
  // which every single clip failed still returned ok:true, and the renderer's headline then read
  // "Compressed 0 clips · 12 failed ✓" — tick included. This is the third instance of that pattern
  // (after "AI auto-enhance complete ✓" and "Filed N …✓"); the per-file errors do reach logIssue, so
  // the information existed and only the headline contradicted it.
  const failedCount = results.filter((r) => r && !r.ok).length;
  if (!compressAborted && okCount) notify('Compression complete', `Compressed ${okCount} clip${okCount !== 1 ? 's' : ''} into your Compressed folder.`);
  else if (!compressAborted && failedCount) notify('Compression failed', `None of the ${failedCount} clip${failedCount !== 1 ? 's' : ''} could be compressed.`);
  return { ok: !compressAborted && (okCount > 0 || failedCount === 0), cancelled: compressAborted, results, outDir: out, okCount, failedCount };
  } finally { compressRunning = false; }
});

// ⚠⚠ THE LAST WALL IN THE FILING CORRIDOR. This returned ONLY `config.finalizeSource`, and the
// Organize screen uses it to decide whether to scan at all:
//
//     const src = await window.api.getFinalizeSource();
//     finScan.dir = src || '';
//     if (src) finRunScan();          // …else render an empty state
//     …and finRunScan() itself opens `if (!finScan.dir) return;`
//
// So with no explicit source chosen, the screen opened EMPTY — while `finalize:scan` on the very
// same page returned 8 files, because it resolves the source itself. Measured in the real app:
// `finScan.dir: none`, `window.api.finalizeScan({})` → 8 files. He clicks the card that says
// footage is ready, lands on a screen showing nothing, and nothing explains why.
//
// It answers with the same ladder everything else uses now, so the card, the screen and the run all
// agree about where the footage is. `finalize:pickSource` still overrides it whenever he chooses.
ipcMain.handle('finalize:getSource', () => config.finalizeSource || organizeSourceDir() || '');

ipcMain.handle('finalize:pickSource', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your Compressed folder',
    defaultPath: config.finalizeSource || config.organizeDest || undefined,
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  config.finalizeSource = res.filePaths[0];
  saveConfig();
  return config.finalizeSource;
});

// "Pending work" for the home screen: how much footage is sitting in the Uncompressed
// intake (still to compress, then organize) vs. already in the Compressed folder ready
// to organize now. Lets the app greet you on launch with "you've got footage to deal
// with" and jump straight into organizing — the per-clip AI analysis is already
// remembered (finalMeta), so nothing re-analyzes.
// ⚠⚠ ONE ANSWER TO "WHERE IS THE FOOTAGE READY TO FILE?" — used by BOTH the Home card and the
// screen it opens.
//
// These disagreed. `finalize:scan` resolved `finalizeSource || compressedFolder || intakeFolder`;
// `pending:work` resolved `finalizeSource || organizeDest`. So the counter that decides whether the
// Home card appears, and the screen that card opens, looked in different places. Measured on a config
// with `compressedFolder` set and nothing else: the scan found 8 clips, and pending:work reported
// `readyDir: "", ready: 0` — the card could never appear at all, for footage the app could see.
//
// That is PROMPT.md §5.4: an invariant applied to one path and not its sibling. The durable fix is
// not to copy the ladder into both, it is to have ONE ladder they both call.
function organizeSourceDir() {
  return config.finalizeSource || config.compressedFolder || config.intakeFolder || '';
}

ipcMain.handle('pending:work', async () => {
  const intakeDir = config.intakeFolder || '';
  const readyDir = organizeSourceDir();
  let uncompressed = 0; let ready = 0; let readyTotal = 0; let readyAnalyzed = 0;
  try { uncompressed = (await listVideosShallow(intakeDir)).length; } catch { /* ignore */ }
  // STILLS IN THE INTAKE, counted separately — because the advice for them is the opposite.
  // Measured: his `01 - Uncompressed` holds 203 app-named photos and ZERO videos, so this card
  // reported nothing at all while 203 files sat there. Worse, had it counted them together the card
  // would have said "compress them first", and photos are NEVER compressed — Tdarr only takes video,
  // so that is advice which can never come true. They are ready to organize as they are (verified:
  // 203/203 file cleanly).
  let uncompressedPhotos = 0;
  try { uncompressedPhotos = (await listImagesShallow(intakeDir)).length; } catch { /* ignore */ }
  // ⚠⚠ THE SAME "offline is not empty" RULE, one level up — and here it is worse.
  //
  // `finalize:scan` now says plainly when a folder is unreachable. This one fed the Home card, and an
  // unreachable archive produced `ready: 0` — so the card simply DISAPPEARED. He opens the app with
  // his `L:` drive unplugged and there is no footage waiting, no explanation, and nothing to click.
  // A wrong number is bad; a silently missing card is worse, because there is nothing to question.
  let readyUnreachable = false;
  if (readyDir) {
    try { await fsp.access(readyDir); } catch { readyUnreachable = true; }
  }
  if (readyDir && !readyUnreachable && readyDir !== intakeDir) {
    try {
      const files = await listVideosShallow(readyDir);
      readyTotal = files.length;
      // COUNT WHAT IS LEFT, not what is in the folder. Filing COPIES, so a filed clip stays in the
      // Compressed folder — the card said "310 clips ready to organize" forever, however much work he
      // did. A number that never moves is a number he stops reading, and then the card meant to pull
      // him into the work becomes wallpaper. Same source of truth as the Organize list (the project
      // ledger's clipNames), so the two screens can never disagree.
      //
      // Fails toward SHOWING work: a ledger problem leaves everything counted, because
      // under-reporting is how this card silently stops doing its job.
      const filed = new Set();
      try {
        for (const rec of (config.projectLedger || [])) {
          for (const n of ((rec && rec.clipNames) || [])) filed.add(String(n || '').toLowerCase());
        }
      } catch { /* ignore */ }
      ready = files.filter((f) => !filed.has(String(f.name || '').toLowerCase())).length;
      const store = currentFinalMeta();
      const stems = new Set(Object.keys(store).map((k) => stemOf(k)));
      for (const f of files) { const lc = f.name.toLowerCase(); if (store[lc] || stems.has(stemOf(lc))) readyAnalyzed += 1; }
    } catch { /* ignore */ }
  }
  // THE WORK HE ACTUALLY ABANDONED. Everything above counts FILES IN FOLDERS; none of it can see a
  // half-finished face review, which on his real store is 458 clusters — the largest pile of
  // part-done work he has, invisible on every launch. His click log shows 267 face confirmations, so
  // he does this work; he just never gets told there is a partly-finished job to walk back into.
  //
  // Only UNREVIEWED clusters count. One he named (`done`), dismissed (`skipped`) or rejected is
  // finished business, and a number that never drops is one he learns to ignore.
  //
  // ensureStore first: ai.facesPending is LAZY, and an unloaded lazy store reads as undefined and
  // would silently report 0 — the same bug class that let the face-crop GC delete every crop.
  // Best-effort: nothing here is worth failing a launch over.
  let facesPending = 0;
  try {
    ensureStore('ai.facesPending');
    const pend = (config.ai && config.ai.facesPending) || [];
    if (Array.isArray(pend)) facesPending = pend.filter((c) => c && !c.done && !c.skipped && !c.rejected).length;
  } catch { facesPending = 0; }

  return { ok: true, intakeDir, readyDir, readyUnreachable, uncompressed, uncompressedPhotos, ready, readyTotal, readyAnalyzed, facesPending };
});

// Scan the (top level of the) Compressed folder and match each file to a stored
// record by exact filename, falling back to a stem match (so a container change
// during compression, e.g. .mov → .mp4, still matches).
ipcMain.handle('finalize:scan', async (_evt, sourceDir) => {
  // Accept either a plain path (legacy) or { dir, includePhotos } so the Organize screen
  // can opt into listing photos alongside (or instead of) videos.
  const opts = (sourceDir && typeof sourceDir === 'object') ? sourceDir : { dir: sourceDir };
  // ⚠⚠ FALL BACK TO WHERE THE FOOTAGE ACTUALLY IS, RATHER THAN DEAD-ENDING.
  //
  // This was `opts.dir || config.finalizeSource`, and on a fresh install NOTHING is set — so the
  // Organize screen answered "No folder chosen" and the app looked broken to anyone who had not
  // already built Jake's exact folder layout. Measured on a clean profile: `intakeFolder` has a
  // sensible default (`<Videos>/USB Auto-Action/01 - Uncompressed`), `compressedFolder` and
  // `finalizeSource` are undefined, and `finalize:scan` refused.
  //
  // Jake, 2026-07-22: *"build it as if it was an application that worked without all the compression
  // folders and stuff and just worked."* Compression is OPTIONAL — plenty of people never encode at
  // all — so a missing Compressed folder must not mean "you cannot organize". Footage that was never
  // compressed is sitting in intake, which is exactly where his own 203 photos are: they never get
  // compressed, so they never reach `02 - Compressed`, so Organize has never been able to see them.
  //
  // `usedDir`/`usedFallback` travel back so the UI can SAY which folder it is showing. Silently
  // scanning somewhere other than the folder he thinks is configured would be its own bug.
  const dir = opts.dir || organizeSourceDir();
  const usedFallback = !opts.dir && !config.finalizeSource
    ? (config.compressedFolder ? 'compressed' : (config.intakeFolder ? 'intake' : ''))
    : '';
  if (!dir) return { ok: false, error: 'No folder chosen' };

  // ⚠⚠ "OFFLINE" AND "EMPTY" ARE DIFFERENT STATES — his own rule, from the Android app this one is
  // measured against: *a fetch that failed must never render as "you have nothing".*
  //
  // `listVideosShallow` catches its own errors and returns `[]`, so an unreachable folder produced
  // `{ ok: true, total: 0 }` — byte-identical to a folder with nothing in it. His archive lives on
  // `L:`, which is not always connected. Measured: with the folder present, 5 files; with it gone,
  // `ok:true total:0 error:none`. The app would have told him he had nothing to organize while it
  // simply could not see 310 clips.
  //
  // A missing drive is not a failure to report as an error either — it is a fact to state plainly,
  // so this returns ok:false with `unreachable` for the UI to word properly.
  try {
    await fsp.access(dir);
  } catch {
    return {
      ok: false,
      unreachable: true,
      dir,
      error: `Can’t reach ${dir} right now — if that drive is unplugged or the network share is offline, your footage is still there. Reconnect it and try again.`,
    };
  }
  let files;
  // COUNT THE PHOTOS EVEN WHEN WE ARE NOT LISTING THEM. Measured on his real setup: `01 - Uncompressed`
  // holds 203 app-named stills, and photos are never compressed, so they never reach the Compressed
  // folder this screen scans. With the toggle off the screen said "This folder has no video files",
  // which is true and useless — it cannot distinguish an empty folder from 203 photos one tick away.
  // Reporting the count lets the screen say which it is; it does NOT change what gets listed.
  let photosHere = 0;
  try {
    files = await listVideosShallow(dir);
    if (opts.includePhotos) {
      const imgs = await listImagesShallow(dir);
      photosHere = imgs.length;
      files = files.concat(imgs);
    } else {
      try { photosHere = (await listImagesShallow(dir)).length; } catch { photosHere = 0; }
    }
  } catch (err) { return { ok: false, error: err.message }; }

  // WHAT HAS HE ALREADY DONE? Filing COPIES, so his clips stay in the Compressed folder afterwards
  // and this scan lists them again — the same 310 rows, with nothing to show that any were filed.
  // Doing the work never made the pile smaller, and "Select all → Run" would re-file the lot.
  //
  // The project ledger already knows: it records `clipNames` per project, and since it finally
  // receives entries from his no-plan runs (2026-07-19bq) it is the store that makes progress
  // visible. No new bookkeeping needed. Best-effort — a ledger problem must never break a scan.
  const filedIn = new Map();
  try {
    for (const rec of (config.projectLedger || [])) {
      for (const n of ((rec && rec.clipNames) || [])) {
        const k = String(n || '').toLowerCase();
        if (k && !filedIn.has(k)) filedIn.set(k, rec.rel || rec.name || '');
      }
    }
  } catch { /* ignore — nothing here is worth failing a scan over */ }

  const store = currentFinalMeta();
  const byName = {}; const byStem = {};
  for (const [k, v] of Object.entries(store)) {
    // LOWERCASE THE KEY. The lookup below is `byName[f.name.toLowerCase()]`, so an index built from
    // the raw store key could only ever match a record whose filename was already lowercase. Records
    // are written under `finalName(clip)` — the real filename, and his are GoPro clips that keep
    // capitals (GX010042.MP4) — so a clip he had named and described came back from finalize:scan as
    // "no metadata", indistinguishable from one the AI never touched. Both sides normalise now.
    const lk = String(k).toLowerCase();
    byName[lk] = v;
    byStem[stemOf(lk)] = v;
  }
  // Token set of a filename stem (drop version/ext/camera junk) for FUZZY matching —
  // recovers the saved record (incl. observation/people) even if the compressor
  // renamed the file (different separators, an added suffix, a dropped token…).
  const fileTokens = (s) => new Set(String(s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/_v\d+$/i, '')
    .split(/[\s\-_.]+/).filter((t) => t && t.length > 1 && !/^(gx|gopro|hero|dji|img|dsc|mvi|mp4|mov|avi)\w*$/i.test(t)));
  const tokenScore = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n += /^\d{4}-\d{2}-\d{2}$/.test(t) ? 3 : 1; return n; };   // a shared date counts strong
  const storeEntries = Object.entries(store).map(([k, v]) => ({ v, tokens: fileTokens(k) }));
  const out = await Promise.all(files.map(async (f) => {
    const lc = f.name.toLowerCase();
    let rec = byName[lc] || byStem[stemOf(lc)] || null;
    let matchType = rec ? 'saved' : null;
    // ASK THE FILE. If the clip still carries the record we embedded at copy time, that is the
    // real answer — no guessing, no sidecar, and it works on another machine or after the sidecar
    // has been pruned. Only reached on a store miss, which is exactly the case where the
    // compressor renamed the file — so we pay the exiftool read precisely when it earns its keep.
    // Photos now carry the embedded record too (phone:distribute), so recover from a PHOTO on a store
    // miss as well — the `!f.isPhoto` gate defeated the round-trip for exactly the format where reading
    // XMP is cheapest. Only fires on `!rec` (a store miss), so it's not a per-photo cost in the common case.
    if (!rec) {
      const embedded = await readEmbeddedRecord(f.sourcePath);
      if (embedded) { rec = embedded; matchType = 'embedded'; }
    }
    if (!rec && storeEntries.length) {
      // Fuzzy: best token-overlap against the saved records; needs a strong match
      // (e.g. shared date + ≥1 subject token) so unrelated files don't false-match.
      const ft = fileTokens(f.name); let best = null; let bestScore = 0;
      for (const e of storeEntries) { const s = tokenScore(ft, e.tokens); if (s > bestScore) { bestScore = s; best = e.v; } }
      if (best && bestScore >= 4) { rec = best; matchType = 'fuzzy'; }
    }
    if (!rec) {
      const parsed = parseNamedClip(f.name);   // last resort: derive from the filename
      if (parsed) { rec = parsed; matchType = 'name'; }
    }
    // Photos almost never have a saved record yet (IMG_1234.jpg), but they should still
    // be SELECTABLE so Analyze can name them — so treat a photo as "matched/included".
    const already = filedIn.get(String(f.name || '').toLowerCase());
    return { name: f.name, sourcePath: f.sourcePath, size: f.size, isPhoto: !!f.isPhoto, matched: !!rec || !!f.isPhoto, matchType: rec ? matchType : (f.isPhoto ? 'photo' : matchType), meta: rec, filed: already !== undefined, filedIn: already || '' };
  }));
  return {
    ok: true, dir,
    files: out,
    total: out.length,
    matchedCount: out.filter((x) => x.matched).length,
    // The counter that must shrink as he works.
    filedCount: out.filter((x) => x.filed).length,
    // How many stills are sitting in this folder, listed or not — so an empty result can say WHICH
    // kind of empty it is. See the photosHere comment above.
    photosHere,
    // Which folder this actually is, when nothing was configured. The UI says so rather than letting
    // him assume he is looking at a Compressed folder he never set up.
    usedFallback,
  };
});

// Build a RICH XMP/IPTC tag set for one clip — the more searchable metadata the
// better for indexing later (digiKam, Bridge, Resolve, Windows search). Everything
// lands in standard XMP namespaces (dc / lr / photoshop) that indexers read.
function buildEmbedTags(meta, parts, fallbackName) {
  const m = meta || {};
  const deh = (s) => String(s || '').replace(/[-_]+/g, ' ').trim();   // de-hyphen for human text
  // Hierarchy-safe component: like deh, but also strips the path separators that
  // structure a hierarchical tag ('|' '/' '\') so a value like "AC/DC" or
  // "Smith | Jones" can't accidentally split into bogus extra tree levels.
  const hc = (s) => deh(s).replace(/[|/\\]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const fieldIds = (config.organizeFields || []).map((f) => f.id);
  const fieldVals = fieldIds.map((id) => m[id]).filter(Boolean);
  const date = String(m.date || '');
  const year = /^(\d{4})/.test(date) ? date.slice(0, 4) : '';
  // Flat keyword list — structured fields PLUS the individual words inside subject/
  // description/location, so a search for any token finds the clip.
  const words = uniqStrings(`${m.subject || ''} ${m.description || ''} ${m.location || ''}`.split(/[\s\-_]+/));
  const keywords = uniqStrings([
    m.subject, m.location, m.shotType, m.category, m.project, ...fieldVals,
    ...(Array.isArray(m.keywords) ? m.keywords : []),
    ...(Array.isArray(m.people) ? m.people : []),
    date, year, ...words
  ]).filter((k) => k && k.length > 1);
  // Hierarchical tags (digiKam/Lightroom): the category→project→subject chain and
  // the actual folder path the clip files into.
  const hier = [];
  const chain = uniqStrings([m.category, m.project, m.subject].map(hc));
  if (chain.length > 1) hier.push(chain.join('|'));
  if (Array.isArray(parts) && parts.length > 1) hier.push(parts.join('|'));
  // A readable caption for full-text search — and append the AI's visual
  // observation if we captured one (great for "what was in that clip?" searches).
  const bits = [];
  if (m.subject) bits.push(deh(m.subject));
  if (m.description) bits.push(deh(m.description));
  if (m.shotType) bits.push(`${deh(m.shotType)} shot`);
  if (m.location) bits.push(`at ${deh(m.location)}`);
  if (date) bits.push(`on ${date}`);
  let caption = bits.join(', ');
  if (m.observation) caption += (caption ? ` — ${m.observation}` : m.observation);
  const title = uniqStrings([deh(m.subject), deh(m.description)]).join(' ').trim() || stemOf(fallbackName || '');

  const tags = {};
  if (title) tags['XMP-dc:Title'] = title;
  if (caption) tags['XMP-dc:Description'] = caption;
  if (keywords.length) tags['XMP-dc:Subject'] = keywords;             // flat keywords (Resolve/Bridge)
  if (hier.length) tags['XMP-lr:HierarchicalSubject'] = hier;          // digiKam/Lightroom tag tree
  // Accept a date that STARTS with YYYY-MM-DD (a trailing time is fine): the old exact-match wrote NO
  // date at all for anything carrying a time.
  const dm = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dm) {
    tags['XMP-photoshop:DateCreated'] = `${dm[1]}-${dm[2]}-${dm[3]}`;
    // ALSO write the NATIVE capture date — Windows "Date taken", Resolve "Date Recorded", and
    // digiKam's default date sort read EXIF/QuickTime, NOT the XMP field, so the AI/user date was
    // invisible everywhere it matters. Gated by file type so exiftool never gets a group the file
    // lacks (an EXIF tag on an MP4 / a QuickTime tag on a JPEG would fail the whole write).
    const exifDate = `${dm[1]}:${dm[2]}:${dm[3]} 00:00:00`;
    const isPhotoFile = /\.(jpe?g|png|heic|heif|tiff?|dng|webp)$/i.test(String(fallbackName || ''));
    if (isPhotoFile) { tags['EXIF:DateTimeOriginal'] = exifDate; tags['EXIF:CreateDate'] = exifDate; }
    else { tags['QuickTime:CreateDate'] = exifDate; }
  }
  if (m.location) tags['XMP-iptcCore:Location'] = deh(m.location);
  if (m.context) tags['XMP-dc:Coverage'] = m.context;                  // the shoot context, kept searchable
  // shotType is ALREADY in the flat dc:Subject keywords (searchable). It used to ALSO be written to
  // XMP:Label — but Label is the Bridge/Lightroom COLOUR-label field, so "pov"/"wide" produced a
  // garbage colour label. Dropped. (Native EXIF/QuickTime capture date is a separate follow-up.)
  // People / faces — written so digiKam reads them as people tags. We write THREE
  // standard things: IPTC PersonInImage (Bridge/Lightroom), a "People/<name>" branch
  // in the hierarchical subject + digiKam's own TagsList (digiKam shows these under
  // its People tag tree), and MWG region person names (digiKam face-region readers).
  if (Array.isArray(m.people) && m.people.length) {
    const ppl = uniqStrings(m.people).filter(Boolean);
    if (ppl.length) {
      tags['XMP-iptcExt:PersonInImage'] = ppl;
      // NOTE: dropped the XMP-mwg-rs:Region* tags. An MWG region struct is INVALID (and ignored by
      // digiKam's face-region reader) without RegionAppliedToDimensions + a per-person Area, which we
      // don't have here — so those three tags were dead XMP noise. PersonInImage + the People/ tag tree
      // below already cover the people-tag case. (Emit real regions later if we thread box coords in.)
      const peopleHier = ppl.map((n) => `People|${hc(n)}`);
      const peopleTags = ppl.map((n) => `People/${hc(n)}`);
      tags['XMP-lr:HierarchicalSubject'] = uniqStrings([...(tags['XMP-lr:HierarchicalSubject'] || hier), ...peopleHier]);
      tags['XMP-digiKam:TagsList'] = peopleTags;
    }
  }
  // User tags — write them into digiKam's own TagsList + the hierarchical tree (not
  // just the flat keyword list) so they show up under digiKam's Tags panel as real
  // tags, exactly like the screenshot the user shared.
  if (Array.isArray(m.tags) && m.tags.length) {
    const ut = uniqStrings(m.tags).filter(Boolean);
    if (ut.length) {
      tags['XMP-digiKam:TagsList'] = uniqStrings([...(tags['XMP-digiKam:TagsList'] || []), ...ut]);
      tags['XMP-lr:HierarchicalSubject'] = uniqStrings([...(tags['XMP-lr:HierarchicalSubject'] || hier), ...ut]);
      tags['XMP-dc:Subject'] = uniqStrings([...(tags['XMP-dc:Subject'] || keywords), ...ut]);
    }
  }
  // Location → a "Places/<location>" branch (digiKam Places tree + Lightroom),
  // mirroring how people get a People branch, so footage is browsable by place and
  // not just findable as a flat keyword.
  const place = hc(m.location);
  if (place) {
    tags['XMP-lr:HierarchicalSubject'] = uniqStrings([...(tags['XMP-lr:HierarchicalSubject'] || hier), `Places|${place}`]);
    tags['XMP-digiKam:TagsList'] = uniqStrings([...(tags['XMP-digiKam:TagsList'] || []), `Places/${place}`]);
  }
  // A LOSSLESS copy of the record, carried by the file itself.
  //
  // Everything above is written for humans and for digiKam/Lightroom, and it is deliberately
  // lossy: Title merges subject+description and de-hyphenates them, Description glues the AI's
  // observation on after an em-dash. You cannot reconstruct the structured record from it.
  //
  // That matters because this app's own Organize step runs LATER, in a separate session, against
  // files that have been through Tdarr — and its only way back to the metadata was a fuzzy
  // filename token-guess against a sidecar. So we also stash the exact record here. If the tags
  // survive the compressor, Organize reads them back perfectly and never has to guess. If Tdarr
  // strips them (it often does), nothing is worse than before — and finalize:run re-embeds
  // everything anyway, so the final archived file always ends up carrying its own truth.
  const record = {};
  for (const k of ['subject', 'description', 'location', 'context', 'shotType', 'category', 'project', 'date', 'observation', 'ledgerRel']) {
    if (m[k]) record[k] = String(m[k]);
  }
  for (const k of ['people', 'peopleAuto', 'tags', 'keywords']) {
    if (Array.isArray(m[k]) && m[k].length) record[k] = uniqStrings(m[k]).filter(Boolean);
  }
  for (const id of fieldIds) if (m[id]) record[id] = String(m[id]);
  if (Object.keys(record).length) tags['XMP-dc:Identifier'] = `${EMBED_RECORD_PREFIX}${JSON.stringify(record)}`;
  return tags;
}

// Marker for our machine-readable record, so we never mistake somebody else's dc:Identifier
// (or a half-written one) for ours.
const EMBED_RECORD_PREFIX = 'usbvd1:';

// Read our own record back out of a file. Returns null when the file carries no record of ours
// — including when a compressor stripped the XMP, which is the expected case for Tdarr output.
async function readEmbeddedRecord(filePath) {
  try {
    const et = getExifTool();
    const t = await et.read(filePath);
    const raw = t && (t.Identifier || t['XMP-dc:Identifier']);
    const s = Array.isArray(raw) ? raw[0] : raw;
    if (typeof s !== 'string' || !s.startsWith(EMBED_RECORD_PREFIX)) return null;
    const rec = JSON.parse(s.slice(EMBED_RECORD_PREFIX.length));
    return (rec && typeof rec === 'object' && !Array.isArray(rec)) ? rec : null;
  } catch { return null; }   // unreadable / no exiftool / not our record — fall through to the old ladder
}

// NOTE — why there is no embed-at-COPY step.
//
// Writing XMP into an MP4/MOV makes exiftool rewrite the WHOLE file (see getExifTool), so
// embedding during the import would add a full extra read+write per clip — roughly doubling the
// time to pull a card of multi-GB GoPro footage. And Tdarr strips metadata on re-encode, so that
// expensive embed would be destroyed before Organize ever saw it. The metadata therefore travels
// across the Tdarr gap in the finalMeta sidecar (which no longer expires — see finalMeta:save),
// and finalize:run embeds it into the file ONCE, at organize time, where the cost is paid on the
// final archived copy that keeps it. The lossless record written by buildEmbedTags means that
// file can be re-read perfectly by readEmbeddedRecord on any later pass or any other machine.

// Which of his standing filing rules, if any, claims this clip? Mirrors the destination map's
// `rulesFor` deliberately — same haystack, same project-beats-descriptor precedence — so the folder
// he is shown on the map and the folder a direct file lands in cannot disagree.
function matchRoute(meta) {
  const list = (config.ai && Array.isArray(config.ai.routes)) ? config.ai.routes : [];
  if (!list.length) return null;
  const hay = `${meta.subject || ''} ${meta.location || ''} ${meta.description || ''}`.toLowerCase();
  let route = null; let desc = null;
  for (const r of list) {
    if (!r || !Array.isArray(r.match)) continue;
    if (!r.match.some((k) => k && hay.includes(String(k).toLowerCase()))) continue;
    if (r.kind === 'descriptor') { if (!desc) desc = r; } else if (!route) route = r;
  }
  return route || desc || null;
}

// THE DESTINATION LADDER — the single place that decides which folder a clip lands in.
//
// Extracted from finalize:run so it can be asked WITHOUT filing anything (Tier 1 item 8: show him
// where each clip will go before he commits). The rungs, in order:
//   1. the destination map's explicit placement, if he made one;
//   2. the configured folderLevels (category/project/…), when the record actually has those fields;
//   3. the record's SUBJECT, then its shoot date beneath it — his real library is app-named, so this
//      is the rung that fires for almost everything he owns;
//   4. `<date>/_unsorted` — the honest holding pen for a clip with nothing to go on.
// It never returns an empty array, because an empty path means the bare root of his Projects tree.
async function destinationParts({ relRaw, levels, meta, sourcePath }) {
  const m = meta || {};
  let parts = relRaw
    ? relRaw.split(/[\\/]+/).map((x) => safeFolderName(x)).filter(Boolean)
    : subdirParts(levels, m);
  if (relRaw || parts.length) return parts;

  // HIS OWN FILING RULES, which until now only applied if he opened the destination map.
  //
  // He has two real ones ("Calisthenics", "Lawn care (Gourgess Lawns)") with keywords and a
  // destination — and every path that filed WITHOUT the map ignored them completely, so the rules he
  // configured did nothing on his most common route. That is the "fully built but never fed" shape,
  // on a feature he explicitly set up. Because every screen now goes through this one ladder, adding
  // it here fixes the one-clip path, Run-without-a-map and the previews at the same time.
  //
  // Same semantics as the map: match on subject + location + description; a real PROJECT route beats
  // a DESCRIPTOR (vlog, timelapse…), which only groups when no project matched. `byDay` appends the
  // shoot date, exactly as `phoneRouteFor` does for photos.
  const routed = matchRoute(m);
  if (routed) {
    const dest = String(routed.dest || '').replace(/\\/g, '/').split('/').map((x) => safeFolderName(x)).filter(Boolean);
    if (dest.length) {
      if (!routed.byDay) return dest;
      const day = String(m.date || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return [...dest, safeFolderName(day)];
      return dest;
    }
  }

  const dayFrom = async () => {
    let day = String(m.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      try { day = new Date((await fsp.stat(sourcePath)).mtimeMs).toISOString().slice(0, 10); } catch { day = ''; }
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? safeFolderName(day) : '';
  };

  // ⚠ A LEDGER RUNG WAS TRIED HERE AND REVERTED — 2026-07-20am. Do not re-add it without reading this.
  //
  // The idea (Tier 2 item 29): file a clip into the project he put the same shoot in last time, using
  // `matchLedgerProjects`' content scoring and requiring its `related` flag. Every unit test passed,
  // including one asserting a same-date clip with nothing in common is NOT pulled in.
  //
  // **Then the real-data probe filed his 309 clips twice.** Run 2 moved 30 of them, and the moves were
  // catastrophic in kind, not just in count:
  //
  //     2026-06-01_vlog_josiah-talking-head_v1.mp4
  //         run 1 → vlog/2026-06-01
  //         run 2 → 2026/2026 - Client Work/Gourgess Lawns
  //
  // On 2026-06-01 he shot BOTH a lawn job and a vlog of Josiah. Run 1 filed the lawn clips into
  // Gourgess Lawns, so the ledger learned that date belongs to that project — and on run 2 the vlog
  // shared the date and enough token overlap to read as `related`, so a personal vlog was filed into a
  // client job. **`related` is far too weak on a day with two shoots**, which is a normal day for him.
  //
  // It also broke IDEMPOTENCY, which had held at 309/309: filing writes the ledger, and the ledger
  // then changes where the next run puts things — a feedback loop where re-running keeps moving
  // footage.
  //
  // My unit test could not catch this because its fixture had ZERO overlap ("birthday" vs
  // "lawnmowing"). Real days overlap partially. Any future attempt needs: a subject-level match rather
  // than any-token, a real score threshold, a same-day-two-shoots fixture, AND the two-run probe.
  const subj = safeFolderName(String(m.subject || '').trim());
  if (subj) {
    const dayPart = await dayFrom();
    return dayPart ? [subj, dayPart] : [subj];
  }
  const dayPart = await dayFrom();
  return [dayPart || 'undated', '_unsorted'].filter(Boolean);
}

// Ask where a clip WOULD go, without touching it. Same ladder, same answer, no side effects.
ipcMain.handle('organize:previewDest', async (_e, payload) => {
  const items = (payload && Array.isArray(payload.items)) ? payload.items : [];
  const levels = (payload && payload.folderLevels) || config.folderLevels || [];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    // eslint-disable-next-line no-await-in-loop
    const parts = await destinationParts({
      relRaw: String(it.rel || ''), levels, meta: it.meta || {}, sourcePath: it.sourcePath || it.path,
    });
    out.push({ name: it.name || '', rel: parts.join('/') });
  }
  return { ok: true, dests: out };
});

let finalizeRunning = false;
ipcMain.handle('finalize:run', async (evt, payload) => {
  // ⚠ ONE FILING RUN AT A TIME — because `config.lastOrganize` is a SINGLE slot holding THE undo
  // record. Two concurrent runs both relocate footage and both stamp it; last write wins, and one
  // run's clips end up in his Projects tree with no undo path at all. That is exactly the outcome
  // the ⚠⚠ note further down was added to prevent, arrived at by a different route.
  //
  // Reachable without any timing trick: the batch Run button disables itself, but `fileOneClipNow`
  // (09-phone-finalize.js) calls this same handler with NO disable and no guard — and it is
  // deliberately the low-friction "file this one clip right now" action, i.e. the one clicked
  // repeatedly. Two of those in succession, or one during a batch Run, is enough.
  //
  // Secondary hazard the guard also closes: the Resolve CSV merge is a read-modify-write across two
  // awaits on one shared file, so concurrent runs drop each other's rows.
  if (finalizeRunning) return { ok: false, error: 'A filing run is already going', errors: ['A filing run is already going'] };
  finalizeRunning = true;
  try {
  const sender = evt.sender;
  const { items, options, dir } = payload || {};
  const opts = options || {};
  // FILING MUST NOT REQUIRE THE AI TO HAVE FINISHED. This used to drop every clip without a stored
  // record — and combined with the Organize screen only listing `matched` rows, it meant a clip the
  // AI had never described could not be filed AT ALL. On his real store that is 4263 of 4594 clips:
  // 93% of his footage, structurally unfileable, which is why he has a project ledger of 0 after
  // months of use. A dated folder on disk beats a card he never empties.
  //
  // An unnamed clip is carried with a MINIMAL synthesised record so the rest of this function has
  // something to work with — `_noMeta` marks it so the embed and the finalMeta bookkeeping below can
  // skip it. It is not a real record and must never be treated as one.
  const list = (Array.isArray(items) ? items : []).filter(Boolean).map((it) => {
    if (it.meta) return it;
    return { ...it, meta: { _noMeta: true }, _noMeta: true };
  });
  // Per-run choices come from the payload (the Organize screen), falling back to
  // the saved config.
  // ⚠⚠ FALL BACK TO THE PROJECTS FOLDER — they are one concept stored in two settings.
  //
  // `organizeDest` and `projectsRoot` both mean "where filed footage goes", and setting one does not
  // set the other. Every route that asks him to configure a destination — the AI health card's "Use
  // that folder", the setup wizard, `projects:setRoot` — writes `projectsRoot`. `finalize:run` read
  // only `organizeDest`, so the realistic state was:
  //
  //     projects:setRoot   -> config.projectsRoot = "…/02 - Projects/2026"
  //     config.organizeDest = ""
  //     finalize:run       -> {"ok":false,"error":"No destination folder set. Choose one in
  //                            Edit → “Organizing & folders…”."}
  //
  // He has already told the app where his footage goes, and filing refuses and points him at a
  // different menu to say it again. `config:get` has always resolved the pair this way round
  // (`projectsRoot || organizeDest || default`); this is the same resolution on the path that files.
  const dest = payload.organizeDest || config.organizeDest || config.projectsRoot || '';
  const levels = (Array.isArray(payload.folderLevels) && payload.folderLevels.length)
    ? payload.folderLevels
    : (Array.isArray(config.folderLevels) && config.folderLevels.length ? config.folderLevels : ['category', 'project']);
  const nasRoot = (opts.nas && payload.nasPath) ? payload.nasPath : '';

  if (opts.organize && !dest) {
    return { ok: false, error: 'No destination folder set. Choose one in Edit → “Organizing & folders…”.' };
  }

  // COPY, not move, unless he explicitly says otherwise.
  //
  // He files from his L: archive into projects on C:. C: has 31 GB free; the compressed archive is
  // 73 GB. So the project folder on C: is a WORKING copy he can clear out whenever the disk fills —
  // and the archive on L: has to still be there when he does. A move would quietly make the C: copy
  // the ONLY copy, on the smaller and fuller of the two disks. ("Copy — keep the archive on L:",
  // his call, 2026-07-13.)
  const copyMode = opts.copy !== undefined ? !!opts.copy : (config.organizeCopy !== false);

  // Organizing MOVES files (organizeMove → moveFileCrossDevice → unlink of the source). If the
  // Compressed folder were ever pointed at the SD card, Run would therefore strip footage off
  // the card — a card delete that never went through the delete confirm or the delete gate.
  // Deleting from the card is only ever allowed as a deliberate act on the Delete step, so
  // refuse outright rather than quietly relocating someone's only copy.
  // (A COPY takes nothing off the card, so it is not part of this.)
  if (opts.organize && !copyMode && await isOnRemovableVolume(dir)) {
    return { ok: false, error: 'That folder is on a removable card or USB drive. Organizing MOVES files, so it would take them off the card — which is only ever allowed from the Delete step, after the copies are verified. Point “Compressed” at a folder on your computer first.' };
  }

  // WILL IT EVEN FIT? Copying adds bytes to the destination volume, and his is the tight one: 31 GB
  // free on C: against a 73 GB archive. Finding that out 40 clips in — with a half-filed shoot and a
  // full system disk — is the worst possible time. Check before writing anything.
  if (opts.organize && dest && copyMode) {
    let need = 0;
    for (const it of list) {
      try { need += (await fsp.stat(it.sourcePath || it.path)).size; } catch { /* counted as 0 */ }
    }
    try {
      const st = await fsp.statfs(await nearestExistingDir(dest));
      const free = Number(st.bavail) * Number(st.bsize);
      const GB = (n) => `${(n / 1e9).toFixed(1)} GB`;
      // 2 GB of headroom: filling a system disk to the last byte breaks the machine, not just the app.
      if (need + 2e9 > free) {
        return { ok: false, error: `Not enough room: this needs ${GB(need)} but only ${GB(free)} is free on that drive. File fewer shoots, or point the projects folder at a bigger disk.` };
      }
    } catch { /* if we genuinely cannot read the volume, don't block the run over it */ }
  }

  const summary = { ok: true, embedded: 0, moved: 0, skipped: 0, unplanned: 0, backedUp: 0, errors: [], total: list.length, csvPath: '', filedRels: [] };
  const undoable = [];   // {from,to} per relocated clip → enables "Undo last organize"
  const ledgerEntries = [];   // audit #29 — what this Run filed, for the project ledger
  const csvRows = [];
  const filed = [];      // clips whose metadata is now consumed → the finalMeta prune may evict them
  // Is the caller driving us from the destination map's plan? (Any item carrying a `rel` means
  // yes.) Under a plan we NEVER invent a folder for a clip the user didn't place.
  const usingPlan = list.some((it) => typeof it.rel === 'string' && it.rel.trim());
  const et = opts.embed ? getExifTool() : null;
  // ONE timestamp for the whole run, taken before anything moves.
  //
  // It has to be stable because the undo record is now written per-clip (see below) and rewritten at
  // the end — a fresh Date.now() each time would make the record's ts drift forward. It also has to
  // be EARLY: organize:undo calls reverseLastLedger(lastOrganize.ts), which refuses to reverse a
  // ledger delta whose own ts is earlier than the run's. Stamping at the start means every delta
  // this run records is unambiguously at-or-after it, so undo can always take the memory back too.
  const runTs = Date.now();
  // Guarded, like every other progress emitter in this app (verify:copies :1309, phone:pull,
  // phone:copyVideos, compress:run, drive:removed) — "best-effort; the sender may already be gone".
  // finalize:run and copy:start were the only two without it, and they are the two that MOVE
  // FOOTAGE: an unguarded throw here aborts a run mid-way, after clips are already relocated.
  const emit = (index, name, phase) => {
    try { sender.send('finalize:progress', { index, total: list.length, name, phase }); } catch { /* window gone */ }
  };

  for (let i = 0; i < list.length; i += 1) {
    const it = list[i];
    const meta = it.meta || {};
    let curPath = it.sourcePath;
    let finalFileName = it.name;
    // `rel` is the folder the DESTINATION MAP decided — the plan the user actually made and can
    // see. It wins over recomputing a path from [category, project], which are normally empty and
    // therefore produced NO subfolders at all: the file was already sitting in the destination, so
    // organizeMove said "in-place" and Run reported "0 moved" while looking like it had worked.
    // Falling back to subdirParts keeps the old behaviour for any caller that sends no plan.
    const relRaw = (typeof it.rel === 'string') ? it.rel.trim() : '';
    // NOT slugFolder. `rel` is a path the user (or the AI, choosing from his real tree) picked —
    // "2026 - Client Work/Gourgess Lawns". Slugging it files into `2026-client-work/gourgess-lawns`,
    // a brand-new folder beside his real one, forking his project tree a little more on every run.
    // An UNNAMED clip has no category/project to file under, so subdirParts would return nothing and
    // it would land loose in the Projects root — worse than leaving it on the card. Give it the one
    // thing it does have: its DATE. His shoots are batches and the date predicts the subject 88% of
    // the time, so `<date>/_unsorted` is a folder he can actually use, and the `_unsorted` level says
    // plainly that this one is unfinished.
    // ONE ladder, in one place. It used to live inline here, which meant any screen wanting to SHOW
    // him where a clip will go before he commits (Tier 1 item 8) had to reimplement it — and a second
    // copy of a fallback ladder is the "two entry points that disagree" shape that has produced a
    // confirmed bug on four separate days in this repo. Extracted verbatim; `destinationParts` is the
    // only thing that decides a destination now, and a preview IPC can call it too.
    const parts = await destinationParts({ relRaw, levels, meta, sourcePath: it.sourcePath || it.path });
    // Under a plan, a clip the user never placed has NO destination. Falling through to
    // subdirParts here would hand it an empty path — i.e. dump it in the ROOT of the Projects
    // tree, which is worse than leaving it alone. Skip its move; it still gets embed/CSV/NAS.
    const skipMove = usingPlan && !relRaw;
    if (skipMove) summary.unplanned += 1;   // reported, not silently dropped
    const tags = buildEmbedTags(meta, parts, it.name);
    const keywords = Array.isArray(tags['XMP-dc:Subject']) ? tags['XMP-dc:Subject'] : [];

    // Did this clip's metadata reach the disk — in the file, or in a sidecar beside it? Drives
    // whether we may mark it consumed at the bottom (see `filed`). Only meaningful when embedding.
    let metaLanded = !et;
    // Declared out here, not inside the catch below, because step 2 has to MOVE it: the sidecar is
    // written beside the source, and organizeMove does not carry an adjacent .xmp along.
    let sidecar = '';

    // 1. Embed a RICH XMP packet (Title, Description, flat keywords→dc:subject,
    // hierarchical tags for digiKam/Lightroom, date, location, people, shot type…).
    //
    // An embed failure used to `continue`, skipping the move, the NAS mirror and the CSV row for
    // that clip — "leave it for a clean retry". But the retry hits the SAME error: a HEIC, an odd
    // codec, or a read-only file fails every time, so with Embed on that clip could NEVER be filed.
    // One unwritable file quietly stayed out of the Projects tree forever, which is worse than
    // filing it with its metadata in a sidecar. So: fall back to an `.xmp` beside the file, then
    // carry on filing either way (#69).
    if (et) {
      emit(i, it.name, 'embedding');
      try {
        if (Object.keys(tags).length) {
          // Skip the write when the file ALREADY carries this exact record. Embedding XMP into an
          // MP4/MOV rewrites the WHOLE file (minutes each on GoPro footage), and a retry / re-run
          // otherwise redoes every already-good clip. The lossless dc:Identifier record captures every
          // field the human-facing tags derive from, so a record match means the whole tag set matches.
          let already = false;
          const newRec = tags['XMP-dc:Identifier'];
          if (newRec) {
            const cur = await readEmbeddedRecord(curPath);
            if (cur) already = (`${EMBED_RECORD_PREFIX}${JSON.stringify(cur)}` === newRec);
          }
          if (!already) await et.write(curPath, tags, ['-overwrite_original']);
          summary.embedded += 1;   // it IS embedded either way (written now, or already carrying it)
        }
        metaLanded = true;
      } catch (err) {
        // Sidecar fallback. An XMP sidecar is a real, standard carrier — digiKam and Lightroom both
        // read `<file>.xmp` — so the metadata is not lost just because the container refused it.
        try {
          // ⚠ Assign `sidecar` only AFTER the write succeeds. It used to be set first, so on the
          // failure path below it stayed truthy — and step 2's `if (sidecar)` then tried to
          // moveFileCrossDevice a file that was never created, throwing and pushing a SECOND,
          // misleading error: "Sidecar for X stayed at the source: ENOENT". Nothing was lost
          // (`metaLanded` correctly stays false, so the metadata is kept for a retry), but one
          // failure reported as two, and one of the two described a file that does not exist.
          const sidePath = `${curPath}.xmp`;
          await et.write(sidePath, tags, ['-overwrite_original']);
          sidecar = sidePath;
          metaLanded = true;
          summary.sidecars = (summary.sidecars || 0) + 1;
          summary.errors.push(`Embed ${it.name}: ${err.message} — wrote ${path.basename(sidecar)} instead`);
        } catch (err2) {
          // Neither route worked. File the clip anyway (leaving it unfiled forever is the worse
          // failure), but say so plainly and do NOT mark its metadata consumed below, so the record
          // survives for a manual retry rather than being pruned away.
          summary.errors.push(`Embed ${it.name}: ${err.message}; sidecar also failed: ${err2.message}`);
        }
      }
    }

    // 2. Organize into <dest>/<folderLevels…>/ (idempotent).
    if (opts.organize && dest && !skipMove) {
      emit(i, it.name, 'moving');
      try {
        const before = curPath;   // capture origin BEFORE reassigning, for undo
        // resolveFolderPath asks the disk what each folder is REALLY called, so `2026 - client work`
        // lands in his existing `2026 - Client Work` instead of creating a second one beside it.
        const targetDir = await resolveFolderPath(dest, parts);
        const r = await organizeMove(curPath, targetDir, it.name, { copy: copyMode });
        if (r.action === 'moved' || r.action === 'copied') {
          summary.moved += 1;
          // WHERE IT LANDED, per clip. The summary counted moves but never said where, so the only
          // way to answer "filed where?" was to go and look in the Projects tree — the exact
          // re-check-its-work loop this app exists to remove. `parts` is the folder the ladder or
          // the map actually chose, which is not always the `rel` the caller sent (it sends none for
          // an unnamed clip).
          // THE FOLDER ON DISK, not the one we asked for. `resolveFolderPath` deliberately overrides
          // our spelling with his — case, and now separators too (`lawnmowing` joins his existing
          // `lawn-mowing/`) — so `parts` is the REQUEST and `targetDir` is the ANSWER. Reporting the
          // request put the wrong folder in the toast, in the row badge and in the ledger for exactly
          // the clips that got reused into an existing tree. Found by breaking the reuse ordering and
          // watching a test that read this field stay green while the disk said otherwise.
          const landedRel = path.relative(dest, r.path ? path.dirname(r.path) : targetDir)
            .split(path.sep).filter(Boolean).join('/');
          summary.filedRels.push({ name: it.name, rel: landedRel || parts.join('/') });
          undoable.push({ from: before, to: r.path, copied: r.action === 'copied' });
          // BRING THE SIDECAR WITH IT. It was written beside the SOURCE in step 1 and then abandoned
          // there: organizeMove doesn't carry an adjacent .xmp, and nothing else looked at it. So the
          // footage arrived in the Projects tree with no metadata while its one standard carrier sat
          // in the intake folder — and because `metaLanded` was already true, the clip counted as
          // FILED, which let the finalMeta prune evict the only other copy of that work.
          // Best-effort: the footage is filed by now, so this must never fail the run.
          if (sidecar) {
            try {
              const landedSidecar = `${r.path}.xmp`;
              if (r.action === 'copied') await copyFileVerified(sidecar, landedSidecar);
              else await moveFileCrossDevice(sidecar, landedSidecar);
              sidecar = landedSidecar;
            } catch (e3) {
              summary.errors.push(`Sidecar for ${it.name} stayed at the source: ${e3.message}`);
            }
          }
          // Feed the PROJECT LEDGER (audit #29). Only the map's "Apply" recorded here, so filing via
          // step-3 Run learned nothing: the ledger is what makes a later import from the same shoot
          // offer the same project, and the shoot DATE is the strongest signal this app has
          // (usb-app-shoots-in-batches). Two filing paths that disagree about learning is exactly the
          // divergence PROMPT.md §2 warns about.
          ledgerEntries.push({
            // WHERE IT ACTUALLY WENT, not where a plan said. `relRaw` is the destination MAP's path,
            // and it is empty on every run he makes — he files from step 3 without a map — so
            // recordLedgerEntries dropped the entry outright (`if (!key) continue`). That is why his
            // project ledger reads 0, and it would have stayed 0 after today's filing fixes: clips
            // would land correctly and the app would learn nothing from it.
            //
            // The ledger is what makes a later import from the same shoot offer the same project,
            // and the shoot date is the strongest signal this app has. Recording the real folder is
            // what finally starts that loop. `_unsorted`/`misc` are still skipped by
            // recordLedgerEntries' own holding-pen rule — a dated holding pen is not a project.
            // THE SAME RESOLVED FOLDER the summary reports. `parts` is what we ASKED for;
            // `resolveFolderPath` may have chosen a folder he already has whose name differs in case
            // or separators (`lawnmowing` → his existing `lawn-mowing/`). Recording the request meant
            // the ledger named a directory that DOES NOT EXIST — and since `finalize:scan` builds its
            // "filed → <folder>" badge from these `clipNames`, every rescan then told him his clip was
            // somewhere it is not.
            //
            // I introduced exactly this by fixing `summary.filedRels` to use the resolved path and
            // leaving the ledger one line below on the old value. Both now read `landedRel`.
            rel: landedRel || relRaw || parts.join('/'),
            name: path.basename(r.path),
            date: meta.date || '',
            subject: meta.subject || '',
            description: meta.description || '',
            location: meta.location || '',
            people: Array.isArray(meta.people) ? meta.people : [],
            observation: meta.observation || '',
          });
        } else summary.skipped += 1;
        // A COPY leaves the original where it is — the archive on L: is the whole point — so the rest
        // of the run (embed, CSV, NAS) must keep operating on the SOURCE, not chase the new copy.
        if (r.action !== 'copied') curPath = r.path;
        finalFileName = path.basename(r.path);
      } catch (err) {
        // A clip whose move FAILED was not filed. It used to fall through to filed.push() below,
        // which marks its metadata `done` and therefore prune-eligible — so the clip stayed where it
        // was AND its metadata became disposable. The embed-failure path above `continue`s for
        // exactly this reason; the move path just didn't.
        summary.errors.push(`Move ${it.name}: ${err.message}`);
        continue;   // leave it — and its metadata — intact for a clean retry
      }
    }

    // 3. Mirror to the NAS (organized structure), if enabled. NOT for a skipMove clip: it was
    // deliberately left unplaced (no rel under a plan), so `parts` is empty and this would flat-dump
    // it into the NAS ROOT next to the real project folders — the very root-dump the local skip avoids.
    if (nasRoot && !skipMove) {
      emit(i, it.name, 'backup');
      try {
        const nasDir = path.join(nasRoot, ...parts);
        const nasTarget = path.join(nasDir, finalFileName);
        // Same verified-copy path as the import-time NAS mirror — one shared primitive,
        // so a truncated/corrupt backup is never trusted (and the two can't drift).
        if (await copyFileVerified(curPath, nasTarget) === 'copied') summary.backedUp += 1;
      } catch (err) { summary.errors.push(`Backup ${it.name}: ${err.message}`); }
    }

    // 4. Resolve CSV row.
    if (opts.csv) {
      // Scene = the deepest configured folder level's value (a useful grouping in
      // Resolve), falling back to the legacy 'project' field.
      // Scene = the deepest folder the clip actually filed into. Under a PLAN the clip files by `rel`
      // (rich project folders), but the old code derived scene from the level fields (category/project),
      // which are normally EMPTY under a plan → a blank Scene column despite meaningful folders. Prefer
      // the plan's leaf folder, then fall back to the configured level / project field.
      const sceneLevel = levels[levels.length - 1];
      const scene = (relRaw ? (parts[parts.length - 1] || '') : '')
        || (sceneLevel ? metaLevelValue(sceneLevel, meta) : '') || meta.project || '';
      csvRows.push({
        file: finalFileName,
        description: meta.description || '',
        // Shot type (wide/close/pov…) and the AI's full visual observation are both derived per clip
        // and were being dropped from the CSV. Resolve's Import Metadata maps "Shot" and "Comments"
        // directly, so an editor gets to sort by shot type and full-text-search the media pool for
        // what was actually in each clip — using work the AI already did.
        shot: meta.shotType || '',
        keywords: keywords.join(', '),
        scene,
        comments: meta.observation || ''
      });
    }
    // This clip's metadata has now been CONSUMED — embedded into the file and/or filed into the
    // tree. Only now may the finalMeta prune consider evicting it. (An embed failure `continue`s
    // above, so a clip that didn't make it never gets marked and its metadata is kept for a retry.)
    //
    // A skipMove clip is the SAME case: it is still sitting unfiled in the Compressed folder (the user
    // hasn't placed it yet), so its metadata must survive for the run that finally files it. Marking
    // it done let the prune evict its meta, after which it was filtered out at the top of the loop
    // (`it.meta` required) and could NEVER be organized again — the AI's work silently gone.
    // Only mark the metadata CONSUMED if it actually landed somewhere (embedded, or in a sidecar).
    // Marking a clip done whose metadata reached neither would let the finalMeta prune evict the
    // AI's work with nothing to show for it.
    if (!skipMove && metaLanded) filed.push(it.name);
    // ⚠⚠ STAMP THE UNDO RECORD AS WE GO, not only at the end.
    //
    // All of this run's bookkeeping used to happen AFTER the loop, so any throw between the first
    // organizeMove and the end meant: clips physically relocated, `config.lastOrganize` never
    // written, ledger never updated — i.e. footage moved into his Projects tree with NO undo record
    // at all. The renderer catches the rejection and shows "Failed: <msg>", which reads as "the run
    // didn't happen" while N clips have in fact moved and cannot be moved back.
    //
    // 10-boot.js:370 explicitly anticipates this rejection ("a locked file on Windows throws
    // EBUSY"), so the renderer was defended and main was not. Writing per-clip is cheap next to the
    // file I/O already happening, and it means the undo record can never be behind the filesystem.
    if (undoable.length) { config.lastOrganize = { ts: runTs, moves: undoable }; saveConfig(); }
  }
  markFinalMetaDone(filed);

  // Write the Resolve metadata CSV next to the organized folder (or the scan
  // folder when not organizing). Columns Resolve's Import Metadata maps directly.
  if (opts.csv && csvRows.length) {
    try {
      const csvDir = (opts.organize && dest) ? dest : (dir || config.finalizeSource || dest);
      const csvPath = path.join(csvDir, 'resolve-metadata.csv');
      const HEADER = ['File Name', 'Description', 'Shot', 'Scene', 'Keywords', 'Comments'];
      // MERGE by File Name, don't overwrite: he organizes batch-by-batch, and a fresh write each run
      // left the editor's Resolve import holding only the last batch's rows. Keep prior rows; this
      // run's rows override a same-named row. Existing data rows are re-emitted verbatim.
      const byFile = new Map();
      try {
        const prev = (await fsp.readFile(csvPath, 'utf8')).split(/\r?\n/).filter(Boolean);
        for (let li = 0; li < prev.length; li += 1) {
          const name = csvFirstField(prev[li]);
          if (li === 0 && name === 'File Name') continue;   // skip the old header
          if (name) byFile.set(name, prev[li]);
        }
      } catch { /* no existing CSV yet */ }
      for (const r of csvRows) byFile.set(r.file, [r.file, r.description, r.shot, r.scene, r.keywords, r.comments].map(csvCell).join(','));
      const lines = [HEADER.map(csvCell).join(',')];
      for (const line of byFile.values()) lines.push(line);
      await fsp.writeFile(csvPath, lines.join('\r\n'), 'utf8');
      summary.csvPath = csvPath;
    } catch (err) { summary.errors.push(`CSV: ${err.message}`); }
  }

  // Record this run's relocations so "Undo last organize" can move them back. Already stamped
  // per-clip inside the loop (see the note there); this is the final, complete write. It MUST reuse
  // `runTs` rather than Date.now(), or the record's timestamp would jump forward past the ledger
  // entries recorded below and reverseLastLedger would refuse to take them back.
  if (undoable.length) { config.lastOrganize = { ts: runTs, moves: undoable }; saveConfig(); }

  // Record what Run filed into the project ledger — AFTER lastOrganize is stamped, because
  // organize:undo only reverses a ledger delta whose ts is >= the run's (see reverseLastLedger).
  // Recording before would leave the delta looking like it belonged to an earlier run and undo
  // would refuse to take it back.
  if (ledgerEntries.length) {
    try { recordLedgerEntries(ledgerEntries); } catch (err) { summary.errors.push(`Ledger: ${err.message}`); }
  }

  // `ok` was set true at construction and never reconsidered, so a run in which EVERY clip failed
  // still reported success and the renderer showed a tidy green summary. Report reality: a run that
  // achieved nothing at all, but was asked to do something, did not succeed.
  const didSomething = summary.embedded > 0 || summary.moved > 0 || summary.backedUp > 0
    || summary.skipped > 0 || summary.unplanned > 0 || !!summary.csvPath;
  if (summary.errors.length && !didSomething) {
    summary.ok = false;
    summary.error = summary.errors[0];
  }
  return summary;
  // Released on every exit path. Leaking it would refuse all filing until the app restarts.
  } finally { finalizeRunning = false; }
});

// Intake folder (compression destination) — view / pick / set.
ipcMain.handle('intake:get', () => config.intakeFolder);

ipcMain.handle('intake:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the compression intake folder',
    defaultPath: config.intakeFolder,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Generic folder picker (destination / NAS backup).
ipcMain.handle('folder:pick', async (_evt, opts) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: (opts && opts.title) || 'Choose a folder',
    defaultPath: (opts && opts.defaultPath) || undefined,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Pick a single document file (for importing a naming SOP / notes into memory).
ipcMain.handle('file:pick', async (_evt, opts) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: (opts && opts.title) || 'Choose a document',
    filters: [{ name: 'Text & docs', extensions: ['txt', 'md', 'markdown', 'rtf', 'csv', 'json', 'text'] }, { name: 'All files', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// Pick one or more image files (for attaching screenshots to feedback).
ipcMain.handle('image:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Attach images',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return [];
  return res.filePaths;
});

ipcMain.handle('intake:set', (_evt, folder) => {
  if (folder && typeof folder === 'string') {
    config.intakeFolder = folder;
    saveConfig();
  }
  return config.intakeFolder;
});

// Rename a copied file inside the intake folder. Returns the new path.
// Rename a clip ON DISK, carrying its metadata with it (FEATURES.md item 42).
//
// This handler EXISTED, correct-looking and unreachable, since before the audit. Wiring it as it
// stood would have shipped two bugs, both of the exact shape this repo keeps producing:
//
//  ⚠⚠ 1. IT TOOK A RENDERER-SUPPLIED PATH AND RENAMED THE FILE AT IT, with no path guard. Every
//        other handler that touches a renderer path is guarded (#95); this one escaped because
//        nothing could call it, so no audit of live call sites ever saw it. It is also the most
//        consequential of them — the others read, this one MOVES a file.
//
//  ⚠⚠ 2. IT RENAMED THE FILE AND LEFT THE METADATA BEHIND. `finalMeta` is keyed by lower-cased
//        FILENAME, so renaming `2026-06-01_vlog_v1.mp4` orphaned its subject, its people and its
//        `done` flag under a key that no longer names anything. The clip would come back looking
//        never-filed and never-analyzed. Fixing a typo would have silently cost him the record —
//        strictly worse than the typo.
//
// So the rename and the record move together, or neither happens.
ipcMain.handle('rename:apply', async (_evt, payload) => {
  const destPath = String((payload && payload.destPath) || '');
  const newName = String((payload && payload.newName) || '');
  // GUARD 1 — the path guard, fail-closed like every other one.
  if (!isPathAllowed(destPath)) return refusePath('rename:apply', destPath);
  // GUARD 2 — an unreadable finalMeta store means an empty default in memory. We could not SEE the
  // record to move it, and renaming anyway would orphan metadata we are not even able to read. Same
  // contract as the rest of the app: refuse rather than half-do it.
  if (storeReadFailed.finalMeta) {
    return { ok: false, error: 'Your clip metadata could not be read this launch, so renaming would lose it. Restart the app first.' };
  }
  try {
    const dir = path.dirname(destPath);
    const ext = path.extname(destPath);
    // ⚠ ORDER MATTERS HERE, and getting it wrong is safe-but-ugly rather than dangerous — which is
    // why it is easy to miss. Drop any directory part FIRST, splitting on both separators by hand:
    // `path.basename` is platform-specific, so on Linux it would leave a Windows-style `..\..\x.mp4`
    // intact, and running the character filter first turns `../../escaped.mp4` into the literal
    // filename `.._.._escaped.mp4`. Both stay inside the folder; only this order also keeps the
    // name readable.
    let cleaned = String(newName || '').trim().split(/[\\/]+/).pop() || '';
    cleaned = cleaned.replace(/[<>:"|?*\x00-\x1f]/g, '_');
    if (!cleaned || cleaned === '.' || cleaned === '..') return { ok: false, error: 'Name cannot be empty' };
    // A name with nothing nameable in it — `/`, `...`, `???` — sanitizes to punctuation and would
    // produce a clip called `_.mp4`. Refuse it and say so, rather than renaming his footage to
    // something he can never find again.
    if (!/[a-z0-9]/i.test(path.basename(cleaned, path.extname(cleaned)))) {
      return { ok: false, error: 'That name has no letters or numbers in it' };
    }
    if (path.extname(cleaned).toLowerCase() !== ext.toLowerCase()) {
      cleaned += ext;
    }
    if (cleaned === path.basename(destPath)) return { ok: false, error: 'That is already its name' };
    const target = await uniqueDest(dir, cleaned);
    // GUARD 3 — where it LANDS must be allowed too. uniqueDest keeps it in `dir`, so this can only
    // fire if the guard's roots change underneath us; it costs nothing and it fails closed.
    if (!isPathAllowed(target)) return refusePath('rename:apply', target);
    await fsp.rename(destPath, target);
    const name = path.basename(target);
    // Carry the metadata across. uniqueDest may have appended " (1)", so key off the ACTUAL new
    // basename, never off what was typed.
    let movedMeta = false;
    try {
      const store = currentFinalMeta();
      const oldKey = Object.keys(store).find((k) => finalMetaKeyMatches(path.basename(destPath), k));
      if (oldKey) {
        const rec = store[oldKey];
        delete store[oldKey];
        store[name.toLowerCase()] = rec;
        config.finalMeta = store;
        saveStore('finalMeta');
        movedMeta = true;
      }
    } catch { /* the file IS renamed; report it rather than throwing the result away */ }
    return { ok: true, destPath: target, name, movedMeta };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Delete selected files from the SOURCE drive (sends to recycle bin via shell).
// Fast integrity fingerprint: size + SHA-256 of three 2 MB samples (head, middle,
// tail). Catches truncation and the common corruption modes without reading a whole
// 50 GB card. (Not a full-file hash — a deliberate speed/safety trade-off.)
async function sampledFingerprint(filePath, { full = false } = {}) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const size = st.size;
    const CHUNK = 2 * 1024 * 1024;
    const hash = crypto.createHash('sha256');
    hash.update(`sz:${size}`);
    // fh.read() may return FEWER bytes than asked for — it is not obliged to fill the buffer in one
    // call. A short read here would silently hash less of the file than intended, which on a
    // verify-before-delete is the difference between checking the footage and pretending to.
    const readAt = async (pos, len) => {
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        // eslint-disable-next-line no-await-in-loop
        const { bytesRead } = await fh.read(buf, got, len - got, Math.max(0, pos) + got);
        if (!bytesRead) break;                     // genuine EOF
        got += bytesRead;
      }
      hash.update(buf.subarray(0, got));
    };
    // full=true hashes the ENTIRE file (used to VERIFY a freshly-written copy — the sampled
    // head/mid/tail can't catch a mid-file corruption that preserves length). Sampled stays
    // the default for the resume/dedup pre-checks that scan whole cards.
    //
    // STREAM IT. This used to be a single readAt(0, size) — i.e. Buffer.alloc(size), the WHOLE FILE in
    // one buffer. Measured: a 900 MB clip took RSS from 43 MB to 987 MB, and verifyCopyPair hashes the
    // source and the copy IN PARALLEL, so ~1.9 GB of RAM per clip — on every copy and every delete.
    // GoPro chapters run to 4 GB, which is at Buffer's ceiling and would simply throw. Feeding the
    // same bytes in the same order to the same sha256 gives a byte-identical digest, so nothing that
    // stored a fingerprint before needs to change.
    if (full || size <= CHUNK * 3) {
      for (let pos = 0; pos < size; pos += CHUNK) await readAt(pos, Math.min(CHUNK, size - pos));
    } else { await readAt(0, CHUNK); await readAt(Math.floor(size / 2) - CHUNK / 2, CHUNK); await readAt(size - CHUNK, CHUNK); }
    return { size, hash: hash.digest('hex') };
  } finally { await fh.close(); }
}
// True when two files have the same size + sampled fingerprint (used for NAS
// resume-dedup and post-copy verification). Best-effort: false on any read error.
async function fingerprintsMatch(a, b, opts) {
  try { const [x, y] = await Promise.all([sampledFingerprint(a, opts), sampledFingerprint(b, opts)]); return x.size === y.size && x.hash === y.hash; }
  catch { return false; }
}
// Verify each copied file against its source BEFORE the originals are deleted.
//
// This is a DELETE GATE: whatever it marks ok, the user is then invited to erase from the
// card. So it hashes the FULL file, exactly like the other two delete gates
// (copyFileVerified / moveFileCrossDevice in 02-media.js). A sampled head/mid/tail hash
// reads ~6 MB of a 4 GB clip and cannot see a mid-file bit-flip that preserves length — it
// would report "verified" on a corrupt copy and the only good original then gets wiped.
// The intake copy itself (copyFileWithProgress) performs NO verification, so this is the
// only integrity check in the whole card-import -> verify -> clear-card flow.
// Cost is a full read of both files; this step is explicitly user-initiated and already
// renders a "Verifying copies…" progress state, so that is the right place to pay it.
// THE delete gate. Full-file hash of both sides; fail-closed on every error path. Deleting
// from the card is the one irreversible act in this app, so this function is the single
// source of truth for "is this file provably already copied?" — used both by the renderer's
// Verify step AND, non-negotiably, by delete:source itself (see below).
// Same volume? Removability is a property of the VOLUME, so a drive letter is exactly the right
// granularity — the same thing isOnRemovableVolume() compares.
function sameVolume(a, b) {
  const letterOf = (s) => {
    const m = /^([A-Za-z]):/.exec(String(s || '').replace(/^\\\\\?\\/, ''));
    return m ? m[1].toUpperCase() : '';
  };
  const la = letterOf(a); const lb = letterOf(b);
  return !!la && la === lb;
}

async function verifyCopyPair(src, dst) {
  let ok = false; let reason = '';
  try {
    if (!src) { reason = 'no source path'; }
    else if (!dst) { reason = 'no copy on record'; }
    else if (sameVolume(src, dst) && await isOnRemovableVolume(src)) {
      // A COPY ON THE SAME CARD IS NOT A COPY OFF THE CARD.
      //
      // uniqueDest() never overwrites, so pointing the intake folder at the card itself produces a
      // genuine, byte-identical second file — which passes identity, size AND hash. The gate would
      // delete the original, report success, and leave him with exactly one copy: on the card he is
      // about to wipe. The whole point of the delete step is that the footage is safe SOMEWHERE ELSE.
      //
      // Checked BEFORE the stat/hash: no point reading a gigabyte off a card to then reject it on
      // volume grounds. Only fires when the source really IS removable, so copying within an internal
      // disk (normal, safe) is untouched — and isOnRemovableVolume fails closed on Windows.
      reason = 'the copy is on the same card as the original — that is not a backup';
    }
    else if (pathsEqual(src, dst)) {
      // A FILE IS NOT A BACKUP OF ITSELF.
      //
      // Without this, `dest === source` sailed through every check below: stat the same file twice
      // (same size), hash it twice (same hash), "verified" — and then delete it. The gate reported
      // `ok: true, method: 'deleted'` while destroying the only copy of the footage. Deleting the
      // card is the one thing in this app that is not undoable, and it was the one check that could
      // fail OPEN.
      reason = 'the copy on record IS the source file — that is not a copy';
    } else {
      let ss = null; let ds = null;
      try { ss = await fsp.stat(src); } catch { reason = 'source missing'; }
      try { ds = await fsp.stat(dst); } catch { reason = reason || 'copy missing'; }
      // Same inode on the same device = the same file reached by a different name: a hardlink, a
      // symlink, a junction, a `subst`ed drive letter, a \\?\ prefix. pathsEqual compares strings
      // and cannot see any of those. The stats are already in hand, so this costs nothing.
      // A COPY ON THE SAME CARD IS NOT A COPY OFF THE CARD — the volume-identity form of the
      // drive-letter check above. That one compares path SPELLING, so it misses a card addressed as
      // `\\?\Volume{GUID}\…` (no letter at all) or mounted into a folder. `st.dev` is the volume
      // identity the OS itself reports, so it sees through spelling entirely.
      //
      // Strictly ADDITIVE: it can only ever refuse more, never fewer — the one direction this gate
      // is allowed to move. Gated on the source really being removable, so an ordinary copy within
      // one internal disk is untouched, and placed before the hash so a refusal costs no I/O.
      if (!reason && ss && ds && ss.dev === ds.dev && await isOnRemovableVolume(src)) {
        reason = 'the copy is on the same card as the original — that is not a backup';
      } else if (ss && ds && ss.ino && ss.ino === ds.ino && ss.dev === ds.dev) {
        reason = 'the copy on record is the same file as the source (a link, not a copy)';
      } else if (ss && ds) {
        if (ss.size !== ds.size) { reason = `size mismatch (${ss.size} vs ${ds.size})`; }
        else {
          const [fa, fb] = await Promise.all([
            sampledFingerprint(src, { full: true }),
            sampledFingerprint(dst, { full: true }),
          ]);
          if (fa.hash === fb.hash) ok = true; else reason = 'content mismatch';
        }
      }
    }
  } catch (e) { reason = e.message || String(e); }
  return { source: src, dest: dst, ok, reason };
}

ipcMain.handle('verify:copies', async (evt, pairs) => {
  const list = Array.isArray(pairs) ? pairs : [];
  const out = [];
  const total = list.length;
  for (let i = 0; i < total; i += 1) {
    const p = list[i];
    // #86: verifying HASHES the whole of every copy — 200 clips is minutes of work with no signal,
    // so the pre-delete "Verifying copies…" looked frozen. Emit per-pair progress before each hash
    // (best-effort; the sender may already be gone). Purely additive — the verdict is unchanged.
    try { evt.sender.send('verify:progress', { done: i, total, name: (p && p.name) || (p && p.source) || '' }); } catch { /* ignore */ }
    out.push(await verifyCopyPair(p && p.source, p && p.dest));
  }
  try { evt.sender.send('verify:progress', { done: total, total, name: '' }); } catch { /* ignore */ }
  return out;
});

// Free space on the volume that contains `folderPath` (walks up to the nearest
// existing ancestor so it works even before the folder is created).
// Walk up to the nearest ancestor that actually exists, so free space can be read for a folder we
// have not created yet (a brand-new project folder is the normal case).
async function nearestExistingDir(folderPath) {
  let probe = String(folderPath || '');
  if (!probe) throw new Error('no path');
  for (let i = 0; i < 8; i += 1) {
    try { await fsp.access(probe); return probe; } catch { /* keep walking up */ }
    const up = path.dirname(probe);
    if (!up || up === probe) break;
    probe = up;
  }
  return probe;
}

ipcMain.handle('disk:freeSpace', async (_evt, folderPath) => {
  try {
    if (!folderPath) return { ok: false, error: 'no path' };
    // #95: free space + the resolved probe path leak disk layout. Same allowlist as the rest.
    if (!isPathAllowed(folderPath)) return refusePath('disk:freeSpace', folderPath);
    const probe = await nearestExistingDir(folderPath);
    const st = await fsp.statfs(probe);
    return { ok: true, free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize), path: probe };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Does a path still exist + is it readable? Used by resume-on-launch to decide whether
// last session's source (a card that may have been unplugged, or a folder) is reachable
// before re-entering that flow.
ipcMain.handle('path:exists', async (_evt, p) => {
  // #95: unguarded this is a disk-mapping oracle — ask it about enough paths and you learn what's
  // on the machine. It returns a bare boolean (resume-on-launch wants a yes/no), so a refusal is
  // reported as `false`: not-reachable-by-this-app, which is exactly what the caller should do.
  try { if (!p || !isPathAllowed(p)) return false; await fsp.access(String(p)); return true; } catch { return false; }
});

// Lightweight index of imported source files (key = name+size) so a re-inserted
// card's already-copied clips can be flagged and skipped. Capped to 30k entries.
ipcMain.handle('imports:get', () => Object.keys(config.importIndex || {}));
ipcMain.handle('imports:add', (_evt, payload) => {
  const keys = (payload && Array.isArray(payload.keys)) ? payload.keys : [];
  if (!keys.length) return { ok: true };
  if (!config.importIndex || typeof config.importIndex !== 'object') config.importIndex = {};
  const now = Date.now();
  for (const k of keys) { if (k) config.importIndex[String(k)] = now; }
  let entries = Object.entries(config.importIndex);
  if (entries.length > 30000) { entries.sort((a, b) => b[1] - a[1]); config.importIndex = Object.fromEntries(entries.slice(0, 30000)); }
  saveConfig();
  return { ok: true, total: Object.keys(config.importIndex).length };
});

// Delete originals from the card. FAIL-CLOSED, and it re-verifies here rather than trusting
// the caller.
//
// This used to take a bare array of paths and unlink whatever it was given — the entire
// "only delete what's provably copied" gate lived up in the renderer. That put the one
// irreversible operation in the app behind a guard that any renderer bug could silently
// disarm (and this codebase has had plenty). The check now lives next to the delete:
//   - the payload MUST be {source, dest} pairs — a bare path proves nothing and is refused;
//   - every file is re-hashed against its copy right here, immediately before the unlink;
//   - anything that doesn't verify is REFUSED and left on the card, with the reason returned.
// It is deliberately impossible to talk this handler into deleting an unverified file.
ipcMain.handle('delete:source', async (_evt, items) => {
  const results = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const src = (it && typeof it === 'object') ? it.source : null;
    const dst = (it && typeof it === 'object') ? it.dest : null;
    if (!src) {
      results.push({ path: String((it && it.source) || it || ''), ok: false, method: '', refused: true, error: 'refused: delete:source needs {source, dest} — a bare path carries no proof a copy exists' });
      continue;
    }
    const v = await verifyCopyPair(src, dst);
    if (!v.ok) {
      results.push({ path: src, ok: false, method: '', refused: true, error: `refused — not deleting: ${v.reason || 'the copy could not be verified'}` });
      continue;
    }
    let ok = false; let method = ''; let error = '';
    // Prefer the Recycle Bin (recoverable), but USB/SD cards (exFAT/removable)
    // usually have no Recycle Bin — there, permanently delete (the intent when
    // clearing a card after copying).
    try { await shell.trashItem(src); ok = true; method = 'recycle'; }
    catch (e1) {
      try { await fsp.rm(src, { force: true }); ok = true; method = 'deleted'; }
      catch (e2) { error = e2.message || e1.message; }
    }
    results.push({ path: src, ok, method, error });
  }
  return results;
});

ipcMain.handle('open:folder', async (_evt, folder) => {
  // #95: this hands a path to the SHELL. Unguarded it was "open anything on this disk" for anyone
  // who could get script into the webSecurity:false renderer.
  const target = folder || config.intakeFolder;
  if (!isPathAllowed(target)) return refusePath('open:folder', target);
  try {
    await shell.openPath(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    // FIRST, in the primary only (we hold the single-instance lock here): move any
    // append-heavy stores still living in config.json into their own sidecar files,
    // before anything can trigger a config save. One-time; a no-op once migrated.
    migrateStores();
    sweepStoreTemps();   // clear any atomic-write .tmp orphans a prior crash left in the store dir

    // Keep the OS login-item entry in sync with config on every start.
    applyLoginItem(config.launchAtLogin);
    console.log(`[startup] launchAtLogin = ${config.launchAtLogin}`);

    ingestMemoryInbox();   // fold any externally-dropped learnings into AI memory
    // Purge last session's thumbnail/poster scratch so temp can't grow without bound.
    try { fs.rmSync(THUMB_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    prunePosterCache();   // bound the PERSISTENT poster cache (survives launches, unlike THUMB_DIR)
    createWindow();
    createTray();

    // Self-update from the Gitea "latest" feed (packaged Windows only). Check a
    // few seconds after boot so it never delays the first paint, then every 6h.
    setTimeout(() => setupAutoUpdates(), 8000);
    setInterval(() => setupAutoUpdates(), 6 * 60 * 60 * 1000);

    // Global hotkey (low-overhead alternative to polling).
    if (config.hotkey) {
      const ok = globalShortcut.register(config.hotkey, triggerHotkey);
      if (ok) console.log(`[hotkey] registered ${config.hotkey}`);
      else console.error(`[hotkey] FAILED to register ${config.hotkey} (already in use?)`);
    }

    // Background polling is opt-in (set "autoPoll": true in config.json).
    if (config.autoPoll) {
      console.log('[detect] auto-poll enabled');
      startPolling();
    } else {
      console.log('[detect] auto-poll disabled — use the hotkey or “Choose drive…”.');
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Do NOT quit when the window closes — the app lives in the tray so the global
// hotkey keeps working. Quit only via the tray's "Quit" item.
app.on('window-all-closed', () => { /* stay resident */ });

app.on('before-quit', () => {
  isQuitting = true;
  if (pollTimer) clearInterval(pollTimer);
  globalShortcut.unregisterAll();
  endExifTool();
});
