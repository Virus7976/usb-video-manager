'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Tray, Menu, nativeImage, nativeTheme, systemPreferences, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const crypto = require('node:crypto');

// Removable-drive enumeration uses a built-in Windows WMI query via PowerShell
// (no native modules — packages cleanly, nothing to compile).
const DETECTION_ENABLED = process.platform === 'win32';

// SINGLE canonical video-extension list for the whole main process. Everything that
// decides "is this a video" (config default, VIDEO_EXTS, the ADB scan predicate + regex)
// derives from THIS — so the sets can never disagree again (they used to: some paths
// treated .webm/.ts/.3gp as video, others didn't). Extensions without the leading dot.
const VIDEO_EXT_LIST = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'mts', 'm2ts', '3gp', '3g2', 'webm', 'ts'];
// Image extensions — the ONE source (IMAGE_EXTS, the ADB scan, and the PowerShell scan all
// derive from this, so they can never disagree). Without the leading dot.
const IMAGE_EXT_LIST = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'dng', 'gif', 'webp', 'bmp', 'tif', 'tiff'];
// Extension-match regex SOURCES derived from the lists above, so the phone scanners
// (PowerShell/MTP + ADB) match the exact same formats — a new format added to the lists
// can't be silently missed by one scanner (mts/m2ts used to be absent from the PS regex).
// In this template literal `\\.` collapses to `\.`, i.e. the regex "literal dot".
const VIDEO_EXT_RX_SRC = `\\.(${VIDEO_EXT_LIST.join('|')})$`;
const MEDIA_EXT_RX_SRC = `\\.(${[...IMAGE_EXT_LIST, ...VIDEO_EXT_LIST].join('|')})$`;

// Explicit identity so the userData path and the login-item registry key are
// unique to this app (the packaged exe isn't rcedit-stamped, so without this it
// would fall back to the generic "Electron" name). Must run before getPath().
app.setName('USB SD Auto-Action');
app.setAppUserModelId('com.jakeg.usbautoaction');

// PIN the userData directory explicitly. Without this, Electron resolved it
// inconsistently between launches — sometimes "%APPDATA%\USB SD Auto-Action"
// (the product name, after setName) and sometimes "%APPDATA%\usb-auto-action"
// (the package name, which Chromium initialises with before setName runs). That
// split meant a reopened instance read an EMPTY config folder and lost all saved
// names/settings. Pinning it makes every launch use the same folder.
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'USB SD Auto-Action'));
} catch (err) {
  console.error('Could not pin userData path:', err.message);
}

// Enable the platform (OS/GPU) HEVC/H.265 decoder so GoPro footage plays in a
// native <video> element in-app, with audio + scrubbing + playbackRate. Verified
// supported on this hardware. Must be set before app is ready.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// Bundled defaults ship read-only (inside app.asar once packaged); the writable
// copy lives in the per-user userData folder so settings persist after install.
const BUNDLED_CONFIG = path.join(__dirname, 'config.json');
// Pin the config to an ABSOLUTE, deterministic path in Roaming AppData rather
// than app.getPath('userData') — that resolution proved flaky between launch
// methods (direct exe vs Start-menu shortcut), so a reopened instance could read
// a different/empty folder and "forget everything". This file is the single
// source of truth for all persisted settings + rename drafts.
const ROAMING_DIR = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const USER_CONFIG = path.join(ROAMING_DIR, 'USB SD Auto-Action', 'config.json');

// Sidecar stores. The append-mostly collections (rename drafts, final metadata,
// version snapshots, project ledger) used to live INSIDE config.json — so every
// trivial toggle and every drafts autosave re-serialized hundreds of KB of unrelated
// data (the documented write-amplification / slow-open). They now live in their OWN
// files next to config.json, loaded into the SAME in-memory `config[key]` (so every
// existing reader is unchanged) but persisted INDEPENDENTLY via saveStore(key). One
// writer per file (single-instance lock) makes a fresh re-read cheap and race-free.
const STORE_DIR = path.join(ROAMING_DIR, 'USB SD Auto-Action');
// A store key may be a top-level config key OR a dotted path into it ('ai.people'). The
// big one is ai.people — face descriptors that used to be ~95% of config.json, so every
// settings toggle re-serialized hundreds of KB of face data. Split out, config.json is tiny.
const STORE_FILES = {
  renameDrafts:   path.join(STORE_DIR, 'drafts.json'),
  finalMeta:      path.join(STORE_DIR, 'final-meta.json'),
  renameVersions: path.join(STORE_DIR, 'versions.json'),
  projectLedger:  path.join(STORE_DIR, 'project-ledger.json'),
  'ai.people':    path.join(STORE_DIR, 'people.json'),
  'ai.clipObs':   path.join(STORE_DIR, 'clip-observations.json'),
};
const STORE_DEFAULT = {
  renameDrafts: () => ({}), finalMeta: () => ({}), renameVersions: () => [], projectLedger: () => [],
  'ai.people': () => [], 'ai.clipObs': () => ({}),
};
const storeSelfMtimeMs = {};   // per-store "our last write" mtime — skip needless re-reads

// Read/write a store's value by key, where key may be dotted ('ai.people').
function storeGet(key) {
  if (!key.includes('.')) return config[key];
  let o = config;
  for (const p of key.split('.')) { if (o == null || typeof o !== 'object') return undefined; o = o[p]; }
  return o;
}
function storeSet(key, val) {
  if (!key.includes('.')) { config[key] = val; return; }
  const parts = key.split('.'); let o = config;
  for (let i = 0; i < parts.length - 1; i += 1) { if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = val;
}
// Build the object to write to config.json: everything EXCEPT the sidecar stores. Nested
// store keys (ai.people/ai.clipObs) clone their parent so the live config isn't mutated.
function stripStoresForWrite() {
  const topStores = new Set(Object.keys(STORE_FILES).filter((k) => !k.includes('.')));
  const nestedByParent = {};
  for (const k of Object.keys(STORE_FILES)) { if (k.includes('.')) { const [p, ...rest] = k.split('.'); (nestedByParent[p] = nestedByParent[p] || []).push(rest.join('.')); } }
  const out = {};
  for (const k of Object.keys(config)) {
    if (topStores.has(k)) continue;
    if (nestedByParent[k] && config[k] && typeof config[k] === 'object') {
      const clone = { ...config[k] };
      for (const leaf of nestedByParent[k]) delete clone[leaf];   // single-level nesting
      out[k] = clone;
    } else out[k] = config[k];
  }
  return out;
}

// Atomic JSON write: write a temp file, then rename it over the target. Rename is
// atomic, so a concurrent reader (e.g. a relaunching instance during quit) always
// sees either the old or the new complete file — never a half-written/empty one.
// A plain writeFileSync truncates-then-writes, which is what was silently losing
// drafts/subjects when quit + reopen overlapped.
let atomicWriteCounter = 0;
function writeJsonAtomic(file, obj) {
  // Unique temp name per write (pid + counter) so two concurrent writers can't
  // clobber a shared "<file>.tmp" and corrupt each other's output.
  const tmp = `${file}.${process.pid}.${atomicWriteCounter += 1}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

// Resilient JSON read: retry a few times so a transient lock during another
// process's write doesn't make us fall back to defaults and wipe saved data.
function readJsonRetry(file, tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; raw = null; } // missing = legitimately none
    if (raw && raw.trim()) {
      try { return JSON.parse(raw); } catch { /* mid-write/corrupt → retry */ }
    }
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } catch { /* sleep best-effort */ }
  }
  return null;
}

function loadConfig() {
  // Generic, machine-independent defaults under the user's Videos folder. Users point
  // these wherever they like in Edit → Settings (or the per-step folder pickers); the
  // app creates folders on demand. No hardcoded drive letters or personal paths.
  let videosRoot;
  try { videosRoot = app.getPath('videos'); } catch { videosRoot = app.getPath('home'); }
  const baseRoot = path.join(videosRoot, 'USB Auto-Action');
  const defaults = {
    intakeFolder: path.join(baseRoot, '01 - Uncompressed'),
    phoneBackupFolder: '',     // local staging folder for media pulled off a phone
    photosTempFolder: path.join(baseRoot, '04 - Photos Temp'),
    phoneNasFolder: '',        // flat NAS destination for the phone backup
    phoneComputerFolder: '',   // flat local/computer destination for the phone backup
    phoneDestComputer: false,  // remembered "send to computer" toggle
    phoneDestNas: true,        // remembered "send to NAS" toggle
    simulatePhone: false,      // dev-only: surface a fake phone backed by a local folder
    useAdb: false,             // fast Android transfer via ADB (opt-in; falls back to MTP)
    adbPath: '',               // optional explicit path to adb.exe
    phoneBackupSource: '',     // wireless: the NAS folder a phone app (QuMagie) auto-uploads to
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    hotkey: 'CommandOrControl+Alt+U',
    launchAtLogin: true,
    autoPoll: false,
    pollIntervalMs: 2500,
    // How compression happens: 'external' = a watch-folder tool (e.g. Tdarr) compresses
    // the intake into the Compressed folder on its own resources (the app does NOT use
    // this machine's CPU); 'app' = the app transcodes locally with ffmpeg. Default keeps
    // the historical behavior (the app never compressed locally).
    compressMode: 'external',
    subjects: [],
    descriptions: {},
    categories: [],
    projects: [],
    // Persistent memory of every project footage has been filed into — so a later
    // import from the same shoot can be recognized and offered the same project,
    // and each project carries an AI summary for indexing/search later.
    projectLedger: [],   // [{ id, rel, name, category, dates[], subjects[], locations[], people[], clips, summary, summaryClips, firstSeen, lastSeen }]
    // User-managed organizing fields (metadata + folder levels). Default keeps the
    // 'category'/'project' ids so older drafts/records/folderLevels still resolve.
    organizeFields: [{ id: 'category', label: 'Category' }, { id: 'project', label: 'Project' }],
    fieldHistory: {},     // { fieldId: [remembered values…] }
    renameDrafts: {},
    defaultSpeed: 1,
    previewWidth: 248,
    hotkeys: { jumpUnnamed: 'F2', captureMacro: 'Ctrl+Shift+S' },
    textMacros: [],
    copyDateMode: 'always',
    enterFlow: 'columns',
    folderLevels: ['category', 'project'],
    organizeDest: '',
    finalizeSource: '',
    projectsRoot: '',
    finalMeta: {},
    nasBackup: { enabled: false, path: '' },
    // Optional LOCAL AI suggestions via Ollama (http://localhost:11434). Fully
    // offline — frames never leave the machine. Off until the user enables it.
    ai: {
      enabled: false, endpoint: 'http://localhost:11434', model: '', textModel: '', suggestCategory: true,
      frames: 3,            // frames sampled across the clip (contact sheet)
      detectShot: true,     // classify shot type (talking-head / pov / vlog / …)
      updateSubject: false, // let AI change the subject too (off = keep my subjects, AI only fills description/metadata)
      shotTypes: [],        // custom shot types [{name,desc}] — blank = built-in defaults
      askAfterRun: false,   // after an analyze run, ask me to confirm each clip (teaches from corrections)
      temperature: 0.2,
      prompt: '',           // custom guidance (blank = built-in default)
      multiPass: false,     // 3-pass reasoning (perceive → name → critique) — slower, better, opt-in
      learnFromEdits: true, // silently learn when the user changes an AI-suggested name
      memories: [],         // discrete learned preferences [{id,text,ts}] — injected into prompts
      styleExamples: [],    // sample "subject / description" pairs learned from the user's own names
      feedbackLog: []       // raw feedback entries the user left
    },
    ui: { showHelp: false, compact: false, showResult: true, autoplayAudio: false, notifications: true, showCommandBar: true, showMetaRow: true, finMatchedOnly: false, cleanGrid: true, dayDividers: true, showLocation: false },
    videoExtensions: VIDEO_EXT_LIST.map((e) => `.${e}`)
  };
  let bundled = {};
  let user = {};
  try { bundled = JSON.parse(fs.readFileSync(BUNDLED_CONFIG, 'utf8')); } catch {}
  const userRead = readJsonRetry(USER_CONFIG);
  if (userRead && typeof userRead === 'object') {
    user = userRead;
  } else if (fs.existsSync(USER_CONFIG)) {
    // File is present but unreadable after retries — DON'T silently treat it as
    // empty (that would overwrite saved settings with defaults on next save).
    // Leave the on-disk file intact and run this session on defaults only.
    console.error('Could not read user config after retries; not overwriting it.');
    config_readFailed = true;
  }
  // Precedence: code defaults < bundled config.json < user's saved settings.
  return { ...defaults, ...bundled, ...user };
}
// True when the user config existed but couldn't be parsed this launch — we then
// avoid writing over it so a transient read glitch can't erase saved settings.
let config_readFailed = false;

const config = loadConfig();
// Pull the sidecar stores into config[key] before any boot migration/slim runs, so
// they operate on the real (sidecar) data. On the FIRST launch after this change the
// sidecars don't exist yet — the old in-config values are kept and migrateStores()
// (post single-instance-lock, in boot) writes them to their new homes.
loadStores();

// Whether a saved user config existed BEFORE this launch — the signal the
// renderer uses to auto-show the first-run setup wizard (issue #1) exactly once,
// on a genuine first run. Captured now, before any saveConfig() writes the file,
// so it stays true for this whole session. Defaults to "not first run" on error
// so we never pop the wizard spuriously over an existing install.
const USER_CONFIG_EXISTED = (() => { try { return fs.existsSync(USER_CONFIG); } catch { return true; } })();

// --- Organizing fields (custom taxonomy) normalisation + migration ----------
const RESERVED_FIELD_IDS = new Set(['date', 'subject', 'description', 'version', 'ts', 'keywords', 'selected', 'name', 'size', 'ext', 'sourcepath', 'derived', 'matchtype', 'meta', 'posterurl', 'datelocked', 'origbase']);
function normalizeOrganizeFields(list) {
  const out = []; const seen = new Set();
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || typeof f !== 'object') continue;
    let id = String(f.id || '').trim().toLowerCase();
    const label = String(f.label || '').trim();
    if (!id || !label || RESERVED_FIELD_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label });
  }
  if (!out.length) return [{ id: 'category', label: 'Category' }, { id: 'project', label: 'Project' }];
  return out;
}
config.organizeFields = normalizeOrganizeFields(config.organizeFields);
if (!config.fieldHistory || typeof config.fieldHistory !== 'object') config.fieldHistory = {};
// One-time migration: seed history for the default fields from the old
// per-field arrays (config.categories / config.projects).
if (config.fieldHistory.category === undefined && Array.isArray(config.categories)) config.fieldHistory.category = config.categories.slice();
if (config.fieldHistory.project === undefined && Array.isArray(config.projects)) config.fieldHistory.project = config.projects.slice();
for (const f of config.organizeFields) if (!Array.isArray(config.fieldHistory[f.id])) config.fieldHistory[f.id] = [];

// AI memories are discrete editable items. Migrate the old single-string memory
// (split on lines/bullets) into a list if needed.
let aiMemCounter = 0;
function newMemId() { aiMemCounter += 1; return `m${Date.now().toString(36)}${aiMemCounter}`; }
if (!config.ai || typeof config.ai !== 'object') config.ai = {};
if (!Array.isArray(config.ai.memories)) {
  const items = [];
  const old = typeof config.ai.memory === 'string' ? config.ai.memory : '';
  for (const line of old.split(/\r?\n/)) {
    const t = line.replace(/^\s*[-*•]\s*/, '').trim();
    if (t) items.push({ id: newMemId(), text: t, ts: Date.now() });
  }
  config.ai.memories = items;
}
delete config.ai.memory;
// Drop any junk items (e.g. a "[object Object]" from an earlier coercion bug).
config.ai.memories = config.ai.memories.filter((m) => m && typeof m.text === 'string' && m.text.trim() && m.text.trim() !== '[object Object]');
if (!Array.isArray(config.ai.feedbackLog)) config.ai.feedbackLog = [];
if (!Array.isArray(config.ai.styleExamples)) config.ai.styleExamples = [];

// One-time SLIM of accumulated bloat. config.json is loaded at boot and rewritten
// whole on every trivial save, so oversized append-mostly stores make the app slow to
// open and every save heavy. Trim to sane caps in memory (newest kept); the next normal
// save persists it. No write here — avoids a second-instance race before the lock check.
try {
  if (config.renameDrafts && typeof config.renameDrafts === 'object') {
    const ents = Object.entries(config.renameDrafts);
    if (ents.length > 1000) {
      ents.sort((a, b) => ((b[1] && b[1].ts) || 0) - ((a[1] && a[1].ts) || 0));
      config.renameDrafts = Object.fromEntries(ents.slice(0, 1000));
    }
  }
  if (Array.isArray(config.renameVersions) && config.renameVersions.length > 12) config.renameVersions = config.renameVersions.slice(0, 12);
  if (Array.isArray(config.ai.memories) && config.ai.memories.length > 300) config.ai.memories = config.ai.memories.slice(-300);
} catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Rename drafts — stored in config.json (the proven-stable store). The handlers
// below re-read the config FRESH from disk before each draft op (so a second
// instance can't clobber), and crucially drafts:save is a NO-OP when there's
// nothing positive to persist — that's what stops a blank-fielded session from
// ever overwriting saved names. Drafts are only removed by drafts:clear (when
// the footage is copied).
// ---------------------------------------------------------------------------
if (!config.renameDrafts || typeof config.renameDrafts !== 'object') config.renameDrafts = {};

// Read the on-disk config fresh (for draft ops), or null if unreadable.
// We are the only writer (single-instance lock), so the in-memory `config` is
// authoritative. Skip the expensive whole-file re-read unless the file was actually
// changed by something ELSE since our last save — turning a ~600KB sync read+parse on
// every draft/pref save into a cheap stat. Returns null when in-memory should be used.
let lastSelfWriteMtimeMs = 0;
function readConfigFresh() {
  try {
    const st = fs.statSync(USER_CONFIG);
    if (lastSelfWriteMtimeMs && st.mtimeMs <= lastSelfWriteMtimeMs) return null;   // nothing external changed it
  } catch { /* no file / stat failed → fall through and try a real read */ }
  const j = readJsonRetry(USER_CONFIG);
  return (j && typeof j === 'object') ? j : null;
}

// Load each sidecar store into config[key]. When a sidecar file is ABSENT but
// config.json already carried the key (the old single-file format), we KEEP that
// in-memory value so migrateStores() can write it to its new home — a non-destructive
// migration (nothing is deleted until it's safely re-homed).
function loadStores() {
  for (const key of Object.keys(STORE_FILES)) {
    const file = STORE_FILES[key];
    const j = readJsonRetry(file);
    if (j !== null && j !== undefined) {
      storeSet(key, j);                                           // sidecar wins
      try { storeSelfMtimeMs[key] = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
    } else if (storeGet(key) === undefined) {
      storeSet(key, STORE_DEFAULT[key]());
    } // else keep the config.json-sourced value as the migration source
  }
}

// One-time, post-lock migration: any store still missing its sidecar file gets its
// current in-memory value (carried over from the old config.json) written out. MUST run
// in the primary only (after requestSingleInstanceLock) and BEFORE anything can trigger
// a config save, so legacy drafts/ledger land in their new files before saveConfig()
// strips those keys from config.json.
function migrateStores() {
  for (const key of Object.keys(STORE_FILES)) {
    try { if (!fs.existsSync(STORE_FILES[key])) saveStore(key); } catch { /* ignore */ }
  }
}

// Persist ONE sidecar store atomically — cheap, only that file is rewritten. Unknown
// keys fall back to a whole-config save so a typo can't silently drop data.
function saveStore(key) {
  const file = STORE_FILES[key];
  if (!file) { saveConfig(); return; }
  if (config_readFailed) return;   // same guard as saveConfig — don't clobber unread data
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cur = storeGet(key);
    const val = (cur === undefined || cur === null) ? STORE_DEFAULT[key]() : cur;
    writeJsonAtomic(file, val);
    try { storeSelfMtimeMs[key] = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
  } catch (err) { console.error(`Could not save store ${key}:`, err.message); }
}

// Return a sidecar store, re-reading from disk ONLY if something else changed the file
// since our last write (rare under the single-instance lock). Replaces the old
// whole-config reload-merge, which blindly overwrote every in-memory key from disk and
// could clobber unsaved edits.
function freshStore(key) {
  const file = STORE_FILES[key];
  if (file) {
    let mtime = 0; let exists = true;
    try { mtime = fs.statSync(file).mtimeMs; } catch { exists = false; }   // no file yet → in-memory
    if (exists && !(storeSelfMtimeMs[key] && mtime <= storeSelfMtimeMs[key])) {
      const j = readJsonRetry(file);
      if (j !== null && j !== undefined) { storeSet(key, j); storeSelfMtimeMs[key] = mtime; }
    }
  }
  if (storeGet(key) === undefined || storeGet(key) === null) storeSet(key, (STORE_DEFAULT[key] || (() => ({})))());
  return storeGet(key);
}

const VIDEO_EXTS = new Set(config.videoExtensions.map((e) => e.toLowerCase()));
// Image types — phone/GoPro photos. They are NEVER compressed and don't need ffmpeg
// frame extraction (the file IS the frame), so poster/contact-sheet short-circuit.
const IMAGE_EXTS = new Set(IMAGE_EXT_LIST.map((e) => `.${e}`));
function isImagePath(p) { return IMAGE_EXTS.has(path.extname(String(p || '')).toLowerCase()); }
const THUMB_DIR = path.join(app.getPath('temp'), 'usb-auto-action-thumbs');

// Path identity, filesystem-case-aware. Windows (and default macOS) are case-INSENSITIVE,
// so "Clip.MP4" and "clip.mp4" are the SAME file — compare case-folded there; compare
// exactly on case-sensitive filesystems. Use pathsEqual()/pathKey() instead of a raw
// `path.resolve(a) === path.resolve(b)`, which misses Windows case-dup collisions (two
// clips could map to one output and silently overwrite, or a src==dest check could miss).
const PATHS_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
function pathKey(p) { const r = path.resolve(String(p || '')); return PATHS_CASE_INSENSITIVE ? r.toLowerCase() : r; }
function pathsEqual(a, b) { return pathKey(a) === pathKey(b); }

function saveConfig() {
  // Guard: if we failed to read an existing config this launch, don't clobber it
  // with our defaults-only in-memory copy.
  if (config_readFailed) { console.error('Skipping config save (read had failed this launch).'); return; }
  try {
    fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
    // The sidecar stores persist to their own files (saveStore) — strip them here (incl.
    // nested ones like ai.people) so a settings save no longer rewrites hundreds of KB of
    // drafts/versions/meta/ledger/face-descriptors.
    writeJsonAtomic(USER_CONFIG, stripStoresForWrite());
    try { lastSelfWriteMtimeMs = fs.statSync(USER_CONFIG).mtimeMs; } catch { /* ignore */ }
  } catch (err) {
    console.error('Could not save config:', err.message);
  }
}

// Register / unregister the app as a Windows login item (HKCU Run entry).
// Works for both packaged builds and `electron .` dev runs.
function applyLoginItem(enabled) {
  const opts = { openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] };
  if (!app.isPackaged) {
    // Unpackaged: relaunch electron.exe with the app directory.
    opts.path = process.execPath;
    opts.args = [app.getAppPath(), '--hidden'];
  }
  try {
    app.setLoginItemSettings(opts);
  } catch (err) {
    console.error('setLoginItemSettings failed:', err.message);
  }
}

function isLoginItemEnabled() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let isQuitting = false;
// Set when the user chooses to let an in-progress copy finish in the background;
// the app then quits itself once the copy completes (see copy:start).
let quitAfterCopy = false;

// --- Windows 11 Fluent theming -------------------------------------------
function isDark() { return nativeTheme.shouldUseDarkColors; }
function accentHex() {
  try {
    const a = systemPreferences.getAccentColor(); // "rrggbbaa"
    if (a && a.length >= 6) return `#${a.slice(0, 6)}`;
  } catch { /* not on Windows / unavailable */ }
  return isDark() ? '#60cdff' : '#005fb8';
}
function titleBarOverlayColors() {
  return {
    color: isDark() ? '#202020' : '#f3f3f3',      // caption strip = Mica base
    symbolColor: isDark() ? '#ffffff' : '#1a1a1a', // min/max/close glyphs
    height: 40
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 760,
    minWidth: 600,
    minHeight: 560,
    show: false,
    backgroundColor: isDark() ? '#202020' : '#f3f3f3',
    backgroundMaterial: 'mica',            // native Win11 Mica backdrop
    title: 'USB / SD Auto-Action',
    titleBarStyle: 'hidden',               // frameless with native caption buttons
    titleBarOverlay: titleBarOverlayColors(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Local-only tool: loads no remote content, but needs to play local video
      // files (file://) in the renderer. Chromium's native file loader handles
      // HEVC range/seek where a custom protocol could not.
      webSecurity: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Lock navigation down: this app only ever shows its own local file:// UI. With
  // webSecurity off, refuse to open new windows or navigate anywhere else, so no stray
  // link / window.open / future bug can load remote content into a context that has the
  // preload bridge. (External links should go through shell.openExternal explicitly.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { try { if (/^https?:/i.test(url)) shell.openExternal(url); } catch { /* ignore */ } return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });

  // Right-click in a field → spelling suggestions + standard edit actions.
  // (Electron spell-checks editable fields by default; we just supply the menu.)
  mainWindow.webContents.on('context-menu', (_evt, params) => {
    // The renderer draws its own rich, on-theme context menus for non-text targets
    // (clips, folders, people, faces, the app menu). The NATIVE menu is kept only for
    // editable text fields (real cut/copy/paste + spellcheck), so the two never clash.
    if (!params.isEditable && !params.misspelledWord) return;
    const items = [];
    if (params.misspelledWord) {
      const sugg = params.dictionarySuggestions || [];
      if (sugg.length) {
        for (const s of sugg.slice(0, 6)) {
          items.push({ label: s, click: () => mainWindow.webContents.replaceMisspelling(s) });
        }
      } else {
        items.push({ label: 'No suggestions', enabled: false });
      }
      items.push({ type: 'separator' });
      items.push({
        label: `Add “${params.misspelledWord}” to dictionary`,
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ role: 'cut', enabled: params.editFlags.canCut });
      items.push({ role: 'copy', enabled: params.editFlags.canCopy });
      items.push({ role: 'paste', enabled: params.editFlags.canPaste });
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll' });
      if (config.ai && config.ai.enabled) {
        const send = (ch) => { if (mainWindow) mainWindow.webContents.send(ch); };
        items.push({ type: 'separator' });
        items.push({
          label: 'AI',
          submenu: [
            { label: 'AI settings…', click: () => send('ai:open-settings') },
            { label: 'Run AI on this clip', click: () => send('ai:run-this') },
            { label: 'Analyze selected clips', click: () => send('ai:analyze-selected') },
            { type: 'separator' },
            { label: 'Leave feedback…', click: () => send('ai:feedback-open') }
          ]
        });
      }
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    // Report feedback about whatever was right-clicked (renderer records the
    // section). Always available — this is the in-app feedback capture.
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Report feedback about this…', click: () => { if (mainWindow) mainWindow.webContents.send('feedback:open'); } });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  // Keep the caption buttons + renderer in sync with the system theme.
  nativeTheme.on('updated', () => {
    if (!mainWindow) return;
    try { mainWindow.setTitleBarOverlay(titleBarOverlayColors()); } catch { /* ignore */ }
    mainWindow.webContents.send('theme:changed', { dark: isDark(), accent: accentHex() });
  });

  // Stay hidden until a drive is detected (or a manual scan is requested).
  if (process.argv.includes('--dev')) {
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Closing the popup hides it (app stays resident so the hotkey keeps working).
  // Real quit happens via the tray menu, which sets isQuitting first.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open (scan for drive)', click: () => triggerHotkey() },
    { label: `Hotkey: ${config.hotkey || '(none)'}`, enabled: false },
    { type: 'separator' },
    { label: 'Open intake folder', click: () => shell.openPath(config.intakeFolder) },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: isLoginItemEnabled(),
      click: (item) => {
        config.launchAtLogin = item.checked;
        applyLoginItem(item.checked);
        saveConfig();
        if (tray) tray.setContextMenu(buildTrayMenu());
      }
    },
    { type: 'separator' },
    ...(updateReady
      ? [{ label: 'Restart to install update', click: installUpdateNow }]
      : [{ label: 'Check for updates…', click: () => setupAutoUpdates({ silent: false }) }]),
    { type: 'separator' },
    { label: 'Quit', click: async () => {
      if (!(await confirmQuitIfCopying())) return;
      isQuitting = true;
      app.quit();
    } }
  ]);
}

function createTray() {
  let image = nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'tray.png'));
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('USB / SD Auto-Action');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => triggerHotkey());
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

