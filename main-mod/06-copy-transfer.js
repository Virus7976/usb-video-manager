// ---------------------------------------------------------------------------
// ffprobe metadata (recording date + duration) for the structured renamer.
// Clip previews play natively in a <video> element, so no FFmpeg thumbnails.
// ---------------------------------------------------------------------------
const metaCache = new Map(); // sourcePath -> { durationSec, dateISO }

// Kill a spawned ffmpeg/ffprobe child if it hangs (corrupt/odd-codec clips can stall
// forever), so the bounded poster/face pipeline can't deadlock and zombies don't pile
// up. The existing 'close'/'error' handlers fire on the kill and settle the Promise.
function killAfter(proc, ms) {
  const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, ms);
  const clear = () => clearTimeout(t);
  try { proc.on('close', clear); proc.on('error', clear); } catch { /* ignore */ }
  return proc;
}
// Single source for "extract ONE frame at timestamp ss to outPath, scaled per `scale`
// (an ffmpeg -vf scale= value)". Replaces 5 near-identical copies that differed only in
// the scale string. Resolves true on success.
function extractFrame(srcPath, ss, outPath, scale, timeout = 60000) {
  return new Promise((resolve) => {
    const proc = killAfter(spawn(config.ffmpegPath, [
      '-y', '-ss', String(ss), '-i', srcPath, '-frames:v', '1', '-vf', `scale=${scale}`, outPath
    ], { windowsHide: true }), timeout);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

function runFfprobeJson(srcPath) {
  return new Promise((resolve) => {
    const proc = killAfter(spawn(config.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration:format_tags=creation_time',
      '-of', 'json', srcPath
    ], { windowsHide: true }), 30000);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

async function probeMeta(srcPath) {
  if (metaCache.has(srcPath)) return metaCache.get(srcPath);
  let durationSec = 0;
  let dateISO = null;
  const out = await runFfprobeJson(srcPath);
  if (out) {
    try {
      const j = JSON.parse(out);
      durationSec = parseFloat(j.format && j.format.duration) || 0;
      const ct = j.format && j.format.tags && j.format.tags.creation_time;
      if (ct) dateISO = ct;
    } catch { /* ignore */ }
  }
  const meta = { durationSec, dateISO };
  metaCache.set(srcPath, meta);
  return meta;
}

// ---------------------------------------------------------------------------
// Poster frames — one static JPG per clip via FFmpeg (software decode, so it
// does NOT consume a GPU HEVC decode session). These are the at-rest preview;
// a live <video> is only created for the clip the user actually plays.
// ---------------------------------------------------------------------------
const POSTER_MAX = 3;
let posterActive = 0;
const posterQueue = [];
function acquirePoster() {
  if (posterActive < POSTER_MAX) { posterActive += 1; return Promise.resolve(); }
  return new Promise((resolve) => posterQueue.push(resolve));
}
function releasePoster() {
  posterActive -= 1;
  const next = posterQueue.shift();
  if (next) { posterActive += 1; next(); }
}

const posterCache = new Map(); // srcPath -> file:// url
const faceFrameCache = new Map(); // srcPath -> file path (960px single frame for face detection)
let posterCounter = 0;
function ffmpegFrame(srcPath, ss, outPath) {
  return extractFrame(srcPath, ss, outPath, '400:-2');
}
async function getPoster(srcPath) {
  if (posterCache.has(srcPath)) return posterCache.get(srcPath);
  // A photo is its own poster — no ffmpeg needed. (HEIC may not render in Chromium;
  // that's fine — the tile just shows a generic icon, AI still reads the file.)
  if (isImagePath(srcPath)) { const u = fileUrl(srcPath); posterCache.set(srcPath, u); return u; }
  await acquirePoster();
  try {
    await ensureDir(THUMB_DIR);
    posterCounter += 1;
    const outPath = path.join(THUMB_DIR, `poster_${posterCounter}.jpg`);
    let ok = await ffmpegFrame(srcPath, 1, outPath);   // ~1s in
    if (!ok) ok = await ffmpegFrame(srcPath, 0, outPath); // very short clips
    if (!ok) return null;
    const url = fileUrl(outPath);
    posterCache.set(srcPath, url);
    return url;
  } finally {
    releasePoster();
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => ({
  intakeFolder: config.intakeFolder,
  photosTempFolder: config.photosTempFolder,
  phoneNasFolder: config.phoneNasFolder,
  phoneComputerFolder: config.phoneComputerFolder,
  phoneBackupSource: config.phoneBackupSource || '',   // wireless: NAS folder the phone auto-uploads to
  phoneDestComputer: !!config.phoneDestComputer,
  phoneDestNas: config.phoneDestNas !== false,
  simulatePhone: config.simulatePhone === true,
  ffmpegPath: config.ffmpegPath,
  hotkey: config.hotkey,
  autoPoll: !!config.autoPoll,
  ui: { showHelp: false, compact: false, showResult: true, autoplayAudio: false, notifications: true, showCommandBar: true, showMetaRow: true, finMatchedOnly: false, ...(config.ui || {}) },
  previewWidth: Number(config.previewWidth) || 248,
  hotkeys: { jumpUnnamed: 'F2', captureMacro: 'Ctrl+Shift+S', ...(config.hotkeys || {}) },
  textMacros: Array.isArray(config.textMacros) ? config.textMacros : [],
  copyDateMode: ['always', 'ask', 'never'].includes(config.copyDateMode) ? config.copyDateMode : 'always',
  enterFlow: ['columns', 'row'].includes(config.enterFlow) ? config.enterFlow : 'columns',
  folderLevels: Array.isArray(config.folderLevels) ? config.folderLevels : ['category', 'project'],
  organizeFields: config.organizeFields,
  organizeDest: config.organizeDest || '',
  finalizeSource: config.finalizeSource || '',
  projectsRoot: config.projectsRoot || config.organizeDest || defaultProjectsRoot(),
  ai: {
    enabled: !!(config.ai && config.ai.enabled),
    endpoint: (config.ai && config.ai.endpoint) || 'http://localhost:11434',
    model: (config.ai && config.ai.model) || '',
    textModel: (config.ai && config.ai.textModel) || '',
    suggestCategory: !(config.ai && config.ai.suggestCategory === false),
    frames: Math.max(1, Math.min(12, Number(config.ai && config.ai.frames) || 3)),
    detectShot: !(config.ai && config.ai.detectShot === false),
    updateSubject: !!(config.ai && config.ai.updateSubject),
    shotTypes: Array.isArray(config.ai && config.ai.shotTypes) ? config.ai.shotTypes : [],
    askAfterRun: !!(config.ai && config.ai.askAfterRun),
    temperature: (() => { const t = Number(config.ai && config.ai.temperature); return isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.2; })(),
    prompt: (config.ai && config.ai.prompt) || '',
    multiPass: !!(config.ai && config.ai.multiPass),
    learnFromEdits: !(config.ai && config.ai.learnFromEdits === false),
    learnFromAnalysis: !(config.ai && config.ai.learnFromAnalysis === false),
    faceInterval: Math.max(1, Math.min(15, Number(config.ai && config.ai.faceInterval) || 2)),
    faceMaxFrames: Math.max(4, Math.min(120, Number(config.ai && config.ai.faceMaxFrames) || 24)),
    memories: Array.isArray(config.ai && config.ai.memories) ? config.ai.memories : []
  },
  nasBackup: { enabled: !!(config.nasBackup && config.nasBackup.enabled), path: (config.nasBackup && config.nasBackup.path) || '' },
  detectionEnabled: DETECTION_ENABLED,
  // First-ever launch (no saved config yet) → renderer shows the setup wizard once.
  firstRun: !USER_CONFIG_EXISTED
}));

// Persist rename-screen prefs that aren't simple booleans (zoom width, hotkeys,
// text shortcuts).
ipcMain.handle('prefs:set', (_evt, patch) => {
  if (patch && typeof patch === 'object') {
    if (typeof patch.previewWidth === 'number' && isFinite(patch.previewWidth)) {
      config.previewWidth = Math.round(patch.previewWidth);
    }
    if (patch.hotkeys && typeof patch.hotkeys === 'object') {
      config.hotkeys = { ...(config.hotkeys || {}), ...patch.hotkeys };
    }
    if (Array.isArray(patch.textMacros)) {
      config.textMacros = patch.textMacros
        .filter((m) => m && typeof m.key === 'string' && typeof m.text === 'string' && m.key && m.text)
        .map((m) => ({ key: m.key, text: m.text }));
    }
    if (['always', 'ask', 'never'].includes(patch.copyDateMode)) {
      config.copyDateMode = patch.copyDateMode;
    }
    if (['columns', 'row'].includes(patch.enterFlow)) {
      config.enterFlow = patch.enterFlow;
    }
    if (['external', 'app'].includes(patch.compressMode)) {
      config.compressMode = patch.compressMode;
    }
    if (Array.isArray(patch.folderLevels)) {
      config.folderLevels = patch.folderLevels.filter((s) => typeof s === 'string');
    }
    if (typeof patch.organizeDest === 'string') config.organizeDest = patch.organizeDest;
    if (typeof patch.finalizeSource === 'string') config.finalizeSource = patch.finalizeSource;
    if (Array.isArray(patch.organizeFields)) {
      config.organizeFields = normalizeOrganizeFields(patch.organizeFields);
      for (const f of config.organizeFields) if (!Array.isArray(config.fieldHistory[f.id])) config.fieldHistory[f.id] = [];
    }
    if (patch.nasBackup && typeof patch.nasBackup === 'object') {
      config.nasBackup = { enabled: !!patch.nasBackup.enabled, path: String(patch.nasBackup.path || '') };
    }
    if (patch.ai && typeof patch.ai === 'object') {
      const t = Number(patch.ai.temperature);
      const prev = config.ai || {};
      // Spread prev FIRST so fields NOT in the settings dialog (routes, people/faces,
      // clipObs, etc.) survive a save — only the explicit settings below override them.
      config.ai = {
        ...prev,
        enabled: !!patch.ai.enabled,
        endpoint: String(patch.ai.endpoint || 'http://localhost:11434').trim() || 'http://localhost:11434',
        model: String(patch.ai.model || '').trim(),
        textModel: String(patch.ai.textModel || '').trim(),
        suggestCategory: patch.ai.suggestCategory !== false,
        frames: Math.max(1, Math.min(12, Number(patch.ai.frames) || 3)),
        detectShot: patch.ai.detectShot !== false,
        updateSubject: !!patch.ai.updateSubject,
        askAfterRun: !!patch.ai.askAfterRun,
        shotTypes: Array.isArray(patch.ai.shotTypes)
          ? patch.ai.shotTypes.map((s) => ({ name: String((s && s.name) || '').trim(), desc: String((s && s.desc) || '').trim() })).filter((s) => s.name)
          : (Array.isArray(prev.shotTypes) ? prev.shotTypes : []),
        temperature: isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.2,
        prompt: String(patch.ai.prompt || ''),
        multiPass: !!patch.ai.multiPass,
        learnFromEdits: patch.ai.learnFromEdits !== false,
        learnFromAnalysis: patch.ai.learnFromAnalysis !== false,
        faceInterval: Math.max(1, Math.min(15, Number(patch.ai.faceInterval) || Number(prev.faceInterval) || 2)),
        faceMaxFrames: Math.max(4, Math.min(120, Number(patch.ai.faceMaxFrames) || Number(prev.faceMaxFrames) || 24)),
        // Memories: editable list from the settings dialog; preserved (with the
        // raw feedback log) when other settings are saved.
        memories: Array.isArray(patch.ai.memories)
          ? patch.ai.memories
            .map((m) => ({ id: (m && m.id) || newMemId(), text: String((m && m.text) || '').trim(), example: String((m && m.example) || '').trim(), ts: (m && m.ts) || Date.now() }))
            .filter((m) => m.text)
          : (Array.isArray(prev.memories) ? prev.memories : []),
        styleExamples: Array.isArray(prev.styleExamples) ? prev.styleExamples : [],
        feedbackLog: Array.isArray(prev.feedbackLog) ? prev.feedbackLog : []
      };
    }
    saveConfig();
  }
  return {
    previewWidth: Number(config.previewWidth) || 248,
    hotkeys: { jumpUnnamed: 'F2', captureMacro: 'Ctrl+Shift+S', ...(config.hotkeys || {}) },
    textMacros: Array.isArray(config.textMacros) ? config.textMacros : [],
    copyDateMode: ['always', 'ask', 'never'].includes(config.copyDateMode) ? config.copyDateMode : 'always'
  };
});

ipcMain.handle('ui:set', (_evt, payload) => {
  config.ui = { showHelp: false, compact: false, showResult: true, autoplayAudio: false, notifications: true, showCommandBar: true, showMetaRow: true, finMatchedOnly: false, cleanGrid: true, dayDividers: true, showLocation: false, ...(config.ui || {}) };
  if (payload && typeof payload.key === 'string') config.ui[payload.key] = !!payload.value;
  saveConfig();
  return config.ui;
});

ipcMain.handle('theme:get', () => ({ dark: isDark(), accent: accentHex() }));

ipcMain.handle('drive:listRemovable', () => listRemovableDrives());

ipcMain.handle('app:hide', () => {
  if (mainWindow) mainWindow.hide();
});

async function confirmQuitIfCopying() {
  if (copyTask && copyTask.active && mainWindow) {
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Finish in background, then quit', 'Stop copy & quit now', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'A copy is in progress',
      detail: 'Let it finish in the background (the app closes automatically and notifies you when it’s done), stop it and quit now, or cancel.'
    });
    if (res.response === 0) {
      // Keep copying; the copy:start handler quits the app once it completes.
      quitAfterCopy = true;
      if (mainWindow) mainWindow.hide();
      return false;
    }
    if (res.response === 2) return false; // cancel the quit
    // Stop & quit now.
    copyTask.aborted = true;
    if (copyTask.token && copyTask.token.destroy) copyTask.token.destroy();
  }
  return true;
}

ipcMain.handle('app:quit', async () => {
  if (!(await confirmQuitIfCopying())) return;
  // Rename work auto-saves continuously, so quitting just quits — no popup that
  // would otherwise re-show the window and tempt a confusing second launch.
  isQuitting = true;
  app.quit();
});

// Allow user to pick a drive manually (fallback / testing without hardware).
ipcMain.handle('drive:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select USB / SD card root folder',
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return { mountpoint: res.filePaths[0], description: 'Manually selected drive', size: 0, isCard: false, isUSB: false };
});

// Wireless workflow: remember the NAS folder a phone app auto-uploads the camera roll
// into, so it's a one-tap source on the home screen (no re-navigating each time).
ipcMain.handle('phoneBackup:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the NAS folder your phone uploads to (e.g. QNAP QuMagie upload folder)',
    defaultPath: config.phoneBackupSource || undefined,
    properties: ['openDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false };
  config.phoneBackupSource = res.filePaths[0]; saveConfig();
  return { ok: true, path: config.phoneBackupSource };
});
ipcMain.handle('phoneBackup:clear', () => { config.phoneBackupSource = ''; saveConfig(); return { ok: true }; });

ipcMain.handle('scan:videos', async (_evt, mountpoint) => {
  if (!mountpoint) return { ok: false, error: 'No mountpoint provided' };
  try {
    const files = await walkForVideos(mountpoint);
    return { ok: true, files };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Tracked copy task so progress survives navigation / window close, and so the
// renderer can resume the view or cancel it.
let copyTask = null; // { active, totalFiles, totalBytes, copiedBytes, currentIndex, currentName, aborted, token }

function copyStatus() {
  if (!copyTask) return { active: false };
  return {
    active: copyTask.active,
    totalFiles: copyTask.totalFiles,
    totalBytes: copyTask.totalBytes,
    copiedBytes: copyTask.copiedBytes,
    currentIndex: copyTask.currentIndex,
    currentName: copyTask.currentName
  };
}

ipcMain.handle('copy:status', () => copyStatus());

ipcMain.handle('copy:cancel', () => {
  phoneAbort = true;   // stop the phone pull/copy loops (long video transfers)
  if (copyTask && copyTask.active) {
    copyTask.aborted = true;
    if (copyTask.token && copyTask.token.destroy) copyTask.token.destroy();
  }
  return true;
});

// Native Windows taskbar progress — the accent bar that fills on the app's taskbar icon
// (fraction 0..1; anything else clears it). Mirrors the in-app progress.
ipcMain.on('progress:set', (_e, frac) => {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(typeof frac === 'number' && frac >= 0 && frac <= 1 ? frac : -1); } catch { /* ignore */ }
});
// Interaction breadcrumb log — appends clicks/navigation to interaction-log.jsonl in
// userData so a reported problem can be traced to "what did I click / where did it go".
// Rolling-capped to ~512KB.
ipcMain.on('log:interaction', (_e, entry) => {
  try {
    const f = path.join(app.getPath('userData'), 'interaction-log.jsonl');
    fs.appendFileSync(f, JSON.stringify(entry) + '\n');
    let st = null; try { st = fs.statSync(f); } catch { /* first write */ }
    if (st && st.size > 512 * 1024) { const buf = fs.readFileSync(f); fs.writeFileSync(f, buf.slice(buf.length - 256 * 1024)); }
  } catch { /* ignore */ }
});

// Copy the given files to the intake folder, reporting progress events.
ipcMain.handle('copy:start', async (evt, payload) => {
  // Refuse a second copy while one is running — a concurrent copy would overwrite the
  // shared copyTask, breaking cancel/status/progress for the first one.
  if (copyTask && copyTask.active) return { ok: false, error: 'A copy is already running' };
  const { files, intakeFolder } = payload;
  const dest = intakeFolder || config.intakeFolder;
  const sender = evt.sender;

  try {
    await ensureDir(dest);
  } catch (err) {
    return { ok: false, error: `Cannot create intake folder: ${err.message}` };
  }

  // Optional second copy to a NAS / backup location during intake. Failures are
  // reported but never abort the main copy (the card import is what matters).
  let nasRoot = '';
  const nasSummary = { ok: 0, failed: 0, verified: 0, skipped: 0, setupError: '' };
  if (config.nasBackup && config.nasBackup.enabled && config.nasBackup.path) {
    nasRoot = config.nasBackup.path;
    try { await ensureDir(nasRoot); }
    catch (err) { nasSummary.setupError = err.message; nasRoot = ''; }
  }

  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const copied = [];
  copyTask = {
    active: true, totalFiles: files.length, totalBytes, copiedBytes: 0,
    currentIndex: 0, currentName: '', aborted: false, token: {}
  };
  const emit = (phase) => sender.send('copy:progress', {
    phase,
    currentIndex: copyTask.currentIndex,
    currentName: copyTask.currentName,
    totalFiles: copyTask.totalFiles,
    copiedBytes: copyTask.copiedBytes,
    totalBytes: copyTask.totalBytes
  });

  for (let i = 0; i < files.length; i += 1) {
    if (copyTask.aborted) break;
    const f = files[i];
    const targetName = destNameFor(f);
    let destPath;
    copyTask.currentIndex = i;
    copyTask.currentName = targetName;
    try {
      destPath = await uniqueDest(dest, targetName);
      emit('copying');
      let lastEmit = 0;
      await copyFileWithProgress(f.sourcePath, destPath, (n) => {
        copyTask.copiedBytes += n;
        const now = Date.now();
        if (now - lastEmit > 80) { lastEmit = now; emit('copying'); }
      }, copyTask.token);
      copied.push({
        sourcePath: f.sourcePath, destPath,
        name: path.basename(destPath), ext: f.ext, size: f.size
      });
      // Mirror this file to the NAS (copy from the just-written intake file, not the
      // card — faster). RESUME-safe: skip a file already there ONLY when its content
      // fingerprint matches (not just size). After copying, VERIFY the NAS copy and
      // retry once on mismatch. Failures are logged, never fatal to the card import.
      if (nasRoot) {
        try {
          const nasTarget = path.join(nasRoot, path.basename(destPath));
          let need = true;
          try {
            const st = await fsp.stat(nasTarget);
            if (st.size === (f.size || 0) && await fingerprintsMatch(destPath, nasTarget)) need = false;
          } catch { /* not there yet */ }
          if (need) {
            await fsp.copyFile(destPath, nasTarget);
            if (!await fingerprintsMatch(destPath, nasTarget)) {
              await fsp.copyFile(destPath, nasTarget);   // one retry
              if (!await fingerprintsMatch(destPath, nasTarget)) throw new Error('verification failed after copy');
            }
            nasSummary.verified = (nasSummary.verified || 0) + 1;
          } else {
            nasSummary.skipped = (nasSummary.skipped || 0) + 1;
          }
          nasSummary.ok += 1;
        } catch (err) {
          nasSummary.failed += 1;
          console.error(`NAS backup failed for ${path.basename(destPath)}: ${err.message}`);
        }
      }
    } catch (err) {
      if (copyTask.aborted) {
        try { await fsp.unlink(destPath); } catch { /* partial may not exist */ }
        break;
      }
      copyTask.active = false;
      const result = { ok: false, error: `Failed copying ${f.name}: ${err.message}`, copied };
      copyTask = null;
      notify('Copy failed', `${f.name}: ${err.message}`);
      if (quitAfterCopy) { quitAfterCopy = false; isQuitting = true; app.quit(); }
      return result;
    }
  }

  const aborted = copyTask.aborted;
  copyTask.active = false;
  emit(aborted ? 'cancelled' : 'done');
  copyTask = null;

  const nasNote = nasRoot
    ? ` · backed up ${nasSummary.ok} to NAS (verified${nasSummary.skipped ? `, ${nasSummary.skipped} already there` : ''})${nasSummary.failed ? ` · ${nasSummary.failed} failed` : ''}`
    : '';
  if (aborted) {
    notify('Copy cancelled', `${copied.length} of ${files.length} file${files.length !== 1 ? 's' : ''} copied before cancelling.${nasNote}`);
  } else {
    const bytes = copied.reduce((s, c) => s + (c.size || 0), 0);
    notify('Copy complete', `Copied ${copied.length} clip${copied.length !== 1 ? 's' : ''} (${fmtBytesMain(bytes)}) to intake.${nasNote}`);
  }
  // If the user chose to quit-when-done while a copy was running, do it now.
  if (quitAfterCopy) { quitAfterCopy = false; isQuitting = true; app.quit(); }

  return { ok: !aborted, cancelled: aborted, copied, nas: { ...nasSummary, enabled: !!nasRoot } };
});

ipcMain.handle('media:url', (_evt, filePath) => fileUrl(filePath));

ipcMain.handle('meta:get', (_evt, srcPath) => probeMeta(srcPath));

ipcMain.handle('poster:get', (_evt, srcPath) => getPoster(srcPath));

// ---------------------------------------------------------------------------
// Local AI suggestions via Ollama (optional, fully offline). Talks to the local
// Ollama server over HTTP; the clip's poster frame (already extracted by ffmpeg)
// is sent as a base64 image. Nothing leaves the machine.
// ---------------------------------------------------------------------------
function aiEndpoint() {
  return ((config.ai && config.ai.endpoint) || 'http://localhost:11434').replace(/\/+$/, '');
}
async function ollamaFetch(pathname, opts = {}, timeoutMs = 6000) {
  return fetch(aiEndpoint() + pathname, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
}
// One Ollama /api/generate call. Returns the raw `response` string. Pass
// `images` for a vision call, `format:'json'` to force JSON. Throws on HTTP error.
async function ollamaGenerate(model, prompt, opts = {}) {
  const body = { model, prompt, stream: false };
  if (opts.images && opts.images.length) body.images = opts.images;
  if (opts.format) body.format = opts.format;
  // Disable thinking-model reasoning (Qwen3, deepseek-r1, …) by default — it's
  // faster and keeps strict-JSON output clean. Ollama ignores `think` for models
  // that don't support it (verified). Pass opts.think:true to allow reasoning.
  body.think = opts.think === undefined ? false : !!opts.think;
  body.options = { temperature: isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.2 };
  const res = await ollamaFetch('/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }, opts.timeout || 180000);
  if (!res.ok) {
    // Surface Ollama's own error text — a bare "HTTP 500" hides the real cause
    // (e.g. a model that can't load: "unknown model architecture: 'mllama'").
    let detail = '';
    try { const b = await res.json(); detail = (b && b.error && (b.error.message || b.error)) || ''; }
    catch { try { detail = await res.text(); } catch { /* ignore */ } }
    detail = String(detail || '').replace(/\s+/g, ' ').trim();
    const e = new Error(`Ollama HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    e.status = res.status; e.detail = detail; e.model = model;
    throw e;
  }
  const j = await res.json();
  // Strip any stray <think>…</think> reasoning so callers get clean text/JSON.
  return String(j.response || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
// The model used for TEXT-ONLY tasks (distilling rules, consolidating memories,
// refining, importing, and the reasoning passes of multi-pass). Falls back to the
// vision model when no dedicated reasoning model is set.
function aiTextModel() { return (config.ai && config.ai.textModel) || (config.ai && config.ai.model) || ''; }

// True when an Ollama error means the chosen model can't actually run on this
// machine/version (not a transient timeout): the runner crashed loading it
// ("unknown model architecture: 'mllama'" on older builds), the GGUF won't load,
// it OOM'd, or the model isn't pulled (404). These are worth a fallback.
function isModelLoadError(err) {
  if (!err) return false;
  const status = err.status;
  const s = `${err.message || ''} ${err.detail || ''}`.toLowerCase();
  if (status === 404 || /not found|no such model|try pulling it/.test(s)) return true;
  if (status === 500 && /terminated|unknown model architecture|error loading model|failed to load|cannot (allocate|load)|out of memory|mllama|requires more system memory/.test(s)) return true;
  return false;
}
// Installed models that can take images, best→worst-ish, excluding `exclude`.
async function listVisionModels(exclude) {
  try {
    const res = await ollamaFetch('/api/tags', {}, 6000);
    if (!res.ok) return [];
    const j = await res.json();
    const names = (j.models || []).map((m) => m && m.name).filter(Boolean);
    const out = [];
    for (const n of names) { if (n === exclude) continue; if (await ollamaModelVision(n)) out.push(n); }
    return out;
  } catch { return []; }
}
// A note about an automatic vision-model swap, surfaced to the UI once (so the
// user learns their configured model is broken) then cleared.
let _visionFallbackNote = '';
let _visionFallbackModel = '';
function takeVisionNote() { const n = _visionFallbackNote; _visionFallbackNote = ''; return n; }
function takeVisionSwitch() { const m = _visionFallbackModel; _visionFallbackModel = ''; return m; }
// Vision generate that survives a broken/unloadable vision model. If the chosen
// model can't load (e.g. llama3.2-vision's 'mllama' arch on an older Ollama → HTTP
// 500), fall back to another INSTALLED vision model, persist it as the new default
// so we don't 500 again next run, and record a note for the UI.
async function ollamaVisionGenerate(model, prompt, opts) {
  try { return await ollamaGenerate(model, prompt, opts); }
  catch (err) {
    if (!isModelLoadError(err)) throw err;
    const alts = await listVisionModels(model);
    for (const alt of alts) {
      try {
        const out = await ollamaGenerate(alt, prompt, opts);
        config.ai = config.ai || {};
        if (config.ai.model === model) { config.ai.model = alt; saveConfig(); }
        _visionFallbackNote = `Vision model "${model}" couldn't load on your Ollama (${(err.detail || err.message || '').slice(0, 90)}). Switched to "${alt}".`;
        _visionFallbackModel = alt;
        return out;
      } catch (e2) { if (!isModelLoadError(e2)) throw e2; /* else try next alt */ }
    }
    throw err;   // no working vision model available — let the caller report it
  }
}
// Parse a JSON object out of a model response, tolerating prose/code fences.
function parseJsonLoose(raw) {
  try { return JSON.parse(raw); } catch { /* try to extract */ }
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return {};
}
// Coerce a model-returned field to a clean string — it may hand back an array
// (e.g. description: ["indoor","close-up"]) or even an object.
function aiFieldStr(v) {
  if (Array.isArray(v)) return aiExtractStrings(v).join(' ');
  if (v && typeof v === 'object') return aiExtractStrings(v).join(' ');
  return String(v == null ? '' : v).trim();
}
// Best-effort check of whether a model can take images (newer Ollama reports
// `capabilities: ["vision", …]` from /api/show; otherwise fall back to the name).
async function ollamaModelVision(name) {
  try {
    const res = await ollamaFetch('/api/show', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name })
    }, 5000);
    if (res.ok) {
      const j = await res.json();
      if (Array.isArray(j.capabilities)) return j.capabilities.includes('vision');
      const fams = (j.details && j.details.families) || [];
      if (fams.some((f) => /clip|mllama|vision|qwen.*vl|gemma3/i.test(f))) return true;
    }
  } catch { /* fall through to name heuristic */ }
  return /llava|vision|qwen.*vl|minicpm-v|moondream|bakllava/i.test(name);
}

const AI_DEFAULT_GUIDANCE = "You are tagging one video clip for a videographer's archive. The image is a contact-sheet GRID of frames sampled across the clip in time order (left-to-right, top-to-bottom). They are all from the SAME clip. COMPARE the frames to judge CAMERA MOTION (static / handheld / moving — panning or following) and whether it stays one continuous shot or cuts between shots, then identify the main subject, the action, and the type of shot.";

// What the VISION pass is asked for: a concrete, literal description of what is
// actually on screen. Deliberately gets NO videographer note — a weak vision
// model that's handed the note tends to parrot it instead of looking, which is
// exactly how descriptions turn into a reshuffle of the user's own words.
const PERCEIVE_INSTRUCTION = "In 1-2 plain sentences, describe ONLY what you can literally SEE in these frames: who or what is in shot and roughly how many, the SPECIFIC physical action happening (be concrete — e.g. 'a person doing push-ups on grass', 'a ride-on mower cutting a lawn'), the setting/environment and any notable objects, and the type of shot plus the camera movement. Describe the footage itself. Do NOT guess names, do NOT tag or label anything — just report what is visible.";

// Built-in shot types (used when the user hasn't defined their own). Each has a
// short definition so the model knows what it looks like.
const DEFAULT_SHOT_TYPES = [
  { name: 'talking-head', desc: 'a person speaking to camera, fairly static framing' },
  { name: 'pov', desc: 'first-person point-of-view; camera moves with the wearer' },
  { name: 'vlog', desc: 'handheld self-recording, person plus their surroundings' },
  { name: 'interview', desc: 'one or more people being interviewed' },
  { name: 'b-roll', desc: 'supplementary footage, no main speaker' },
  { name: 'action', desc: 'fast movement or sport' },
  { name: 'wide-establishing', desc: 'a wide shot that sets the scene' },
  { name: 'timelapse', desc: 'sped-up footage over time' },
  { name: 'still', desc: 'a held photo or barely-moving frame' }
];
function aiShotTypes() {
  const list = (config.ai && Array.isArray(config.ai.shotTypes)) ? config.ai.shotTypes : [];
  const clean = list.map((s) => ({ name: String((s && s.name) || '').trim(), desc: String((s && s.desc) || '').trim() })).filter((s) => s.name);
  return clean.length ? clean : DEFAULT_SHOT_TYPES;
}

// Recursively pull every string out of whatever shape the model returned — it
// might give ["a","b"], [{rule:"a"}], or even [{rule1:"a",rule2:"b"}]. Flattening
// avoids the old "[object Object]" bug and never drops nested rules.
function aiExtractStrings(val) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { const t = v.trim(); if (t) out.push(t); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(val);
  return out;
}

// Like aiExtractStrings but keeps an optional example with each rule. Accepts
// {rule|text, example|eg} objects, bare strings, or arrays/objects of those.
// Returns [{text, example}] so memories are never vague ("e.g. …").
function aiExtractRules(val) {
  const out = [];
  const push = (text, example) => {
    const t = String(text == null ? '' : text).trim();
    if (!t) return;
    let e = example;
    if (e && typeof e === 'object') e = aiExtractStrings(e).join(' ');   // avoid "[object Object]"
    out.push({ text: t, example: String(e == null ? '' : e).trim() });
  };
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') push(v, '');
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') {
      if (typeof v.rule === 'string' || typeof v.text === 'string') push(v.rule || v.text, v.example || v.eg || v.eg_ || '');
      else Object.values(v).forEach(walk);
    }
  };
  walk(val);
  return out;
}

// Extract one frame at a timestamp, scaled to a fixed HEIGHT (so frames tile
// cleanly into a contact sheet grid).
function ffmpegFrameH(srcPath, ss, outPath) {
  return extractFrame(srcPath, ss, outPath, '-2:240');
}
// Tile a contiguous numbered frame sequence (pattern e.g. cs7_%03d.jpg) into a
// cols×rows grid. Verified ffmpeg pads the final partial row with `color`.
function ffmpegTileSeq(pattern, cols, rows, outPath) {
  return new Promise((resolve) => {
    const proc = killAfter(spawn(config.ffmpegPath, ['-y', '-i', pattern, '-frames:v', '1', '-vf', `tile=${cols}x${rows}:padding=6:margin=6:color=black`, outPath], { windowsHide: true }), 60000);
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
const montageCache = new Map();   // `${srcPath}|${n}` -> contact-sheet path
let montageCounter = 0;
// A contact-sheet GRID of N frames evenly sampled across the clip, so a single
// vision call can reason about motion / shot type with good per-frame detail
// (a grid keeps frames larger than a long single row). Falls back to the lone
// poster for N<=1 or unknown duration.
async function getContactSheet(srcPath, n) {
  // A photo: the AI vision pass should look at the photo itself, not an ffmpeg grid.
  if (isImagePath(srcPath)) { try { await fsp.access(srcPath); return srcPath; } catch { return null; } }
  const N = Math.max(1, Math.min(12, Number(n) || 3));
  if (N <= 1) { const u = await getPoster(srcPath); return u ? fileURLToPath(u) : null; }
  const key = `${srcPath}|${N}`;
  if (montageCache.has(key)) return montageCache.get(key);
  let durationSec = 0;
  try { durationSec = (await probeMeta(srcPath)).durationSec || 0; } catch { /* ignore */ }
  if (!durationSec || !isFinite(durationSec)) { const u = await getPoster(srcPath); return u ? fileURLToPath(u) : null; }
  await acquirePoster();   // bound concurrent ffmpeg work (shared with posters)
  try {
    await ensureDir(THUMB_DIR);
    montageCounter += 1;
    const tag = `cs${montageCounter}`;
    // Extract frames into a CONTIGUOUS sequence (skip indices that fail so the
    // %03d pattern has no gaps), then tile.
    const frameFiles = [];
    let seq = 0;
    for (let i = 0; i < N; i += 1) {
      const ss = Math.max(0, durationSec * ((i + 0.5) / N));
      const fp = path.join(THUMB_DIR, `${tag}_${String(seq + 1).padStart(3, '0')}.jpg`);
      // eslint-disable-next-line no-await-in-loop
      if (await ffmpegFrameH(srcPath, ss, fp)) { frameFiles.push(fp); seq += 1; }
    }
    if (!frameFiles.length) return null;
    if (frameFiles.length === 1) return frameFiles[0];
    const cols = Math.ceil(Math.sqrt(frameFiles.length));
    const rows = Math.ceil(frameFiles.length / cols);
    const out = path.join(THUMB_DIR, `${tag}_grid.jpg`);
    const ok = await ffmpegTileSeq(path.join(THUMB_DIR, `${tag}_%03d.jpg`), cols, rows, out);
    for (const f of frameFiles) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    if (!ok) return null;
    montageCache.set(key, out);
    return out;
  } finally { releasePoster(); }
}

