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
    const timer = setTimeout(() => { treeKill(ps); resolve({ ok: false, error: 'timeout', stdout: out, stderr: err }); }, timeoutMs);
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
$rx = '${MEDIA_EXT_RX_SRC}'
$vrx = '${VIDEO_EXT_RX_SRC}'
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
# Assign first, THEN wrap with @(): @(pipeline | ConvertFrom-Json) collapses a JSON
# array into ONE element, so $albums[0] would be the whole array and match no folder.
if ($env:MTP_ALBUMS) { try { $parsed = ($env:MTP_ALBUMS | ConvertFrom-Json); $albums = @($parsed) } catch { $albums = @() } }
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
  // Prefer ADB when it's on + an authorized device is present: MTP often goes blind
  // to Windows once USB-debugging is enabled, so the PowerShell scan finds nothing.
  const serial = await adbReadyDevice().catch(() => null);
  if (serial) {
    try { const a = await adbScanMedia(serial, albums); if (a.ok) return { ok: true, media: a.media }; }
    catch (e) { console.error('[adb] scan failed, falling back to MTP:', e.message); }
  }
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
  const serial = await adbReadyDevice().catch(() => null);
  if (serial) {
    try { const a = await adbListAlbums(serial); if (a.ok && a.albums.length) return a; }
    catch (e) { console.error('[adb] album list failed, falling back to MTP:', e.message); }
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

// "Pick up from anywhere": which photos are ALREADY pulled to Photos Temp (by filename),
// so a re-scan can recognize them instead of re-offering them. Just a directory listing
// (no per-file stat) so it's fast even over the NAS. Returns lowercased filenames.
ipcMain.handle('phone:pulledNames', async () => {
  const dir = config.photosTempFolder;
  if (!dir) return [];
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isFile()).map((e) => e.name.toLowerCase());
  } catch { return []; }
});

// GoPro-style pull: copy ONLY the PHOTOS off the phone (into "04 - Photos Temp") —
// videos STAY on the device and are only copied to the Uncompressed intake later, at
// the copy step. Returns staged clips: photos with a local sourcePath; videos as
// references (sim videos already have a local path, real-phone videos are deferred).
// Set by copy:cancel — checked in the phone pull/copy loops so Cancel actually stops the
// (long) video transfer instead of hanging.
let phoneAbort = false;
ipcMain.handle('phone:pull', async (evt, payload) => {
  const { device, items, photoDest, videoDest, sim } = payload || {};
  if (!device || !Array.isArray(items) || !items.length) return { ok: false, error: 'Nothing selected' };
  phoneAbort = false;
  const photos = items.filter((it) => it.kind !== 'video');
  const videos = items.filter((it) => it.kind === 'video');
  const vDest = videoDest || photoDest;
  try { await ensureDir(photoDest); } catch { /* ignore */ }
  try { await ensureDir(vDest); } catch { /* ignore */ }
  const sender = evt.sender;
  const staged = [];
  const total = items.length; let done = 0;
  const prog = (name) => { done += 1; try { sender.send('phone:copy-progress', { done, total, name }); } catch { /* ignore */ } };

  // Pull a set of items off the phone into ONE local dest, then stage each with its LOCAL
  // path (so batching, thumbnails, and AI all work on real files). Photos → Photos Temp,
  // videos → _Phone Video Temp — BOTH up-front, so nothing stays stranded on the phone.
  const pullInto = async (list, dest, kind) => {
    if (!list.length) return;
    if (sim) {
      for (const it of list) {
        if (phoneAbort) break;
        const dst = path.join(dest, it.name);
        try {
          let st = null; try { st = await fsp.stat(dst); } catch { /* not there yet */ }
          if (!st || st.size !== it.size) { await fsp.copyFile(it.abs, dst); st = await fsp.stat(dst); }  // resume
          staged.push({ sourcePath: dst, name: it.name, ext: path.extname(it.name), size: st.size, mtimeMs: st.mtimeMs, kind });
        } catch { /* skip */ }
        prog(it.name);
      }
    } else {
      await mtpCopyToDest(device, list, dest, (name) => prog(name));   // ADB-first; checks phoneAbort
      for (const it of list) {
        const p = path.join(dest, it.name);
        try { const st = await fsp.stat(p); staged.push({ sourcePath: p, name: it.name, ext: path.extname(it.name), size: st.size, mtimeMs: st.mtimeMs, kind }); } catch { /* couldn't verify — skip */ }
      }
    }
  };

  await pullInto(photos, photoDest, 'photo');
  if (!phoneAbort) await pullInto(videos, vDest, 'video');
  return { ok: true, copied: staged.length, total, staged, cancelled: phoneAbort };
});

// MTP-copy a list of items (same rel-folder navigation) to ONE local dest, streaming
// progress. Used for pulling real-phone photos now, and videos at the copy step.
// ---------------------------------------------------------------------------
// ADB fast transfer (Android) — `adb pull` is dramatically faster + more reliable
// than Windows MTP CopyHere for bulk camera-roll transfers. Opt-in (config.useAdb);
// auto-fetches platform-tools to userData so there's no manual install. Falls back
// to MTP automatically if ADB isn't set up or no authorized device is connected.
// ---------------------------------------------------------------------------
let _adbPath = null;
function probeAdb(p) {
  if (!p) return false;
  try { return require('node:child_process').spawnSync(p, ['version'], { windowsHide: true, timeout: 8000 }).status === 0; } catch { return false; }
}
async function ensureAdb(allowDownload = false) {
  if (_adbPath && probeAdb(_adbPath)) return _adbPath;
  const ud = app.getPath('userData');
  const cands = [config.adbPath, path.join(ud, 'platform-tools', 'adb.exe'), 'adb',
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe')].filter(Boolean);
  for (const c of cands) { if (probeAdb(c)) { _adbPath = c; return c; } }
  if (!allowDownload) return null;
  try {   // one-time: download Google's official platform-tools and unzip it
    const zip = path.join(ud, 'platform-tools.zip');
    const res = await fetch('https://dl.google.com/android/repository/platform-tools-latest-windows.zip');
    if (!res.ok) throw new Error('http ' + res.status);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    await new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${ud}'`], { windowsHide: true });
      ps.on('close', (c) => (c === 0 ? resolve() : reject(new Error('unzip ' + c)))); ps.on('error', reject);
    });
    try { fs.rmSync(zip, { force: true }); } catch { /* ignore */ }
    const adb = path.join(ud, 'platform-tools', 'adb.exe');
    if (probeAdb(adb)) { _adbPath = adb; return adb; }
  } catch (e) { console.error('[adb] setup failed:', e.message); }
  return null;
}
function runAdb(args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    if (!_adbPath) { resolve({ code: -1, out: '', err: 'no adb' }); return; }
    const ps = spawn(_adbPath, args, { windowsHide: true });
    let out = ''; let err = '';
    const t = setTimeout(() => { treeKill(ps); }, timeoutMs);
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    ps.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
function adbParseDevices(out) {
  let device = null; let unauthorized = false;
  for (const l of String(out || '').split(/\r?\n/).slice(1)) {
    let m; if ((m = l.match(/^(\S+)\t+device\b/))) device = m[1]; else if (/\bunauthorized\b/.test(l)) unauthorized = true;
  }
  return { device, unauthorized };
}
async function adbReadyDevice() {
  if (!config.useAdb) return null;
  if (!await ensureAdb(false)) return null;
  return adbParseDevices((await runAdb(['devices'], { timeoutMs: 10000 })).out).device;
}
// Map an MTP-scan rel ("Internal storage/DCIM/Camera") to the on-device path
// (/sdcard/DCIM/Camera) — internal storage is /sdcard on Android.
function adbRemotePath(rel, name) {
  const parts = String(rel || '').split('/').filter(Boolean).slice(1);   // drop the storage label
  return '/sdcard/' + [...parts, name].join('/');
}
// Media extensions we care about, as a toybox-`find` predicate group. Video portion is
// single-sourced from VIDEO_EXT_LIST (main-mod/01-core.js) so it can't drift from VIDEO_EXTS.
const ADB_MEDIA_EXTS = [...IMAGE_EXT_LIST, ...VIDEO_EXT_LIST];   // single-sourced (01-core)
const ADB_VIDEO_RX = new RegExp(VIDEO_EXT_RX_SRC, 'i');
function adbInamePredicate() {
  return '\\( ' + ADB_MEDIA_EXTS.map((e) => `-iname '*.${e}'`).join(' -o ') + ' \\)';
}
// Roots we scan on the device. DCIM is the camera roll; Pictures/Movies/Download catch
// screenshots, saved clips, WhatsApp, etc. Missing roots are silently skipped (2>/dev/null).
const ADB_SCAN_ROOTS = ['/sdcard/DCIM', '/sdcard/Pictures', '/sdcard/Movies', '/sdcard/Download'];
// Turn an on-device path (/sdcard/DCIM/Camera/x.jpg) back into an MTP-style rel
// ("Internal storage/DCIM/Camera") so the rest of the pipeline + adbRemotePath agree.
function adbPathToRel(devPath) {
  const name = devPath.split('/').pop();
  const dir = devPath.slice(0, devPath.length - name.length - 1);
  return { name, rel: 'Internal storage' + dir.replace(/^\/sdcard/, '') };
}
// The "album" label for a device path = the first folder under one of our roots
// (e.g. /sdcard/DCIM/Camera/x.jpg → "Camera"); files directly in a root use the root name.
function adbAlbumOf(devPath) {
  for (const root of ADB_SCAN_ROOTS) {
    if (devPath.startsWith(root + '/')) {
      const rest = devPath.slice(root.length + 1);
      const rootLabel = root.split('/').pop();
      return rest.includes('/') ? rest.split('/')[0] : rootLabel;
    }
  }
  return 'Phone';
}
// ADB-based media scan — one `find` over the media roots, with sizes via `stat`. Returns
// the same shape as the MTP scan ({ name, rel, size, kind }). Used for BOTH the scan and
// (grouped) the album chips, because when USB-debugging/ADB is on the phone often stops
// exposing MTP to Windows, so the PowerShell scan sees nothing.
let _adbScanCache = null;   // { serial, at, media } — the chooser lists albums then scans; don't `find` twice.
async function adbScanAll(serial) {
  if (_adbScanCache && _adbScanCache.serial === serial && (Date.now() - _adbScanCache.at) < 15000) {
    return { ok: true, media: _adbScanCache.media };
  }
  const roots = ADB_SCAN_ROOTS.map((r) => `'${r}'`).join(' ');
  const cmd = `find ${roots} -type f ${adbInamePredicate()} -exec stat -c '%s|%n' {} + 2>/dev/null`;
  const r = await runAdb(['-s', serial, 'shell', cmd], { timeoutMs: 120000 });
  const out = r.out || '';
  if (!out.trim()) return { ok: r.code === 0, media: [] };
  const media = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^(\d+)\|(\/.+)$/);
    if (!m) continue;
    const size = Number(m[1]);
    const p = m[2].trim();
    // Skip hidden folders/files (.thumbnails cache, .gs*, etc.) — not real camera media.
    if (p.split('/').some((seg) => seg.startsWith('.'))) continue;
    const { name, rel } = adbPathToRel(p);
    if (!name) continue;
    media.push({ name, rel, size, kind: ADB_VIDEO_RX.test(name) ? 'video' : 'photo', _album: adbAlbumOf(p) });
  }
  _adbScanCache = { serial, at: Date.now(), media };
  return { ok: true, media };
}
async function adbListAlbums(serial) {
  const scan = await adbScanAll(serial);
  if (!scan.ok) return { ok: false, albums: [] };
  const counts = new Map();
  for (const it of scan.media) counts.set(it._album, (counts.get(it._album) || 0) + 1);
  const albums = [...counts.entries()].map(([album, count]) => ({ album, count }))
    .sort((a, b) => b.count - a.count);
  return { ok: true, albums };
}
async function adbScanMedia(serial, albums) {
  const scan = await adbScanAll(serial);
  if (!scan.ok) return { ok: false, media: [] };
  const want = Array.isArray(albums) && albums.length ? new Set(albums) : null;
  const media = scan.media.filter((it) => !want || want.has(it._album))
    .map(({ _album, ...rest }) => rest);   // drop the internal album tag
  return { ok: true, media };
}
async function adbPullToDest(serial, items, dest, onName) {
  try { await ensureDir(dest); } catch { /* ignore */ }
  const results = [];
  for (const it of items) {
    if (phoneAbort) break;   // Cancel pressed — stop pulling
    const destFile = path.join(dest, it.name);
    let status = 'FAIL';
    try {
      let have = null; try { have = fs.statSync(destFile); } catch { /* not there */ }
      if (have && it.size && have.size === Number(it.size)) status = 'SKIP';   // resume
      else {
        const r = await runAdb(['-s', serial, 'pull', '-a', adbRemotePath(it.rel, it.name), destFile]);
        let ok = false; try { ok = fs.statSync(destFile).size > 0; } catch { /* */ }
        status = (r.code === 0 && ok) ? 'OK' : 'FAIL';
      }
    } catch { status = 'FAIL'; }
    results.push({ status, name: it.name });
    if (onName) { try { onName(it.name); } catch { /* ignore */ } }
  }
  return { ok: true, results };
}
ipcMain.handle('adb:status', async () => {
  const adb = await ensureAdb(false);
  if (!adb) return { ok: false, installed: false, useAdb: !!config.useAdb };
  const d = adbParseDevices((await runAdb(['devices'], { timeoutMs: 10000 })).out);
  return { ok: true, installed: true, device: d.device, unauthorized: d.unauthorized, useAdb: !!config.useAdb };
});
ipcMain.handle('adb:enable', async () => {
  const adb = await ensureAdb(true);   // download if missing
  if (!adb) return { ok: false, error: 'Could not download/find ADB (check your internet).' };
  const d = adbParseDevices((await runAdb(['devices'], { timeoutMs: 12000 })).out);
  config.useAdb = true; saveConfig();
  return { ok: true, device: d.device, unauthorized: d.unauthorized };
});
ipcMain.handle('adb:disable', () => { config.useAdb = false; saveConfig(); return { ok: true }; });

// Transfer dispatcher: use the fast ADB path when enabled + an authorized device is
// present, otherwise the original MTP copy. ADB failure falls back to MTP per call.
async function mtpCopyToDest(device, items, dest, onName) {
  const serial = await adbReadyDevice().catch(() => null);
  if (serial) {
    try { const r = await adbPullToDest(serial, items, dest, onName); if (r && r.ok) return r; }
    catch (e) { console.error('[adb] pull failed, falling back to MTP:', e.message); }
  }
  return mtpCopyViaMtp(device, items, dest, onName);
}

function mtpCopyViaMtp(device, items, dest, onName) {
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
    const results = [];   // [{ name, status: OK|SKIP|FAIL }]
    // The PS script emits a PROGRESS line after every file (each file's own copy wait is
    // bounded to ~300s), so >8 min of TOTAL silence means PowerShell is wedged inside a COM
    // call on a disconnected phone — the idle watchdog kills it instead of leaking an orphan
    // that never resolves. A genuinely slow-but-progressing transfer keeps resetting the timer.
    streamSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { MTP_DEVICE: device, MTP_DEST: dest, MTP_LIST: listFile },   // merged into process.env by streamSpawn
      idleMs: 8 * 60 * 1000,
      timeoutMs: 3 * 60 * 60 * 1000,   // absolute ceiling — a child that dribbles stderr forever still can't run past 3h

      onLine: (raw) => {
        const line = raw.trim();
        const p = line.match(/^PROGRESS \d+ (.*)$/); if (p && onName) { onName(p[1]); return; }
        const r = line.match(/^RESULT (OK|SKIP|FAIL) (.*)$/); if (r) results.push({ status: r[1], name: r[2] });
      },
    }).then((res) => {
      try { fs.rmSync(listFile, { force: true }); } catch { /* ignore */ }
      // ok=false only when we couldn't spawn (-1) or killed it for hanging; a normal exit
      // (even non-zero) is ok — the per-file RESULT lines carry the real success/fail.
      resolve({ ok: res.code !== -1 && !res.timedOut, results, timedOut: res.timedOut });
    });
  });
}

// Copy phone VIDEOS to the Uncompressed intake at the copy step (renamed). Sim
// videos are a local copy; real-phone videos are pulled off MTP now (kept on device
// until this moment). `jobs` = [{phoneRef, dest}] where dest is the final file path.
ipcMain.handle('phone:copyVideos', async (evt, payload) => {
  const { jobs } = payload || {};
  if (!Array.isArray(jobs) || !jobs.length) return { ok: true, copied: 0 };
  phoneAbort = false;
  const sender = evt.sender;
  let done = 0; let failed = 0; const total = jobs.length;
  const okDests = [];   // dests that actually ended up in place (so the renderer only repoints those)
  const prog = (name) => { try { sender.send('phone:copy-progress', { done: done + failed, total, name }); } catch { /* ignore */ } };
  const realByDevice = new Map();
  // Videos were already pulled off the phone into _Phone Video Temp during the pull step,
  // so this is just a MOVE into the Uncompressed intake — same drive = instant rename.
  for (const j of jobs) {
    if (phoneAbort) break;
    try {
      let already = null; try { already = await fsp.stat(j.dest); } catch { /* not there */ }
      if (already && Number(j.size) && already.size === Number(j.size)) { done += 1; okDests.push(j.dest); prog(path.basename(j.dest)); continue; }   // resume
      const src = j.src || (j.phoneRef && j.phoneRef.abs) || '';
      let hasSrc = false; try { hasSrc = !!(src && (await fsp.stat(src)).size > 0); } catch { /* not local */ }
      if (hasSrc) {
        await ensureDir(path.dirname(j.dest));
        // verify-before-destroy move: on a cross-drive copy it fingerprints the copy
        // before deleting the source, so a truncated copy can't lose the only good file.
        try { await moveFileCrossDevice(src, j.dest); done += 1; okDests.push(j.dest); }
        catch { failed += 1; }
        prog(path.basename(j.dest));
      } else if (j.phoneRef && !j.phoneRef.sim && j.phoneRef.device && j.phoneRef.rel) {
        // Legacy safety: a video that's still only on the phone — pull it now.
        if (!realByDevice.has(j.phoneRef.device)) realByDevice.set(j.phoneRef.device, []);
        realByDevice.get(j.phoneRef.device).push(j);
      } else { failed += 1; prog(path.basename(j.dest)); }
    } catch { failed += 1; }
  }
  for (const [device, list] of realByDevice) {
    if (phoneAbort) break;
    const tmp = path.join(app.getPath('temp'), `phonevid_${Date.now()}`);
    try { await ensureDir(tmp); } catch { /* ignore */ }
    const mtp = await mtpCopyToDest(device, list.map((j) => j.phoneRef), tmp, (name) => prog(name));
    const failSet = new Set((mtp.results || []).filter((r) => r.status === 'FAIL').map((r) => r.name));
    for (const j of list) {
      if (failSet.has(j.phoneRef.name)) { failed += 1; continue; }
      const src = path.join(tmp, j.phoneRef.name);
      try { await ensureDir(path.dirname(j.dest)); await moveFileCrossDevice(src, j.dest); done += 1; okDests.push(j.dest); }
      catch { failed += 1; }   // verify-before-destroy (never deletes an unverified source)
    }
  }
  return { ok: true, copied: done, failed, total, okDests, cancelled: phoneAbort };
});

// Flat-copy files (renamed photos from Photos Temp) to the chosen back-up
// destinations (computer and/or NAS). jobs = [{src, dest}]; streams progress.
ipcMain.handle('phone:distribute', async (evt, payload) => {
  const { jobs } = payload || {};
  if (!Array.isArray(jobs) || !jobs.length) return { ok: true, copied: 0 };
  const sender = evt.sender; let done = 0; const total = jobs.length; const errors = [];
  for (const j of jobs) {
    try {
      // Verified copy: fingerprint-checks the result before trusting it (a truncated
      // network copy of the right byte-count is no longer silently accepted as done).
      await copyFileVerified(j.src, j.dest);
      done += 1;
    } catch (e) { errors.push((e && e.message) || String(e)); }
    try { sender.send('phone:copy-progress', { done, total, name: path.basename(j.dest) }); } catch { /* ignore */ }
  }
  // ok reflects reality — false when any file failed (was unconditionally true, so a
  // partial backup with dropped photos reported success).
  return { ok: errors.length === 0, copied: done, total, failed: errors.length, errors, error: errors[0] || '' };
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
    rs.on('error', (e) => { try { ws.destroy(); } catch { /* ignore */ } reject(token && token.aborted ? new Error('aborted') : e); });
    ws.on('error', (e) => { try { rs.destroy(); } catch { /* ignore */ } reject(token && token.aborted ? new Error('aborted') : e); });
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

