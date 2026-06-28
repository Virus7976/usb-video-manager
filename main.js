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
    videoExtensions: ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.mts', '.m2ts']
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
function readConfigFresh() {
  const j = readJsonRetry(USER_CONFIG);
  return (j && typeof j === 'object') ? j : null;
}

const VIDEO_EXTS = new Set(config.videoExtensions.map((e) => e.toLowerCase()));
// Image types — phone/GoPro photos. They are NEVER compressed and don't need ffmpeg
// frame extraction (the file IS the frame), so poster/contact-sheet short-circuit.
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.dng', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
function isImagePath(p) { return IMAGE_EXTS.has(path.extname(String(p || '')).toLowerCase()); }
const THUMB_DIR = path.join(app.getPath('temp'), 'usb-auto-action-thumbs');

function saveConfig() {
  // Guard: if we failed to read an existing config this launch, don't clobber it
  // with our defaults-only in-memory copy.
  if (config_readFailed) { console.error('Skipping config save (read had failed this launch).'); return; }
  try {
    fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
    writeJsonAtomic(USER_CONFIG, config);
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

// ---------------------------------------------------------------------------
// Native Windows notifications. Toast delivery needs the AppUserModelId (set at
// the top of this file) and a Start-menu shortcut, which the NSIS installer
// creates — so toasts work in the packaged build. Honors the user's toggle.
// ---------------------------------------------------------------------------
let notifyIcon = null;
function notify(title, body, onClick) {
  if (config.ui && config.ui.notifications === false) return;
  try {
    if (!Notification.isSupported()) return;
    if (!notifyIcon) {
      notifyIcon = nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'tray.png'));
    }
    const n = new Notification({ title, body, icon: notifyIcon, silent: false });
    n.on('click', () => { try { (onClick || showWindow)(); } catch { /* ignore */ } });
    n.show();
  } catch (err) {
    console.error('notify failed:', err.message);
  }
}
// ---------------------------------------------------------------------------
// Auto-update (electron-updater) — packaged Windows builds self-update from the
// generic publish feed in package.json (build.publish), which points at the
// fixed "latest" Gitea release that `npm run release` keeps current. No-op in
// dev / non-Windows so `npm start`, CI and tooling never touch the network or
// the updater. The download runs in the background; the staged update installs
// when the user quits via the tray (autoInstallOnAppQuit), or immediately if
// they click the "ready" toast / pick "Restart to update" in the tray.
// ---------------------------------------------------------------------------
let autoUpdater = null;   // lazy electron-updater handle (packaged Windows only)
let updateReady = false;  // a downloaded update is staged for install on quit
let updateCheckSilent = true;  // whether the in-flight check should stay quiet (startup) or toast (manual)

function setupAutoUpdates({ silent = true } = {}) {
  if (!app.isPackaged || process.platform !== 'win32') {
    if (!silent) notify('Updates', 'Auto-update only runs in the installed Windows app.');
    return;
  }
  // Track the CURRENT check's intent at module scope — the event handlers below are
  // registered once but fire for every check, so they must NOT capture `silent` (a
  // manual "Check for updates…" after the silent startup check would otherwise be
  // mute). Updated on each call before the check is kicked off.
  updateCheckSilent = silent;
  if (!autoUpdater) {
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (err) {
      console.error('[update] electron-updater unavailable:', err.message);
      if (!silent) notify('Update check failed', 'The updater module is missing from this build.');
      return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      console.log(`[update] downloading v${info.version}`);
      notify('Update available', `Downloading v${info.version} in the background…`);
    });
    autoUpdater.on('update-not-available', () => {
      console.log('[update] already up to date');
      if (!updateCheckSilent) notify('Up to date', `You're on the latest version (v${app.getVersion()}).`);
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[update] ready to install v${info.version}`);
      updateReady = true;
      if (tray) tray.setContextMenu(buildTrayMenu());
      notify('Update ready', `v${info.version} installs when you quit — click to restart now.`, installUpdateNow);
    });
    autoUpdater.on('error', (err) => {
      console.error('[update] error:', err ? (err.stack || String(err)) : 'unknown');
      if (!updateCheckSilent) notify('Update check failed', 'Could not reach the update server.');
    });
  }
  autoUpdater.checkForUpdates().catch((err) => console.error('[update] check failed:', err.message));
}

function installUpdateNow() {
  if (!autoUpdater || !updateReady) return;
  isQuitting = true;
  try { autoUpdater.quitAndInstall(); } catch { app.quit(); }
}

// Renderer-triggered native notification (AI done, faces tagged, etc.).
ipcMain.handle('app:notify', (_e, payload) => {
  const title = String((payload && payload.title) || 'USB / SD Auto-Action');
  const body = String((payload && payload.body) || '');
  if (body || title) notify(title, body);
  return { ok: true };
});

// Local clips are referenced with plain file:// URLs (webSecurity is disabled
// for the window). Chromium's native file loader handles HEVC range/seeking —
// including the moov atom at the end of GoPro files — which a custom protocol
// could not. pathToFileURL handles path encoding (spaces, etc.).
function fileUrl(p) { return pathToFileURL(p).toString(); }

// Human-readable byte size (for notification bodies, etc.).
function fmtBytesMain(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ---------------------------------------------------------------------------
// ExifTool (lazy) — writes XMP metadata into the final compressed files during
// the Finalize / Organize action. The vendored binary is unpacked OUT of the
// app.asar (see asarUnpack in package.json); we MUST hand the ExifTool
// constructor an explicit path with the app.asar → app.asar.unpacked fixup, or
// in the packaged build it resolves a path inside the (virtual, read-only) asar
// and fails to spawn. The persistent child process is only started the first
// time Finalize runs, and ended on quit.
// ---------------------------------------------------------------------------
let _exiftool = null;
// Map a virtual app.asar path to its unpacked sibling (no-op in dev or when the
// path is already unpacked). Handles both Windows "\" and POSIX "/" separators.
function unpackAsar(p) {
  if (typeof p === 'string' && /app\.asar([\\/])/.test(p) && !p.includes('app.asar.unpacked')) {
    return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  }
  return p;
}
function exiftoolBinaryPath() {
  // The exiftool-vendored.exe package's main export IS the absolute path to
  // exiftool.exe. Resolve it RELATIVE TO the exiftool-vendored package: npm
  // hoists the .exe to the top level in dev, but the packaged build (re)nests it
  // under exiftool-vendored/node_modules — so a bare require('exiftool-vendored.exe')
  // from this file would fail in the packaged app. Resolving from the parent
  // package's dir finds it in both layouts.
  let p = null;
  try {
    const vendoredDir = path.dirname(require.resolve('exiftool-vendored/package.json'));
    const exeIndex = require.resolve('exiftool-vendored.exe', { paths: [vendoredDir] });
    p = require(exeIndex);
  } catch { p = null; }
  if (typeof p !== 'string') {
    try { p = require('exiftool-vendored.exe'); } catch { p = null; }
  }
  if (typeof p !== 'string') return undefined;
  p = unpackAsar(p);
  // Last-ditch: if the resolved path isn't on disk, fall back to the bare require
  // (also asar-fixed). Better to hand ExifTool *something* than undefined.
  try { if (!fs.existsSync(p)) { const alt = unpackAsar(require('exiftool-vendored.exe')); if (fs.existsSync(alt)) p = alt; } }
  catch { /* ignore */ }
  return p;
}
function getExifTool() {
  if (_exiftool) return _exiftool;
  const { ExifTool } = require('exiftool-vendored');
  // Writing XMP into an MP4/MOV makes exiftool REWRITE the whole file, so a big
  // GoPro clip (multi-GB, possibly on a slow/network drive) can take minutes — a
  // short task timeout spuriously fails the embed. Give each task plenty of room.
  _exiftool = new ExifTool({ exiftoolPath: exiftoolBinaryPath(), taskTimeoutMillis: 600000 });
  return _exiftool;
}
async function endExifTool() {
  if (!_exiftool) return;
  const et = _exiftool; _exiftool = null;
  try { await et.end(); } catch { /* ignore */ }
}

// Slug a metadata value into a filesystem-safe folder name (matches the
// renderer's slug(): lowercase, runs of non-alphanumerics → single hyphen).
function slugFolder(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function metaLevelValue(level, meta) {
  if (level === 'category') return meta.category;
  if (level === 'project') return meta.project;
  if (level === 'subject') return meta.subject;
  if (level === 'date') return meta.date;
  return '';
}
// Ordered folder-name parts for a clip given the configured folder schema.
// Levels with no value are SKIPPED (collapsed away) rather than creating an
// "unsorted" folder — so a clip with a Category but no Project files straight
// into the category folder. If every level is empty the file isn't moved into a
// subfolder at all. Still deterministic, so re-running stays idempotent.
function subdirParts(levels, meta) {
  return (levels || []).map((lvl) => slugFolder(metaLevelValue(lvl, meta))).filter(Boolean);
}
// De-duplicated, trimmed list of human-readable strings (for keywords).
function uniqStrings(arr) {
  const seen = new Set(); const out = [];
  for (const x of (arr || [])) {
    const v = String(x == null ? '' : x).trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  return out;
}
function stemOf(name) { return String(name || '').replace(/\.[^.]+$/, ''); }
// CSV cell with RFC-4180 quoting (Resolve's Import Metadata reads UTF-8 CSV).
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Move a file, falling back to copy+verify+unlink across volumes (rename gives
// EXDEV when the organized destination is on a different drive than the source).
// The cross-device path is "verify before destroy": copy to a temp sibling, confirm
// it matches the source, atomically rename it into place, and only THEN delete the
// original. A failure or crash at any step leaves the SOURCE intact (a clip is never
// lost) and never leaves a half-written file at the real destination path.
async function moveFileCrossDevice(src, dest) {
  try { await fsp.rename(src, dest); return; }
  catch (err) { if (err.code !== 'EXDEV') throw err; }
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  try {
    await fsp.copyFile(src, tmp);
    if (!(await fingerprintsMatch(src, tmp))) throw new Error('verify failed after cross-device copy');
    await fsp.rename(tmp, dest);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* best-effort cleanup of the temp copy */ }
    throw err;
  }
  await fsp.unlink(src);
}

// Move a file into targetDir, idempotently:
//  - already at the target path           → 'in-place' (skip)
//  - a byte-identical file already there   → 'skip-dup' (true duplicate / re-run, skip)
//  - a DIFFERENT file sharing the name     → version the name " (n)" and move
//  - nothing there                         → move
async function organizeMove(srcPath, targetDir, fileName) {
  await ensureDir(targetDir);
  const targetPath = path.join(targetDir, fileName);
  if (path.resolve(srcPath).toLowerCase() === path.resolve(targetPath).toLowerCase()) {
    return { action: 'in-place', path: targetPath };
  }
  let existing = null;
  try { existing = await fsp.stat(targetPath); } catch { existing = null; }
  if (existing) {
    // Something already occupies the target name. Skip ONLY if it is byte-for-byte
    // identical (size + sampled SHA-256) — an idempotent re-run or a genuine
    // duplicate. If it's a different clip that merely shares this name, version ours
    // so a distinct clip is never overwritten or silently left unfiled (the old
    // size-only test could collide two different files of equal size).
    if (await fingerprintsMatch(srcPath, targetPath)) return { action: 'skip-dup', path: targetPath };
    const versioned = await uniqueDest(targetDir, fileName);
    await moveFileCrossDevice(srcPath, versioned);
    return { action: 'moved', path: versioned };
  }
  await moveFileCrossDevice(srcPath, targetPath);
  return { action: 'moved', path: targetPath };
}

// Parse the app's naming format (yyyy-mm-dd_subject_description_v#) out of a
// filename, so a compressed clip can match even without a saved record — the
// name itself carries date/subject/description. Returns null for names that
// don't look app-generated (e.g. raw GoPro GX026816.mp4), so they aren't matched.
function parseNamedClip(name) {
  let stem = stemOf(name).replace(/_v\d+$/i, '');     // drop the _v# version tag
  const hadVersion = /_v\d+$/i.test(stemOf(name));
  const parts = stem.split('_');
  let date = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) { date = parts.shift(); }
  const subject = parts.shift() || '';
  const description = parts.join('_');
  // Only treat it as app-named if it leads with a date or carried a _v# tag —
  // otherwise random filenames would spuriously "match".
  if (!date && !hadVersion) return null;
  if (!date && !subject) return null;
  return { date, subject, description, category: '', project: '', keywords: [subject].filter(Boolean), derived: true };
}

// Shallow list of video files directly in a folder (NOT recursive). Finalize
// scans only the top level of the Compressed folder so that files already filed
// into <Category>/<Project>/ subfolders by a previous run aren't picked up again.
async function listVideosShallow(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) continue;
    const full = path.join(dir, e.name);
    let st; try { st = await fsp.stat(full); } catch { continue; }
    out.push({ sourcePath: full, name: e.name, ext, size: st.size, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}
// Same, but for IMAGE files — used when the user wants to organize/name photos.
async function listImagesShallow(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    const full = path.join(dir, e.name);
    let st; try { st = await fsp.stat(full); } catch { continue; }
    out.push({ sourcePath: full, name: e.name, ext, size: st.size, mtimeMs: st.mtimeMs, isPhoto: true });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

// ---------------------------------------------------------------------------
// Destination map — read the real Projects folder tree so the user can visualise
// (and the AI can analyse) where clips will be filed, then move them there.
// ---------------------------------------------------------------------------
const JUNK_FOLDER = /^(new folder.*|untitled.*|temp|tmp|cache|exports?|raw|version|versions)$/i;
async function readProjectTree(dir, depth) {
  const out = [];
  let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue;
    if (JUNK_FOLDER.test(e.name.trim())) continue;
    const full = path.join(dir, e.name);
    out.push({ name: e.name, path: full, children: depth > 0 ? await readProjectTree(full, depth - 1) : [] });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}
function defaultProjectsRoot() { return path.join(os.homedir(), 'Videos', '02 - Projects'); }
ipcMain.handle('projects:getRoot', () => config.projectsRoot || defaultProjectsRoot());
ipcMain.handle('projects:setRoot', (_e, p) => { config.projectsRoot = String(p || ''); saveConfig(); return config.projectsRoot; });
ipcMain.handle('projects:pickRoot', async () => {
  const res = await dialog.showOpenDialog(mainWindow, { title: 'Choose your Projects root folder', defaultPath: config.projectsRoot || undefined, properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  config.projectsRoot = res.filePaths[0]; saveConfig(); return config.projectsRoot;
});
ipcMain.handle('projects:tree', async (_e, root) => {
  const r = String(root || config.projectsRoot || defaultProjectsRoot());
  if (!r) return { ok: false, error: 'No projects root set' };
  try { await fsp.access(r); } catch { return { ok: false, error: `Folder not found: ${r}` }; }
  return { ok: true, root: r, tree: await readProjectTree(r, 4) };
});
// Move/file clips into chosen folders. moves: [{from, toDir, name?, rel?, meta?}].
// When payload.embed, write a rich XMP packet into each file (from mv.meta) BEFORE
// moving it — so the organized clip carries its metadata into the Projects tree.
ipcMain.handle('projects:move', async (_e, payload) => {
  const moves = (payload && payload.moves) || [];
  const embed = !!(payload && payload.embed);
  const et = embed ? getExifTool() : null;
  const results = [];
  for (const mv of moves) {
    try {
      // Embed metadata BEFORE the move (write to the source path, which still exists).
      // A failure here must never block filing the clip — but we DO record it so the
      // caller can tell the user "filed, but metadata didn't write" instead of it
      // silently vanishing.
      let embedded = null; let embedError = null;
      if (et && mv.meta && typeof mv.meta === 'object') {
        try {
          const tags = buildEmbedTags(mv.meta, String(mv.rel || '').split('/').filter(Boolean), mv.name || path.basename(mv.from));
          if (Object.keys(tags).length) {
            // eslint-disable-next-line no-await-in-loop
            await et.write(mv.from, tags, ['-overwrite_original']);
            embedded = true;
          }
        } catch (e) { embedded = false; embedError = (e && e.message) ? String(e.message).slice(0, 200) : 'embed failed'; }
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await organizeMove(mv.from, mv.toDir, mv.name || path.basename(mv.from));
      const out = { from: mv.from, ok: true, action: r.action, path: r.path };
      if (embedded != null) out.embedded = embedded;
      if (embedError) out.embedError = embedError;
      results.push(out);
    } catch (err) {
      // Keep the documented result shape {from, ok, action, path} uniform even on
      // failure so callers can read it without branching. The clip stays where it
      // was (organizeMove/moveFileCrossDevice never delete a source they didn't
      // safely land) — nothing is lost; this run just gets retried.
      results.push({ from: mv.from, ok: false, action: 'error', path: null, error: err.message || String(err) });
    }
  }
  // Record this run's actual relocations so it can be UNDONE (move files back).
  const undoable = results.filter((x) => x.ok && x.action === 'moved' && x.path && x.from).map((x) => ({ from: x.from, to: x.path }));
  if (undoable.length) { config.lastOrganize = { ts: Date.now(), moves: undoable }; saveConfig(); }
  return { ok: true, results, undoable: undoable.length };
});
// Is there a recent Organize run that can be undone?
ipcMain.handle('organize:undoInfo', () => {
  const lo = config.lastOrganize;
  return (lo && Array.isArray(lo.moves) && lo.moves.length) ? { ok: true, count: lo.moves.length, ts: lo.ts } : { ok: false };
});
// Undo the last Organize — move each filed clip back to where it came from.
ipcMain.handle('organize:undo', async () => {
  const lo = config.lastOrganize;
  if (!lo || !Array.isArray(lo.moves) || !lo.moves.length) return { ok: false, error: 'Nothing to undo' };
  let undone = 0; let failed = 0;
  for (const m of lo.moves) {
    try {
      let here = false; try { await fsp.access(m.to); here = true; } catch { /* filed file gone */ }
      if (!here) { failed += 1; continue; }
      await ensureDir(path.dirname(m.from));
      let target = m.from;
      try { await fsp.access(m.from); target = await uniqueDest(path.dirname(m.from), path.basename(m.from)); } catch { /* original slot is free */ }
      // eslint-disable-next-line no-await-in-loop
      await moveFileCrossDevice(m.to, target);
      undone += 1;
    } catch { failed += 1; }
  }
  config.lastOrganize = null; saveConfig();
  return { ok: true, undone, failed };
});
// ---------------------------------------------------------------------------
// PROJECT LEDGER — persistent memory of every project footage is filed into.
// Built automatically as clips are filed (projects:move via the destination map).
// Powers: (1) recognizing a later import from the same shoot and offering the same
// project, and (2) an AI summary per project for indexing/search later.
// ---------------------------------------------------------------------------
// The project-level key. The tree is YEAR / YEAR-Category / Project / Day…, so the
// project is the first THREE segments — day folders and inner layout (…/Day 3/
// Footage) collapse into the one project record. Shorter rels use what's there.
function ledgerKeyFromRel(rel) {
  const segs = String(rel || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return '';
  return segs.slice(0, Math.min(3, segs.length)).join('/');
}
function ledgerFind(key) { return (config.projectLedger || []).find((p) => p.rel === key) || null; }
function ledgerMerge(arr, vals, cap) {
  const set = new Set((arr || []).filter(Boolean));
  for (const v of (Array.isArray(vals) ? vals : [vals])) { const s = String(v || '').trim(); if (s) set.add(s); }
  return [...set].slice(-(cap || 200));
}
ipcMain.handle('ledger:get', () => {
  const list = Array.isArray(config.projectLedger) ? config.projectLedger.slice() : [];
  list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return list;
});
// Record filed clips into their project records (called after a successful file).
ipcMain.handle('ledger:record', (_e, payload) => {
  const entries = (payload && Array.isArray(payload.entries)) ? payload.entries : [];
  if (!Array.isArray(config.projectLedger)) config.projectLedger = [];
  const now = Date.now();
  const touched = new Set();
  for (const en of entries) {
    const key = ledgerKeyFromRel(en && en.rel);
    if (!key) continue;
    let rec = ledgerFind(key);
    if (!rec) {
      const segs = key.split('/');
      const category = segs.slice(0, Math.min(2, segs.length)).join('/');   // YEAR/YEAR - Category
      rec = { id: newMemId(), rel: key, name: segs[segs.length - 1], category, dates: [], subjects: [], locations: [], people: [], samples: [], clips: 0, summary: '', summaryClips: 0, firstSeen: now, lastSeen: now };
      config.projectLedger.push(rec);
    }
    rec.lastSeen = now;
    if (en.date) rec.dates = ledgerMerge(rec.dates, en.date, 400);
    if (en.subject) rec.subjects = ledgerMerge(rec.subjects, en.subject, 200);
    if (en.location) rec.locations = ledgerMerge(rec.locations, en.location, 80);
    if (Array.isArray(en.people) && en.people.length) rec.people = ledgerMerge(rec.people, en.people, 80);
    rec.clips = (rec.clips || 0) + 1;
    // Keep a rolling sample of the richest detail for the AI summary (cap 60).
    if (en.subject || en.description || en.observation) {
      rec.samples = (rec.samples || []).concat([{ subject: en.subject || '', description: en.description || '', observation: (en.observation || '').slice(0, 240), people: Array.isArray(en.people) ? en.people : [], date: en.date || '' }]).slice(-60);
    }
    touched.add(key);
  }
  if (touched.size) saveConfig();
  return { ok: true, projects: [...touched] };
});
// Find ledger projects whose dates overlap the given dates (a later import from the
// same shoot). Returns light records the renderer uses to offer "add to this project".
ipcMain.handle('ledger:matchDates', (_e, payload) => {
  const want = new Set((payload && Array.isArray(payload.dates) ? payload.dates : []).map((d) => String(d || '').trim()).filter(Boolean));
  if (!want.size) return [];
  // Score relatedness by CONTENT (subject / people / location overlap), not just a
  // shared date — so unrelated footage shot the same day isn't pulled into a project.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokenSet = (arr) => { const s = new Set(); for (const x of (arr || [])) for (const t of norm(x).split(' ')) if (t && t.length > 1) s.add(t); return s; };
  const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n += 1; return n; };
  const wantSubj = tokenSet(payload && payload.subjects);
  const wantPpl = new Set(((payload && payload.people) || []).map(norm).filter(Boolean));
  const wantLoc = tokenSet(payload && payload.locations);
  const out = [];
  for (const rec of (config.projectLedger || [])) {
    if (!rec || !rec.clips) continue;
    const shared = (rec.dates || []).filter((d) => want.has(d));
    if (!shared.length) continue;
    const subjOv = overlap(wantSubj, tokenSet(rec.subjects));
    const pplOv = overlap(wantPpl, new Set((rec.people || []).map(norm).filter(Boolean)));
    const locOv = overlap(wantLoc, tokenSet(rec.locations));
    const contentOverlap = subjOv + pplOv + locOv;
    const score = pplOv * 3 + subjOv * 2 + locOv * 2 + shared.length * 0.4;
    out.push({ rel: rec.rel, name: rec.name, category: rec.category, dates: rec.dates, sharedDates: shared, clips: rec.clips, summary: rec.summary || '', people: rec.people || [], subjects: (rec.subjects || []).slice(0, 12), score, related: contentOverlap > 0 });
  }
  // Surface genuinely-related projects first; date-only matches rank last (and the
  // renderer can choose to ignore them).
  out.sort((a, b) => Number(b.related) - Number(a.related) || b.score - a.score || b.clips - a.clips);
  return out;
});
// Generate (or refresh) the AI summary for one project from its accumulated detail.
ipcMain.handle('ledger:summarize', async (_e, payload) => {
  const key = ledgerKeyFromRel(payload && payload.rel);
  const rec = ledgerFind(key);
  if (!rec) return { ok: false, error: 'Unknown project' };
  const model = aiTextModel();
  if (!model) return { ok: false, error: 'No model selected' };
  const samples = (rec.samples || []).slice(-40);
  const lines = samples.map((s, i) => `${i + 1}. ${[s.subject, s.description].filter(Boolean).join(' / ')}${s.observation ? ` — seen: ${s.observation}` : ''}${(s.people || []).length ? ` [people: ${s.people.join(', ')}]` : ''}${s.date ? ` (${s.date})` : ''}`).join('\n');
  const dateSpan = (() => { const ds = (rec.dates || []).filter(Boolean).sort(); return ds.length ? (ds[0] === ds[ds.length - 1] ? ds[0] : `${ds[0]} – ${ds[ds.length - 1]}`) : ''; })();
  const prompt = `Write a SHORT factual summary of one video project so it can be found later by search. Project folder: "${rec.name}". ${dateSpan ? `Filmed: ${dateSpan}. ` : ''}${(rec.people || []).length ? `People: ${rec.people.join(', ')}. ` : ''}${(rec.locations || []).length ? `Places: ${rec.locations.join(', ')}. ` : ''}\nClips filed here so far (${rec.clips}):\n${lines || '(no detail yet)'}\n\nReturn STRICT JSON only: {"summary":"2-3 sentences, what this project is, who/what's in it, where & when — concrete and searchable, no fluff","keywords":["6-12 lowercase search keywords"]}`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(model, prompt, { format: 'json', temperature: 0.3, timeout: 120000, think: false }));
    const summary = String((o && o.summary) || '').trim();
    if (!summary) return { ok: false, error: 'Empty summary' };
    rec.summary = summary;
    rec.keywords = Array.isArray(o && o.keywords) ? o.keywords.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean).slice(0, 12) : (rec.keywords || []);
    rec.summaryClips = rec.clips;
    rec.summaryAt = Date.now();
    saveConfig();
    return { ok: true, summary, keywords: rec.keywords };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Discover the COMMON subfolder layout inside the existing project folders under
// `rel` — e.g. if every "Day N" folder contains a "Footage" subfolder (or
// "Footage/Selects"), return that path so new day folders mirror it and the clips
// land where the others keep theirs. Returns '' when there's no shared structure.
ipcMain.handle('projects:innerLayout', async (_e, payload) => {
  const root = config.projectsRoot || defaultProjectsRoot();
  const rel = String((payload && payload.rel) || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel) return { ok: true, inner: '' };
  const base = path.join(root, ...rel.split('/'));
  const dirs = async (d) => {
    try { const es = await fsp.readdir(d, { withFileTypes: true }); return es.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !JUNK_FOLDER.test(e.name.trim())).map((e) => e.name); }
    catch { return []; }
  };
  const commonChild = async (parents) => {
    if (!parents.length) return null;
    const cnt = {}; const orig = {};
    for (const p of parents) { const subs = await dirs(p); const seen = new Set(); for (const s of subs) { const lk = s.toLowerCase(); if (!seen.has(lk)) { seen.add(lk); cnt[lk] = (cnt[lk] || 0) + 1; orig[lk] = orig[lk] || s; } } }
    let best = null; let bn = 0; for (const [lk, n] of Object.entries(cnt)) if (n > bn) { bn = n; best = lk; }
    return (best && bn >= Math.ceil(parents.length / 2)) ? orig[best] : null;
  };
  try {
    const dayFolders = await dirs(base);
    if (!dayFolders.length) return { ok: true, inner: '' };
    let parents = dayFolders.map((d) => path.join(base, d));
    let inner = ''; let guard = 0;
    while (guard++ < 3) {
      // eslint-disable-next-line no-await-in-loop
      const c = await commonChild(parents);
      if (!c) break;
      inner = inner ? `${inner}/${c}` : c;
      const next = []; for (const p of parents) { const cp = path.join(p, c); try { await fsp.access(cp); next.push(cp); } catch { /* skip */ } }
      parents = next; if (!parents.length) break;
    }
    return { ok: true, inner };
  } catch (err) { return { ok: false, error: err.message || String(err), inner: '' }; }
});

// Discover how each existing project is organized INSIDE — its real subfolders —
// so the AI places clips AWARE of each folder's actual structure and continues
// whatever pattern it finds (Day N, dates, "NN - desc", "Shoot 03", …). This is
// what keeps placement VARIABLE/discovered, not hardcoded to any one scheme.
function structureDigest(folders) {
  const kids = {};
  for (const f of folders) {
    const segs = String(f || '').split('/').filter(Boolean);
    if (segs.length < 2) continue;
    const parent = segs.slice(0, -1).join('/');
    (kids[parent] = kids[parent] || new Set()).add(segs[segs.length - 1]);
  }
  const lines = [];
  for (const [parent, set] of Object.entries(kids)) {
    const names = [...set];
    // Only worth showing projects that actually have a subfolder series to learn from.
    if (names.length < 2) continue;
    lines.push(`- "${parent}" is organized inside as: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`);
  }
  if (!lines.length) return '';
  return `\nHOW THE EXISTING PROJECTS ARE ORGANIZED INSIDE — read each one and CONTINUE its own pattern, never impose a different scheme:\n${lines.slice(0, 50).join('\n')}\n`;
}
// ---- Placement-brain helpers (pure — unit-testable without Ollama) ----
// Normalize a string to a space-joined lowercase token string.
function pbNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
// Meaningful tokens (≥3 chars) from a string.
function pbToks(s) { return pbNorm(s).split(' ').filter((w) => w.length > 2); }
// Strip leading/trailing slashes + backslashes → a comparable relative path.
function pbCleanPath(p) { return String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim(); }

// CANDIDATE SELECTION — rank the existing folder tree toward THIS batch so the
// genuinely-relevant project is always visible to the model (and distractors that
// drive mis-placement are dropped). Scores each folder by token overlap with the
// batch's people (weighted highest) / subjects / locations, a nudge for matching the
// batch's top-level category, and a strong boost for any standing-route destination
// (which must never be hidden). Small trees are shown whole — hiding helps nothing.
// Returns { shown:[paths], hiddenCount, ranked }. Pure.
function rankCandidateFolders(folders, clips, categories, routeRules, opts) {
  const MAX = (opts && opts.max) || 80;
  const list = (folders || []).map(pbCleanPath).filter(Boolean);
  if (list.length <= MAX) return { shown: list, hiddenCount: 0, ranked: false };
  const subj = new Set(); const ppl = new Set(); const loc = new Set();
  for (const c of (clips || [])) {
    pbToks(c && c.subject).forEach((t) => subj.add(t));
    pbToks(c && c.description).forEach((t) => subj.add(t));
    pbToks(c && c.location).forEach((t) => loc.add(t));
    (Array.isArray(c && c.people) ? c.people : []).forEach((p) => pbToks(p).forEach((t) => ppl.add(t)));
  }
  const hasSignal = subj.size || ppl.size || loc.size;
  const cats = (categories || []).map(pbNorm).filter(Boolean);
  const routeDests = new Set((routeRules || []).map((r) => pbCleanPath(r && r.dest)).filter(Boolean));
  const score = (f) => {
    const segs = f.split('/').filter(Boolean);
    const ft = new Set(); segs.forEach((s) => pbToks(s).forEach((t) => ft.add(t)));
    let s = 0;
    ft.forEach((t) => { if (ppl.has(t)) s += 3; if (subj.has(t)) s += 2; if (loc.has(t)) s += 2; });
    if (cats.length && cats.includes(pbNorm(segs[0] || ''))) s += 1;
    if (routeDests.has(f)) s += 6;
    return s;
  };
  const scored = list.map((f, idx) => ({ f, s: score(f), idx }));
  const anyHit = scored.some((x) => x.s > 0);
  // No usable signal/overlap → keep the original (recent-first) order, just truncated.
  if (!hasSignal || !anyHit) return { shown: list.slice(0, MAX), hiddenCount: list.length - MAX, ranked: false };
  const chosen = scored.slice().sort((a, b) => b.s - a.s || a.idx - b.idx).slice(0, MAX).map((x) => x.f);
  // Guarantee every standing-route destination is present even if it scored out.
  for (const d of routeDests) { if (d && list.includes(d) && !chosen.includes(d)) chosen.push(d); }
  return { shown: chosen, hiddenCount: Math.max(0, list.length - chosen.length), ranked: true };
}

// CONFIDENCE CALIBRATION + same-subject grouping. The model's self-reported
// confidence is unreliable, but the renderer's "Needs you" review split depends on
// it, so we calibrate deterministically from what the destination actually IS:
//   - _Unsorted               → capped low (≤0.3)
//   - brand-new folder/project (neither an existing folder, a child of one, nor a
//     route dest) → capped (≤0.5) — a guess, not a known match
//   - existing project / route dest → trust the model's value (it was told to be high
//     only for sure matches); fill a sensible default when it omitted one.
// Then force clips that share a (non-empty) subject onto ONE destination — the one the
// most-confident, most-grounded member got — so a subject is never split. Pure.
function calibratePlacements(placements, clips, ctx) {
  const folderSet = new Set(((ctx && ctx.folders) || []).map(pbCleanPath).filter(Boolean));
  const routeDests = new Set(((ctx && ctx.routeRules) || []).map((r) => pbCleanPath(r && r.dest)).filter(Boolean));
  const isUnsorted = (p) => /(^|\/)_unsorted(\/|$)/i.test(p);
  const round2 = (n) => Math.round(n * 100) / 100;
  const out = (placements || []).map((p) => {
    const path = pbCleanPath(p.path);
    const existing = folderSet.has(path);
    const parent = path.split('/').slice(0, -1).join('/');
    const underExisting = !!parent && folderSet.has(parent);
    const known = existing || routeDests.has(path);
    const unsorted = isUnsorted(path);
    let conf = (p.confidence == null || !isFinite(p.confidence)) ? null : Math.max(0, Math.min(1, p.confidence));
    if (conf == null) conf = unsorted ? 0.25 : (known ? 0.7 : (underExisting ? 0.6 : 0.4));
    if (unsorted) conf = Math.min(conf, 0.3);
    else if (!known && !underExisting) conf = Math.min(conf, 0.5);
    return { i: p.i, path, why: p.why, confidence: round2(conf), _known: known ? 1 : 0, _unsorted: unsorted ? 1 : 0 };
  });
  // Same-subject grouping.
  const subjOf = {}; (clips || []).forEach((c, idx) => { subjOf[idx] = pbNorm(c && c.subject); });
  const groups = {};
  for (const p of out) { const sj = subjOf[p.i]; if (!sj) continue; (groups[sj] = groups[sj] || []).push(p); }
  for (const sj of Object.keys(groups)) {
    const g = groups[sj]; if (g.length < 2) continue;
    const winner = g.slice().sort((a, b) => (b._known - a._known) || (a._unsorted - b._unsorted) || (b.confidence - a.confidence))[0];
    for (const p of g) { if (p.path !== winner.path) { p.path = winner.path; p.why = winner.why; p.confidence = Math.min(p.confidence, winner.confidence); } }
  }
  return out.map((p) => ({ i: p.i, path: p.path, why: p.why, confidence: p.confidence }));
}

// AI: given the real folder list + clip metadata, propose a destination folder
// path per clip (existing or new), grouping related clips together.
ipcMain.handle('ai:suggestProjects', async (_e, payload) => {
  const clips = (payload && payload.clips) || [];
  const folders = (payload && payload.folders) || [];
  const categories = (payload && payload.categories) || [];
  const context = String((payload && payload.context) || '').trim();
  const feedback = String((payload && payload.feedback) || '').trim();
  const routes = aiRoutes();
  if (!clips.length) return { ok: true, placements: [] };
  if (!aiTextModel()) return { ok: false, error: 'No model selected (set one in AI settings)' };
  const routeRules = routes.filter((r) => r.kind !== 'descriptor');
  // CANDIDATE SELECTION: rank the folder tree toward THIS batch so the genuinely
  // relevant project is always visible and distractor folders that cause mis-placement
  // are dropped (standing-route dests are always kept; small trees shown whole).
  const cand = rankCandidateFolders(folders, clips, categories, routeRules, { max: 80 });
  const folderList = cand.shown.join('\n') || '(no existing folders)';
  const omittedLine = cand.hiddenCount
    ? `\n(${cand.hiddenCount} less-relevant folder(s) are hidden — ranked unlikely for this batch. If NONE of the projects above genuinely fits a clip, file it to "<its category>/_Unsorted" rather than inventing or forcing a project.)`
    : '';
  const clipList = clips.map((c, i) => {
    const saw = c.observation ? ` saw="${String(c.observation).replace(/"/g, "'").slice(0, 400)}"` : '';
    const ppl = (Array.isArray(c.people) && c.people.length) ? ` people="${c.people.join(', ')}"` : '';
    return `${i}: subject="${c.subject || ''}" desc="${c.description || ''}" location="${c.location || ''}" date="${c.date || ''}"${saw}${ppl} file="${c.name || ''}"`;
  }).join('\n');
  // PAST FILING MEMORY — the single strongest signal. The app remembers every
  // project footage was filed into (people, subjects, places, an AI summary). Score
  // each remembered project against THIS batch's tokens and feed the model the most
  // relevant ones so it reuses the EXACT existing project instead of re-guessing.
  const ledgerBlock = suggestLedgerMemory(clips);
  const ctxLine = context ? `\nWhat the videographer told us about this batch (use it to identify the subjects/people/shoot and group correctly): "${context}"\n` : '';
  const catLine = categories.length ? `EVERY clip MUST be filed under exactly one of these top-level categories (use the path that starts with it): ${categories.join(' | ')}.` : '';
  const routeLine = routeRules.length ? `\nThe user has STANDING filing rules — obey them when a clip matches:\n${routeRules.map((r) => `- if it's about [${(r.match || []).join(', ')}] → "${r.dest}"${r.byDay ? ' (return just this project path; the app adds the day folder)' : ''}`).join('\n')}` : '';
  const fbLine = feedback ? `\nTHE USER REVIEWED YOUR LAST PLAN AND WANTS THESE CORRECTIONS — obey them above all other rules:\n"${feedback}"\n` : '';
  const structDigest = structureDigest(folders);
  const prompt = `A videographer files video clips into this project-folder tree (relative paths), ranked with the most relevant projects for this batch first:\n${folderList}${omittedLine}\n${structDigest}${ledgerBlock}\nClips to place:\n${clipList}\n${ctxLine}${fbLine}\n${catLine}${routeLine}\n\nRULES — choose each clip's destination folder PATH (relative, "/" separators):\n1. PAST FILING MEMORY WINS. If a clip's subject / people / place matches a remembered project above, reuse that EXACT path. This beats folder-name guessing.\n2. MATCH BY CONTENT, NOT DATE. Place a clip by what it IS (subject / description / people), never merely because it shares a date with other clips.\n3. PREFER AN EXISTING PROJECT when the clip genuinely belongs there — reuse the exact existing path shown above.\n4. GROUP SAME SUBJECT TOGETHER. Every clip with the same subject/shoot goes to the SAME project path. Never split one subject across folders.\n5. CONTINUE EACH PROJECT'S OWN INTERNAL PATTERN (see the "organized inside" list above): "Day 1/Day 2…" → the next "Day N"; dates → a date (YYYY-MM-DD); "01 - desc" / "Shoot 03" → the next in that series. Do NOT impose a different scheme; only fall back to the clip's date when a project has no consistent pattern. If unsure of the exact subfolder, return just the project path. NEVER nest one date folder inside another.\n6. WHEN GENUINELY UNSURE, DO NOT GUESS. File the clip to "<its category>/_Unsorted" with LOW confidence. A wrong existing-project guess is worse than _Unsorted.\n\nCONFIDENCE (0-1) — be honest; the app sends low-confidence clips to a human review queue:\n- 0.85-1.0 ONLY for an exact existing-project match, a past-filing-memory match, or a standing-rule match.\n- 0.5-0.8 for a plausible existing project you are not certain about.\n- 0.4 or less for a brand-new project or anything ambiguous; 0.3 or less for _Unsorted.\n\nFor EACH clip also give a SHORT "why" (≤8 words, e.g. "matches your Lawn Mowing shoot", "new project", "unsorted — unclear subject").\n\nWORKED EXAMPLE (shows format + grouping + an unsure clip; do not copy its values):\nClips 0 and 1 are both subject="lawn mowing" for an existing "2026/Clients/Gourgess Lawns" project; clip 2 is an unclear drone test.\n{"placements":[{"i":0,"path":"2026/Clients/Gourgess Lawns/2026-06-27","why":"matches Gourgess Lawns shoot","confidence":0.9},{"i":1,"path":"2026/Clients/Gourgess Lawns/2026-06-27","why":"same lawn mowing subject","confidence":0.9},{"i":2,"path":"2026/_Unsorted","why":"unsorted — unclear subject","confidence":0.25}]}\n\nReply STRICT JSON only, no prose: {"placements":[{"i":0,"path":"...","why":"...","confidence":0.9}]}.`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 180000 }));
    const arr = Array.isArray(o.placements) ? o.placements : (Array.isArray(o) ? o : []);
    const placements = arr.map((p) => {
      const conf = Number(p.confidence != null ? p.confidence : p.conf);
      return {
        i: Number(p.i != null ? p.i : (p.I != null ? p.I : p.index)),
        path: String(p.path || p.Path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim(),
        why: String(p.why || p.reason || '').trim().slice(0, 60),
        confidence: isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null
      };
    }).filter((p) => isFinite(p.i) && p.path);
    // Deterministically calibrate confidence + enforce same-subject grouping.
    const calibrated = calibratePlacements(placements, clips, { folders, routeRules });
    return { ok: true, placements: calibrated };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Build the "PAST FILING MEMORY" prompt block: the remembered projects (ledger)
// most relevant to THIS batch, scored by shared people / subject / location tokens
// (people weighted highest, mirroring ledger:matchDates). Returns '' when there's
// no useful memory so the prompt stays lean.
function suggestLedgerMemory(clips) {
  const ledger = Array.isArray(config.projectLedger) ? config.projectLedger : [];
  if (!ledger.length) return '';
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const toks = (s) => norm(s).split(' ').filter((w) => w.length > 2);
  const batchSubj = new Set(); const batchPeople = new Set(); const batchLoc = new Set();
  for (const c of clips) {
    toks(c.subject).forEach((t) => batchSubj.add(t));
    toks(c.description).forEach((t) => batchSubj.add(t));
    toks(c.location).forEach((t) => batchLoc.add(t));
    (Array.isArray(c.people) ? c.people : []).forEach((p) => batchPeople.add(norm(p)));
  }
  const scored = ledger.map((m) => {
    let s = 0;
    (m.people || []).forEach((p) => { if (batchPeople.has(norm(p))) s += 3; });
    (m.subjects || []).forEach((x) => { if (toks(x).some((t) => batchSubj.has(t))) s += 2; });
    (m.keywords || []).forEach((k) => { if (toks(k).some((t) => batchSubj.has(t) || batchLoc.has(t))) s += 1.5; });
    (m.locations || []).forEach((l) => { if (toks(l).some((t) => batchLoc.has(t))) s += 2; });
    return { m, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 24);
  if (!scored.length) return '';
  const lines = scored.map(({ m }) => {
    const ppl = (m.people || []).slice(0, 6).join(', ');
    const subj = (m.subjects || []).slice(0, 6).join(', ');
    const sum = m.summary ? ` — ${String(m.summary).slice(0, 160)}` : '';
    return `- "${m.rel}"${ppl ? ` [people: ${ppl}]` : ''}${subj ? ` [about: ${subj}]` : ''}${sum}`;
  }).join('\n');
  return `\nPAST FILING MEMORY (projects you've already filed similar footage into — reuse the EXACT path when a clip matches one):\n${lines}\n`;
}

// Look at a batch summary and ask the user 2-4 SHORT clarifying questions whose
// answers most reduce filing ambiguity (is a label a real project or a descriptor?
// are different days separate projects? which client/category?). Each question may
// carry a few tap-able suggested answers.
ipcMain.handle('ai:batchQuestions', async (_e, payload) => {
  const summary = String((payload && payload.summary) || '').trim();
  const categories = (payload && payload.categories) || [];
  const folders = (payload && payload.folders) || [];
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  const folderList = folders.slice(0, 250).join('\n') || '(none)';
  const prompt = `A videographer is about to file a batch of video clips. Here is what we know:\n${summary}\n\nTop-level categories: ${categories.join(' | ') || '(none)'}\n\nTheir EXISTING project folders (relative paths):\n${folderList}\n\nAsk ONLY the clarifying questions whose answer would actually CHANGE where a clip gets filed — as few as possible (0 to 6). Skip anything already determinable from the summary, the existing folders, or obvious context: do NOT ask about a subject that clearly matches an existing folder, and do NOT pad to hit a number. A question earns its place only by resolving a REAL filing ambiguity in THIS batch — e.g. whether a label like "vlog"/"timelapse" is a real project or just a descriptor, whether clips on different days are separate projects, who is in them, or which client/project an ambiguous subject belongs to. Merge near-duplicate ambiguities into one question.\nFor "hints" (tap-able suggested answers): when a question is about WHICH client or project something belongs to, the hints MUST be the ACTUAL matching folder NAMES from the list above — never placeholders like "Client A". For yes/no or project-vs-descriptor questions, use the obvious short options. Keep each question under ~14 words.\nReply STRICT JSON only: {"questions":[{"q":"<question>","hints":["<real option>","<real option>"]}]}.`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.3, timeout: 120000 }));
    const arr = Array.isArray(o.questions) ? o.questions : (Array.isArray(o) ? o : []);
    const questions = arr.map((x) => ({
      q: String((x && (x.q || x.question)) || '').trim(),
      hints: (Array.isArray(x && x.hints) ? x.hints : []).map((h) => String(h).trim()).filter(Boolean).slice(0, 5)
    })).filter((x) => x.q).slice(0, 6);
    if (!questions.length) return { ok: false, error: 'No questions' };
    return { ok: true, questions };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Analyze the batch's subjects and SUGGEST an answer for each (which folder, or
// "descriptor" / "delete" / "unsorted") — used to pre-fill the wizard's per-subject
// questions so the AI does the first pass and the user just confirms.
ipcMain.handle('ai:answerSubjects', async (_e, payload) => {
  const subjects = (payload && payload.subjects) || [];
  const folders = (payload && payload.folders) || [];
  const categories = (payload && payload.categories) || [];
  if (!subjects.length) return { ok: true, answers: {} };
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  const folderList = folders.slice(0, 250).join('\n') || '(none)';
  const subjLines = subjects.map((s) => `- "${s.subject}" (${s.count} clips)`).join('\n');
  const prompt = `A videographer is filing these subjects:\n${subjLines}\n\nTop-level categories: ${categories.join(' | ') || '(none)'}\n\nExisting project folders:\n${folderList}\n\nFor EACH subject, suggest the single best SHORT answer for where it goes:\n- If the subject is a TYPE OF SHOT rather than a project — vlog, pov, timelapse, b-roll, montage, cutaway, slow-mo, interview, talking-head — answer EXACTLY "descriptor".\n- Else an EXISTING project folder NAME from the list (the bare folder NAME, e.g. "Gourgess Lawns" — NOT a full path and NOT a dated/day subfolder), when it clearly belongs there,\n- or one of the category names,\n- or "delete" if it's clearly trash (named delete/junk),\n- or "unsorted" if it's unnamed/unclear.\nOnly name an existing folder when the subject CLEARLY belongs there — a confident, specific match. When in doubt, answer "unsorted": a weak guess that mis-files footage is worse than leaving it for the user. Do not stretch to fit a folder.\nReply STRICT JSON only mapping each subject to its short answer: {"answers":{"<subject>":"<answer>"}}.`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 120000 }));
    const raw = (o && o.answers && typeof o.answers === 'object') ? o.answers : (o && typeof o === 'object' ? o : {});
    const answers = {};
    for (const [k, v] of Object.entries(raw)) { const a = String(v == null ? '' : v).trim(); if (a) answers[String(k).toLowerCase()] = a; }
    return { ok: true, answers };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// --- Standing filing rules ("routes"): subject keywords → a destination folder,
// optionally one subfolder per day. The user teaches these (plain-English or the
// editor) and they're remembered + applied on every Destination map.
function aiRoutes() { return (config.ai && Array.isArray(config.ai.routes)) ? config.ai.routes : []; }
ipcMain.handle('routes:get', () => aiRoutes());
ipcMain.handle('routes:save', (_e, list) => {
  config.ai = config.ai || {};
  config.ai.routes = (Array.isArray(list) ? list : []).map((r) => {
    const kind = r.kind === 'descriptor' ? 'descriptor' : 'route';
    const base = {
      id: String(r.id || `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`),
      name: String(r.name || '').slice(0, 80),
      kind,
      match: (Array.isArray(r.match) ? r.match : String(r.match || '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20),
      byDay: !!r.byDay
    };
    if (kind === 'descriptor') {
      // A descriptor word (vlog, timelapse, b-roll…) is NOT a project. joinProject:
      // true = file each clip into the project/day it was shot with; false = each
      // shooting DAY becomes its own separate project folder.
      base.joinProject = !!r.joinProject;
      base.category = String(r.category || '').trim();   // optional: client|personal|social
    } else {
      base.dest = String(r.dest || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/\d{4}-\d{2}-\d{2}$/, '').trim();
    }
    return base;
  }).filter((r) => r.match.length && (r.kind === 'descriptor' || r.dest));
  saveConfig();
  return config.ai.routes;
});
// Words that name a TYPE of shot (a "descriptor"), never a project on their own.
// Used to robustly reclassify a rule the model mislabelled as a route when it has
// no destination — a bare descriptor word can't be a project folder.
const DESCRIPTOR_WORDS = new Set([
  'vlog', 'vlogs', 'pov', 'timelapse', 'time-lapse', 'hyperlapse', 'b-roll', 'broll',
  'interview', 'montage', 'cutaway', 'slow-mo', 'slowmo', 'slow-motion', 'talking-head',
  'establishing', 'drone', 'aerial', 'gimbal', 'handheld'
]);

// Parse a plain-English filing instruction into a structured route, using the
// real folder tree so the destination path matches what already exists.
ipcMain.handle('ai:parseRoute', async (_e, payload) => {
  const text = String((payload && payload.text) || '').trim();
  const folders = (payload && payload.folders) || [];
  if (!text) return { ok: false, error: 'Nothing to parse' };
  if (!aiTextModel()) return { ok: false, error: 'No model selected (set one in AI settings)' };
  const folderList = folders.slice(0, 250).join('\n') || '(no existing folders)';
  const prompt = `Existing project folders (relative paths):\n${folderList}\n\nThe user is teaching ONE video-filing rule, in plain English:\n"${text}"\n\nDerive EVERY value below from the user's instruction above — do NOT reuse the placeholder text.\n- "name": a short label for this rule.\n- "match": the lowercase subject keywords (and obvious synonyms/typos) that should trigger it.\n- "dest": the destination folder PATH. If the user names a folder that exists in the list above, use that exact path; otherwise build a sensible new path under the right category.\n- "byDay": true only if the user wants each day in its own dated subfolder. When byDay is true, do NOT put a date in "dest" — the app adds the dated subfolder itself.\nReply STRICT JSON only in this exact shape (replace every <…> placeholder): {"name":"<short label>","match":["<keyword>","<synonym>"],"dest":"<folder path>","byDay":<true or false>}.`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.1, timeout: 120000 }));
    const route = {
      name: String(o.name || '').slice(0, 80),
      match: (Array.isArray(o.match) ? o.match : String(o.match || '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean),
      dest: String(o.dest || o.Dest || o.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/\d{4}-\d{2}-\d{2}$/, '').trim(),
      byDay: !!(o.byDay || o.byday || o.perDay)
    };
    if (!route.match.length || !route.dest) return { ok: false, error: 'Could not understand that — try naming the subject and the folder.' };
    return { ok: true, route };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Parse a plain-English instruction into ONE OR MORE rules, telling apart real
// PROJECT keywords (route → a folder) from DESCRIPTORS (vlog/timelapse/b-roll —
// not a project; group by day or file with the day's project).
ipcMain.handle('ai:parseRules', async (_e, payload) => {
  const text = String((payload && payload.text) || '').trim();
  const folders = (payload && payload.folders) || [];
  if (!text) return { ok: false, error: 'Nothing to parse' };
  if (!aiTextModel()) return { ok: false, error: 'No model selected (set one in AI settings)' };
  const folderList = folders.slice(0, 250).join('\n') || '(no existing folders)';
  const prompt = `You turn a videographer's plain-English filing instruction into ONE OR MORE rules.

Two KINDS of rule:
- "route": a real PROJECT/subject keyword that files into a specific folder. Fields: match (keywords), dest (use an EXISTING folder path from the list when the user names one, else a sensible new path under the right category), byDay (does each day get its own dated subfolder?).
- "descriptor": a word that describes the TYPE of shot, NOT a project — e.g. vlog, timelapse, b-roll, interview, montage, slow-mo, cutaway. Clips tagged with it must NOT all be lumped into one folder.

Decide KIND from meaning: if the user gives a word a destination folder → route. If a word is "not its own project", "separate projects", "belongs with", "goes in the project it was taken in", or is "just a label" → descriptor.

For a DESCRIPTOR, choose "placement" — how its clips are organised. Pick EXACTLY ONE of these two strings (each option spells out exactly what it means, so you cannot get it backwards):
- "separate"  → the clips are their OWN separate projects; EACH shooting DAY becomes its own project folder. Choose this for: "X is its own project", "X are separate projects", "each X is separate", "not part of another shoot". Example: "vlogs are separate projects" → "separate".
- "with_day"  → the clip BELONGS WITH the main footage shot that day; file it INTO that day's existing project. Choose this for: "X goes in the project it was taken in", "X belongs with the shoot", "X is a side-shot of the bigger project". Example: "timelapse goes with the day's project" → "with_day".

One instruction may describe SEVERAL behaviors — output one rule per distinct behavior (e.g. "vlogs are separate but timelapses go with the shoot" = two descriptor rules).

Existing folders:
${folderList}

Instruction (derive everything from THIS — do not copy the placeholders):
"${text}"

Reply STRICT JSON only: {"rules":[{"kind":"<route|descriptor>","name":"<short label>","match":["<word>"],"dest":"<folder path — route only>","byDay":<true|false>,"placement":"<separate|with_day — descriptor only>"}]}`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.1, timeout: 120000 }));
    const arr = Array.isArray(o.rules) ? o.rules : (Array.isArray(o) ? o : []);
    const rules = arr.map((r) => normalizeParsedRule(r)).filter((r) => r && r.match.length && (r.kind === 'descriptor' || r.dest));
    if (!rules.length) return { ok: false, error: 'Could not understand that — try naming the subject(s) and where they go.' };
    return { ok: true, rules };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Normalise one raw parsed rule into the canonical rule shape the rest of the app
// uses ({kind,name,match[],dest?,byDay,joinProject?}). The model now returns an
// explicit "placement" enum for descriptors (separate | with_day) which CANNOT be
// flipped like the old joinProject boolean — we still emit joinProject (derived)
// for backward compatibility with stored rules + the renderer.
function descriptorPlacement(r) {
  // Prefer the explicit enum; fall back to a legacy joinProject boolean if that's
  // all the model returned. Default 'separate' (each day its own project).
  const p = String((r && (r.placement || r.Placement)) || '').toLowerCase().replace(/[^a-z]/g, '');
  if (p === 'withday' || p === 'joinday' || p === 'join' || p === 'withproject') return 'with_day';
  if (p === 'separate' || p === 'separateprojects' || p === 'own' || p === 'perday') return 'separate';
  if (r && (r.joinProject != null || r.joinproject != null || r.join != null)) return (r.joinProject || r.joinproject || r.join) ? 'with_day' : 'separate';
  return 'separate';
}
function normalizeParsedRule(r) {
  if (!r || typeof r !== 'object') return null;
  let kind = (String(r.kind || '').toLowerCase() === 'descriptor') ? 'descriptor' : 'route';
  const match = (Array.isArray(r.match) ? r.match : String(r.match || '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const dest = String(r.dest || r.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/\d{4}-\d{2}-\d{2}$/, '').trim();
  // Route-vs-descriptor safety net: a rule the model called a "route" but that has
  // NO destination and whose keywords are ALL known shot-type words can't really be
  // a project folder — treat it as a descriptor so it isn't lumped into one folder.
  if (kind === 'route' && !dest && match.length && match.every((m) => DESCRIPTOR_WORDS.has(m))) kind = 'descriptor';
  const out = { kind, name: String(r.name || (match[0] || '')).slice(0, 80), match };
  if (kind === 'descriptor') {
    const placement = descriptorPlacement(r);
    out.placement = placement;                 // explicit, unambiguous
    out.joinProject = placement === 'with_day'; // derived — kept for back-compat
    out.byDay = true;
  } else {
    out.dest = dest;
    out.byDay = !!(r.byDay || r.byday);
  }
  return out;
}

// --- Per-clip analysis memory: cache each clip's vision observation keyed by its
// file fingerprint, so re-analyzing reuses prior work instead of looking again.
function clipObsStore() { config.ai = config.ai || {}; if (!config.ai.clipObs || typeof config.ai.clipObs !== 'object') config.ai.clipObs = {}; return config.ai.clipObs; }
ipcMain.handle('clipObs:get', () => clipObsStore());
ipcMain.handle('clipObs:save', (_e, payload) => {
  const key = String((payload && payload.key) || '').trim();
  const obs = String((payload && payload.obs) || '').trim();
  if (!key || !obs) return false;
  const store = clipObsStore();
  store[key] = { obs, ts: Date.now() };
  // Cap to 4000 most-recent observations.
  const keys = Object.keys(store);
  if (keys.length > 4000) { keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0)); for (const k of keys.slice(0, keys.length - 4000)) delete store[k]; }
  saveConfig();
  return true;
});

// ---------------------------------------------------------------------------
// Pop-out preview window — a small always-handy window that shows the clip
// currently being worked on (handy in the compact/zoomed-out rename view).
// ---------------------------------------------------------------------------
let previewWindow = null;
let lastPreview = null; // { url, name }
function createPreviewWindow() {
  previewWindow = new BrowserWindow({
    width: 540, height: 360, minWidth: 280, minHeight: 180,
    title: 'Preview', backgroundColor: '#000',
    backgroundMaterial: 'auto',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      webSecurity: false // play local file:// clips (same as the main window)
    }
  });
  previewWindow.removeMenu();
  previewWindow.loadFile(path.join(__dirname, 'src', 'preview.html'));
  previewWindow.webContents.on('did-finish-load', () => {
    if (lastPreview && previewWindow) previewWindow.webContents.send('preview:update', lastPreview);
  });
  previewWindow.on('closed', () => {
    previewWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:closed');
  });
}

ipcMain.handle('preview:toggle', () => {
  if (previewWindow && !previewWindow.isDestroyed()) { previewWindow.close(); previewWindow = null; return { open: false }; }
  createPreviewWindow();
  return { open: true };
});
ipcMain.handle('preview:state', () => ({ open: !!(previewWindow && !previewWindow.isDestroyed()) }));
ipcMain.handle('preview:set', (_evt, payload) => {
  if (!payload || !payload.path) return false;
  lastPreview = {
    url: fileUrl(payload.path),
    name: payload.name || '',
    muted: payload.muted !== false,        // default muted, like the in-card previews
    speed: Number(payload.speed) || 1
  };
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.webContents.send('preview:update', lastPreview);
  return true;
});

// ---------------------------------------------------------------------------
// Drive detection (Windows WMI via PowerShell — no native modules)
// DriveType=2 is removable media (USB sticks, SD/CF cards). A reader slot with
// no card returns a null Size, so we treat "has Size" as "media present".
// ---------------------------------------------------------------------------
let knownMountpoints = new Set();
let pollTimer = null;
let primed = false;

const PS_DRIVE_QUERY =
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | " +
  'Select-Object DeviceID,VolumeName,Size,FileSystem | ConvertTo-Json -Compress';

function mapDrive(d) {
  if (!d || !d.DeviceID) return null;
  // No Size / FileSystem ⇒ empty reader slot (no card inserted) ⇒ skip.
  if (d.Size === null || d.Size === undefined || d.Size === '') return null;
  const letter = d.DeviceID; // e.g. "D:"
  const fs = d.FileSystem || '';
  const label = d.VolumeName && d.VolumeName.trim() ? d.VolumeName.trim() : '';
  const descParts = [label, fs].filter(Boolean);
  return {
    raw: letter,
    mountpoint: `${letter}\\`,
    description: descParts.join(' · ') || 'Removable drive',
    size: Number(d.Size) || 0,
    isCard: false,
    isUSB: true,
    busType: 'USB'
  };
}

// Return all removable volumes that currently have media inserted.
function listRemovableDrives() {
  if (!DETECTION_ENABLED) return Promise.resolve([]);
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_DRIVE_QUERY],
      { windowsHide: true }
    );
    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('error', (err) => {
      console.error('drive query failed:', err.message);
      resolve([]);
    });
    ps.on('close', () => {
      const trimmed = out.trim();
      let parsed = [];
      if (trimmed) {
        try {
          const json = JSON.parse(trimmed);
          // PowerShell 5.1 emits a bare object (not an array) for a single result.
          parsed = Array.isArray(json) ? json : [json];
        } catch (err) {
          console.error('drive query parse error:', err.message);
        }
      }
      resolve(parsed.map(mapDrive).filter(Boolean));
    });
  });
}

// Invoked by the global hotkey: bring up the window and present drive options.
async function triggerHotkey() {
  showWindow();
  const drives = await listRemovableDrives();
  console.log(`[hotkey] ${drives.length} removable drive(s): ${drives.map((d) => d.mountpoint).join(', ') || '(none)'}`);
  if (!mainWindow) return;
  if (drives.length === 1) {
    mainWindow.webContents.send('drive:detected', drives[0]);
  } else {
    // 0 or many → let the renderer show a picker (or a "none found" message).
    mainWindow.webContents.send('drive:options', drives);
  }
}

async function pollDrives() {
  const drives = await listRemovableDrives();
  const currentMounts = new Set();
  for (const d of drives) {
    currentMounts.add(d.mountpoint);
    if (primed && !knownMountpoints.has(d.mountpoint)) {
      console.log(`[detect] NEW removable drive: ${d.mountpoint} (${d.description})`);
      notify('Card detected', `${d.description} (${d.mountpoint}) — open to import.`);
      if (mainWindow) {
        showWindow();
        mainWindow.webContents.send('drive:detected', d);
      }
    }
  }

  if (!primed) {
    console.log(`[detect] primed. Ignoring already-present drives: ${[...currentMounts].join(', ') || '(none)'}`);
  } else if (currentMounts.size !== knownMountpoints.size) {
    console.log(`[detect] mounts now: ${[...currentMounts].join(', ') || '(none)'}`);
  }

  knownMountpoints = currentMounts;
  primed = true;
}

function startPolling() {
  if (!DETECTION_ENABLED) return;
  if (pollTimer) return;   // don't stack intervals if called more than once
  pollDrives();
  pollTimer = setInterval(pollDrives, config.pollIntervalMs);
}

// ---------------------------------------------------------------------------
// Phone backup (MTP) — phones (iPhone/Android) mount under "This PC" as a
// Windows Portable Device WITHOUT a drive letter, so Node's fs can't read them.
// We drive the Windows Shell COM object via PowerShell to enumerate, list DCIM
// media, and copy files OFF the phone into a local staging folder. Validated
// end-to-end (detect + list size/date + real CopyHere) on a Samsung S23.
// ---------------------------------------------------------------------------
function runPwshScript(script, { timeoutMs = 120000, env = {} } = {}) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, env: { ...process.env, ...env } });
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { ps.kill(); } catch { /* ignore */ } resolve({ ok: false, error: 'timeout', stdout: out, stderr: err }); }, timeoutMs);
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, stdout: out, stderr: err }); });
    ps.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err }); });
  });
}

// List portable devices (phones) plugged in — anything under "This PC" that is a
// shell-namespace folder WITHOUT a drive letter. Classify phone vs DLNA server.
const PS_PHONE_LIST = `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$pc = $shell.NameSpace(17)
$out = @()
foreach ($it in $pc.Items()) {
  if (-not $it.IsFolder) { continue }
  $p = [string]$it.Path
  if ($p -match '^[A-Za-z]:\\\\?$') { continue }
  if ($p -notmatch '^::\\{') { continue }
  $kind = 'device'
  if ($p -match 'usb#|mtp|ms_comp_mtp') { $kind = 'phone' }
  elseif ($p -match 'uuid:') { $kind = 'dlna' }
  $out += [pscustomobject]@{ name = $it.Name; kind = $kind }
}
$out | ConvertTo-Json -Compress
`;
// Extract the JSON array/object from PowerShell stdout even if a stray line slipped in.
function parsePsJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return [];
  const tryParse = (txt) => { try { const j = JSON.parse(txt); return Array.isArray(j) ? j : [j]; } catch { return null; } };
  let r = tryParse(s);
  if (r) return r;
  const a = s.indexOf('['); const o = s.indexOf('{');
  const start = (a === -1) ? o : (o === -1 ? a : Math.min(a, o));
  if (start >= 0) { r = tryParse(s.slice(start)); if (r) return r; }
  return [];
}
// A fake phone backed by a real local folder — lets the whole flow be exercised
// without a physical device. Same shape as a real MTP device, just `sim:true`.
const SIM_PHONE_NAME = 'Simulated phone (testing)';
function simPhoneRoot() { return path.join(os.homedir(), 'USB-AutoAction-SimPhone'); }
function simPhoneOn() { return config.simulatePhone === true && fs.existsSync(path.join(simPhoneRoot(), 'Internal storage', 'DCIM')); }

async function listPhones() {
  const phones = [];
  if (simPhoneOn()) phones.push({ name: SIM_PHONE_NAME, kind: 'phone', sim: true });
  // Cold MTP/COM enumeration of a freshly-attached phone can take >25s on the first
  // probe (device handshake), so give it room — otherwise a real phone is dropped.
  const r = await runPwshScript(PS_PHONE_LIST, { timeoutMs: 60000 });
  for (const d of parsePsJson(r.stdout).filter((x) => x && x.kind === 'phone')) phones.push(d);
  return phones;
}

// fs-walk the simulated phone's DCIM (it's a normal local folder).
async function scanSimPhone() {
  const dcim = path.join(simPhoneRoot(), 'Internal storage', 'DCIM');
  const out = [];
  async function walk(dir, rel) {
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full, `${rel}/${e.name}`); continue; }
      const ext = path.extname(e.name).toLowerCase();
      const kind = IMAGE_EXTS.has(ext) ? 'photo' : (VIDEO_EXTS.has(ext) ? 'video' : '');
      if (!kind) continue;
      let size = 0; try { size = (await fsp.stat(full)).size; } catch { /* ignore */ }
      out.push({ name: e.name, rel, size, kind, abs: full });
    }
  }
  await walk(dcim, 'Internal storage/DCIM');
  return out;
}

// Walk the phone's DCIM (depth-limited) and return every photo/video with size +
// modified date. `rel` includes the storage name so copy can re-navigate exactly.
// FAST pattern: regex extension test + a typed List (avoids the per-item .NET /
// pipeline overhead that made a naive walk 20x slower). Size is read inline (cheap);
// the capture date comes from the filename later, so we skip the slow MTP date read.
const PS_PHONE_SCAN = `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$name = $env:MTP_DEVICE
$shell = New-Object -ComObject Shell.Application
$pc = $shell.NameSpace(17)
$dev = $pc.Items() | Where-Object { $_.Name -eq $name } | Select-Object -First 1
if (-not $dev) { 'NODEV'; exit }
$rx = '\\.(jpg|jpeg|png|heic|heif|dng|gif|webp|bmp|tif|tiff|mp4|mov|m4v|3gp|3g2|avi|mkv|webm|ts)$'
$vrx = '\\.(mp4|mov|m4v|3gp|3g2|avi|mkv|webm|ts)$'
$list = New-Object System.Collections.Generic.List[object]
$max = 12000
function Walk($folder, $rel, $depth) {
  if ($depth -gt 5 -or $list.Count -ge $max) { return }
  foreach ($it in $folder.Items()) {
    if ($list.Count -ge $max) { return }
    if ($it.IsFolder) { Walk $it.GetFolder "$rel/$($it.Name)" ($depth + 1) }
    else {
      $nm = $it.Name
      if ($nm -notmatch $rx) { continue }
      $list.Add([pscustomobject]@{ name = $nm; rel = $rel; size = [long]($it.ExtendedProperty('System.Size')); kind = $(if ($nm -match $vrx) { 'video' } else { 'photo' }) })
    }
  }
}
$albums = @()
if ($env:MTP_ALBUMS) { try { $albums = @($env:MTP_ALBUMS | ConvertFrom-Json) } catch { $albums = @() } }
$root = $dev.GetFolder
foreach ($st in $root.Items()) {
  if (-not $st.IsFolder) { continue }
  $dcim = $st.GetFolder.Items() | Where-Object { $_.Name -eq 'DCIM' } | Select-Object -First 1
  if (-not $dcim) { continue }
  if ($albums.Count -gt 0) {
    # Scoped scan: only the album folders the user chose (e.g. just "Camera").
    foreach ($a in $albums) {
      $af = $dcim.GetFolder.Items() | Where-Object { $_.Name -eq $a -and $_.IsFolder } | Select-Object -First 1
      if ($af) { Walk $af.GetFolder "$($st.Name)/DCIM/$a" 0 }
    }
  } else {
    Walk $dcim.GetFolder "$($st.Name)/DCIM" 0
  }
}
$list | ConvertTo-Json -Compress
`;
// List the album folders under DCIM (Camera, Screenshots, …) with a quick item count,
// so the user can choose what to back up BEFORE a full scan. Count is the folder's
// total item count (fast; close enough for a chip label).
const PS_PHONE_ALBUMS = `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$name = $env:MTP_DEVICE
$shell = New-Object -ComObject Shell.Application
$dev = $shell.NameSpace(17).Items() | Where-Object { $_.Name -eq $name } | Select-Object -First 1
if (-not $dev) { 'NODEV'; exit }
$acc = @{}
foreach ($st in $dev.GetFolder.Items()) {
  if (-not $st.IsFolder) { continue }
  $dcim = $st.GetFolder.Items() | Where-Object { $_.Name -eq 'DCIM' } | Select-Object -First 1
  if (-not $dcim) { continue }
  foreach ($alb in $dcim.GetFolder.Items()) {
    if (-not $alb.IsFolder) { continue }
    $c = 0; try { $c = $alb.GetFolder.Items().Count } catch { $c = 0 }
    if ($acc.ContainsKey($alb.Name)) { $acc[$alb.Name] += $c } else { $acc[$alb.Name] = $c }
  }
}
$out = foreach ($k in $acc.Keys) { [pscustomobject]@{ album = $k; count = $acc[$k] } }
$out | ConvertTo-Json -Compress
`;
// Returns { ok, media, reason } so the UI can tell "empty roll" from "scan failed"
// (phone locked / disconnected / timed out) instead of falsely reporting no media.
async function scanPhone(deviceName, albums) {
  if (deviceName === SIM_PHONE_NAME) return { ok: true, media: await scanSimPhone() };
  const env = { MTP_DEVICE: deviceName };
  if (Array.isArray(albums) && albums.length) env.MTP_ALBUMS = JSON.stringify(albums);
  const r = await runPwshScript(PS_PHONE_SCAN, { timeoutMs: 180000, env });
  if (!r.ok) return { ok: false, media: [], reason: r.error || 'scan failed' };
  if (/\bNODEV\b/.test(r.stdout || '')) return { ok: false, media: [], reason: 'device not found' };
  return { ok: true, media: parsePsJson(r.stdout) };
}

// List DCIM album folders + counts (for the "choose what to back up" chips). Sim phone
// reports its single folder so the chooser still works in testing.
async function listPhoneAlbums(deviceName) {
  if (deviceName === SIM_PHONE_NAME) {
    const m = await scanSimPhone();
    return { ok: true, albums: [{ album: 'Camera', count: m.length }] };
  }
  const r = await runPwshScript(PS_PHONE_ALBUMS, { timeoutMs: 60000, env: { MTP_DEVICE: deviceName } });
  if (!r.ok) return { ok: false, albums: [], reason: r.error || 'failed' };
  if (/\bNODEV\b/.test(r.stdout || '')) return { ok: false, albums: [], reason: 'device not found' };
  return { ok: true, albums: parsePsJson(r.stdout).filter((a) => a && a.album) };
}

ipcMain.handle('phone:list', () => listPhones());
ipcMain.handle('phone:albums', (_e, p) => listPhoneAlbums((p && p.device) || p));
ipcMain.handle('phone:scan', (_e, p) => {
  // Back-compat: accept either a bare device name or { name, albums }.
  if (p && typeof p === 'object') return scanPhone(p.name, p.albums);
  return scanPhone(p);
});

// GoPro-style pull: copy ONLY the PHOTOS off the phone (into "04 - Photos Temp") —
// videos STAY on the device and are only copied to the Uncompressed intake later, at
// the copy step. Returns staged clips: photos with a local sourcePath; videos as
// references (sim videos already have a local path, real-phone videos are deferred).
ipcMain.handle('phone:pull', async (evt, payload) => {
  const { device, items, photoDest, sim } = payload || {};
  if (!device || !Array.isArray(items) || !items.length) return { ok: false, error: 'Nothing selected' };
  const photos = items.filter((it) => it.kind !== 'video');
  const videos = items.filter((it) => it.kind === 'video');
  try { await fsp.mkdir(photoDest, { recursive: true }); } catch { /* ignore */ }
  const sender = evt.sender;
  const staged = [];
  const total = items.length; let done = 0;
  const prog = (name) => { done += 1; try { sender.send('phone:copy-progress', { done, total, name }); } catch { /* ignore */ } };

  // --- Photos → Photos Temp ---
  if (sim) {
    for (const it of photos) {
      const dst = path.join(photoDest, it.name);
      try {
        let st = null; try { st = await fsp.stat(dst); } catch { /* not there yet */ }
        if (!st || st.size !== it.size) { await fsp.copyFile(it.abs, dst); st = await fsp.stat(dst); }  // skip re-copy if already pulled
        staged.push({ sourcePath: dst, name: it.name, ext: path.extname(it.name), size: st.size, mtimeMs: st.mtimeMs, kind: 'photo' });
      } catch { /* skip */ }
      prog(it.name);
    }
  } else if (photos.length) {
    await mtpCopyToDest(device, photos, photoDest, (name) => prog(name));
    for (const it of photos) { const p = path.join(photoDest, it.name); try { const st = await fsp.stat(p); staged.push({ sourcePath: p, name: it.name, ext: path.extname(it.name), size: st.size, mtimeMs: st.mtimeMs, kind: 'photo' }); } catch { /* skip */ } }
  }

  // --- Videos STAY on device (only referenced; copied to Uncompressed at copy step) ---
  for (const it of videos) {
    if (sim) staged.push({ sourcePath: it.abs, name: it.name, ext: path.extname(it.name), size: it.size, mtimeMs: Date.now(), kind: 'video', phoneRef: { sim: true, abs: it.abs } });
    else staged.push({ sourcePath: '', name: it.name, ext: path.extname(it.name), size: it.size, mtimeMs: Date.now(), kind: 'video', phoneRef: { sim: false, device, rel: it.rel, name: it.name, size: it.size } });
    prog(it.name);
  }
  return { ok: true, copied: staged.length, total, staged };
});

// MTP-copy a list of items (same rel-folder navigation) to ONE local dest, streaming
// progress. Used for pulling real-phone photos now, and videos at the copy step.
function mtpCopyToDest(device, items, dest, onName) {
  return new Promise((resolve) => {
    fs.mkdirSync(dest, { recursive: true });
    const listFile = path.join(app.getPath('temp'), `mtp_pull_${Date.now()}.json`);
    fs.writeFileSync(listFile, JSON.stringify(items), 'utf8');
    const script = `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$name = $env:MTP_DEVICE
$dest = $env:MTP_DEST
$items = Get-Content $env:MTP_LIST -Raw | ConvertFrom-Json
$shell = New-Object -ComObject Shell.Application
$dev = $shell.NameSpace(17).Items() | Where-Object { $_.Name -eq $name } | Select-Object -First 1
if (-not $dev) { 'NODEV'; exit }
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
$destNs = $shell.NameSpace($dest)
$cache = @{}
function GetFolderByRel($rel) {
  if ($cache.ContainsKey($rel)) { return $cache[$rel] }
  $cur = $dev.GetFolder
  foreach ($p in ($rel -split '/')) { $next = $cur.Items() | Where-Object { $_.Name -eq $p -and $_.IsFolder } | Select-Object -First 1; if (-not $next) { return $null }; $cur = $next.GetFolder }
  $cache[$rel] = $cur; return $cur
}
$done = 0
foreach ($entry in $items) {
  $st = 'FAIL'
  $folder = GetFolderByRel $entry.rel
  if ($folder) {
    $fi = $folder.Items() | Where-Object { $_.Name -eq $entry.name } | Select-Object -First 1
    if ($fi) {
      $target = Join-Path $dest $entry.name
      $need = [long]$entry.size
      if ((Test-Path $target) -and ((Get-Item $target).Length -eq $need)) { $st = 'SKIP' }
      else {
        $destNs.CopyHere($fi, 1556)
        $tries = 0
        while ($tries -lt 1500) { if ((Test-Path $target) -and ((Get-Item $target).Length -ge $need)) { break }; Start-Sleep -Milliseconds 200; $tries++ }
        if ((Test-Path $target) -and ((Get-Item $target).Length -ge $need)) { $st = 'OK' } else { $st = 'FAIL' }
      }
    }
  }
  $done++
  "PROGRESS $done $($entry.name)"
  "RESULT $st $($entry.name)"
}
`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, env: { ...process.env, MTP_DEVICE: device, MTP_DEST: dest, MTP_LIST: listFile } });
    let buf = '';
    const results = [];   // [{ name, status: OK|SKIP|FAIL }]
    ps.stdout.on('data', (d) => {
      buf += d.toString(); let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        const p = line.match(/^PROGRESS \d+ (.*)$/); if (p && onName) { onName(p[1]); continue; }
        const r = line.match(/^RESULT (OK|SKIP|FAIL) (.*)$/); if (r) results.push({ status: r[1], name: r[2] });
      }
    });
    ps.on('error', () => { try { fs.rmSync(listFile, { force: true }); } catch { /* ignore */ } resolve({ ok: false, results }); });
    ps.on('close', () => { try { fs.rmSync(listFile, { force: true }); } catch { /* ignore */ } resolve({ ok: true, results }); });
  });
}

// Copy phone VIDEOS to the Uncompressed intake at the copy step (renamed). Sim
// videos are a local copy; real-phone videos are pulled off MTP now (kept on device
// until this moment). `jobs` = [{phoneRef, dest}] where dest is the final file path.
ipcMain.handle('phone:copyVideos', async (evt, payload) => {
  const { jobs } = payload || {};
  if (!Array.isArray(jobs) || !jobs.length) return { ok: true, copied: 0 };
  const sender = evt.sender;
  let done = 0; let failed = 0; const total = jobs.length;
  const realByDevice = new Map();
  for (const j of jobs) {
    const ref = j.phoneRef || {};
    try {
      await fsp.mkdir(path.dirname(j.dest), { recursive: true });
      if (ref.sim) {
        // Resume: skip if already there with matching size; verify the copy after.
        let st = null; try { st = await fsp.stat(j.dest); } catch { /* not there */ }
        const need = (await fsp.stat(ref.abs)).size;
        if (!(st && st.size === need)) { await fsp.copyFile(ref.abs, j.dest); st = await fsp.stat(j.dest); }
        if (st && st.size === need) done += 1; else failed += 1;
        try { sender.send('phone:copy-progress', { done: done + failed, total, name: path.basename(j.dest) }); } catch { /* ignore */ }
      } else { if (!realByDevice.has(ref.device)) realByDevice.set(ref.device, []); realByDevice.get(ref.device).push(j); }
    } catch { failed += 1; }
  }
  // Real-phone videos: MTP-copy (resume + verify) to a temp by original name, then
  // rename to final. Files the MTP pass couldn't verify are counted as failed.
  for (const [device, list] of realByDevice) {
    const tmp = path.join(app.getPath('temp'), `phonevid_${Date.now()}`);
    const mtp = await mtpCopyToDest(device, list.map((j) => j.phoneRef), tmp, (name) => { try { sender.send('phone:copy-progress', { done: done + failed + 1, total, name }); } catch { /* ignore */ } });
    const failSet = new Set((mtp.results || []).filter((r) => r.status === 'FAIL').map((r) => r.name));
    for (const j of list) {
      if (failSet.has(j.phoneRef.name)) { failed += 1; continue; }
      const src = path.join(tmp, j.phoneRef.name);
      try { await fsp.mkdir(path.dirname(j.dest), { recursive: true }); await fsp.rename(src, j.dest); done += 1; }
      catch { try { await fsp.copyFile(src, j.dest); done += 1; } catch { failed += 1; } }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { ok: true, copied: done, failed, total };
});

// Flat-copy files (renamed photos from Photos Temp) to the chosen back-up
// destinations (computer and/or NAS). jobs = [{src, dest}]; streams progress.
ipcMain.handle('phone:distribute', async (evt, payload) => {
  const { jobs } = payload || {};
  if (!Array.isArray(jobs) || !jobs.length) return { ok: true, copied: 0 };
  const sender = evt.sender; let done = 0; const total = jobs.length; const errors = [];
  for (const j of jobs) {
    try {
      let dst = null; try { dst = await fsp.stat(j.dest); } catch { /* not there */ }
      const src = await fsp.stat(j.src);
      if (!dst || dst.size !== src.size) { await fsp.mkdir(path.dirname(j.dest), { recursive: true }); await fsp.copyFile(j.src, j.dest); }  // skip if already there
      done += 1;
    } catch (e) { errors.push((e && e.message) || String(e)); }
    try { sender.send('phone:copy-progress', { done, total, name: path.basename(j.dest) }); } catch { /* ignore */ }
  }
  return { ok: true, copied: done, total, error: errors[0] || '' };
});

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------
async function walkForVideos(root) {
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip common junk/system folders.
        if (/^(\$RECYCLE\.BIN|System Volume Information|\.Spotlight-V100|\.Trashes)$/i.test(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // Pick up PHOTOS as well as videos (GoPro stills, phone-card JPGs) — tagged
        // so the rename flow handles them right (photos → Photos Temp, not Uncompressed).
        const kind = VIDEO_EXTS.has(ext) ? 'video' : (IMAGE_EXTS.has(ext) ? 'photo' : '');
        if (kind) {
          let stat;
          try {
            stat = await fsp.stat(full);
          } catch {
            continue;
          }
          results.push({
            sourcePath: full,
            name: entry.name,
            ext,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            kind
          });
        }
      }
    }
  }
  await walk(root);
  results.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return results;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// Compute the destination filename for a file being copied: the user's chosen
// name (sanitized) + original extension, falling back to the original name.
function destNameFor(f) {
  const ext = f.ext || path.extname(f.name);
  const origBase = f.name.slice(0, f.name.length - ext.length);
  let base = String(f.newName != null ? f.newName : origBase).trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!base) base = origBase;
  return base + ext;
}

// Resolve a non-colliding destination path by appending " (n)" before the ext.
async function uniqueDest(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${base} (${n})${ext}`);
      n += 1;
    } catch {
      return candidate;
    }
  }
}

function copyFileWithProgress(src, dest, onBytes, token) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    if (token) token.destroy = () => { rs.destroy(); ws.destroy(); };
    rs.on('data', (chunk) => { onBytes(chunk.length); if (token && token.aborted) rs.destroy(); });
    rs.on('error', (e) => reject(token && token.aborted ? new Error('aborted') : e));
    ws.on('error', (e) => reject(token && token.aborted ? new Error('aborted') : e));
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

// ---------------------------------------------------------------------------
// ffprobe metadata (recording date + duration) for the structured renamer.
// Clip previews play natively in a <video> element, so no FFmpeg thumbnails.
// ---------------------------------------------------------------------------
const metaCache = new Map(); // sourcePath -> { durationSec, dateISO }

function runFfprobeJson(srcPath) {
  return new Promise((resolve) => {
    const proc = spawn(config.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration:format_tags=creation_time',
      '-of', 'json', srcPath
    ], { windowsHide: true });
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
  return new Promise((resolve) => {
    const proc = spawn(config.ffmpegPath, [
      '-y', '-ss', String(ss), '-i', srcPath,
      '-frames:v', '1', '-vf', 'scale=400:-2', outPath
    ], { windowsHide: true });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
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
  if (copyTask && copyTask.active) {
    copyTask.aborted = true;
    if (copyTask.token && copyTask.token.destroy) copyTask.token.destroy();
  }
  return true;
});

// Copy the given files to the intake folder, reporting progress events.
ipcMain.handle('copy:start', async (evt, payload) => {
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
  const nasSummary = { ok: 0, failed: 0, setupError: '' };
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
  return new Promise((resolve) => {
    const proc = spawn(config.ffmpegPath, ['-y', '-ss', String(ss), '-i', srcPath, '-frames:v', '1', '-vf', 'scale=-2:240', outPath], { windowsHide: true });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
// Tile a contiguous numbered frame sequence (pattern e.g. cs7_%03d.jpg) into a
// cols×rows grid. Verified ffmpeg pads the final partial row with `color`.
function ffmpegTileSeq(pattern, cols, rows, outPath) {
  return new Promise((resolve) => {
    const proc = spawn(config.ffmpegPath, ['-y', '-i', pattern, '-frames:v', '1', '-vf', `tile=${cols}x${rows}:padding=6:margin=6:color=black`, outPath], { windowsHide: true });
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

// ---------------------------------------------------------------------------
// MEASURED camera motion — vision models guess motion poorly from a contact
// sheet, so we measure it and feed it to the AI as ground truth. For GoPro clips
// we read the real GYRO from the embedded GPMF telemetry stream (no video decode);
// otherwise we fall back to mean frame-difference over sampled frames.
// ---------------------------------------------------------------------------
const motionCache = new Map();   // srcPath -> string ('' = unknown)
let motionCounter = 0;
function runCapture(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = ''; let done = false;
    let proc; try { proc = spawn(cmd, args, { windowsHide: true }); } catch { resolve(''); return; }
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } finish(''); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => finish(''));
    proc.on('close', () => finish(out));
  });
}
function classifyGyro(meanMag) {
  if (meanMag < 0.05) return 'locked off / static (tripod or set down)';
  if (meanMag < 0.5) return 'handheld with small movement';
  if (meanMag < 1.5) return 'moving — panning, walking or following the subject';
  return 'lots of movement — fast action';
}
// Find the GoPro GPMF telemetry stream index ('gpmd' codec tag), or -1.
async function gpmfIndex(srcPath) {
  const out = await runCapture(config.ffprobePath, ['-v', 'error', '-show_entries', 'stream=index,codec_tag_string', '-of', 'csv=p=0', srcPath], 15000);
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(',');
    if ((parts[1] || '').trim() === 'gpmd') return Number(parts[0]);
  }
  return -1;
}
async function detectMotionGoPro(srcPath) {
  const idx = await gpmfIndex(srcPath);
  if (idx < 0) return '';
  await ensureDir(THUMB_DIR);
  motionCounter += 1;
  const binPath = path.join(THUMB_DIR, `gpmf_${motionCounter}.bin`);
  // Stream-copy ONLY the telemetry track — fast even on multi-GB 4K (no decode).
  const ok = await new Promise((resolve) => {
    const p = spawn(config.ffmpegPath, ['-y', '-i', srcPath, '-codec', 'copy', '-map', `0:${idx}`, '-f', 'rawvideo', binPath], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', (c) => resolve(c === 0));
  });
  if (!ok) return '';
  try {
    const raw = await fsp.readFile(binPath);
    // eslint-disable-next-line global-require
    const gt = require('gopro-telemetry');
    const data = await new Promise((resolve) => {
      try {
        gt({ rawData: raw, timing: { frameDuration: 1 / 30, start: new Date(), samples: [] } }, { stream: ['GYRO'], repeatSticky: false },
          (...args) => resolve(args.find((a) => a && typeof a === 'object' && Object.keys(a).some((k) => a[k] && a[k].streams)) || null));
      } catch { resolve(null); }
    });
    if (!data) return '';
    const dev = Object.keys(data).find((k) => data[k] && data[k].streams && data[k].streams.GYRO);
    const samples = dev ? (data[dev].streams.GYRO.samples || []) : [];
    if (!samples.length) return '';
    let sum = 0; let n = 0;
    for (const s of samples) { const v = s.value || []; sum += Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0); n += 1; }
    return n ? `${classifyGyro(sum / n)} (from the camera's motion sensor)` : '';
  } catch { return ''; }
  finally { try { fs.rmSync(binPath, { force: true }); } catch { /* ignore */ } }
}
// Fallback: mean absolute frame-difference (mafd) over sampled small frames via
// ffmpeg scdet → coarse static/moving signal for non-GoPro footage.
async function detectMotionFrames(srcPath) {
  let durationSec = 0;
  try { durationSec = (await probeMeta(srcPath)).durationSec || 0; } catch { /* ignore */ }
  if (!durationSec || !isFinite(durationSec)) return '';
  await acquirePoster();
  try {
    await ensureDir(THUMB_DIR);
    motionCounter += 1;
    const tag = `mo${motionCounter}`;
    const N = 14; let k = 0;
    for (let i = 0; i < N; i += 1) {
      const ss = Math.max(0, durationSec * ((i + 0.5) / N));
      const fp = path.join(THUMB_DIR, `${tag}_${String(k + 1).padStart(3, '0')}.jpg`);
      // eslint-disable-next-line no-await-in-loop
      const ok = await new Promise((r) => { const p = spawn(config.ffmpegPath, ['-y', '-ss', String(ss), '-i', srcPath, '-frames:v', '1', '-vf', 'scale=160:-2', fp], { windowsHide: true }); p.on('error', () => r(false)); p.on('close', (c) => r(c === 0)); });
      if (ok) k += 1;
    }
    if (k < 3) return '';
    const metaFile = path.join(THUMB_DIR, `${tag}_meta.txt`);
    await new Promise((r) => { const p = spawn(config.ffmpegPath, ['-y', '-i', path.join(THUMB_DIR, `${tag}_%03d.jpg`), '-vf', `scdet=s=1,metadata=print:file=${metaFile}`, '-f', 'null', '-'], { windowsHide: true }); p.on('error', () => r()); p.on('close', () => r()); });
    let mafds = [];
    try { mafds = (await fsp.readFile(metaFile, 'utf8')).split(/\r?\n/).map((l) => { const m = l.match(/lavfi\.scd\.mafd=([\d.]+)/); return m ? Number(m[1]) : null; }).filter((x) => x != null); } catch { /* ignore */ }
    for (let i = 1; i <= k; i += 1) { try { fs.rmSync(path.join(THUMB_DIR, `${tag}_${String(i).padStart(3, '0')}.jpg`), { force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(metaFile, { force: true }); } catch { /* ignore */ }
    if (!mafds.length) return '';
    const mean = mafds.reduce((a, b) => a + b, 0) / mafds.length;
    const cls = mean < 2 ? 'mostly static, little change between frames' : mean < 8 ? 'some movement / the scene changes moderately' : 'a lot of change between frames — moving camera or multiple shots';
    return `${cls} (estimated from the frames)`;
  } finally { releasePoster(); }
}
async function detectMotion(srcPath) {
  if (motionCache.has(srcPath)) return motionCache.get(srcPath);
  let result = '';
  try { result = await detectMotionGoPro(srcPath); } catch { result = ''; }
  if (!result) { try { result = await detectMotionFrames(srcPath); } catch { result = ''; } }
  motionCache.set(srcPath, result);
  return result;
}

ipcMain.handle('ai:status', async () => {
  try {
    const res = await ollamaFetch('/api/tags', {}, 4000);
    if (!res.ok) return { running: false, error: `HTTP ${res.status}`, models: [], vision: [] };
    const j = await res.json();
    const names = (j.models || []).map((m) => m.name).filter(Boolean);
    const vision = [];
    for (const n of names) { if (await ollamaModelVision(n)) vision.push(n); }
    return { running: true, endpoint: aiEndpoint(), models: names, vision };
  } catch (err) {
    return { running: false, error: err.message || String(err), models: [], vision: [] };
  }
});

// Vision guidance + an optional "what the user told us" note injected as ground truth.
function aiContextBlock(context) {
  const c = String(context || '').trim();
  // The note helps IDENTIFY things (who the people are, what the shoot is) and
  // resolve ambiguity — but it must NOT be copied into the fields. The #1 failure
  // mode is the model reshuffling the note's words (esp. names) into the
  // description, so we forbid that explicitly.
  return c ? `\nBACKGROUND from the videographer (for understanding only, NOT text to reuse): "${c}". Use it only to identify the subject/people or settle what's ambiguous in the frames. NEVER copy these words — especially people's names — into the description. The description must describe what is VISIBLY happening in the footage, not restate this note.` : '';
}
// Measured camera-motion fact (gyro or frame-diff) injected as ground truth.
function aiMotionBlock(motion) {
  const m = String(motion || '').trim();
  return m ? `\nCamera motion (MEASURED, not guessed): ${m}. Trust this over the frames when judging movement and shot type.` : '';
}
// Recognized people (from FACE recognition — reliable identities, unlike the free
// note). The model MAY use these exact names in the subject/description.
function aiPeopleBlock(people) {
  const ppl = uniqStrings(Array.isArray(people) ? people : []).filter(Boolean);
  if (!ppl.length) return '';
  const first = ppl[0].toLowerCase();
  return `\nRecognized people in this clip (confirmed by face recognition — reliable, unlike the background note): ${ppl.join(', ')}. USE the real name(s): wherever you would otherwise write a generic word like "person", "man", "woman", "guy", "kid", "someone", replace it with the recognized name. Put the name in the subject or description when a person is the focus (e.g. "${first}-pushups", "${first}-carrying-firewood", not "person-carrying-object"). Action first, then the name.`;
}
// ---- Deterministic naming clean-up -----------------------------------------
// Weak local models still emit prose ("a man in a car", "2 people walking") even
// when told not to. We NEVER trust the model to obey — every subject/description
// is passed through here so the result is always clean hyphen-keywords AND uses
// the recognized person's real name instead of a generic word. This is what makes
// names actually show up; the prompt is only a hint, this is the guarantee.
const NAME_STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'being', 'been',
  'of', 'on', 'in', 'at', 'to', 'into', 'onto', 'with', 'and', 'or', 'for', 'from', 'by', 'as', 'over',
  'under', 'this', 'that', 'these', 'those', 'it', 'its', 'their', 'there', 'while', 'who', 'which']);
// Generic person words we replace with a real name when face recognition gave us one.
const GENERIC_PERSON = new Set(['someone', 'somebody', 'anyone', 'person', 'persons', 'people', 'man', 'men',
  'woman', 'women', 'guy', 'guys', 'lady', 'boy', 'boys', 'girl', 'girls', 'kid', 'kids', 'child', 'children',
  'male', 'female', 'figure', 'individual', 'individuals', 'subject', 'human', 'adult', 'adults']);
// Count words that often precede a generic ("two people", "group of guys").
const COUNT_WORDS = new Set(['two', 'three', 'four', 'five', 'several', 'multiple', 'group', 'couple', 'bunch', 'pair']);

function nameToTokens(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9\s\-]+/g, '').split(/[\s\-]+/).filter(Boolean);
}

// Turn a raw field string into clean lowercase hyphen-keywords, dropping articles/
// filler, and swapping generic person words for the recognized name(s).
function cleanNameField(raw, people) {
  const names = uniqStrings(Array.isArray(people) ? people : []).filter(Boolean);
  const nameTokenSets = names.map(nameToTokens);                 // [["liam"], ["josiah"]]
  let toks = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]+/g, ' ')
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .filter((t) => !NAME_STOPWORDS.has(t));

  const out = [];
  let injectedNames = false;
  // Inject the FIRST name of each recognized person (cleaner filenames, matches the
  // "liam-pushups" style); the FULL name still lands in XMP via the people array.
  const injectNames = () => {
    if (injectedNames) return;
    nameTokenSets.forEach((set) => { if (set[0]) out.push(set[0]); });
    injectedNames = true;
  };
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    // "two people" / "group of guys" → drop the count, the generic gets handled next.
    if ((COUNT_WORDS.has(t) || /^\d+$/.test(t)) && (GENERIC_PERSON.has(toks[i + 1]) || GENERIC_PERSON.has(toks[i + 2]))) continue;
    if (GENERIC_PERSON.has(t)) {
      if (names.length) injectNames();         // swap generic → real name(s)
      else out.push(t);                        // no name known → keep the cleaned generic word
      continue;
    }
    out.push(t);
  }
  // Collapse duplicates while preserving order (so a name isn't repeated).
  const seen = new Set();
  let res = out.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  // If the model never mentioned a person but we DID recognize one and the field is
  // about a person-centric subject, we still don't force it in — avoids misattribution.
  // But if the ONLY content was the generic word (now empty) and we have names, keep names.
  if (!res.length && names.length) res = nameTokenSets.map((s) => s[0]).filter(Boolean);
  return res.join('-');
}

// Clean an AI tags array into tidy, human-readable keyword tags (digiKam-style):
// lowercase, trimmed, de-duplicated, no junk/empties, capped so a runaway answer
// can't flood the tag row. Tags keep spaces ("golden hour") unlike hyphen-fields.
function cleanTags(raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const seen = new Set(); const out = [];
  for (const t of arr) {
    const s = String(t == null ? '' : t).toLowerCase().replace(/[_]+/g, ' ').replace(/[^a-z0-9\s\-]+/g, '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2 || s.length > 28 || seen.has(s)) continue;
    seen.add(s); out.push(s);
    if (out.length >= 10) break;
  }
  return out;
}

// Normalize a full naming result. Subject + description get cleaned & name-swapped;
// shotType/category pass through aiFieldStr untouched; tags get tidied.
function normalizeNaming(out, people) {
  const o = out || {};
  return {
    subject: cleanNameField(aiFieldStr(o.subject), people),
    description: cleanNameField(aiFieldStr(o.description), people),
    shotType: aiFieldStr(o.shotType),
    category: aiFieldStr(o.category),
    tags: cleanTags(o.tags)
  };
}

// Shared naming spec (field list + rules + style/memory) — used by ai:suggest AND
// the self-review ai:improve pass so they stay consistent. `hasPeople` relaxes the
// no-names rule (recognized people are fine; only the free NOTE's words are banned).
function aiNamingSpec(ai, opts) {
  const { subjects, categories, hasPeople } = opts || {};
  const subjHint = (Array.isArray(subjects) ? subjects : []).slice(0, 40).join(', ');
  const catList = (Array.isArray(categories) ? categories : []).slice(0, 40);
  const wantCat = !(ai.suggestCategory === false) && catList.length > 0;
  const detectShot = ai.detectShot !== false;
  const wantTags = ai.suggestTags !== false;   // default ON — auto-fill the tag row
  const fields = ['"subject": "..."', '"description": "..."'];
  if (detectShot) fields.push('"shotType": "..."');
  if (wantCat) fields.push('"category": "..."');
  if (wantTags) fields.push('"tags": ["...", "..."]');
  const fieldSpec = `{${fields.join(', ')}}`;
  const nameRule = hasPeople
    ? 'You MAY include a RECOGNIZED person\'s name (from the recognized-people list) when they are the focus, but NEVER invent names or copy words from the background note.'
    : 'NEVER put a person\'s name in the description (no recognized people here). Describe the action.';
  const rules = [
    'subject: 1-3 words naming the main thing/activity in the footage, lowercase, hyphens for spaces (e.g. "lawn-mowing", "calisthenics").',
    `description: usually 2-6 keywords for WHAT IS VISIBLY HAPPENING — the specific action plus the setting/object (good: "pushups-on-grass", "liam-mowing-front-lawn", "chainsaw-stump-removal"). There is NO hard limit — use a few more keywords when they genuinely make the clip more specific and findable (e.g. "liam-josiah-building-treehouse-backyard"); just never pad with filler. Base it ONLY on the observed footage. Do NOT include the shot type here (it has its own field). ${nameRule} No articles/filler ("a","the","is","of","on","with"), no sentences. lowercase, hyphens for spaces.`,
    'Use ALL the information you have — the observation, recognized people, measured motion, shot type and the user\'s style — to make the description as specific and useful as possible. Describe the FOOTAGE, not the note.'
  ];
  if (detectShot) {
    const sts = aiShotTypes();
    const defs = sts.map((s) => `${s.name}${s.desc ? ` (${s.desc})` : ''}`).join('; ');
    rules.push(`shotType: exactly ONE of [${sts.map((s) => s.name).join(', ')}]. Judge from camera motion + framing. Definitions — ${defs}.`);
  }
  if (wantCat) rules.push(`category: pick the SINGLE best match ONLY from [${catList.join(', ')}], or "" if none fit.`);
  if (wantTags) rules.push('tags: 3-8 SHORT lowercase keyword tags for browsing/searching this clip later — concrete things VISIBLE in the footage: objects, setting/place, activity, season/time-of-day, mood. Each tag is 1-2 plain words (e.g. "backyard", "golden hour", "power tools", "winter"). Do NOT just repeat the subject/description words; add the broader searchable concepts. No people names (handled separately).');
  if (subjHint) rules.push(`Prefer these known subjects when they genuinely fit: [${subjHint}].`);
  const rulesText = rules.map((r) => `- ${r}`).join('\n');
  const exs = (Array.isArray(ai.styleExamples) ? ai.styleExamples : []).slice(0, 12);
  const mems = (Array.isArray(ai.memories) ? ai.memories : []).map((m) => (m && m.text ? (m.example ? `${m.text} (e.g. ${m.example})` : m.text) : '')).filter(Boolean);
  let styleBlock = '';
  if (exs.length) styleBlock += `\nMatch this user's own naming style. Real examples (subject / description):\n${exs.join('\n')}`;
  if (mems.length) styleBlock += `\nFollow these learned preferences from the user:\n- ${mems.join('\n- ')}`;
  return { fieldSpec, rulesText, styleBlock, detectShot, wantCat };
}

// Perceive ONE clip (vision only) → a free-text observation. Used by the batch
// flow to do all vision passes first (model stays loaded), then name them all.
ipcMain.handle('ai:perceive', async (_evt, payload) => {
  const { sourcePath, model } = payload || {};
  if (!sourcePath) return { ok: false, error: 'No clip' };
  const ai = config.ai || {};
  const useModel = model || ai.model;
  if (!useModel) return { ok: false, error: 'No model selected' };
  const temp = isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2;
  const guidance = (ai.prompt && ai.prompt.trim()) || AI_DEFAULT_GUIDANCE;
  try {
    const sheet = await getContactSheet(sourcePath, ai.frames || 3);
    if (!sheet) return { ok: false, error: 'Could not read frames' };
    const imgB64 = (await fsp.readFile(sheet)).toString('base64');
    const motion = await detectMotion(sourcePath);
    const perceivePrompt = `${guidance}${aiMotionBlock(motion)}\n${PERCEIVE_INSTRUCTION}`;
    const observation = (await ollamaVisionGenerate(useModel, perceivePrompt, { images: [imgB64], temperature: temp, timeout: 180000 })).trim();
    return { ok: true, observation: `${observation}${motion ? `\n(Measured camera motion: ${motion})` : ''}`, note: takeVisionNote(), switchedTo: takeVisionSwitch() };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('ai:suggest', async (evt, payload) => {
  const { sourcePath, model, subjects, categories } = payload || {};
  if (!sourcePath) return { ok: false, error: 'No clip' };
  const ai = config.ai || {};
  const useModel = model || ai.model;
  if (!useModel) return { ok: false, error: 'No model selected' };
  const temp = isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2;
  const step = (phase) => { try { evt.sender.send('ai:suggest-step', { phase }); } catch { /* ignore */ } };
  const ctxBlock = aiContextBlock(payload && payload.context);
  const peopleBlock = aiPeopleBlock(payload && payload.people);
  const hasPeople = !!(payload && Array.isArray(payload.people) && payload.people.filter(Boolean).length);
  const precomputed = String((payload && payload.observation) || '').trim();
  // Measured motion (gyro / frame-diff) — when the observation is precomputed it
  // already carries this, so only fetch it when we'll build prompts ourselves.
  const motionBlock = precomputed ? '' : aiMotionBlock(await detectMotion(sourcePath));
  // "Refine" mode: the user already wrote a name — improve it, don't start over.
  const draft = (payload && payload.draft) || null;
  const draftBlock = (draft && (draft.subject || draft.description || draft.location))
    ? `\nThe user already wrote this for the clip — subject: "${draft.subject || ''}", description: "${draft.description || ''}", location: "${draft.location || ''}". Treat all of it as authoritative CONTEXT about what's shown, and IMPROVE/tighten the subject + description: keep their meaning and correct keywords, just fix wording to match the rules and style. Do NOT start from scratch unless clearly wrong.`
    : '';

  // Read the contact sheet lazily — multi-pass with a precomputed observation
  // needs no image at all (the text model just names from the observation).
  const readSheet = async () => {
    const sheet = await getContactSheet(sourcePath, ai.frames || 3);
    if (!sheet) throw new Error('Could not read frames from this clip');
    return (await fsp.readFile(sheet)).toString('base64');
  };

  const guidance = (ai.prompt && ai.prompt.trim()) || AI_DEFAULT_GUIDANCE;
  const { fieldSpec, rulesText, styleBlock } = aiNamingSpec(ai, { subjects, categories, hasPeople });

  const finish = (out) => ({ ok: true, ...normalizeNaming(out, payload && payload.people) });
  const errMsg = (err) => (/aborted|timeout/i.test(err.message || '') ? 'Timed out — the model may still be loading; try again.' : (err.message || String(err)));

  // --- Multi-pass reasoning: perceive (vision) → name (text) → critique (text).
  // Weak local models name better when perception is separated from style-matching.
  // A "quick" request forces the single fast vision call (skips the 2 extra text
  // passes) — ~3x fewer model calls per clip for big batches.
  const multiPass = (payload && payload.quick) ? false : ai.multiPass;
  if (multiPass) {
    // Perception uses the vision model; the naming + critique passes use the
    // (optional) dedicated reasoning model when set — better at style + JSON.
    const reason = aiTextModel() || useModel;
    try {
      let observation = precomputed;
      if (!observation) {
        step('perceiving');
        const imgB64 = await readSheet();
        const perceivePrompt = `${guidance}${motionBlock}\n${PERCEIVE_INSTRUCTION}`;
        observation = (await ollamaVisionGenerate(useModel, perceivePrompt, { images: [imgB64], temperature: temp, timeout: 180000 })).trim();
      }

      // Run a JSON text call on the reasoning model; if THAT fails (e.g. the
      // chosen reasoning model isn't actually pulled → HTTP 404), fall back to the
      // vision model so naming never silently produces nothing.
      const genJson = async (prompt, t) => {
        try { return parseJsonLoose(await ollamaGenerate(reason, prompt, { format: 'json', temperature: t, timeout: 120000 })); }
        catch (e) {
          if (reason !== useModel) return parseJsonLoose(await ollamaGenerate(useModel, prompt, { format: 'json', temperature: t, timeout: 120000 }));
          throw e;
        }
      };
      step('naming');
      let p2 = `A videographer needs to name one video clip for their archive. Here is an objective observation of what the clip's frames actually show:\n"${observation}"${ctxBlock}${peopleBlock}${motionBlock}\n\nThe subject and description MUST come from the observation (what is visibly happening). The background note only helps you identify the subject/people — it is NOT to be copied into the description. Output STRICT JSON only — no prose, no code fences: ${fieldSpec}\n${rulesText}${styleBlock}${draftBlock}`;
      const draft = await genJson(p2, temp);

      step('checking');
      const p3 = `Here is a draft name for a video clip, plus the observation of what the frames actually show:\nDRAFT: ${JSON.stringify({ subject: aiFieldStr(draft.subject), description: aiFieldStr(draft.description), shotType: aiFieldStr(draft.shotType), category: aiFieldStr(draft.category) })}\nOBSERVATION: "${observation}"${peopleBlock}\n\nFix any violations of the user's rules. In particular: is the description just words copied from the videographer note instead of the VISIBLE action? If so, rewrite it to describe what's happening in the observation. Is it using ALL the available detail (action, setting, recognized people, shot type)? Also: description too long or containing articles/filler? subject not 1-3 words? shotType not in the allowed list? category not from the allowed list? If everything already fits, return it unchanged.\n${rulesText}${styleBlock}\nOutput corrected STRICT JSON only: ${fieldSpec}`;
      let out;
      try { out = await genJson(p3, Math.max(0, temp - 0.1)); }
      catch { out = draft; }   // critique pass is best-effort; fall back to the draft
      if (!out || !aiFieldStr(out.subject)) out = draft;   // guard against an empty correction
      // Return the observation too so Improve / Learn-rules can reuse what was SEEN
      // without re-watching the footage (one shared analysis across all AI features).
      return { ...finish(out || {}), observation, note: takeVisionNote(), switchedTo: takeVisionSwitch() };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  // --- Single-pass (default): one vision call → JSON. We ALSO ask for a short
  // "observation" field so this one call records what was seen — Improve and
  // Learn-rules then reuse it instead of telling the user to analyze first.
  const obsField = '"observation": "one plain sentence: what is visibly happening across the frames"';
  const fieldSpecO = `{${obsField}, ${fieldSpec.slice(1)}`;
  let prompt = `${guidance}${ctxBlock}${peopleBlock}${motionBlock}\nReply with STRICT JSON only — no prose, no code fences: ${fieldSpecO}\n${rulesText}${styleBlock}${draftBlock}`;
  try {
    step('naming');
    const imgB64 = await readSheet();
    const out = parseJsonLoose(await ollamaVisionGenerate(useModel, prompt, { images: [imgB64], format: 'json', temperature: temp, timeout: 180000 }));
    const observation = precomputed || aiFieldStr(out.observation) || '';
    return { ...finish(out), observation, note: takeVisionNote(), switchedTo: takeVisionSwitch() };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

// SELF-REVIEW: go back to the cached visual observation + the current draft and FIX
// the name — TEXT-ONLY (no re-vision), using all available data (observation,
// recognized people, shot type, the user's style + learned memories). "See where it
// went wrong and make it better." Uses the reasoning model when set.
ipcMain.handle('ai:improve', async (_e, payload) => {
  const ai = config.ai || {};
  const reason = aiTextModel() || ai.model;
  if (!reason) return { ok: false, error: 'No model selected' };
  const observation = String((payload && payload.observation) || '').trim();
  if (!observation) return { ok: false, error: 'No earlier analysis to review for this clip' };
  const temp = isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2;
  const draft = (payload && payload.draft) || {};
  const peopleBlock = aiPeopleBlock(payload && payload.people);
  const hasPeople = !!(payload && Array.isArray(payload.people) && payload.people.filter(Boolean).length);
  const ctxBlock = aiContextBlock(payload && payload.context);
  const { fieldSpec, rulesText, styleBlock } = aiNamingSpec(ai, { subjects: payload && payload.subjects, categories: payload && payload.categories, hasPeople });
  const prompt = `You earlier looked at a video clip and recorded this observation of what its frames show:\n"${observation}"${ctxBlock}${peopleBlock}\n\nThe clip's CURRENT name is:\nDRAFT: ${JSON.stringify({ subject: aiFieldStr(draft.subject), description: aiFieldStr(draft.description), shotType: aiFieldStr(draft.shotType), category: aiFieldStr(draft.category) })}\n\nReview the draft AGAINST the observation. Decide where it is wrong, vague, generic, or missing detail, and REWRITE it to be the best, most specific, most useful name possible using ALL the information (the visible action, the setting/objects, recognized people, the shot type). Don't lose anything correct; sharpen everything else. Output corrected STRICT JSON only — no prose: ${fieldSpec}\n${rulesText}${styleBlock}`;
  const sourcePath = (payload && payload.sourcePath) || '';
  // When there's no DEDICATED text model, `reason` is the vision model. Many vision
  // models (e.g. qwen2.5vl) fail or stall on a TEXT-ONLY generate, which is why
  // Improve died on the first clip while Analyze (vision, with an image) worked. So:
  // if we're leaning on the vision model, run Improve WITH the footage too; and on
  // ANY failure, fall back to a vision pass using the cached frames.
  const usingVisionModel = !(ai.textModel && ai.textModel !== ai.model);
  const sheetImage = async () => {
    if (!sourcePath) return null;
    const sheet = await getContactSheet(sourcePath, ai.frames || 3);
    if (!sheet) return null;
    return (await fsp.readFile(sheet)).toString('base64');
  };
  const visionPass = async () => {
    const img = await sheetImage();
    if (!img) return null;
    const raw = await ollamaVisionGenerate(reason, prompt, { images: [img], format: 'json', temperature: temp, timeout: 180000 });
    return { ok: true, ...normalizeNaming(parseJsonLoose(raw), payload && payload.people), note: takeVisionNote(), switchedTo: takeVisionSwitch() };
  };
  try {
    // Preferred path: vision-assisted when only a vision model is available, else text-only.
    if (usingVisionModel && sourcePath) {
      const r = await visionPass();
      if (r) return r;
    }
    const out = parseJsonLoose(await ollamaGenerate(reason, prompt, { format: 'json', temperature: temp, timeout: 120000 }));
    return { ok: true, ...normalizeNaming(out, payload && payload.people) };
  } catch (err) {
    // Last resort: if the text-only call errored but we have the footage, re-try as vision.
    try { const r = await visionPass(); if (r) return r; } catch { /* fall through */ }
    return { ok: false, error: /aborted|timeout/i.test(err.message || '') ? 'Timed out — the model may still be loading; try again.' : (err.message || String(err)) };
  }
});

// Pull a model into Ollama from inside the app, streaming progress to the UI.
ipcMain.handle('ai:pull', async (evt, name) => {
  const model = String(name || '').trim();
  if (!model) return { ok: false, error: 'No model name' };
  const sender = evt.sender;
  try {
    const res = await fetch(aiEndpoint() + '/api/pull', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(3600000)
    });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.error) { sender.send('ai:pull-progress', { error: o.error }); return { ok: false, error: o.error }; }
        const pct = (o.total && o.completed) ? Math.round((o.completed / o.total) * 100) : null;
        sender.send('ai:pull-progress', { status: o.status || '', percent: pct });
      }
    }
    sender.send('ai:pull-progress', { status: 'success', percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    sender.send('ai:pull-progress', { error: err.message || String(err) });
    return { ok: false, error: err.message || String(err) };
  }
});

// In-app model "store": a curated list of current local VISION models (Ollama has
// no official API to browse its whole library), enriched with install-state and a
// best-effort live peek at ollama.com for anything newer. Download uses ai:pull.
const AI_MODEL_CATALOG = [
  { name: 'qwen2.5vl:7b', params: '7B', size: '6.0 GB', desc: 'Qwen2.5-VL — best-in-class at reading the actual action & detail in a frame. Best descriptions (recommended).', rec: true },
  { name: 'minicpm-v', params: '8B', size: '5.5 GB', desc: 'MiniCPM-V — excellent fine detail and on-screen text.', rec: true },
  { name: 'llava-llama3', params: '8B', size: '5.5 GB', desc: 'LLaVA on Llama 3 — solid general captions, light footprint.', rec: true },
  { name: 'gemma3', params: '4B', size: '3.3 GB', desc: 'Google Gemma 3 — modern multimodal, quick.', rec: false },
  { name: 'llava-phi3', params: '3.8B', size: '2.9 GB', desc: 'Compact LLaVA on Phi-3 — fast, lower memory.', rec: false },
  { name: 'moondream', params: '1.8B', size: '1.7 GB', desc: 'Tiny and very fast — good on modest hardware.', rec: false },
  { name: 'granite3.2-vision', params: '2B', size: '2.4 GB', desc: 'IBM Granite Vision — tuned for documents and charts.', rec: false },
  { name: 'llama3.2-vision', params: '11B', size: '7.8 GB', desc: "Meta Llama 3.2 Vision — strong, but needs a RECENT Ollama; older builds fail to load it ('mllama' error).", rec: false },
  { name: 'llava', params: '7B', size: '4.7 GB', desc: 'Original LLaVA — reliable baseline.', rec: false },
  { name: 'bakllava', params: '7B', size: '4.7 GB', desc: 'BakLLaVA on Mistral — alternative captioner.', rec: false }
];
ipcMain.handle('ai:catalog', async () => {
  let installed = [];
  try {
    const res = await ollamaFetch('/api/tags', {}, 4000);
    if (res.ok) { const j = await res.json(); installed = (j.models || []).map((m) => m.name).filter(Boolean); }
  } catch { /* offline — still show the curated catalog so the user can plan */ }
  const instBase = new Set(installed.map((n) => n.split(':')[0]));
  const isInstalled = (name) => instBase.has(name) || installed.includes(name);
  const catalog = AI_MODEL_CATALOG.map((m) => ({ ...m, installed: isInstalled(m.name) }));
  // Best-effort live discovery of newer vision models (network; never fatal).
  let live = false;
  try {
    const r = await fetch('https://ollama.com/search?c=vision', { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const html = await r.text();
      const known = new Set(AI_MODEL_CATALOG.map((x) => x.name));
      const visionRe = /llava|vision|-vl\b|vl\b|moondream|minicpm-v|bakllava|gemma3|pixtral|cogvlm|janus/i;
      const re = /\/library\/([a-z0-9][a-z0-9._-]*)/gi;
      let m;
      while ((m = re.exec(html))) {
        const name = m[1].toLowerCase();
        if (known.has(name) || !visionRe.test(name)) continue;
        known.add(name);
        catalog.push({ name, params: '', size: '', desc: 'From the Ollama vision library.', rec: false, installed: isInstalled(name), live: true });
        if (catalog.length >= 40) break;
      }
      live = true;
    }
  } catch { /* offline or blocked — the curated list is enough */ }
  return { ok: true, installed, catalog, live };
});

// Uninstall a model from Ollama (frees disk). DELETE /api/delete.
ipcMain.handle('ai:delete', async (_evt, name) => {
  const model = String(name || '').trim();
  if (!model) return { ok: false, error: 'No model' };
  try {
    const res = await fetch(aiEndpoint() + '/api/delete', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }), signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    // If the removed model was selected anywhere, clear it.
    const ai = config.ai || (config.ai = {});
    let changed = false;
    if (ai.model === model) { ai.model = ''; changed = true; }
    if (ai.textModel === model) { ai.textModel = ''; changed = true; }
    if (changed) saveConfig();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Feedback → memory: store the raw note, then ask the model to fold it into the
// running "learned preferences" memory that gets injected into every suggestion.
// Runs in the background; the renderer is notified when the memory updates.
ipcMain.handle('ai:feedback', async (evt, payload) => {
  const fb = String((payload && payload.feedback) || '').trim();
  if (!fb) return { ok: false, error: 'Empty feedback' };
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.feedbackLog)) ai.feedbackLog = [];
  if (!Array.isArray(ai.memories)) ai.memories = [];
  ai.feedbackLog.push({ text: fb, example: String((payload && payload.example) || ''), ts: Date.now() });
  if (ai.feedbackLog.length > 200) ai.feedbackLog = ai.feedbackLog.slice(-200);

  // Distil the feedback into 1-2 concise preference rules, EACH WITH a concrete
  // example so the rule is never vague later. Appended to the list, not rewritten.
  let newItems = [];
  try {
    if (aiTextModel()) {
      const ex = (payload && payload.example) ? ` about the clip description "${payload.example}"` : '';
      const prompt = `Convert this user feedback about how AI should name video clips into 1-2 short, standalone preference rules. Feedback${ex}: "${fb}". Reply with STRICT JSON only: {"memories": [{"rule": "...", "example": "..."}]}. Each rule is a concise imperative ≤ 12 words; each example is a SHORT concrete illustration of the rule (e.g. a sample subject/description). Use 1 rule unless the feedback clearly covers two separate points.`;
      const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.3, timeout: 120000 }));
      newItems = aiExtractRules((o && o.memories !== undefined) ? o.memories : o).slice(0, 3);
    }
  } catch { /* fall back below */ }
  if (!newItems.length) newItems = [{ text: fb, example: String((payload && payload.example) || '') }];   // no model → store raw

  const now = Date.now();
  const added = [];
  for (const it of newItems) {
    if (ai.memories.some((m) => (m.text || '').toLowerCase() === it.text.toLowerCase())) continue;   // dedup
    ai.memories.push({ id: newMemId(), text: it.text, example: it.example || '', ts: now });
    added.push(it.text);
  }
  // SELF-CORRECT: also REMOVE any existing rule this feedback directly contradicts or
  // makes obsolete, so memory shrinks as well as grows (anti-bloat, anti-conflict).
  let removed = 0;
  try {
    if (aiTextModel() && ai.memories.length > 1) {
      const list = ai.memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
      const rprompt = `A user just gave this feedback about how to name video clips: "${fb}". Below are the existing saved rules. List the NUMBERS of any rule that this feedback CONTRADICTS, overrides, or makes obsolete and should be REMOVED. Be conservative — only clear conflicts. If none, return an empty list. STRICT JSON only: {"remove":[numbers]}.\nRULES:\n${list}`;
      const ro = parseJsonLoose(await ollamaGenerate(aiTextModel(), rprompt, { format: 'json', temperature: 0.1, timeout: 120000, think: false }));
      const idxs = (Array.isArray(ro && ro.remove) ? ro.remove : []).map((n) => Number(n) - 1).filter((n) => n >= 0 && n < ai.memories.length);
      // don't remove the rules we just added
      const addedSet = new Set(added.map((t) => t.toLowerCase()));
      const drop = new Set(idxs.filter((i) => !addedSet.has((ai.memories[i].text || '').toLowerCase())));
      if (drop.size) { ai.memories = ai.memories.filter((m, i) => !drop.has(i)); removed = drop.size; }
    }
  } catch { /* best-effort */ }
  if (ai.memories.length > 300) ai.memories = ai.memories.slice(-300);
  saveConfig();
  try { evt.sender.send('ai:memory-updated', { memories: ai.memories }); } catch { /* ignore */ }
  maybeAutoConsolidate();
  return { ok: true, memories: ai.memories, added, removed };
});

// Learn from edits (implicit): the renderer records when the user changes a value
// the AI suggested ({field, from, to}); distil the corrections into 1-3 candidate
// rules. We do NOT save them here — they're PROPOSED back to the renderer, which
// queues them as questions for the user to confirm before they become memory.
ipcMain.handle('ai:learnEdits', async (_evt, payload) => {
  const edits = (Array.isArray(payload) ? payload : (payload && payload.edits) || [])
    .filter((e) => e && e.from && e.to && String(e.from).toLowerCase() !== String(e.to).toLowerCase())
    .slice(0, 30);
  if (!edits.length) return { ok: false, error: 'No edits' };
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.memories)) ai.memories = [];
  if (!Array.isArray(ai.feedbackLog)) ai.feedbackLog = [];
  ai.feedbackLog.push({ kind: 'edits', edits, ts: Date.now() });
  if (ai.feedbackLog.length > 200) ai.feedbackLog = ai.feedbackLog.slice(-200);
  saveConfig();   // keep the raw edits even if distillation/confirmation never happens

  const lines = edits.map((e) => `- ${e.field}: AI suggested "${e.from}" → user changed to "${e.to}"`).join('\n');
  let proposed = [];
  try {
    if (aiTextModel()) {
      const prompt = `An AI suggested names for video clips, but the user corrected them:\n${lines}\n\nInfer 1-3 short, standalone preference rules the AI should follow so it makes these corrections itself next time (about wording, length, format, or subject choice). Ignore one-off changes that aren't a pattern. Reply with STRICT JSON only: {"memories": [{"rule": "...", "example": "..."}]}. Each rule is a concise imperative ≤ 12 words; each example is a SHORT concrete illustration (e.g. the corrected wording).`;
      const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.3, timeout: 120000 }));
      proposed = aiExtractRules((o && o.memories !== undefined) ? o.memories : o).slice(0, 3);
    }
  } catch { /* no model / parse failure → nothing to propose */ }
  // Drop rules already in memory so we don't ask about ones we've learned.
  proposed = proposed.filter((p) => p.text && !ai.memories.some((m) => (m.text || '').toLowerCase() === p.text.toLowerCase()));
  return { ok: true, proposed };
});

// Commit user-confirmed memory rules (from the review form's "remember this" step,
// or anywhere else the renderer wants to add rules). Dedups + persists + notifies.
ipcMain.handle('ai:addMemories', (evt, payload) => {
  const rules = aiExtractRules(Array.isArray(payload) ? payload : (payload && payload.rules) || []).slice(0, 20);
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.memories)) ai.memories = [];
  const now = Date.now();
  const added = [];
  for (const it of rules) {
    if (ai.memories.some((m) => (m.text || '').toLowerCase() === it.text.toLowerCase())) continue;   // dedup
    ai.memories.push({ id: newMemId(), text: it.text, example: it.example || '', ts: now });
    added.push(it.text);
  }
  if (!added.length) return { ok: true, memories: ai.memories, added: [] };
  if (ai.memories.length > 300) ai.memories = ai.memories.slice(-300);
  saveConfig();
  try { evt.sender.send('ai:memory-updated', { memories: ai.memories }); } catch { /* ignore */ }
  maybeAutoConsolidate();   // background-compress when it grows
  return { ok: true, memories: ai.memories, added };
});

// REFLECT: work BACKWARDS from how clips were SEEN (the vision observation across
// frames) and what they were NAMED → derive durable, reusable naming RULES and add
// them to memory. This is the app learning from its OWN analysis, not just edits.
ipcMain.handle('ai:reflect', async (evt, payload) => {
  const ai = config.ai || (config.ai = {});
  const model = aiTextModel() || ai.model;
  if (!model) return { ok: false, error: 'No model selected' };
  const samples = (Array.isArray(payload && payload.samples) ? payload.samples : [])
    .filter((s) => s && s.observation && (s.subject || s.description)).slice(0, 24);
  if (samples.length < 2) return { ok: false, error: 'Not enough analyzed clips to learn from' };
  const lines = samples.map((s, i) => {
    const name = [s.subject, s.description].filter(Boolean).join(' / ');
    const extra = [s.shotType ? `shot:${s.shotType}` : '', (Array.isArray(s.people) && s.people.length) ? `people:${s.people.join(',')}` : ''].filter(Boolean).join(' ');
    const ctx = s.context ? ` (user's intent: "${String(s.context).slice(0, 140)}")` : '';
    return `${i + 1}. SAW: "${String(s.observation).slice(0, 320)}"${ctx} -> NAMED: "${name}"${extra ? ` [${extra}]` : ''}`;
  }).join('\n');
  const existing = (ai.memories || []).map((m) => m.text).filter(Boolean).slice(0, 40);
  const prompt = `A system looked at these video clips (what it SAW across the frames) and the names it produced:\n${lines}\n\nWork BACKWARDS: what GENERAL, reusable naming rules or preferences explain these choices and would help name SIMILAR future footage the same way? Focus on DURABLE patterns — how to describe an action, what a recurring subject/place should be called, shot-type conventions, how recognized people are used — NOT facts about these specific clips. Do NOT repeat anything already covered by these existing rules:\n- ${existing.join('\n- ') || '(none yet)'}\nReturn 0-4 genuinely NEW rules (or none). STRICT JSON only: {"memories":[{"rule":"<= 14 words","example":"short illustration or empty"}]}`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(model, prompt, { format: 'json', temperature: 0.3, timeout: 120000, think: false }));
    const rules = aiExtractRules(o && o.memories ? o.memories : o).slice(0, 4);
    if (!Array.isArray(ai.memories)) ai.memories = [];
    const now = Date.now(); const added = [];
    for (const it of rules) {
      const t = (it.text || '').trim(); if (!t) continue;
      if (ai.memories.some((m) => (m.text || '').toLowerCase() === t.toLowerCase())) continue;
      ai.memories.push({ id: newMemId(), text: t, example: it.example || '', ts: now });
      added.push(t);
    }
    if (added.length) {
      if (ai.memories.length > 300) ai.memories = ai.memories.slice(-300);
      saveConfig();
      try { evt.sender.send('ai:memory-updated', { memories: ai.memories }); } catch { /* ignore */ }
      maybeAutoConsolidate();
    }
    return { ok: true, added };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Refine/compact one memory's text into a tidy keyword-style rule (used by the
// add-memory editor's "Refine with AI" button; returns the refined text only).
ipcMain.handle('ai:refineMemory', async (_evt, payload) => {
  const text = String((payload && payload.text) || '').trim();
  if (!text) return { ok: false, error: 'Empty' };
  const ai = config.ai || {};
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  try {
    const prompt = `Rewrite this note as ONE concise, standalone preference rule for an AI that names video clips. Keep every useful keyword, drop filler. Reply with STRICT JSON only: {"rule": "...", "example": "..."} — rule ≤ 14 words, example a SHORT concrete illustration (may be "").\nNote: "${text}"`;
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 120000 }));
    const r = aiExtractRules((o && (o.rule || o.memories || o.text)) !== undefined ? (o.memories || o) : o)[0];
    if (!r || !r.text) return { ok: false, error: 'No result' };
    return { ok: true, text: r.text, example: r.example || '' };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Import a document (e.g. a naming SOP): extract the useful rules+keywords into
// PROPOSED memory items the user then confirms. Reads a text-like file directly.
ipcMain.handle('ai:importDoc', async (_evt, payload) => {
  const filePath = String((payload && payload.path) || '').trim();
  let text = String((payload && payload.text) || '');
  if (!text && filePath) { try { text = await fsp.readFile(filePath, 'utf8'); } catch (err) { return { ok: false, error: `Couldn't read file: ${err.message}` }; } }
  text = text.slice(0, 16000).trim();   // cap context
  if (!text) return { ok: false, error: 'Nothing to read in that file' };
  const ai = config.ai || {};
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  try {
    const prompt = `The following is a videographer's notes/SOP. Extract EVERY concrete, reusable fact or rule that would help an AI name, tag, organize, or file their video clips — including: naming format, wording/casing, keywords or tags, folder and location conventions, storage paths, and any specific values mentioned (folder names, drive paths, etc.). Capture specifics verbatim where useful. Ignore only pure prose/boilerplate. If a line states a concrete convention, it IS a rule. Reply with STRICT JSON only: {"memories": [{"rule": "...", "example": "..."}]} — up to 15 rules, each ≤ 18 words, example a SHORT illustration or the concrete value (may be "").\n\nNOTES:\n${text}`;
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 180000 }));
    const proposed = aiExtractRules((o && o.memories !== undefined) ? o.memories : o).slice(0, 12);
    return { ok: true, proposed };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Learn the user's naming STYLE from the names they've already given clips (the
// Compressed folder + saved records). Stores example pairs (injected into every
// suggestion) and asks the model to distil 3-6 style rules into memory.
ipcMain.handle('ai:learnNames', async (_evt, payload) => {
  const ai = config.ai || (config.ai = {});
  const dir = (payload && payload.dir) || config.finalizeSource || '';
  const pairs = [];
  if (dir) {
    let files = [];
    try { files = await listVideosShallow(dir); } catch { /* ignore */ }
    for (const f of files) {
      const p = parseNamedClip(f.name);
      if (p && (p.subject || p.description)) pairs.push(`${p.subject || '?'} / ${p.description || '?'}`);
    }
  }
  // Also mine the saved final-metadata records.
  try {
    for (const v of Object.values(currentFinalMeta())) {
      if (v && (v.subject || v.description)) pairs.push(`${v.subject || '?'} / ${v.description || '?'}`);
    }
  } catch { /* ignore */ }
  const uniq = [...new Set(pairs)].filter((s) => s !== '? / ?');
  if (!uniq.length) return { ok: false, error: dir ? 'No app-named clips found in that folder.' : 'No Compressed folder set and no saved names yet.' };

  // Deep mining: feed up to 200 of the user's own names and ask for MORE rules,
  // each carrying a real example drawn from their data.
  const sample = uniq.slice(0, 200);
  let rules = [];
  try {
    if (aiTextModel()) {
      const prompt = `Here is how a videographer names their own video clips, as "subject / description" pairs (${sample.length} examples):\n${sample.join('\n')}\n\nStudy their STYLE in depth and summarise it into 5-10 short imperative rules an AI should follow to name clips exactly the same way — cover word count, format/casing, what they consistently include or omit, how they phrase subjects vs descriptions, and any recurring vocabulary. Reply with STRICT JSON only: {"rules": [{"rule": "...", "example": "..."}]}. Each rule ≤ 14 words; each example is a REAL pair from the list above that illustrates the rule.`;
      const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.3, timeout: 180000 }));
      rules = aiExtractRules((o && o.rules !== undefined) ? o.rules : o).slice(0, 10);
    }
  } catch { /* keep examples even if rule distillation fails */ }

  if (!Array.isArray(ai.memories)) ai.memories = [];
  ai.styleExamples = uniq.slice(0, 60);   // few-shot examples — fine to keep silently
  saveConfig();
  // PROPOSE the distilled rules (don't auto-add) — the user confirms which to keep.
  const proposed = rules.filter((r) => r.text && !ai.memories.some((m) => (m.text || '').toLowerCase() === r.text.toLowerCase()));
  return { ok: true, examples: uniq.length, proposed };
});

// Consolidate the memory list: merge tiny/overlapping rules into fewer, grouped
// ones (each keeps an example). PROPOSES a new list — the renderer confirms before
// it replaces the old one. This is the "stop creating many tiny memories" lever.
// Memory inbox: a plain file (memory-inbox.jsonl) that anything — including Claude
// between sessions — can append learnings to. On launch we fold them into AI memory
// (deduped) and archive the inbox, so external refinements flow in without touching
// the live config.json. Each line is {"text":"…","example":"…"} or just raw text.
function ingestMemoryInbox() {
  const inbox = path.join(path.dirname(USER_CONFIG), 'memory-inbox.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(inbox, 'utf8').split(/\r?\n/).filter((l) => l.trim()); } catch { return; }
  if (!lines.length) return;
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.memories)) ai.memories = [];
  const have = new Set(ai.memories.map((m) => String((m && m.text) || '').toLowerCase()));
  let added = 0;
  for (const l of lines) {
    let text = ''; let example = '';
    try { const o = JSON.parse(l); text = String(o.text || o.rule || '').trim(); example = String(o.example || ''); }
    catch { text = l.trim(); }
    if (text && !have.has(text.toLowerCase())) { have.add(text.toLowerCase()); ai.memories.push({ id: newMemId(), text, example, ts: Date.now() }); added += 1; }
  }
  if (added) saveConfig();
  try { fs.renameSync(inbox, `${inbox}.${Date.now()}.done`); } catch { try { fs.writeFileSync(inbox, ''); } catch { /* ignore */ } }
  if (added) setTimeout(() => { maybeAutoConsolidate(); }, 2000);
}

// Self-compressing memory: when it grows past a threshold, merge/dedupe it in the
// BACKGROUND (no approval) so it stays a tight set of distinct rules forever.
let _autoConsolidating = false;
const AUTO_CONSOLIDATE_AT = 20;
async function maybeAutoConsolidate() {
  const ai = config.ai || {};
  const mems = (ai.memories || []).filter((m) => m && m.text);
  if (mems.length < AUTO_CONSOLIDATE_AT || _autoConsolidating || !aiTextModel()) return;
  _autoConsolidating = true;
  try {
    // Memories are listed OLDEST→NEWEST; on a CONFLICT, the later rule reflects the
    // user's more recent preference and wins.
    const list = mems.map((m, i) => `${i + 1}. ${m.text}${m.example ? ` (e.g. ${m.example})` : ''}`).join('\n');
    const prompt = `Here are preference rules (oldest first) for an AI that names & organizes video clips. Clean them into a tight, NON-CONTRADICTORY set:\n- MERGE overlapping/duplicate rules into fewer well-grouped ones.\n- If two rules CONFLICT (say opposite things), DROP the older one and keep the newer (later-numbered) rule — it is the user's more recent preference.\n- DELETE anything redundant, vague, or now contradicted. Do not invent new rules.\n- PRESERVE every distinct concrete requirement + one short example.\nAim for ≤ 18 rules. Reply STRICT JSON only: {"memories":[{"rule":"...","example":"..."}]}.\n\nRULES:\n${list}`;
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 180000 }));
    const merged = aiExtractRules((o && o.memories !== undefined) ? o.memories : o).slice(0, 60);
    const before = mems.map((m) => (m.text || '').toLowerCase().trim()).join('|');
    const after = merged.map((r) => (r.text || '').toLowerCase().trim()).join('|');
    // Apply when the set actually changed and didn't GROW (merges, conflict-drops, edits).
    if (merged.length && merged.length <= mems.length && after !== before) {
      const now = Date.now();
      config.ai.memories = merged.map((r) => ({ id: newMemId(), text: r.text, example: r.example || '', ts: now }));
      saveConfig();
      if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('ai:memory-updated', { memories: config.ai.memories, consolidated: true }); } catch { /* ignore */ } }
    }
  } catch { /* best-effort */ }
  _autoConsolidating = false;
}

// ---------------------------------------------------------------------------
// People / face recognition store (fully local). Each person keeps a few face
// DESCRIPTORS (128-float embeddings produced in the renderer by face-api.js).
// Matching is by euclidean distance. Detection runs in the renderer (WebGL, no
// native modules); main just persists + matches. Auto-tagged people flow into
// the clip's XMP PersonInImage + keywords (see buildEmbedTags).
// ---------------------------------------------------------------------------
// Each person keeps a list of FACES = { d:[128 descriptor], t:'thumb dataURL' } so
// the People dashboard can show every face per person (digiKam-style). Older configs
// stored parallel `descriptors`+`thumb`/`thumbs`; migratePerson() folds them into faces.
function migratePerson(p) {
  if (!Array.isArray(p.faces)) {
    const ds = Array.isArray(p.descriptors) ? p.descriptors : [];
    const ts = Array.isArray(p.thumbs) ? p.thumbs : (p.thumb ? [p.thumb] : []);
    p.faces = ds.map((d, i) => ({ d, t: ts[i] || p.thumb || '' }));
  }
  // Existing faces were user-named → treat as confirmed. New unconfirmed ones come
  // in with confirmed:false.
  p.faces.forEach((f) => { if (f.confirmed === undefined) f.confirmed = true; });
  if (!p.thumb && p.faces.length) p.thumb = ((p.faces.find((f) => f.confirmed && f.t) || p.faces.find((f) => f.t)) || {}).t || '';
  return p;
}
function aiPeople() { config.ai = config.ai || {}; if (!Array.isArray(config.ai.people)) config.ai.people = []; config.ai.people.forEach(migratePerson); return config.ai.people; }
function aiIgnoredFaces() { config.ai = config.ai || {}; if (!Array.isArray(config.ai.ignored)) config.ai.ignored = []; return config.ai.ignored; }
function personCover(p) { return p.thumb || ((p.faces || []).find((f) => f.confirmed && f.t) || (p.faces || []).find((f) => f.t) || {}).t || ''; }
function faceDist(a, b) { if (!a || !b) return Infinity; let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i += 1) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
function personCounts(p) { const fs = p.faces || []; const conf = fs.filter((f) => f.confirmed).length; return { count: fs.length, confirmed: conf, unconfirmed: fs.length - conf }; }
ipcMain.handle('people:get', () => aiPeople().map((p) => ({ id: p.id, name: p.name, thumb: personCover(p), ...personCounts(p) })));
ipcMain.handle('faces:ignoredCount', () => aiIgnoredFaces().length);
// Full detail incl. every face thumb + confirmed flag — for the dashboard's grid.
ipcMain.handle('people:detail', (_e, id) => {
  const p = aiPeople().find((x) => x.id === id);
  if (!p) return { ok: false };
  return { ok: true, id: p.id, name: p.name, cover: personCover(p), ...personCounts(p), faces: (p.faces || []).map((f, i) => ({ i, t: f.t || '', confirmed: !!f.confirmed })) };
});
ipcMain.handle('people:save', (_e, payload) => {
  // Upsert a person by name; append new faces (descriptor + its thumb). `confirmed`
  // false = a recognized-but-not-yet-confirmed face (shows in the dashboard's
  // Unconfirmed section). Near-duplicate faces are skipped to keep the store diverse.
  const name = String((payload && payload.name) || '').trim();
  if (!name) return { ok: false, error: 'No name' };
  const descriptors = Array.isArray(payload && payload.descriptors) ? payload.descriptors.filter((d) => Array.isArray(d) && d.length) : [];
  const thumb = String((payload && payload.thumb) || '');
  const confirmed = !(payload && payload.confirmed === false);
  const people = aiPeople();
  let p = people.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) { p = { id: `pp${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name, faces: [], thumb: '', ts: Date.now() }; people.push(p); }
  migratePerson(p);
  const isDup = (d) => d && (p.faces || []).some((f) => f.d && faceDist(f.d, d) < 0.35);
  for (const d of descriptors) { if (!isDup(d)) p.faces.push({ d, t: thumb, confirmed }); }
  if (!descriptors.length && thumb) p.faces.push({ d: null, t: thumb, confirmed });
  if (p.faces.length > 80) p.faces = p.faces.slice(-80);
  if (thumb && confirmed && !p.thumb) p.thumb = thumb;
  saveConfig();
  return { ok: true, id: p.id };
});
// Promote an unconfirmed face to confirmed.
ipcMain.handle('people:confirmFace', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const idx = Number(payload && payload.index);
  if (!p || !p.faces || !(idx >= 0 && idx < p.faces.length)) return { ok: false };
  p.faces[idx].confirmed = true;
  if (!p.thumb && p.faces[idx].t) p.thumb = p.faces[idx].t;
  saveConfig();
  return { ok: true };
});
// Move a face into the global Ignored bin (won't be suggested as a person again).
ipcMain.handle('faces:ignore', (_e, payload) => {
  const ig = aiIgnoredFaces();
  const fromId = payload && payload.id; const idx = Number(payload && payload.index);
  if (fromId !== undefined && idx >= 0) {
    const p = aiPeople().find((x) => x.id === fromId);
    if (p && p.faces && idx < p.faces.length) { ig.push(p.faces[idx]); p.faces.splice(idx, 1); if (p.thumb && !(p.faces || []).some((f) => f.t === p.thumb)) p.thumb = personCover(p); }
  } else if (Array.isArray(payload && payload.descriptor)) {
    ig.push({ d: payload.descriptor, t: String(payload.thumb || ''), confirmed: false });
  }
  if (ig.length > 200) config.ai.ignored = ig.slice(-200);
  saveConfig();
  return { ok: true };
});
// Move one face from person `fromId` to a (possibly new) person `toName` — for
// "this isn't them, it's <someone else>" (digiKam-style reassign). The face keeps
// its descriptor so the target person learns from it; it lands confirmed.
ipcMain.handle('people:reassignFace', (_e, payload) => {
  const from = aiPeople().find((x) => x.id === (payload && payload.fromId));
  const idx = Number(payload && payload.index);
  const toName = String((payload && payload.toName) || '').trim();
  if (!from || !toName || !(idx >= 0 && idx < (from.faces || []).length)) return { ok: false };
  const face = from.faces[idx];
  from.faces.splice(idx, 1);
  if (from.thumb && !(from.faces || []).some((f) => f.t === from.thumb)) from.thumb = personCover(from);
  const people = aiPeople();
  let to = people.find((x) => x.name.toLowerCase() === toName.toLowerCase());
  if (!to) { to = { id: `pp${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: toName, faces: [], thumb: '', ts: Date.now() }; people.push(to); }
  migratePerson(to);
  if (!(to.faces || []).some((f) => f.d && faceDist(f.d, face.d) < 0.2)) to.faces.push({ d: face.d, t: face.t, confirmed: true });
  if (face.t && !to.thumb) to.thumb = face.t;
  if (to.faces.length > 80) to.faces = to.faces.slice(-80);
  saveConfig();
  return { ok: true, toId: to.id, toName: to.name };
});
ipcMain.handle('faces:listIgnored', () => aiIgnoredFaces().map((f, i) => ({ i, t: f.t || '' })));
ipcMain.handle('faces:unignore', (_e, idx) => { const ig = aiIgnoredFaces(); const i = Number(idx); if (i >= 0 && i < ig.length) { ig.splice(i, 1); saveConfig(); } return { ok: true }; });
ipcMain.handle('people:rename', (_e, payload) => { const p = aiPeople().find((x) => x.id === (payload && payload.id)); if (p) { p.name = String(payload.name || p.name).trim() || p.name; saveConfig(); } return { ok: true }; });
ipcMain.handle('people:delete', (_e, id) => { config.ai.people = aiPeople().filter((p) => p.id !== id); saveConfig(); return { ok: true }; });
// Merge `fromId` into `intoId` (combines faces, deletes the source) — for fixing
// the same person split across two names.
ipcMain.handle('people:merge', (_e, payload) => {
  const into = aiPeople().find((x) => x.id === (payload && payload.intoId));
  const from = aiPeople().find((x) => x.id === (payload && payload.fromId));
  if (!into || !from || into === from) return { ok: false };
  into.faces = [...(into.faces || []), ...(from.faces || [])].slice(-60);
  config.ai.people = aiPeople().filter((x) => x.id !== from.id);
  saveConfig();
  return { ok: true };
});
// Remove one face (a wrong crop) from a person.
ipcMain.handle('people:removeFace', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const idx = Number(payload && payload.index);
  if (!p || !Array.isArray(p.faces) || !(idx >= 0 && idx < p.faces.length)) return { ok: false };
  p.faces.splice(idx, 1);
  if (p.thumb && !(p.faces || []).some((f) => f.t === p.thumb)) p.thumb = personCover(p);
  saveConfig();
  return { ok: true, faces: (p.faces || []).map((f, i) => ({ i, t: f.t || '' })) };
});
ipcMain.handle('people:setCover', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const t = String((payload && payload.thumb) || '');
  if (!p || !t) return { ok: false };
  p.thumb = t; saveConfig(); return { ok: true };
});
// Given a face descriptor, return the best-matching known person (or null).
ipcMain.handle('people:match', (_e, payload) => {
  const desc = Array.isArray(payload && payload.descriptor) ? payload.descriptor : null;
  const threshold = Number(payload && payload.threshold) || 0.52;
  if (!desc) return { ok: true, match: null };
  // If the face is closest to an IGNORED face, treat it as a non-match (digiKam's
  // "Ignored" bin — stops suggesting people you've told it to skip).
  let ignD = Infinity;
  for (const f of aiIgnoredFaces()) { if (!f.d) continue; const dist = faceDist(desc, f.d); if (dist < ignD) ignD = dist; }
  let best = null; let bestD = Infinity;
  for (const p of aiPeople()) { for (const f of (p.faces || [])) { if (!f.d) continue; const dist = faceDist(desc, f.d); if (dist < bestD) { bestD = dist; best = p; } } }
  if (ignD < bestD && ignD <= threshold) return { ok: true, match: null, dist: bestD, ignored: true };
  return { ok: true, match: (best && bestD <= threshold) ? { id: best.id, name: best.name, dist: bestD } : null, dist: bestD };
});

// Extract a single large frame (960px wide) for face detection — much better than a
// contact-sheet grid where faces are tiny. Cached separately from the poster.
async function getFaceFrame(srcPath) {
  if (faceFrameCache.has(srcPath)) return faceFrameCache.get(srcPath);
  await acquirePoster();
  try {
    await ensureDir(THUMB_DIR);
    const tag = Buffer.from(srcPath).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    const outPath = path.join(THUMB_DIR, `face_${tag}.jpg`);
    if (await fsp.access(outPath).then(() => true).catch(() => false)) {
      faceFrameCache.set(srcPath, outPath); return outPath;
    }
    const extract = (ss) => new Promise((resolve) => {
      const proc = spawn(config.ffmpegPath, ['-y', '-ss', String(ss), '-i', srcPath, '-frames:v', '1', '-vf', 'scale=960:-2', outPath], { windowsHide: true });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
    let ok = await extract(1);
    if (!ok) ok = await extract(0);
    if (!ok) return null;
    faceFrameCache.set(srcPath, outPath);
    return outPath;
  } finally { releasePoster(); }
}

// A clip's frame as a data URL, for the renderer to run face detection on.
// Uses a single 960px-wide frame (not a grid) so face-api gets a big target.
ipcMain.handle('faces:image', async (_e, payload) => {
  const sourcePath = String((payload && payload.sourcePath) || '');
  if (!sourcePath) return { ok: false, error: 'No clip' };
  try {
    const framePath = await getFaceFrame(sourcePath);
    if (!framePath) return { ok: false, error: 'Could not read frame' };
    const b64 = (await fsp.readFile(framePath)).toString('base64');
    return { ok: true, dataUrl: `data:image/jpeg;base64,${b64}` };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Sample frames ACROSS THE WHOLE CLIP for face detection (digiKam-style "scan the
// whole video"). N = ceil(duration / interval), capped at maxFrames, spread evenly.
// Fast `-ss`-before-`-i` keyframe seeking keeps it quick even on big 4K GoPro clips.
async function getFaceFrames(srcPath, interval, maxFrames) {
  let durationSec = 0;
  try { durationSec = (await probeMeta(srcPath)).durationSec || 0; } catch { /* ignore */ }
  if (!durationSec || !isFinite(durationSec) || durationSec < interval) {
    const one = await getFaceFrame(srcPath);
    return one ? [one] : [];
  }
  const N = Math.max(1, Math.min(maxFrames, Math.ceil(durationSec / interval)));
  await ensureDir(THUMB_DIR);
  const tag = Buffer.from(srcPath).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  const jobs = [];
  for (let i = 0; i < N; i += 1) {
    const ss = durationSec * ((i + 0.5) / N);
    const out = path.join(THUMB_DIR, `fscan_${tag}_${i}.jpg`);
    jobs.push((async () => {
      await acquirePoster();
      try {
        const ok = await new Promise((res) => {
          const p = spawn(config.ffmpegPath, ['-y', '-ss', String(ss), '-i', srcPath, '-frames:v', '1', '-vf', 'scale=1100:-2', out], { windowsHide: true });
          p.on('error', () => res(false)); p.on('close', (c) => res(c === 0));
        });
        return ok ? out : null;
      } finally { releasePoster(); }
    })());
  }
  return (await Promise.all(jobs)).filter(Boolean);
}

// Returns an ARRAY of frame data-URLs spanning the clip, for whole-clip face scan.
ipcMain.handle('faces:frames', async (_e, payload) => {
  const sourcePath = String((payload && payload.sourcePath) || '');
  if (!sourcePath) return { ok: false, error: 'No clip' };
  // A PHOTO is its own single "frame" — hand the image straight to face detection
  // (no ffmpeg frame extraction). This is what lets face recognition run on stills.
  if (isImagePath(sourcePath)) {
    try {
      const ext = path.extname(sourcePath).slice(1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
      const b64 = (await fsp.readFile(sourcePath)).toString('base64');
      return { ok: true, frames: [`data:${mime};base64,${b64}`] };
    } catch (err) { return { ok: false, error: err.message || String(err) }; }
  }
  const ai = config.ai || {};
  const interval = Math.max(1, Math.min(15, Number(payload && payload.interval) || Number(ai.faceInterval) || 2));
  const maxFrames = Math.max(1, Math.min(120, Number(payload && payload.maxFrames) || Number(ai.faceMaxFrames) || 24));
  try {
    const paths = await getFaceFrames(sourcePath, interval, maxFrames);
    if (!paths.length) return { ok: false, error: 'Could not read frames' };
    const frames = [];
    for (const fp of paths) {
      try { const b64 = (await fsp.readFile(fp)).toString('base64'); frames.push(`data:image/jpeg;base64,${b64}`); } catch { /* skip */ }
      fsp.unlink(fp).catch(() => {});   // temp scan frames — don't keep them around
    }
    return { ok: true, frames };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('ai:consolidateMemories', async (_evt) => {
  const ai = config.ai || (config.ai = {});
  const mems = (ai.memories || []).filter((m) => m && m.text);
  if (mems.length < 2) return { ok: false, error: 'Not enough memories to group' };
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  const list = mems.map((m, i) => `${i + 1}. ${m.text}${m.example ? ` (e.g. ${m.example})` : ''}`).join('\n');
  try {
    const prompt = `Here is a list of preference rules for an AI that names and organizes video clips. Many are tiny or overlapping. Merge closely-related rules into fewer, well-grouped rules; combine duplicates; keep genuinely distinct rules separate. PRESERVE every concrete requirement and keep one good example per rule. Prefer a handful of clear grouped rules over many tiny ones. Reply STRICT JSON only: {"memories":[{"rule":"...","example":"..."}]}.\n\nRULES:\n${list}`;
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 180000 }));
    const merged = aiExtractRules((o && o.memories !== undefined) ? o.memories : o);
    if (!merged.length) return { ok: false, error: 'No result from the model' };
    return { ok: true, proposed: merged, before: mems.length };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Replace the whole memory list (used after the user approves a consolidation).
ipcMain.handle('ai:replaceMemories', (evt, payload) => {
  const rules = aiExtractRules(Array.isArray(payload) ? payload : (payload && payload.rules) || []).slice(0, 100);
  const ai = config.ai || (config.ai = {});
  const now = Date.now();
  ai.memories = rules.map((r) => ({ id: newMemId(), text: r.text, example: r.example || '', ts: now }));
  saveConfig();
  try { evt.sender.send('ai:memory-updated', { memories: ai.memories }); } catch { /* ignore */ }
  return { ok: true, memories: ai.memories };
});

// --- In-app feedback log (Help → Feedback, or right-click → Report feedback) ---
// Captured to a JSONL file in the app data folder so both the local AI and Claude
// can read it while the app is being built. Export to CSV or an AI-bundled summary.
const FEEDBACK_FILE = path.join(path.dirname(USER_CONFIG), 'feedback.jsonl');
function readFeedback() {
  try {
    return fs.readFileSync(FEEDBACK_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
ipcMain.handle('feedback:add', (_evt, payload) => {
  const text = String((payload && payload.text) || '').trim();
  const srcImgs = Array.isArray(payload && payload.images) ? payload.images : [];
  if (!text && !srcImgs.length) return { ok: false, error: 'Empty feedback' };
  // Copy any attached screenshots into the app data folder so the log is self-contained.
  const images = [];
  if (srcImgs.length) {
    const imgDir = path.join(path.dirname(USER_CONFIG), 'feedback-images');
    try { fs.mkdirSync(imgDir, { recursive: true }); } catch { /* ignore */ }
    let n = 0;
    for (const src of srcImgs.slice(0, 8)) {
      try {
        const dst = path.join(imgDir, `${Date.now().toString(36)}_${n += 1}${path.extname(src) || '.png'}`);
        fs.copyFileSync(src, dst); images.push(dst);
      } catch { /* skip unreadable image */ }
    }
  }
  const rec = { ts: new Date().toISOString(), section: String((payload && payload.section) || '').slice(0, 200), context: String((payload && payload.context) || '').slice(0, 500), text, images };
  try { fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(rec) + '\n'); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, file: FEEDBACK_FILE };
});
ipcMain.handle('feedback:list', () => ({ ok: true, items: readFeedback(), file: FEEDBACK_FILE }));
// Return all feedback as ready-to-copy TEXT (plain list, or AI-refined markdown).
ipcMain.handle('feedback:text', async (_evt, payload) => {
  const refine = !!(payload && payload.refine);
  const items = readFeedback();
  if (!items.length) return { ok: false, error: 'No feedback recorded yet' };
  const plain = items.map((it, i) => `${i + 1}. [${it.section || 'general'}] ${it.text}${it.context ? ` (${it.context})` : ''}`).join('\n');
  if (!refine) return { ok: true, text: plain };
  if (!aiTextModel()) return { ok: false, error: 'Select an AI model first (or copy the raw list)' };
  try {
    const prompt = `These are raw feedback notes a developer left while building a desktop app (each tagged with the UI section). Group them by theme/section and rewrite as a clean, prioritized markdown summary with headings and bullets. Keep every concrete request; merge duplicates. Notes:\n${plain}`;
    const md = await ollamaGenerate(aiTextModel(), prompt, { temperature: 0.3, timeout: 180000 });
    return { ok: true, text: `# Feedback summary (${items.length} notes)\n\n${md}` };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});
// Write text to the system clipboard (reliable; navigator.clipboard is flaky on file://).
ipcMain.handle('clipboard:write', (_evt, text) => { try { require('electron').clipboard.writeText(String(text || '')); return true; } catch { return false; } });
ipcMain.handle('feedback:export', async (_evt, payload) => {
  const refine = !!(payload && payload.refine);
  const items = readFeedback();
  if (!items.length) return { ok: false, error: 'No feedback recorded yet' };
  const dir = path.dirname(USER_CONFIG);
  if (refine) {
    if (!aiTextModel()) return { ok: false, error: 'Select an AI model first (or export as CSV)' };
    try {
      const lines = items.map((it, i) => `${i + 1}. [${it.section || 'general'}] ${it.text}`).join('\n');
      const prompt = `These are raw feedback notes a developer left while building a desktop app (each tagged with the UI section it's about). Group them by theme/section and rewrite as a clean, prioritized markdown summary with headings and bullet points. Keep every concrete request; merge duplicates. Notes:\n${lines}`;
      const md = await ollamaGenerate(aiTextModel(), prompt, { temperature: 0.3, timeout: 180000 });
      const out = path.join(dir, 'feedback-summary.md');
      fs.writeFileSync(out, `# Feedback summary (${items.length} notes)\n\n${md}\n`, 'utf8');
      return { ok: true, path: out };
    } catch (err) { return { ok: false, error: err.message || String(err) }; }
  }
  const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const rows = ['ts,section,context,text', ...items.map((it) => [esc(it.ts), esc(it.section), esc(it.context), esc(it.text)].join(','))];
  const out = path.join(dir, 'feedback.csv');
  try { fs.writeFileSync(out, rows.join('\r\n'), 'utf8'); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, path: out };
});

// Default playback speed for the in-app <video> previews (persisted).
ipcMain.handle('player:info', () => ({ defaultSpeed: Number(config.defaultSpeed) || 1 }));
ipcMain.handle('player:setSpeed', (_evt, speed) => {
  config.defaultSpeed = Number(speed) || 1;
  saveConfig();
  return config.defaultSpeed;
});

ipcMain.handle('subjects:get', () => config.subjects || []);

ipcMain.handle('subjects:add', (_evt, name) => {
  const s = String(name || '').trim();
  config.subjects = config.subjects || [];
  if (s && !config.subjects.includes(s)) {
    config.subjects.push(s);
    config.subjects.sort((a, b) => a.localeCompare(b));
    saveConfig();
  }
  return config.subjects;
});

ipcMain.handle('subjects:remove', (_evt, name) => {
  config.subjects = (config.subjects || []).filter((s) => s !== name);
  saveConfig();
  return config.subjects;
});

// Locations (e.g. a named lawn/client "dusty") — remembered + autocompleted like
// subjects, embedded into XMP keywords at Finalize.
ipcMain.handle('locations:get', () => config.locations || []);
ipcMain.handle('locations:add', (_evt, name) => {
  const s = String(name || '').trim();
  config.locations = config.locations || [];
  if (s && !config.locations.includes(s)) {
    config.locations.push(s);
    config.locations.sort((a, b) => a.localeCompare(b));
    saveConfig();
  }
  return config.locations;
});

// Descriptions are stored with usage counts and returned most-used first
// ("smart indexed") so autocomplete favours what you actually type a lot.
ipcMain.handle('descriptions:get', () => {
  const d = config.descriptions || {};
  return Object.keys(d).sort((a, b) => (d[b] - d[a]) || a.localeCompare(b));
});

ipcMain.handle('descriptions:add', (_evt, value) => {
  const v = String(value || '').trim();
  if (v) {
    config.descriptions = config.descriptions || {};
    config.descriptions[v] = (config.descriptions[v] || 0) + 1;
    saveConfig();
  }
  return true;
});

// Categories & Projects — remembered value history for the organizing fields
// (used for metadata + the Compressed/<Category>/<Project>/ folder structure).
function makeListHandlers(key) {
  ipcMain.handle(`${key}:get`, () => config[key] || []);
  ipcMain.handle(`${key}:add`, (_evt, name) => {
    const s = String(name || '').trim();
    config[key] = config[key] || [];
    if (s && !config[key].includes(s)) {
      config[key].push(s);
      config[key].sort((a, b) => a.localeCompare(b));
      saveConfig();
    }
    return config[key];
  });
  ipcMain.handle(`${key}:remove`, (_evt, name) => {
    config[key] = (config[key] || []).filter((s) => s !== name);
    saveConfig();
    return config[key];
  });
}
makeListHandlers('categories');
makeListHandlers('projects');

// Custom organizing fields (the user-managed taxonomy) + their value history.
ipcMain.handle('fields:get', () => config.organizeFields);
ipcMain.handle('fields:set', (_evt, list) => {
  config.organizeFields = normalizeOrganizeFields(list);
  for (const f of config.organizeFields) if (!Array.isArray(config.fieldHistory[f.id])) config.fieldHistory[f.id] = [];
  saveConfig();
  return config.organizeFields;
});
ipcMain.handle('fieldHistory:get', () => config.fieldHistory || {});
ipcMain.handle('fieldHistory:add', (_evt, payload) => {
  const id = String((payload && payload.id) || '').trim().toLowerCase();
  const value = String((payload && payload.value) || '').trim();
  if (!id || !value) return config.fieldHistory[id] || [];
  if (!Array.isArray(config.fieldHistory[id])) config.fieldHistory[id] = [];
  if (!config.fieldHistory[id].includes(value)) {
    config.fieldHistory[id].push(value);
    config.fieldHistory[id].sort((a, b) => a.localeCompare(b));
    saveConfig();
  }
  return config.fieldHistory[id];
});
ipcMain.handle('fieldHistory:remove', (_evt, payload) => {
  const id = String((payload && payload.id) || '').trim().toLowerCase();
  const value = String((payload && payload.value) || '');
  if (Array.isArray(config.fieldHistory[id])) {
    config.fieldHistory[id] = config.fieldHistory[id].filter((v) => v !== value);
    saveConfig();
  }
  return config.fieldHistory[id] || [];
});

// Rename drafts — persist in-progress naming (date/subject/description) keyed by
// a per-clip fingerprint (name + size) so work survives an app restart, not just
// in-session navigation. Pruned by age + count so the store can't grow forever.

// In-app diagnostics — reports what THIS process actually sees (env, resolved
// paths, raw file bytes, parsed drafts). Surfaced via Help → Copy diagnostics so
// the exact runtime view can be copied out, since external inspection of the
// same paths has been disagreeing with what the app reads.
ipcMain.handle('debug:info', () => {
  const safe = (fn) => { try { return fn(); } catch (e) { return `ERR: ${e.message}`; } };
  const info = {
    now: new Date().toISOString(),
    pid: process.pid,
    appName: safe(() => app.getName()),
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    dirname: __dirname,
    env_APPDATA: process.env.APPDATA || '(unset)',
    env_LOCALAPPDATA: process.env.LOCALAPPDATA || '(unset)',
    getPath_appData: safe(() => app.getPath('appData')),
    getPath_userData: safe(() => app.getPath('userData')),
    ROAMING_DIR,
    USER_CONFIG,
    BUNDLED_CONFIG,
    userConfigExists: safe(() => fs.existsSync(USER_CONFIG)),
    inMemoryDraftKeys: Object.keys(config.renameDrafts || {}),
    currentDraftKeys: safe(() => Object.keys(currentDrafts()))
  };
  try {
    const raw = fs.readFileSync(USER_CONFIG, 'utf8');
    info.userConfigBytes = raw.length;
    info.userConfigMtime = safe(() => fs.statSync(USER_CONFIG).mtime.toISOString());
    const pj = JSON.parse(raw);
    info.userConfigDraftKeys = Object.keys(pj.renameDrafts || {});
  } catch (e) { info.userConfigReadError = e.message; }
  try {
    const braw = fs.readFileSync(BUNDLED_CONFIG, 'utf8');
    info.bundledDraftKeys = Object.keys((JSON.parse(braw).renameDrafts) || {});
  } catch (e) { info.bundledReadError = e.message; }
  // Other USB-app config.json folders that might be shadowing this one.
  try {
    const roam = process.env.APPDATA || '';
    info.siblingConfigs = ['USB SD Auto-Action', 'usb-auto-action'].map((n) => {
      const p = path.join(roam, n, 'config.json');
      let k = '(missing)';
      try { k = Object.keys((JSON.parse(fs.readFileSync(p, 'utf8')).renameDrafts) || {}).length; } catch { /* missing */ }
      return `${n}: ${fs.existsSync(p) ? `exists drafts=${k}` : 'missing'}`;
    });
  } catch (e) { info.siblingError = e.message; }
  return info;
});

// Merge the freshest on-disk renameDrafts into our in-memory copy, then return
// it. Reading fresh means a draft written by another instance is still seen.
function currentDrafts() {
  const fresh = readConfigFresh();
  if (fresh && fresh.renameDrafts && typeof fresh.renameDrafts === 'object') {
    config.renameDrafts = fresh.renameDrafts;
    // Adopt other fresh fields too so a later save can't write stale settings.
    for (const k of Object.keys(fresh)) if (k !== 'renameDrafts') config[k] = fresh[k];
  }
  if (!config.renameDrafts || typeof config.renameDrafts !== 'object') config.renameDrafts = {};
  return config.renameDrafts;
}

ipcMain.handle('drafts:get', () => currentDrafts());

// ADD/UPDATE-only, and a NO-OP when the incoming map carries no real data. This
// is the crucial guard: a session showing blank fields auto-saves an empty map,
// which now writes NOTHING — so it can never wipe previously-saved names.
// Removal happens solely via drafts:clear (when footage is copied).
ipcMain.handle('drafts:save', (_evt, map) => {
  if (!map || typeof map !== 'object') return false;
  // A draft carries real data if ANY of its values (besides the timestamp) is
  // non-empty — covers subject/description/date + any custom organizing field.
  const hasData = (v) => v && Object.entries(v).some(([k, val]) => k !== 'ts' && val);
  const additions = Object.entries(map).filter(([, v]) => hasData(v));
  if (!additions.length) return true;
  const drafts = currentDrafts();
  const now = Date.now();
  for (const [k, v] of additions) drafts[k] = { ...v, ts: now };
  // Prune: drop entries older than 60 days, then cap to the 4000 most recent.
  const MAX_AGE = 60 * 24 * 3600 * 1000;
  let entries = Object.entries(drafts).filter(([, v]) => v && (now - (v.ts || 0)) < MAX_AGE);
  if (entries.length > 4000) {
    entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    entries = entries.slice(0, 4000);
  }
  config.renameDrafts = Object.fromEntries(entries);
  saveConfig();
  return true;
});

// Clear drafts: the given keys (consumed by a copy), or all of them.
ipcMain.handle('drafts:clear', (_evt, keys) => {
  const drafts = currentDrafts();
  if (Array.isArray(keys) && keys.length) {
    for (const k of keys) delete drafts[k];
  } else {
    config.renameDrafts = {};
  }
  saveConfig();
  return true;
});

// ---------------------------------------------------------------------------
// Version history / save points. A "version" is a full snapshot of every clip's
// editable naming fields (same shape as a draft map), captured manually or
// automatically before an AI run, so the user can roll back. Persisted in config
// as a newest-first array; capped so it can't grow without bound.
// ---------------------------------------------------------------------------
function currentVersions() {
  if (!Array.isArray(config.renameVersions)) config.renameVersions = [];
  return config.renameVersions;
}
ipcMain.handle('versions:get', () => currentVersions());
ipcMain.handle('versions:save', (_evt, entry) => {
  if (!entry || typeof entry !== 'object' || !entry.map || typeof entry.map !== 'object') return currentVersions();
  const list = currentVersions();
  list.unshift({
    id: String(entry.id || `v${Date.now()}`),
    ts: Number(entry.ts) || Date.now(),
    label: String(entry.label || 'Save point').slice(0, 120),
    auto: !!entry.auto,
    count: Number(entry.count) || 0,
    map: entry.map
  });
  if (list.length > 60) list.length = 60;   // keep the 60 most recent
  config.renameVersions = list;
  saveConfig();
  return list;
});
ipcMain.handle('versions:delete', (_evt, id) => {
  config.renameVersions = currentVersions().filter((v) => v && v.id !== id);
  saveConfig();
  return config.renameVersions;
});
ipcMain.handle('versions:clear', () => { config.renameVersions = []; saveConfig(); return []; });

// ---------------------------------------------------------------------------
// Metadata-by-final-filename store. renameDrafts is keyed by the SOURCE clip
// (name+size), but compressed files are re-encoded — different size, sometimes a
// different container — so the draft key can't match them. When a copy finishes,
// the renderer persists a record keyed by the clip's FINAL filename (e.g.
// 2026-06-01_vlog_josiah_v1.mp4) so the Finalize step can match the compressed
// file by name and write its metadata. Keyed lower-cased for robust matching.
// ---------------------------------------------------------------------------
function currentFinalMeta() {
  const fresh = readConfigFresh();
  if (fresh && fresh.finalMeta && typeof fresh.finalMeta === 'object') {
    config.finalMeta = fresh.finalMeta;
    for (const k of Object.keys(fresh)) if (k !== 'finalMeta') config[k] = fresh[k];
  }
  if (!config.finalMeta || typeof config.finalMeta !== 'object') config.finalMeta = {};
  return config.finalMeta;
}

ipcMain.handle('finalMeta:save', (_evt, map) => {
  if (!map || typeof map !== 'object') return false;
  const incoming = Object.entries(map).filter(([k, v]) => k && v && typeof v === 'object');
  if (!incoming.length) return true;
  const store = currentFinalMeta();
  const now = Date.now();
  for (const [name, v] of incoming) {
    // Store all provided fields generically (subject/description/date + whatever
    // custom organizing fields the clip carried), plus the keyword list.
    const rec = { ts: now };
    for (const [k, val] of Object.entries(v)) {
      if (k === 'ts') continue;
      if (k === 'keywords' || k === 'people') rec[k] = Array.isArray(val) ? val : [];
      else rec[k] = (val == null ? '' : String(val));
    }
    if (!Array.isArray(rec.keywords)) rec.keywords = [];
    store[String(name).toLowerCase()] = rec;
  }
  // Prune: drop entries older than 180 days, then cap to the 5000 most recent.
  const MAX_AGE = 180 * 24 * 3600 * 1000;
  let entries = Object.entries(store).filter(([, v]) => v && (now - (v.ts || 0)) < MAX_AGE);
  if (entries.length > 5000) {
    entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    entries = entries.slice(0, 5000);
  }
  config.finalMeta = Object.fromEntries(entries);
  saveConfig();
  return true;
});

ipcMain.handle('finalMeta:get', () => currentFinalMeta());

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
  return { ...base, ...(s && s.overrides ? s.overrides : {}), skipExisting: !(s && s.skipExisting === false) };
}
function buildCompressArgs(src, out, s) {
  const a = ['-y', '-i', src];
  if (s.scale && s.scale !== 'source') a.push('-vf', `scale=-2:${s.scale}`);
  if (s.codec === 'h265') a.push('-c:v', 'libx265', '-tag:v', 'hvc1', '-crf', String(s.crf ?? 28));
  else a.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(s.crf ?? 23));
  a.push('-preset', s.preset || 'medium');
  if (s.audio === 'copy') a.push('-c:a', 'copy'); else a.push('-c:a', 'aac', '-b:a', '160k');
  a.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out);
  return a;
}
function ffmpegLastError(err) {
  const lines = String(err || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 200) : '';
}
let compressProc = null;
let compressAborted = false;
ipcMain.handle('compress:cancel', () => { compressAborted = true; if (compressProc) { try { compressProc.kill('SIGKILL'); } catch { /* ignore */ } } return true; });
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
ipcMain.handle('compress:run', async (evt, payload) => {
  const { files, outDir } = payload || {};
  if (!Array.isArray(files) || !files.length) return { ok: false, error: 'No files to compress' };
  const out = outDir || config.finalizeSource;
  if (!out) return { ok: false, error: 'No output (Compressed) folder set' };
  try { await fsp.mkdir(out, { recursive: true }); } catch (e) { return { ok: false, error: `Cannot create output folder: ${e.message}` }; }
  const s = compressSettings(payload && payload.settings);
  compressAborted = false;
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
    if (path.resolve(outPath) === path.resolve(src)) outPath = path.join(out, `${base}_compressed.mp4`);
    // Two source clips that share a stem but differ in container (clip.mov + clip.mp4)
    // would map to the same output — disambiguate so neither is lost/overwritten.
    let cn = 1;
    while (produced.has(path.resolve(outPath))) { outPath = path.join(out, `${base} (${cn}).mp4`); cn += 1; }
    produced.add(path.resolve(outPath));
    let inBytes = 0; try { inBytes = (await fsp.stat(src)).size; } catch { /* ignore */ }
    let durationSec = 0; try { durationSec = (await probeMeta(src)).durationSec || 0; } catch { /* ignore */ }
    if (s.skipExisting) { try { const st = await fsp.stat(outPath); if (st.size > 0) { results.push({ name: f.name, ok: true, skipped: true, outPath, inBytes, outBytes: st.size }); send({ index: i, total: files.length, name: f.name, pct: 100, phase: 'skipped' }); continue; } } catch { /* not there */ } }
    send({ index: i, total: files.length, name: f.name, pct: 0, phase: 'starting', inBytes });
    const args = buildCompressArgs(src, outPath, s);
    // eslint-disable-next-line no-await-in-loop
    const res = await new Promise((resolve) => {
      let errBuf = '';
      const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
      compressProc = proc;
      proc.stdout.on('data', (d) => {
        const m = String(d).match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m && durationSec) {
          const sec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          send({ index: i, total: files.length, name: f.name, pct: Math.max(1, Math.min(99, Math.round((sec / durationSec) * 100))), phase: 'compressing', inBytes });
        }
      });
      proc.stderr.on('data', (d) => { errBuf += String(d); if (errBuf.length > 6000) errBuf = errBuf.slice(-6000); });
      proc.on('error', (e) => { compressProc = null; resolve({ ok: false, error: e.message }); });
      proc.on('close', (code) => { compressProc = null; resolve(code === 0 ? { ok: true } : { ok: false, error: compressAborted ? 'cancelled' : (ffmpegLastError(errBuf) || `ffmpeg exited ${code}`) }); });
    });
    if (res.ok) {
      let outBytes = 0; try { outBytes = (await fsp.stat(outPath)).size; } catch { /* ignore */ }
      results.push({ name: f.name, ok: true, outPath, inBytes, outBytes });
      send({ index: i, total: files.length, name: f.name, pct: 100, phase: 'done', inBytes, outBytes });
    } else {
      try { await fsp.rm(outPath, { force: true }); } catch { /* ignore */ }   // never leave a half-written file
      results.push({ name: f.name, ok: false, error: res.error });
      send({ index: i, total: files.length, name: f.name, pct: 0, phase: 'error', error: res.error });
      if (compressAborted) break;
    }
  }
  // Point Finalize at where we just wrote, so "Organize" continues seamlessly.
  if (out && out !== config.finalizeSource) { config.finalizeSource = out; saveConfig(); }
  const okCount = results.filter((r) => r.ok && !r.skipped).length;
  if (!compressAborted) notify('Compression complete', `Compressed ${okCount} clip${okCount !== 1 ? 's' : ''} into your Compressed folder.`);
  return { ok: !compressAborted, cancelled: compressAborted, results, outDir: out };
});

ipcMain.handle('finalize:getSource', () => config.finalizeSource || '');

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

// Scan the (top level of the) Compressed folder and match each file to a stored
// record by exact filename, falling back to a stem match (so a container change
// during compression, e.g. .mov → .mp4, still matches).
ipcMain.handle('finalize:scan', async (_evt, sourceDir) => {
  // Accept either a plain path (legacy) or { dir, includePhotos } so the Organize screen
  // can opt into listing photos alongside (or instead of) videos.
  const opts = (sourceDir && typeof sourceDir === 'object') ? sourceDir : { dir: sourceDir };
  const dir = opts.dir || config.finalizeSource;
  if (!dir) return { ok: false, error: 'No folder chosen' };
  let files;
  try {
    files = await listVideosShallow(dir);
    if (opts.includePhotos) files = files.concat(await listImagesShallow(dir));
  } catch (err) { return { ok: false, error: err.message }; }

  const store = currentFinalMeta();
  const byName = {}; const byStem = {};
  for (const [k, v] of Object.entries(store)) {
    byName[k] = v;
    byStem[stemOf(k)] = v;
  }
  // Token set of a filename stem (drop version/ext/camera junk) for FUZZY matching —
  // recovers the saved record (incl. observation/people) even if the compressor
  // renamed the file (different separators, an added suffix, a dropped token…).
  const fileTokens = (s) => new Set(String(s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/_v\d+$/i, '')
    .split(/[\s\-_.]+/).filter((t) => t && t.length > 1 && !/^(gx|gopro|hero|dji|img|dsc|mvi|mp4|mov|avi)\w*$/i.test(t)));
  const tokenScore = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n += /^\d{4}-\d{2}-\d{2}$/.test(t) ? 3 : 1; return n; };   // a shared date counts strong
  const storeEntries = Object.entries(store).map(([k, v]) => ({ v, tokens: fileTokens(k) }));
  const out = files.map((f) => {
    const lc = f.name.toLowerCase();
    let rec = byName[lc] || byStem[stemOf(lc)] || null;
    let matchType = rec ? 'saved' : null;
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
    return { name: f.name, sourcePath: f.sourcePath, size: f.size, isPhoto: !!f.isPhoto, matched: !!rec || !!f.isPhoto, matchType: rec ? matchType : (f.isPhoto ? 'photo' : matchType), meta: rec };
  });
  return {
    ok: true, dir,
    files: out,
    total: out.length,
    matchedCount: out.filter((x) => x.matched).length
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) tags['XMP-photoshop:DateCreated'] = date;
  if (m.location) tags['XMP-iptcCore:Location'] = deh(m.location);
  if (m.context) tags['XMP-dc:Coverage'] = m.context;                  // the shoot context, kept searchable
  if (m.shotType) tags['XMP-xmp:Label'] = deh(m.shotType);
  // People / faces — written so digiKam reads them as people tags. We write THREE
  // standard things: IPTC PersonInImage (Bridge/Lightroom), a "People/<name>" branch
  // in the hierarchical subject + digiKam's own TagsList (digiKam shows these under
  // its People tag tree), and MWG region person names (digiKam face-region readers).
  if (Array.isArray(m.people) && m.people.length) {
    const ppl = uniqStrings(m.people).filter(Boolean);
    if (ppl.length) {
      tags['XMP-iptcExt:PersonInImage'] = ppl;
      tags['XMP-mwg-rs:RegionPersonDisplayName'] = ppl;
      tags['XMP-mwg-rs:RegionName'] = ppl;
      tags['XMP-mwg-rs:RegionType'] = ppl.map(() => 'Face');
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
  return tags;
}

ipcMain.handle('finalize:run', async (evt, payload) => {
  const sender = evt.sender;
  const { items, options, dir } = payload || {};
  const opts = options || {};
  const list = Array.isArray(items) ? items.filter((it) => it && it.meta) : [];
  // Per-run choices come from the payload (the Organize screen), falling back to
  // the saved config.
  const dest = payload.organizeDest || config.organizeDest || '';
  const levels = (Array.isArray(payload.folderLevels) && payload.folderLevels.length)
    ? payload.folderLevels
    : (Array.isArray(config.folderLevels) && config.folderLevels.length ? config.folderLevels : ['category', 'project']);
  const nasRoot = (opts.nas && payload.nasPath) ? payload.nasPath : '';

  if (opts.organize && !dest) {
    return { ok: false, error: 'No destination folder set. Choose one in Edit → “Organizing & folders…”.' };
  }

  const summary = { ok: true, embedded: 0, moved: 0, skipped: 0, backedUp: 0, errors: [], total: list.length, csvPath: '' };
  const undoable = [];   // {from,to} per relocated clip → enables "Undo last organize"
  const csvRows = [];
  const et = opts.embed ? getExifTool() : null;
  const emit = (index, name, phase) => sender.send('finalize:progress', { index, total: list.length, name, phase });

  for (let i = 0; i < list.length; i += 1) {
    const it = list[i];
    const meta = it.meta || {};
    let curPath = it.sourcePath;
    let finalFileName = it.name;
    const parts = subdirParts(levels, meta);
    const tags = buildEmbedTags(meta, parts, it.name);
    const keywords = Array.isArray(tags['XMP-dc:Subject']) ? tags['XMP-dc:Subject'] : [];

    // 1. Embed a RICH XMP packet (Title, Description, flat keywords→dc:subject,
    // hierarchical tags for digiKam/Lightroom, date, location, people, shot type…).
    // If the embed fails, SKIP the move/backup for this file and leave it where it
    // is, so re-running retries it cleanly (a moved-but-untagged file would drop
    // out of the next shallow scan).
    if (et) {
      emit(i, it.name, 'embedding');
      try {
        if (Object.keys(tags).length) {
          await et.write(curPath, tags, ['-overwrite_original']);
          summary.embedded += 1;
        }
      } catch (err) {
        summary.errors.push(`Embed ${it.name}: ${err.message}`);
        continue;   // leave untouched for a clean retry
      }
    }

    // 2. Organize into <dest>/<folderLevels…>/ (idempotent).
    if (opts.organize && dest) {
      emit(i, it.name, 'moving');
      try {
        const before = curPath;   // capture origin BEFORE reassigning, for undo
        const r = await organizeMove(curPath, path.join(dest, ...parts), it.name);
        if (r.action === 'moved') { summary.moved += 1; undoable.push({ from: before, to: r.path }); } else summary.skipped += 1;
        curPath = r.path;
        finalFileName = path.basename(r.path);
      } catch (err) { summary.errors.push(`Move ${it.name}: ${err.message}`); }
    }

    // 3. Mirror to the NAS (organized structure), if enabled.
    if (nasRoot) {
      emit(i, it.name, 'backup');
      try {
        const nasDir = path.join(nasRoot, ...parts);
        await ensureDir(nasDir);
        const nasTarget = path.join(nasDir, finalFileName);
        // Skip only if the NAS copy already matches by CONTENT (not just size), and
        // VERIFY after copying with one retry — same integrity guarantee as the
        // import-time NAS mirror, so a truncated/corrupt backup is never trusted.
        let need = true;
        try {
          const a = await fsp.stat(nasTarget); const b = await fsp.stat(curPath);
          if (a.size === b.size && await fingerprintsMatch(curPath, nasTarget)) need = false;
        } catch { /* not there */ }
        if (need) {
          await fsp.copyFile(curPath, nasTarget);
          if (!await fingerprintsMatch(curPath, nasTarget)) {
            await fsp.copyFile(curPath, nasTarget);   // one retry
            if (!await fingerprintsMatch(curPath, nasTarget)) throw new Error('NAS verify failed after copy');
          }
          summary.backedUp += 1;
        }
      } catch (err) { summary.errors.push(`Backup ${it.name}: ${err.message}`); }
    }

    // 4. Resolve CSV row.
    if (opts.csv) {
      // Scene = the deepest configured folder level's value (a useful grouping in
      // Resolve), falling back to the legacy 'project' field.
      const sceneLevel = levels[levels.length - 1];
      const scene = (sceneLevel ? metaLevelValue(sceneLevel, meta) : '') || meta.project || '';
      csvRows.push({
        file: finalFileName,
        description: meta.description || '',
        keywords: keywords.join(', '),
        scene
      });
    }
  }

  // Write the Resolve metadata CSV next to the organized folder (or the scan
  // folder when not organizing). Columns Resolve's Import Metadata maps directly.
  if (opts.csv && csvRows.length) {
    try {
      const csvDir = (opts.organize && dest) ? dest : (dir || config.finalizeSource || dest);
      const csvPath = path.join(csvDir, 'resolve-metadata.csv');
      const lines = [['File Name', 'Description', 'Keywords', 'Scene'].map(csvCell).join(',')];
      for (const r of csvRows) lines.push([r.file, r.description, r.keywords, r.scene].map(csvCell).join(','));
      await fsp.writeFile(csvPath, lines.join('\r\n'), 'utf8');
      summary.csvPath = csvPath;
    } catch (err) { summary.errors.push(`CSV: ${err.message}`); }
  }

  // Record this run's relocations so "Undo last organize" can move them back.
  if (undoable.length) { config.lastOrganize = { ts: Date.now(), moves: undoable }; saveConfig(); }

  return summary;
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
ipcMain.handle('rename:apply', async (_evt, payload) => {
  const { destPath, newName } = payload;
  try {
    const dir = path.dirname(destPath);
    const ext = path.extname(destPath);
    // Sanitize the user-supplied name; keep their extension if they typed one.
    let cleaned = String(newName || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (!cleaned) return { ok: false, error: 'Name cannot be empty' };
    if (path.extname(cleaned).toLowerCase() !== ext.toLowerCase()) {
      cleaned += ext;
    }
    const target = await uniqueDest(dir, cleaned);
    await fsp.rename(destPath, target);
    return { ok: true, destPath: target, name: path.basename(target) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Delete selected files from the SOURCE drive (sends to recycle bin via shell).
// Fast integrity fingerprint: size + SHA-256 of three 2 MB samples (head, middle,
// tail). Catches truncation and the common corruption modes without reading a whole
// 50 GB card. (Not a full-file hash — a deliberate speed/safety trade-off.)
async function sampledFingerprint(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const size = st.size;
    const CHUNK = 2 * 1024 * 1024;
    const hash = crypto.createHash('sha256');
    hash.update(`sz:${size}`);
    const readAt = async (pos, len) => {
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, Math.max(0, pos));
      hash.update(buf.subarray(0, bytesRead));
    };
    if (size <= CHUNK * 3) { await readAt(0, size); }
    else { await readAt(0, CHUNK); await readAt(Math.floor(size / 2) - CHUNK / 2, CHUNK); await readAt(size - CHUNK, CHUNK); }
    return { size, hash: hash.digest('hex') };
  } finally { await fh.close(); }
}
// True when two files have the same size + sampled fingerprint (used for NAS
// resume-dedup and post-copy verification). Best-effort: false on any read error.
async function fingerprintsMatch(a, b) {
  try { const [x, y] = await Promise.all([sampledFingerprint(a), sampledFingerprint(b)]); return x.size === y.size && x.hash === y.hash; }
  catch { return false; }
}
// Verify each copied file against its source BEFORE the originals are deleted.
ipcMain.handle('verify:copies', async (_evt, pairs) => {
  const out = [];
  for (const p of (Array.isArray(pairs) ? pairs : [])) {
    const src = p && p.source; const dst = p && p.dest;
    let ok = false; let reason = '';
    try {
      if (!dst) { reason = 'no copy on record'; }
      else {
        let ss = null; let ds = null;
        try { ss = await fsp.stat(src); } catch { reason = 'source missing'; }
        try { ds = await fsp.stat(dst); } catch { reason = reason || 'copy missing'; }
        if (ss && ds) {
          if (ss.size !== ds.size) { reason = `size mismatch (${ss.size} vs ${ds.size})`; }
          else {
            const [fa, fb] = await Promise.all([sampledFingerprint(src), sampledFingerprint(dst)]);
            if (fa.hash === fb.hash) ok = true; else reason = 'content mismatch';
          }
        }
      }
    } catch (e) { reason = e.message || String(e); }
    out.push({ source: src, dest: dst, ok, reason });
  }
  return out;
});

// Free space on the volume that contains `folderPath` (walks up to the nearest
// existing ancestor so it works even before the folder is created).
ipcMain.handle('disk:freeSpace', async (_evt, folderPath) => {
  try {
    let probe = String(folderPath || '');
    if (!probe) return { ok: false, error: 'no path' };
    for (let i = 0; i < 8; i += 1) {
      try { await fsp.access(probe); break; } catch { const up = path.dirname(probe); if (!up || up === probe) break; probe = up; }
    }
    const st = await fsp.statfs(probe);
    return { ok: true, free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize), path: probe };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
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

ipcMain.handle('delete:source', async (_evt, sourcePaths) => {
  const results = [];
  for (const p of sourcePaths) {
    let ok = false; let method = ''; let error = '';
    // Prefer the Recycle Bin (recoverable), but USB/SD cards (exFAT/removable)
    // usually have no Recycle Bin — there, permanently delete (the intent when
    // clearing a card after copying).
    try { await shell.trashItem(p); ok = true; method = 'recycle'; }
    catch (e1) {
      try { await fsp.rm(p, { force: true }); ok = true; method = 'deleted'; }
      catch (e2) { error = e2.message || e1.message; }
    }
    results.push({ path: p, ok, method, error });
  }
  return results;
});

ipcMain.handle('open:folder', async (_evt, folder) => {
  try {
    await shell.openPath(folder || config.intakeFolder);
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
    // Keep the OS login-item entry in sync with config on every start.
    applyLoginItem(config.launchAtLogin);
    console.log(`[startup] launchAtLogin = ${config.launchAtLogin}`);

    ingestMemoryInbox();   // fold any externally-dropped learnings into AI memory
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
