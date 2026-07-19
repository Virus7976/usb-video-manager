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
// publish feed in package.json (build.publish): the **github** provider, pointed
// at Virus7976/usb-video-manager, which `npm run release` keeps current. (This
// comment used to say "generic feed … fixed 'latest' Gitea release" — that was
// never true of the shipped config. Code lives on Gitea; the ~130MB installer and
// the update feed live on GitHub because Gitea 413s over its 100MB asset cap.)
// No-op in
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

// What changed, readable inside the app — the owner asked to see what's being done to his tool
// without reading a repo. CHANGELOG.md is already written in his language ("your footage"), so it is
// the source rather than a second list that would drift. Shipped in build.files; read from
// __dirname so it resolves the same packed in app.asar as it does in dev.
//
// Returns RAW markdown and lets the renderer format it: the renderer already owns escaping (it runs
// webSecurity:false, so nothing untrusted may reach innerHTML unescaped), and doing it here would
// hand it pre-built HTML — exactly the shape that guard exists to prevent.
ipcMain.handle('changelog:get', async () => {
  try {
    const text = await fsp.readFile(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    return { ok: true, text, version: (() => { try { return app.getVersion(); } catch { return ''; } })() };
  } catch (err) {
    // A missing changelog is a packaging mistake, not a crash — say so plainly in the dialog.
    return { ok: false, error: err.message || String(err) };
  }
});
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

// A FOLDER NAME IS NOT A SLUG. His projects are real folders with real names:
//
//   C:\Users\jakeg\Videos\02 - Projects\2026\2026 - Client Work\Gourgess Lawns
//
// slugFolder() would turn that into `2026-client-work/gourgess-lawns` — a BRAND NEW folder, created
// right next to the real one, holding the new footage while all his actual edits sit in the other.
// It silently FORKS his project tree, and every subsequent run makes the split worse. Filing a clip
// into a folder that merely resembles the one he picked is not organizing.
//
// So: keep the name he (or the AI, choosing from his real tree) actually chose. Sanitize only what
// Windows genuinely forbids — never case, never spaces.
function safeFolderName(s) {
  let out = String(s || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')   // illegal on NTFS
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');                        // Windows cannot end a name with a dot or space
  if (!out) return '';
  // `!!!` is a perfectly legal Windows folder name and a completely useless project name. If there is
  // not one letter or digit in it, it is punctuation, not a name — refuse rather than create it.
  // (\p{L}/\p{N}, not [a-z0-9]: a name in any script is still a name.)
  if (!/[\p{L}\p{N}]/u.test(out)) return '';
  if (WIN_RESERVED_NAMES.has(out.toLowerCase())) out = `${out}-folder`;
  return out;
}

// Reuse the folder that is ALREADY THERE, whatever case it is in.
//
// The AI answers with `2026 - Client Work`; he might type `2026 - client work`; the folder on disk is
// `2026 - Client Work`. On Windows those are all one folder — but path.join() would happily create a
// second one on a case-sensitive volume or a network share, and the name shown in his file browser
// would be whichever we wrote first. Ask the disk what the folder is really called.
async function resolveFolderPath(root, parts) {
  let cur = root;
  for (const raw of (parts || [])) {
    const want = safeFolderName(raw);
    if (!want) continue;
    let actual = want;
    try {
      const entries = await fsp.readdir(cur, { withFileTypes: true });
      const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === want.toLowerCase());
      if (hit) actual = hit.name;                  // his spelling wins over ours, always
    } catch { /* the folder does not exist yet — we are about to create it */ }
    cur = path.join(cur, actual);
  }
  return cur;
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
  // safeFolderName, not slugFolder: `meta.category` is a phrase HE typed ("Client Work"), and a
  // folder called `client-work` is a different folder from the one he already has.
  return (levels || []).map((lvl) => safeFolderName(metaLevelValue(lvl, meta))).filter(Boolean);
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
// Extract just the FIRST field of a CSV line (RFC-4180 aware) — used to MERGE the Resolve CSV by
// File Name across runs instead of overwriting it, so the batch-by-batch workflow doesn't clobber
// earlier rows.
function csvFirstField(line) {
  if (line[0] === '"') {
    let s = '';
    for (let i = 1; i < line.length; i += 1) {
      const c = line[i];
      if (c === '"') { if (line[i + 1] === '"') { s += '"'; i += 1; } else return s; }
      else s += c;
    }
    return s;
  }
  const comma = line.indexOf(',');
  return comma === -1 ? line : line.slice(0, comma);
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
// Make a just-renamed file's DIRECTORY ENTRY durable (audit #19).
//
// flushToDisk above makes the file's BYTES durable, but the entry that names them lives in the
// parent directory and is its own write. After `rename(tmp, dest)` that entry can still be sitting
// in the OS cache: a power loss then loses the file entirely, even though its contents reached the
// platter — and moveFileCrossDevice DELETES the source immediately after, so that is the only copy.
//
// writeJsonAtomic (main-mod/01-core.js) has done this for the JSON stores since the store work; the
// FOOTAGE path never got the same guarantee. Same primitive, same reasoning, now on the path where
// losing the write is unrecoverable.
//
// Best-effort BY DESIGN: Windows cannot fsync a directory handle through Node, so this is a no-op
// there and must never be the reason a copy fails. (That means the window it closes is real on
// NAS/ext4/APFS and documented-but-open on Windows — see AGENTS.md.)
async function flushDirEntry(dirPath) {
  if (!dirPath) return;
  try { const dh = await fsp.open(dirPath, 'r'); try { await dh.sync(); } finally { await dh.close(); } }
  catch { /* unsupported (Windows) or gone — never fail a copy over this */ }
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
    // The bytes are durable; make the NAME durable too, before anything trusts this copy enough to
    // delete the source (audit #19). After the rename, so we record a directory that HAS the file.
    await flushDirEntry(path.dirname(dest));
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* best-effort cleanup of the temp copy */ }
    throw err;   // never leave a half-written clip behind under the real name
  }
}

async function moveFileCrossDevice(src, dest) {
  // Same-device fast path: rename IS the move, so the new directory entry is the only record that
  // the footage exists under this name. Make it durable before returning (audit #19) — the
  // cross-device path below gets the same treatment inside stageVerifiedCopy.
  try { await fsp.rename(src, dest); await flushDirEntry(path.dirname(dest)); return; }
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
    // dest exists but DIFFERS → a prior copy of this file was truncated/corrupt; REPAIR it (the atomic
    // copy below overwrites via rename). NOTE: content alone can't tell "corrupt copy of THIS file"
    // from "good copy of a DIFFERENT clip that collided on basename". Repair is the intended default —
    // the real fix for cross-clip name collisions is unique final names (see the clipKey backlog item),
    // not clobber-avoidance here (which would strand the truncated file forever).
  } catch { /* not there yet → copy it */ }
  // ATOMIC staged copy: stageVerifiedCopy writes a .part temp → flush → FULL verify → rename into
  // place, and unlinks the temp on any failure. So a crash/power-loss mid-copy never leaves a
  // truncated file wearing the real name in the NAS/archive/backup (the old direct-to-dest write did).
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try { await stageVerifiedCopy(src, dest); return 'copied'; }
    catch (err) { lastErr = err; }
  }
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
    // FULL hash: this decides whether to skip filing a clip into his C: project archive, so a sampled
    // head/mid/tail match on two equal-size-but-different clips must not be trusted as "already there"
    // (which would leave the real clip unfiled). Same rule as the delete gate.
    if (await fingerprintsMatch(srcPath, targetPath, { full: true })) return { action: 'skip-dup', path: targetPath };
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
  // COPY vs MOVE. The map's "Apply" used to ALWAYS move — silently deleting the L: archive source and
  // leaving the C: project tree as the only copy, violating the app's "organize COPIES, never moves"
  // rule and its most protective invariant. Copy is now the default; only an explicit `copy:false`
  // (the user unchecked "Keep the originals") moves. A missing flag defaults to the SAFE side (copy).
  const copy = payload && payload.copy !== undefined ? !!payload.copy : true;
  // The Projects root, so each folder can be resolved against the DISK (case-correct) rather than
  // filed at a verbatim joined path. Without this the map forked the tree on any case/spelling drift.
  const projRoot = (payload && payload.root) ? String(payload.root).replace(/[\\/]+$/, '') : '';
  // NEVER MOVE FOOTAGE OFF A CARD. The twin path (finalize:run, main-mod/09-ipc-boot.js) refuses
  // this outright; projects:move — which the destination map's "Apply — file clips" calls — had no
  // removability test at all, so unticking "Keep the originals" while Compressed pointed at a card
  // would strip the clips off it. Card deletes are only ever allowed through the Delete step, after
  // the copies are hash-verified; this is the one other door that could take footage off a card, and
  // it was unlocked.
  //
  // A COPY takes nothing off the card, so it is not part of this — the twin draws the same line, and
  // copy is the default. Asked ONCE PER DISTINCT SOURCE FOLDER: isOnRemovableVolume shells out to
  // PowerShell, so asking per clip would add a process spawn to every file in a 200-clip batch.
  // Failing closed is deliberate — isOnRemovableVolume already fails closed on an unreadable volume.
  if (!copy) {
    const srcDirs = [...new Set(moves.map((mv) => (mv && mv.from) ? path.dirname(mv.from) : '').filter(Boolean))];
    for (const d of srcDirs) {
      // eslint-disable-next-line no-await-in-loop
      if (await isOnRemovableVolume(d)) {
        return { ok: false, error: 'That folder is on a removable card or USB drive. Organizing MOVES files, so it would take them off the card — which is only ever allowed from the Delete step, after the copies are verified. Point “Compressed” at a folder on your computer first.' };
      }
    }
  }

  // WILL THIS EVEN FIT? The twin path (finalize:run, main-mod/09-ipc-boot.js) has had this preflight
  // for a while, as do copy:start and phone:pull — projects:move, which the map's "Apply — file
  // clips" actually calls, never got it. Same operation, same default (copy), same destination: the
  // Projects tree on Jake's TIGHT C: drive, fed from a much larger archive. Running out part-way
  // leaves a half-filed shoot, a truncated file in the tree, and a full system disk.
  //
  // 2 GB of headroom, matching the twin: filling a system disk to the last byte breaks the machine,
  // not just the app.
  //
  // ADVISORY, deliberately — it must never be the reason a real filing run is refused:
  //   - only when COPYING (a move within a volume consumes no new space, so refusing one would be
  //     nonsense — the twin gates on copyMode for the same reason),
  //   - we STAT THE SOURCES OURSELVES rather than trusting caller-supplied `mv.size`. That was the
  //     bug: the only caller (src/mod/07-organize-map.js) builds moves as `{from,toDir,rel,name,meta}`
  //     with no `size`, so `need` was always 0 and this entire block was unreachable — present,
  //     commented, and dead, exactly like the cardIsGone guard that sat on the non-default loop. The
  //     twin never trusted the caller either (finalize:run stats each file, 09-ipc-boot.js:578).
  //   - a file we cannot stat counts as 0 rather than blocking the run,
  //   - an unreadable volume skips the check entirely.
  if (copy) {
    // Every move in a batch can name a different folder, so check the volume each one lands on.
    const byDir = new Map();
    for (const mv of moves) {
      const d = mv && mv.toDir;
      if (!d) continue;
      let sz = Number(mv && mv.size) || 0;
      if (!sz && mv.from) {
        // eslint-disable-next-line no-await-in-loop
        try { sz = (await fsp.stat(mv.from)).size; } catch { sz = 0; }
      }
      byDir.set(d, (byDir.get(d) || 0) + sz);
    }
    for (const [dir, bytes] of byDir) {
      if (bytes <= 0) continue;
      try {
        const st = await fsp.statfs(await nearestExistingDir(dir));
        const free = Number(st.bavail) * Number(st.bsize);
        const GB = (n) => `${(n / 1e9).toFixed(1)} GB`;
        if (bytes + 2e9 > free) {
          return { ok: false, error: `Not enough room: this needs ${GB(bytes)} but only ${GB(free)} is free on that drive. File fewer shoots, or point the projects folder at a bigger disk.` };
        }
      } catch { /* if we genuinely cannot read the volume, don't block the run over it */ }
    }
  }

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
      // Resolve the destination folder against what's REALLY on disk, so a plan path like
      // "2026 - client work" files into his existing "2026 - Client Work" instead of forking a second
      // folder beside it (finalize:run always did this; the map's Apply skipped it and forked the tree).
      let toDir = mv.toDir;
      if (projRoot && typeof mv.rel === 'string' && mv.rel.trim()) {
        const parts = mv.rel.split(/[\\/]+/).map((x) => safeFolderName(x)).filter(Boolean);
        // eslint-disable-next-line no-await-in-loop
        try { toDir = await resolveFolderPath(projRoot, parts); } catch { toDir = mv.toDir; }
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await organizeMove(mv.from, toDir, mv.name || path.basename(mv.from), { copy });
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
  // Record this run's actual relocations so it can be UNDONE. Include COPIED clips too (the default
  // mode) — organize:undo removes the copy for those (see its m.copied branch); recording only 'moved'
  // meant the default copy mode had no undo at all.
  const undoable = results.filter((x) => x.ok && (x.action === 'moved' || x.action === 'copied') && x.path && x.from).map((x) => ({ from: x.from, to: x.path, copied: x.action === 'copied' }));
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
      // Undoing a COPY is not the same as undoing a MOVE. A copy left the original untouched, so
      // "undo" means REMOVE the filed copy — not move it back, which just dumped a versioned duplicate
      // beside the still-present source. Guarded: only delete the copy while the original is verifiably
      // there; if the original somehow vanished, restore the copy into its slot instead (never lose the
      // only remaining file).
      if (m.copied) {
        let origHere = false; try { await fsp.access(m.from); origHere = true; } catch { /* original gone */ }
        // eslint-disable-next-line no-await-in-loop
        if (origHere) { await fsp.unlink(m.to); } else { await ensureDir(path.dirname(m.from)); await moveFileCrossDevice(m.to, m.from); }
        undone += 1;
        continue;
      }
      await ensureDir(path.dirname(m.from));
      let target = m.from;
      try { await fsp.access(m.from); target = await uniqueDest(path.dirname(m.from), path.basename(m.from)); } catch { /* original slot is free */ }
      // eslint-disable-next-line no-await-in-loop
      await moveFileCrossDevice(m.to, target);
      undone += 1;
    } catch { failed += 1; }
  }
  // Reverse this run's PROJECT-LEDGER additions too (audit #37). Undoing the files but keeping
  // the memory left a phantom project whose dates/subjects kept matching future imports. The
  // files are already back at this point, so a ledger problem must never fail the undo.
  let ledgerReversed = 0;
  try { ledgerReversed = reverseLastLedger(lo.ts); } catch { /* memory only — never fail the undo */ }
  config.lastOrganize = null; saveConfig();
  return { ok: true, undone, failed, ledgerReversed };
});
