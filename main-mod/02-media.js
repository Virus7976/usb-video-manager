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
ipcMain.handle('app:version', () => { try { return app.getVersion(); } catch { return ''; } });
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

// Windows refuses to create a file OR folder with one of these legacy DOS device names,
// with or without an extension. A category/project genuinely named "Con" or "Aux" would
// slug to a name that mkdir can never create, and the organize step would fail with an
// opaque EINVAL. Suffix them so they stay readable and legal.
const WIN_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
// Slug a metadata value into a filesystem-safe folder name (matches the
// renderer's slug(): lowercase, runs of non-alphanumerics → single hyphen).
// Note `..` needs no special handling: the dots become a hyphen, which is then stripped.
function slugFolder(s) {
  const out = String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return WIN_RESERVED_NAMES.has(out) ? `${out}-folder` : out;
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
// Best-effort flush of a just-written file's bytes to durable storage before we verify it,
// so the post-copy fingerprint checks what's actually ON DISK, not the OS page cache. Without
// this, a copy can "verify" against cached bytes and then a power loss / NAS disconnect leaves
// the file short or empty — catastrophic for moveFileCrossDevice, which deletes the source
// right after. Silently no-ops on filesystems that don't support fsync.
async function flushToDisk(p) {
  try { const fh = await fsp.open(p, 'r+'); try { await fh.datasync(); } finally { await fh.close(); } }
  catch { /* best-effort */ }
}
// Stage → flush → FULL verify → rename. The one way footage is written in this app.
//
// Shared by the move and the copy so they can never drift: a second hand-rolled copy of the footage
// is exactly how you end up with one path that verifies and one that doesn't.
async function stageVerifiedCopy(src, dest) {
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  try {
    await fsp.copyFile(src, tmp);
    await flushToDisk(tmp);
    // FULL verify (not sampled): a move DELETES the source, and a copy is the thing he will later
    // trust instead of the source. Prove the whole file either way.
    if (!(await fingerprintsMatch(src, tmp, { full: true }))) throw new Error('verify failed after copy');
    await fsp.rename(tmp, dest);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* best-effort cleanup of the temp copy */ }
    throw err;   // never leave a half-written clip behind under the real name
  }
}

// COPY the footage to `dest`, leaving the source exactly where it is.
//
// Jake files from his L: archive into projects on C:. C: has 31 GB free; the archive is 73 GB. So the
// project folder on C: is a WORKING copy he can clear out at any time — and the archive on L: must
// still be there when he does. A move would make the C: copy the only one, on the smaller, fuller disk.
async function copyFileVerified(src, dest) {
  await stageVerifiedCopy(src, dest);
}

async function moveFileCrossDevice(src, dest) {
  try { await fsp.rename(src, dest); return; }
  catch (err) { if (err.code !== 'EXDEV') throw err; }
  await stageVerifiedCopy(src, dest);
  await fsp.unlink(src);
}

// Verified COPY — the sibling of moveFileCrossDevice (which verifies then deletes the
// source). Copy src → dest and PROVE it landed intact before trusting it: if a
// byte-identical file is already there, skip; otherwise copy → fingerprint-verify → one
// retry → throw on a final mismatch. A truncated/interrupted copy is NEVER silently
// accepted as done. fingerprintsMatch already compares size, so there's no separate
// size pre-check (a size-only or stale scan-time-size check was the bug that let the two
// hand-rolled NAS mirrors diverge and let phone backups trust a truncated copy).
// Returns 'copied' | 'skipped'. Throws on failure so callers count it as failed.
async function copyFileVerified(src, dest, { retries = 1 } = {}) {
  await ensureDir(path.dirname(dest));
  try {
    await fsp.stat(dest);
    if (await fingerprintsMatch(src, dest)) return 'skipped';   // already there, identical
  } catch { /* not there yet → copy it */ }
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fsp.copyFile(src, dest);
      await flushToDisk(dest);
      if (await fingerprintsMatch(src, dest, { full: true })) return 'copied';   // FULL verify of the fresh copy
      lastErr = new Error('verification failed after copy');
    } catch (err) { lastErr = err; }
  }
  // Every attempt failed — don't leave a known-corrupt file at dest where a future resume
  // scan might trust it. Best-effort remove, then surface the failure.
  try { await fsp.unlink(dest); } catch { /* may not exist */ }
  throw lastErr || new Error('copy failed');
}

// Move a file into targetDir, idempotently:
//  - already at the target path           → 'in-place' (skip)
//  - a byte-identical file already there   → 'skip-dup' (true duplicate / re-run, skip)
//  - a DIFFERENT file sharing the name     → version the name " (n)" and move
//  - nothing there                         → move
async function organizeMove(srcPath, targetDir, fileName, opts = {}) {
  const copy = !!opts.copy;
  const place = copy ? copyFileVerified : moveFileCrossDevice;
  const verb = copy ? 'copied' : 'moved';
  await ensureDir(targetDir);
  const targetPath = path.join(targetDir, fileName);
  if (pathsEqual(srcPath, targetPath)) {
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
    await place(srcPath, versioned);
    return { action: verb, path: versioned };
  }
  await place(srcPath, targetPath);
  return { action: verb, path: targetPath };
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
// His projects live one level deeper than the obvious guess: `~/Videos/02 - Projects/2026`, holding
// `2026 - Client Work`, `2026 - Personal`, `2026 - Social Media`. Filing into `02 - Projects` itself
// would drop every clip a level ABOVE his actual project folders — technically "organized", and
// useless. Prefer the current year when that folder really exists, and this keeps working in 2027.
function defaultProjectsRoot() {
  const base = path.join(os.homedir(), 'Videos', '02 - Projects');
  const year = String(new Date().getFullYear());
  try { if (fs.statSync(path.join(base, year)).isDirectory()) return path.join(base, year); }
  catch { /* no year folder — the base is the honest default */ }
  return base;
}
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
