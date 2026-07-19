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
// ConvertTo-Json emits a bare OBJECT (not a 1-element array) when the result has exactly
// one element, so always normalize to an array — that is what makes "exactly one phone
// attached" and "exactly one album" work. A `null` result normalizes to [] rather than
// [null], so no caller has to filter a hole out of the list.
// Brace-hunting is delegated to scanBalancedJson (01-core.js): the old indexOf('{') scan
// started mid-banner whenever a stray stdout line contained a brace, JSON.parse threw, and
// the real trailing JSON was dropped — reporting ZERO phones with no error surfaced.
function parsePsJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return [];
  const norm = (j) => (j === null || j === undefined ? [] : (Array.isArray(j) ? j : [j]));
  try { return norm(JSON.parse(s)); } catch { /* stray line in stdout — go find the JSON */ }
  const found = scanBalancedJson(s);
  return found === undefined ? [] : norm(found);
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
  // A phone connected over Wi-Fi debugging is invisible to Windows' portable-device (MTP)
  // enumeration — it exists only to `adb devices`. Surface it as a phone so it can be
  // backed up wirelessly. Its serial is "ip:port" (has a colon); USB-ADB phones already
  // appear via MTP above and have a colon-free serial, so this adds no duplicates.
  try {
    const serial = await adbReadyDevice();
    if (serial && serial.includes(':') && !phones.some((p) => p.serial === serial)) {
      let model = '';
      try { model = (await runAdb(['-s', serial, 'shell', 'getprop', 'ro.product.model'], { timeoutMs: 6000 })).out.trim(); } catch { /* getprop can fail on a flaky link */ }
      phones.push({ name: (model || 'Android phone') + ' (Wi-Fi)', kind: 'phone', adb: true, wireless: true, serial });
    }
  } catch { /* adb off, or no authorized device */ }
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

  // WILL IT FIT? A camera roll is routinely tens of GB, and this used to just start writing —
  // running to ENOSPC part-way leaves a half-pulled phone, a truncated file and a full system disk.
  // The organize and intake paths have had this check for a while; the phone pull never got it.
  //
  // Photos and videos land in DIFFERENT destinations (Photos Temp vs _Phone Video Temp), which can be
  // on different volumes — so each destination is checked against the bytes actually headed there.
  // Summing everything against one disk would be wrong in both directions.
  //
  // Same stance as the sibling preflights: 2 GB of headroom (filling a system disk breaks the
  // machine, not just the app), a missing size counts as 0, and an unreadable volume skips the check
  // rather than blocking a real pull.
  const needBy = new Map();
  for (const it of items) {
    const d = (it && it.kind === 'video') ? vDest : photoDest;
    if (d) needBy.set(d, (needBy.get(d) || 0) + (Number(it && it.size) || 0));
  }
  for (const [d, bytes] of needBy) {
    if (!bytes) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const st = await fsp.statfs(await nearestExistingDir(d));
      const free = Number(st.bavail) * Number(st.bsize);
      const GB = (n) => `${(n / 1e9).toFixed(1)} GB`;
      if (bytes + 2e9 > free) {
        return { ok: false, error: `Not enough room: this needs ${GB(bytes)} but only ${GB(free)} is free on ${d}. Pull fewer items, or point the phone folders at a bigger disk.` };
      }
    } catch { /* cannot read the volume → never block the pull over it */ }
  }

  const sender = evt.sender;
  const staged = [];
  const total = items.length; let done = 0; let incomplete = 0;
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
        try {
          const st = await fsp.stat(p);
          // Stage on COMPLETENESS, not mere existence. A file present but SHORT of its known source
          // size is a truncated pull (an MTP CopyHere timeout, a dropped connection) — staging it
          // would rename it, move it into Uncompressed, and let Tdarr compress a corrupt clip into the
          // archive. Decline it: the phone still holds the original, so a re-pull recovers it cleanly.
          // (it.size may be 0/unknown for some devices; then we can't check, so we keep the old behavior.)
          if (it.size && st.size !== it.size) {
            // DELETE the truncated file, don't just skip staging it. Left on disk under its final name,
            // resume (scanPhoneStagedDir just stats) would re-adopt it as a complete clip and Tdarr it
            // into the archive — the exact corruption this gate exists to stop. The phone still holds
            // the original, so a re-pull recovers it cleanly.
            // eslint-disable-next-line no-await-in-loop
            try { await fsp.unlink(p); } catch { /* best-effort */ }
            incomplete += 1; continue;
          }
          staged.push({ sourcePath: p, name: it.name, ext: path.extname(it.name), size: st.size, mtimeMs: st.mtimeMs, kind });
        } catch { /* couldn't verify — skip */ }
      }
    }
  };

  await pullInto(photos, photoDest, 'photo');
  if (!phoneAbort) await pullInto(videos, vDest, 'video');
  return { ok: true, copied: staged.length, total, staged, incomplete, cancelled: phoneAbort };
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
    // ADB_MDNS_OPENSCREEN=1 makes the adb server discover Wi-Fi devices (Android 11+
    // wireless debugging) via its built-in mDNS backend — no Apple Bonjour install
    // needed. Harmless for USB/`pull` calls; required for `adb mdns services`/pairing.
    const ps = spawn(_adbPath, args, { windowsHide: true, env: { ...process.env, ADB_MDNS_OPENSCREEN: '1' } });
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
  // Names already taken by an earlier item in THIS pull — see claimPullDest (audit #5).
  const claimed = new Set();
  for (const it of items) {
    if (phoneAbort) break;   // Cancel pressed — stop pulling
    // eslint-disable-next-line no-await-in-loop
    const destFile = await claimPullDest(dest, it.name, claimed);
    let status = 'FAIL';
    try {
      let have = null; try { have = fs.statSync(destFile); } catch { /* not there */ }
      if (have && it.size && have.size === Number(it.size)) status = 'SKIP';   // resume
      else {
        const r = await runAdb(['-s', serial, 'pull', '-a', adbRemotePath(it.rel, it.name), destFile]);
        // Judge on COMPLETENESS, not mere existence (audit #17). A cancelled pull, an unplugged
        // cable or a phone that sleeps mid-transfer leaves a SHORT file under its final name, and
        // `size > 0` called that a success. That is footage loss, not a wrong number: a file
        // reported OK is never retried (the per-file retry only chases stragglers, #89) and the
        // staging gate later deletes it for being short — so the clip vanishes from the pull AND
        // from the retry list while the UI says the backup finished.
        //
        // The right test already existed three lines above in the resume check
        // (`have.size === Number(it.size)`), and the MTP sibling has the same rule for the same
        // reason (see the staging gate ~line 312). This just applies it here too.
        let ok = false;
        try {
          const st = fs.statSync(destFile);
          // Some devices report no size; requiring an exact match there would refuse every pull, so
          // fall back to non-empty for that case ONLY — the same concession the MTP gate makes.
          ok = it.size ? (st.size === Number(it.size)) : (st.size > 0);
        } catch { /* nothing landed */ }
        status = (r.code === 0 && ok) ? 'OK' : 'FAIL';
        // Remove a short/failed file rather than leaving it wearing a real clip name. Left on disk
        // it can be adopted by a later resume scan (which only stats) and Tdarr'd into the archive
        // as a corrupt clip — exactly what the MTP gate deletes for. The phone still holds the
        // original, so a re-pull recovers it cleanly.
        if (status === 'FAIL') { try { fs.unlinkSync(destFile); } catch { /* best-effort */ } }
      }
    } catch { status = 'FAIL'; }
    results.push({ status, name: it.name });
    if (onName) { try { onName(it.name); } catch { /* ignore */ } }
  }
  return { ok: true, results };
}
let _lastReconnectScan = 0;   // throttle the port-scan reconnect (status is polled often)
ipcMain.handle('adb:status', async () => {
  const adb = await ensureAdb(false);
  if (!adb) return { ok: false, installed: false, useAdb: !!config.useAdb };
  let d = adbParseDevices((await runAdb(['devices'], { timeoutMs: 10000 })).out);
  // Wireless is sticky: if nothing's connected but we've paired before, try silently
  // re-connecting to the last Wi-Fi address (the phone keeps trusting this PC).
  if (!d.device && config.wirelessAddr) {
    await runAdb(['connect', config.wirelessAddr], { timeoutMs: 8000 });
    d = adbParseDevices((await runAdb(['devices'], { timeoutMs: 10000 })).out);
    // Saved port went stale (Android rotates the adb-tls-connect port). Scan for the
    // live one so we reconnect WITHOUT making the user pair again — throttled so a
    // frequent status poll doesn't scan every time.
    if (!d.device && (Date.now() - _lastReconnectScan > 20000)) {
      _lastReconnectScan = Date.now();
      const host = String(config.wirelessAddr).split(':')[0];
      if (host) {
        const scanned = await connectByScan(host);
        if (scanned.dev) { config.wirelessAddr = scanned.addr; saveConfig(); d = adbParseDevices((await runAdb(['devices'], { timeoutMs: 8000 })).out); }
      }
    }
  }
  const wireless = !!d.device && /:\d+$/.test(d.device);
  return { ok: true, installed: true, device: d.device, unauthorized: d.unauthorized, wireless, useAdb: !!config.useAdb };
});
ipcMain.handle('adb:enable', async () => {
  const adb = await ensureAdb(true);   // download if missing
  if (!adb) return { ok: false, error: 'Could not download/find ADB (check your internet).' };
  const d = adbParseDevices((await runAdb(['devices'], { timeoutMs: 12000 })).out);
  config.useAdb = true; saveConfig();
  return { ok: true, device: d.device, unauthorized: d.unauthorized };
});
ipcMain.handle('adb:disable', () => { config.useAdb = false; saveConfig(); return { ok: true }; });

// ---------------------------------------------------------------------------
// Wireless debugging (Android 11+) — pair over Wi-Fi with a QR code, exactly like
// Android Studio, so a phone never needs a cable. We mint a random pairing name +
// password and render the ADB QR (WIFI:T:ADB;S:<name>;P:<pass>;;). The phone scans
// it under Settings → Developer options → Wireless debugging → "Pair device with QR
// code", then advertises an mDNS `_adb-tls-pairing._tcp` service. We discover it with
// our OWN Node multicast-DNS querying every LAN interface (adb's built-in discovery
// binds the wrong adapter on WSL/Hyper-V/VPN boxes and hangs) — plus `adb mdns services`
// as a second source — then `adb pair` and `adb connect` the resolved address directly.
// No cable, no IP typing. A manual pairing-code path is the fallback when the network
// blocks mDNS entirely (some corporate/guest Wi-Fi isolates clients).
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _pairState = null;   // { name, pass, cancelled } for the in-flight QR pairing

function randToken(n, alphabet) {
  const bytes = crypto.randomBytes(n);
  let s = ''; for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}
// Parse `adb mdns services` — one service per line, columns are whitespace/tab
// separated: "<instance>  _adb-tls-(pairing|connect)._tcp.  <host>:<port>".
function parseMdnsServices(out) {
  const svcs = [];
  for (const l of String(out || '').split(/\r?\n/)) {
    const m = l.match(/^(.*?)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+([0-9.]+):(\d+)\s*$/);
    if (m) svcs.push({ instance: m[1].trim(), type: m[2], host: m[3], port: m[4] });
  }
  return svcs;
}
async function adbMdnsServices() {
  return parseMdnsServices((await runAdb(['mdns', 'services'], { timeoutMs: 8000 })).out);
}

// Every non-internal IPv4 interface on this machine. A dev box typically has several —
// real Wi-Fi/Ethernet PLUS virtual ones from WSL, Hyper-V, VirtualBox, VPNs. adb's own
// mDNS discovery often binds just one (often a virtual one) and never sees the phone, so
// we query them all ourselves.
function lanIPv4Interfaces() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// Discover an `_adb-tls-(pairing|connect)._tcp` service via multicast DNS, done in Node
// so we control the sockets: we open one mDNS responder per LAN interface and broadcast
// the PTR query out ALL of them, then resolve SRV+A into host:port. This is far more
// reliable on Windows dev machines than `adb mdns services` (whose openscreen backend
// picks the wrong adapter when WSL/Hyper-V/VPN adapters are present). Resolves to
// { host, port, instance } or null on timeout. `want` optionally filters by instance
// name and/or host so the connect step targets the same phone we just paired.
function mdnsDiscover(kind, want, timeoutMs, onSeen) {
  return new Promise((resolve) => {
    let mdns; try { mdns = require('multicast-dns'); } catch { resolve(null); return; }
    const type = `_adb-tls-${kind}._tcp.local`;
    const servers = [];
    const aByName = {};        // hostname.local -> ipv4
    const byInstance = {};     // instance -> { port, target }
    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      clearInterval(qTimer); clearTimeout(tTimer);
      for (const s of servers) { try { s.destroy(); } catch { /* */ } }
      resolve(val);
    };
    const tryResolve = () => {
      for (const [inst, r] of Object.entries(byInstance)) {
        if (want && want.instance && inst !== want.instance) continue;
        const host = r.target && aByName[r.target];
        if (!host || !r.port) continue;
        if (want && want.host && host !== want.host) continue;
        finish({ host, port: String(r.port), instance: inst });
        return;
      }
    };
    const onResponse = (res) => {
      for (const a of [...(res.answers || []), ...(res.additionals || [])]) {
        if (a.type === 'A' && a.name) aByName[a.name] = a.data;
        else if (a.type === 'SRV' && typeof a.name === 'string' && a.name.includes(type) && a.data) {
          byInstance[a.name.split('.')[0]] = { port: a.data.port, target: a.data.target };
        } else if (a.type === 'PTR' && a.name === type && a.data) {
          byInstance[String(a.data).split('.')[0]] = byInstance[String(a.data).split('.')[0]] || {};
        }
      }
      if (onSeen) { try { onSeen(); } catch { /* */ } }
      tryResolve();
    };
    const ifaces = lanIPv4Interfaces();
    for (const ip of (ifaces.length ? ifaces : [undefined])) {
      let s; try { s = mdns({ interface: ip, loopback: false, reuseAddr: true }); } catch { continue; }
      s.on('error', () => { /* an interface that can't bind just contributes nothing */ });
      s.on('response', onResponse);
      servers.push(s);
    }
    if (!servers.length) { resolve(null); return; }
    const query = () => { for (const s of servers) { try { s.query([{ name: type, type: 'PTR' }]); } catch { /* */ } } };
    query();
    const qTimer = setInterval(query, 1200);
    const tTimer = setTimeout(() => finish(null), timeoutMs);
  });
}

// Discover a service via BOTH our own Node mDNS and `adb mdns services`, first hit wins.
async function discoverService(kind, want, timeoutMs, onSeen) {
  const viaNode = mdnsDiscover(kind, want, timeoutMs, onSeen);
  const viaAdb = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = (await adbMdnsServices()).find((s) => s.type === kind
        && (!want || !want.instance || s.instance === want.instance)
        && (!want || !want.host || s.host === want.host));
      if (hit) return { host: hit.host, port: hit.port, instance: hit.instance };
      await sleep(1500);
    }
    return null;
  })();
  const winner = await Promise.race([viaNode, viaAdb]);
  if (winner) return winner;
  return (await Promise.all([viaNode, viaAdb])).find(Boolean) || null;
}
function wsSend(payload) { try { if (mainWindow) mainWindow.webContents.send('wireless:status', payload); } catch { /* ignore */ } }

// Start a QR pairing session: ensure ADB, bounce the server so mDNS discovery is live,
// mint a name/password, and return the QR as a PNG data URL for the renderer to show.
ipcMain.handle('wireless:begin', async () => {
  const adb = await ensureAdb(true);   // download platform-tools if missing
  if (!adb) return { ok: false, error: 'Could not download/find ADB (check your internet).' };
  config.useAdb = true; saveConfig();
  // Restart the adb server so it comes up under ADB_MDNS_OPENSCREEN (a server already
  // running from earlier USB use may have started without mDNS discovery).
  await runAdb(['kill-server'], { timeoutMs: 8000 });
  await runAdb(['start-server'], { timeoutMs: 15000 });
  const name = 'gour-' + randToken(6, 'abcdefghijklmnopqrstuvwxyz0123456789');
  const pass = randToken(8, '0123456789');   // pairing secret embedded in the QR
  _pairState = { name, pass, cancelled: false };
  let qr;
  try { qr = await require('qrcode').toDataURL(`WIFI:T:ADB;S:${name};P:${pass};;`, { margin: 1, width: 260, errorCorrectionLevel: 'M' }); }
  catch (e) { return { ok: false, error: 'QR generation failed: ' + e.message }; }
  const chk = await runAdb(['mdns', 'check'], { timeoutMs: 6000 });
  const mdnsOk = !/unavailable|no mdns/i.test((chk.out || '') + (chk.err || ''));
  return { ok: true, qr, name, code: pass, mdnsOk };
});

// TCP-scan a host for open ports in Android's adb-tls-connect range. mDNS often
// hands back a STALE connect port (the port rotates every time Wireless debugging
// cycles), and adb's own discovery is unreliable behind WSL/Hyper-V/VPN adapters —
// a direct scan finds the port that's actually listening right now. Fast because
// closed ports RST instantly on a LAN; only the few open ones cost the timeout.
function scanAdbPorts(host, { start = 30000, end = 49999, concurrency = 800, timeoutMs = 300 } = {}) {
  const net = require('net');
  return new Promise((resolve) => {
    const open = [];
    let next = start, active = 0, done = false;
    const finish = () => { if (!done) { done = true; resolve(open.sort((a, b) => a - b)); } };
    const pump = () => {
      while (active < concurrency && next <= end) {
        const port = next++; active += 1;
        const s = new net.Socket();
        const clear = () => { active -= 1; s.destroy(); if (next > end && active === 0) finish(); else pump(); };
        s.setTimeout(timeoutMs);
        s.once('connect', () => { open.push(port); clear(); });
        s.once('timeout', clear);
        s.once('error', clear);
        s.connect(port, host);
      }
    };
    pump();
  });
}

// Last-resort connect: scan the phone for its live adb port and `adb connect` each
// open one until a device shows up. This is what makes pairing reliable on networks
// where mDNS lies about the connect port. Returns { dev, addr } or { dev:null }.
async function connectByScan(host, isCancelled) {
  let ports = [];
  try { ports = await scanAdbPorts(host); } catch { ports = []; }
  if (!ports.length) return { dev: null, addr: null };
  let connectedAddr = null;
  // `adb connect` is cheap + idempotent — connect to EVERY open port; only the real
  // adb-tls-connect one authorizes. (The others are stale transports / the pairing
  // port and just come back "offline" or refused.)
  for (const p of ports) {
    if (isCancelled && isCancelled()) break;
    // eslint-disable-next-line no-await-in-loop
    const cr = await runAdb(['connect', `${host}:${p}`], { timeoutMs: 6000 });
    if (/connected|already connected/i.test((cr.out || '') + (cr.err || ''))) connectedAddr = `${host}:${p}`;
  }
  // Poll for an ONLINE device — adb often lands "offline" for a beat before it flips.
  for (let i = 0; i < 5 && !(isCancelled && isCancelled()); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const parsed = adbParseDevices((await runAdb(['devices'], { timeoutMs: 8000 })).out);
    if (parsed.device) return { dev: parsed.device, addr: parsed.device };
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  return { dev: null, addr: connectedAddr };
}

// Wait for the scanned phone to appear over mDNS, pair, then connect. Long-polls up to
// ~2 min; the renderer shows a spinner and can `wireless:cancel`. Emits phase updates.
ipcMain.handle('wireless:await', async () => {
  const st = _pairState;
  if (!st) return { ok: false, error: 'Pairing not started.' };
  // Discovery is the slow part; once we have the phone's address, pair+connect are
  // near-instant. 60s is plenty for someone to open the QR scanner and scan — if the
  // phone isn't found by then it's a network/reachability problem, not slowness.
  wsSend({ phase: 'waiting' });
  const pairSvc = await discoverService('pairing', { instance: st.name }, 60000, () => { if (!st.cancelled) wsSend({ phase: 'waiting' }); });
  if (st.cancelled) { _pairState = null; return { ok: false, cancelled: true }; }
  if (!pairSvc) {
    _pairState = null;
    return { ok: false, error: 'Couldn’t find your phone on the network. Check that the phone and PC are on the SAME Wi-Fi (not a guest network), then try again — or use “Enter code manually”.' };
  }
  wsSend({ phase: 'pairing' });
  const pr = await runAdb(['pair', `${pairSvc.host}:${pairSvc.port}`, st.pass], { timeoutMs: 20000 });
  if (!/success/i.test(pr.out || '')) { _pairState = null; return { ok: false, error: (pr.err || pr.out || 'Pairing was rejected — try again.').trim().slice(0, 200) }; }
  // Paired — now establish the actual debugging session. The phone advertises a SEPARATE
  // `_adb-tls-connect._tcp` service (different port from pairing) that can take a few
  // seconds to appear, and `adb connect` sometimes lands the device as "offline" for a
  // beat before it flips to "device". So retry the discover→connect→verify cycle for a
  // while instead of a single shot. adb's OWN discovery is broken here (WSL adapters),
  // so there's no auto-connect to fall back on — this loop is the whole connection.
  wsSend({ phase: 'connecting' });
  let addr = null; let dev = null; let lastOut = '';
  // SCAN-FIRST: the connect port rotates and mDNS routinely reports a stale one, so
  // a direct port scan is what actually works. Retry a few times — the phone can take
  // a couple seconds to start listening on its connect port after pairing.
  for (let attempt = 0; attempt < 5 && !dev && !st.cancelled; attempt += 1) {
    const scanned = await connectByScan(pairSvc.host, () => st.cancelled);
    if (scanned.dev) { dev = scanned.dev; addr = scanned.addr; break; }
    if (scanned.addr) addr = scanned.addr;
    // Bonus: also try whatever mDNS advertises (cheap, occasionally right).
    if (!dev) {
      const conn = await discoverService('connect', { host: pairSvc.host }, 2500);
      if (conn) {
        const cr = await runAdb(['connect', `${conn.host}:${conn.port}`], { timeoutMs: 8000 });
        lastOut = (cr.out || cr.err || '').trim();
        dev = adbParseDevices((await runAdb(['devices'], { timeoutMs: 8000 })).out).device;
        if (dev) { addr = `${conn.host}:${conn.port}`; break; }
      }
    }
    if (!dev) await sleep(1800);
  }
  _pairState = null;
  // Remember the address even if this connect didn't verify — the sticky reconnect in
  // adb:status will retry it, and it often lands a moment later.
  if (dev || addr) { config.wirelessAddr = (dev && /:\d+$/.test(dev)) ? dev : (addr || ''); saveConfig(); }
  if (!dev) {
    const why = lastOut ? ` (adb: ${lastOut.slice(0, 120)})` : (addr ? '' : ' — couldn’t find the phone’s connect address on the network.');
    return { ok: false, paired: true, error: `Paired successfully, but couldn’t open the connection${why}. Try “Pair over Wi-Fi” once more — pairing is remembered, so it just needs to connect.` };
  }
  return { ok: true, device: dev, address: addr, paired: true };
});
ipcMain.handle('wireless:cancel', () => { if (_pairState) _pairState.cancelled = true; return { ok: true }; });

// Fallback for when mDNS/QR won't work: the user reads the phone's "Pair device with
// pairing code" screen (host:port + 6-digit code) and types them here. Optionally the
// connect host:port from the main wireless-debugging screen for the follow-up connect.
ipcMain.handle('wireless:manualPair', async (_evt, { hostport, code, connectAddr } = {}) => {
  const adb = await ensureAdb(true);
  if (!adb) return { ok: false, error: 'Could not download/find ADB (check your internet).' };
  config.useAdb = true; saveConfig();
  const pairHost = String(hostport || '').trim().split(':')[0];
  const pr = await runAdb(['pair', String(hostport || '').trim(), String(code || '').trim()], { timeoutMs: 20000 });
  if (!/success/i.test(pr.out || '')) return { ok: false, error: (pr.err || pr.out || 'Pairing was rejected.').trim().slice(0, 200) };
  // Prefer the connect address the user typed off the phone's main screen (100% reliable,
  // no discovery); otherwise discover the same phone's connect endpoint over mDNS.
  let addr = String(connectAddr || '').trim();
  if (!addr) { const c = await discoverService('connect', pairHost ? { host: pairHost } : null, 12000); if (c) addr = `${c.host}:${c.port}`; }
  if (addr) await runAdb(['connect', addr], { timeoutMs: 12000 });
  let dev = adbParseDevices((await runAdb(['devices'], { timeoutMs: 10000 })).out).device;
  // Typed/mDNS connect port didn't take → scan the phone for its live adb port.
  if (!dev && pairHost) {
    const scanned = await connectByScan(pairHost);
    if (scanned.dev) { dev = scanned.dev; addr = scanned.addr; }
  }
  if (dev) { config.wirelessAddr = /:\d+$/.test(dev) ? dev : (addr || ''); saveConfig(); }
  return { ok: !!dev, device: dev, address: addr };
});

// Transfer dispatcher: use the fast ADB path when enabled + an authorized device is
// present, otherwise the original MTP copy. ADB failure falls back to MTP per call.
// Which items still need pulling after an ADB pass (audit #89).
//
// `adbPullToDest` reports failure PER FILE (`status:'FAIL'`) but returns `{ ok: true }` for the batch
// no matter what — so the caller's `if (r && r.ok) return r` made the MTP fallback unreachable, and
// anything ADB choked on was silently dropped while the pull reported done.
//
// "Not mentioned in the results" counts as needing a retry, NOT as done: a crash or an abort
// mid-batch leaves later items unreported, and treating no-news as success is exactly how a file
// goes missing quietly.
function adbRetryList(items, results) {
  const done = new Set(((results || []).filter((r) => r && (r.status === 'OK' || r.status === 'SKIP'))).map((r) => r.name));
  return (items || []).filter((it) => it && !done.has(it.name));
}
// Combine the ADB pass with the MTP retry — the LATER attempt wins per file, so an item MTP rescued
// reports OK rather than staying FAIL (which would show up as a phantom loss in the declined count,
// audit #87).
function mergePullResults(first, second) {
  const by = new Map();
  for (const r of (first || [])) if (r && r.name) by.set(r.name, r);
  for (const r of (second || [])) if (r && r.name) by.set(r.name, r);
  return [...by.values()];
}
async function mtpCopyToDest(device, items, dest, onName) {
  const serial = await adbReadyDevice().catch(() => null);
  if (serial) {
    try {
      const r = await adbPullToDest(serial, items, dest, onName);
      const retry = adbRetryList(items, r && r.results);
      if (!retry.length) return r;
      // ADB got some (or none) of them — give the rest their second chance on the slower path that
      // works, instead of dropping them. Only the stragglers are re-pulled, never the whole batch.
      console.error(`[adb] ${retry.length} item(s) failed, retrying those over MTP`);
      const m = await mtpCopyViaMtp(device, retry, dest, onName);
      return { ok: true, results: mergePullResults(r && r.results, m && m.results) };
    } catch (e) { console.error('[adb] pull failed, falling back to MTP:', e.message); }
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
      // Cancel actually cancels now: the PS batch loops over every file with no way to check a flag,
      // so pressing Cancel used to keep copying to the very end. Poll phoneAbort and kill the child;
      // the staging gate declines the half-copied file. (ADB path already honors per-file cancel.)
      abortCheck: () => phoneAbort,

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
      const src = j.src || (j.phoneRef && j.phoneRef.abs) || '';
      let already = null; try { already = await fsp.stat(j.dest); } catch { /* not there */ }
      if (already) {
        // RESUME vs COLLISION — and the old code got both wrong.
        //
        // The check was SIZE-ONLY: a same-size but DIFFERENT clip was treated as "already done" and
        // silently dropped. And anything else fell through to moveFileCrossDevice, which renames
        // straight OVER its destination (organizeMove guards that with uniqueDest; this path never
        // did) — silently destroying a clip already staged in _Phone Video Temp / 01 - Uncompressed.
        //
        // It really collides: recomputeVersions() only de-duplicates _v# within the CURRENT scan, so
        // a second phone batch producing the same subject/description restarts at _v1 and lands on
        // the first batch's filename.
        let identical = false;
        try { identical = !!src && await fingerprintsMatch(src, j.dest, { full: true }); } catch { identical = false; }
        if (identical) { done += 1; okDests.push(j.dest); prog(path.basename(j.dest)); continue; }   // genuinely already there
        j.dest = await uniqueDest(path.dirname(j.dest), path.basename(j.dest));   // a DIFFERENT clip — never overwrite it
      }
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
  // `ok` was hardcoded true, so a run that failed to move a single video still reported success and
  // the renderer showed a green tick. Report reality.
  return { ok: failed === 0, copied: done, failed, total, okDests, cancelled: phoneAbort, error: failed ? `${failed} video(s) failed to move` : '' };
});

// Flat-copy files (renamed photos from Photos Temp) to the chosen back-up
// destinations (computer and/or NAS). jobs = [{src, dest}]; streams progress.
ipcMain.handle('phone:distribute', async (evt, payload) => {
  const { jobs } = payload || {};
  if (!Array.isArray(jobs) || !jobs.length) return { ok: true, copied: 0 };
  const sender = evt.sender; let done = 0; const total = jobs.length; const errors = [];
  // Embed the AI's record (subject / people / keywords / description / date…) into each unique SOURCE
  // photo ONCE, so every verified copy below inherits it. Videos get rich XMP through finalize:run;
  // photos used to get copied bytes and nothing else, so all the AI's work was thrown away the moment
  // a photo left the flow. The source is a working staging copy (Photos Temp / a pulled temp), NEVER
  // the phone original, so this respects "organize copies, never the archive original"; and an XMP
  // write to a JPG/HEIC is metadata-only, so "photos stay original quality" still holds.
  let tagged = 0; let tagFailed = 0; const embeddedSrc = new Set();
  for (const j of jobs) {
    if (!j || !j.meta || !j.src || embeddedSrc.has(j.src)) continue;
    embeddedSrc.add(j.src);
    try {
      const tags = buildEmbedTags(j.meta, [], path.basename(j.src));
      if (Object.keys(tags).length) { await getExifTool().write(j.src, tags, ['-overwrite_original']); tagged += 1; }
    } catch { tagFailed += 1; }   // a tag failure never blocks the backup — the copy still runs
  }
  // PER-JOB results, not just a tally. The caller needs to know WHICH photo landed WHERE:
  // without that, a photo has no recorded destination, which is why photos could never enter
  // state.copied and therefore could never be cleared off the card — and why their AI metadata
  // was never carried forward to Organize.
  const results = [];
  for (const j of jobs) {
    let ok = false; let error = '';
    try {
      // COLLISION, before the copy — the same guard phone:copyVideos has had for a while, which the
      // photo twin never got. `recomputeVersions()` only de-duplicates `_v#` within the CURRENT
      // scan, so a second batch with the same subject/description restarts at `_v1` and lands on the
      // first batch's filename. copyFileVerified deliberately OVERWRITES a differing destination (it
      // reads a mismatch as a truncated copy of the same file needing repair, and says so in its own
      // comment) — so without this, batch 2 destroyed batch 1's photo, and distribute fans out to the
      // computer folder, the NAS folder AND the routed Projects folder, so all three died at once
      // while the backup reported success.
      let occupied = false;
      try { occupied = !!(await fsp.stat(j.dest)); } catch { occupied = false; }
      if (occupied) {
        // Byte-identical means a genuine re-run: skip it, or every retry litters the backup with
        // _v2, _v3, _v4. FULL hash, not sampled — this decides whether a photo is overwritten.
        let identical = false;
        try { identical = await fingerprintsMatch(j.src, j.dest, { full: true }); } catch { identical = false; }
        if (!identical) j.dest = await uniqueDest(path.dirname(j.dest), path.basename(j.dest));
      }
      // Verified copy: fingerprint-checks the result before trusting it (a truncated
      // network copy of the right byte-count is no longer silently accepted as done).
      await copyFileVerified(j.src, j.dest);
      done += 1; ok = true;
    } catch (e) { error = (e && e.message) || String(e); errors.push(error); }
    results.push({ src: j.src, dest: j.dest, ok, error });
    try { sender.send('phone:copy-progress', { done, total, name: path.basename(j.dest) }); } catch { /* ignore */ }
  }
  // ok reflects reality — false when any file failed (was unconditionally true, so a
  // partial backup with dropped photos reported success).
  return { ok: errors.length === 0, copied: done, total, failed: errors.length, errors, results, tagged, tagFailed, error: errors[0] || '' };
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
    // Basenames (no extension) of the PHOTOS in this dir — so a .MOV that shares a still's name can be
    // spotted as an iPhone Live Photo sidecar rather than a real video.
    const photoStems = new Set();
    for (const e of entries) {
      if (e.isFile()) { const x = path.extname(e.name).toLowerCase(); if (IMAGE_EXTS.has(x)) photoStems.add(e.name.slice(0, e.name.length - x.length).toLowerCase()); }
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
        let kind = VIDEO_EXTS.has(ext) ? 'video' : (IMAGE_EXTS.has(ext) ? 'photo' : '');
        // iPhone Live Photo: a .MOV paired with a same-name HEIC/JPG still. Treat it as a PHOTO so it
        // rides to Photos Temp with the still instead of flooding the Tdarr video intake / compress
        // queue with thousands of 2-3s motion clips beside each picture.
        if (kind === 'video' && ext === '.mov' && photoStems.has(entry.name.slice(0, entry.name.length - ext.length).toLowerCase())) kind = 'photo';
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
// The synchronous sibling. Needed by the handful of genuinely sync paths (saveFaceCrop runs inside
// migratePerson, which is called from the store accessor and cannot be async). Same primitive, same
// concern — so a fix to how we create directories still lands in ONE place.
function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Compute the destination filename for a file being copied: the user's chosen
// name (sanitized) + original extension, falling back to the original name.
// The single place a destination FILENAME is built. slugFolder() already defends the folder path
// against Windows' reserved device names and length; the file path had neither guard:
//
//  • RESERVED NAMES — a subject that slugs to `con`/`aux`/`nul`/`com1`… produced `CON.mp4`, which
//    Windows cannot create. createWriteStream throws, and (before the copy fixes) that abandoned the
//    whole remaining batch.
//  • LENGTH — nothing capped it. The AI path caps its description at 12 words, but the USER/batch path
//    capped nothing: paste a long description into the batch bar, apply it to 200 clips, and every one
//    of them fails with ENAMETOOLONG — or blows Windows' 260-char MAX_PATH once
//    <Category>/<Project>/<Subject>/ folders are prepended at organize time.
//  • TRAILING DOTS/SPACES — Windows silently strips them, so `clip .mp4` and `clip.mp4` collide.
//
// 120 chars of stem leaves comfortable room for a deep Projects tree under MAX_PATH while still being
// far longer than any sane name.
const MAX_STEM = 120;
function destNameFor(f) {
  const ext = f.ext || path.extname(f.name);
  const origBase = f.name.slice(0, f.name.length - ext.length);
  let base = String(f.newName != null ? f.newName : origBase).trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!base) base = origBase;
  if (base.length > MAX_STEM) base = base.slice(0, MAX_STEM).replace(/[-_ ]+$/, '');   // don't end mid-separator
  base = base.replace(/[. ]+$/, '');                                                    // Windows strips these anyway
  if (!base) base = origBase;
  if (WIN_RESERVED_NAMES.has(base.toLowerCase())) base = `${base}_`;                    // CON.mp4 is not creatable
  return base + ext;
}

// Resolve a non-colliding destination path by appending " (n)" before the ext.
// Claim a destination for ONE pulled item, so two albums can't collide in the flat pull folder
// (audit #5).
//
// A pull flattens every selected album into one directory, and `IMG_0001.jpg` exists in Camera AND
// WhatsApp AND Downloads. Joining the raw name meant the second item either overwrote the first, or
// — if their sizes happened to match — was read as a completed RESUME and skipped. One irreplaceable
// photo gone either way, silently.
//
// The distinction that makes this safe: only rename when the name was claimed by a DIFFERENT item in
// THIS run. A file left by a PREVIOUS run must keep its exact path, or every resumed pull
// re-downloads the whole card under new names. Keyed case-insensitively because IMG_1.JPG and
// img_1.jpg are one file on Windows.
// Note it cannot just delegate to uniqueDest(): that only steps past names that EXIST ON DISK, and a
// name claimed earlier in this run hasn't been written yet (the pull is still in flight). So the
// claim set and the disk are both consulted, using uniqueDest's own " (n)" convention so a resumed
// run recognises the files a previous one left.
async function claimPullDest(dir, name, claimed) {
  const raw = path.join(dir, name);
  // NOT claimed by an earlier item this run → hand back the real name untouched. A file sitting
  // there is a RESUME of this same item, and the caller's size check owns that decision. (Delegating
  // to uniqueDest here would step past it and re-download the whole card under new names.)
  if (!claimed || !claimed.has(raw.toLowerCase())) {
    if (claimed) claimed.add(raw.toLowerCase());
    return raw;
  }
  // Claimed → this is a genuinely DIFFERENT item that happens to share a filename. Step past both
  // what this run has spoken for and what is already on disk, using uniqueDest's " (n)" convention.
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let n = 1; n < 10000; n += 1) {
    const cand = path.join(dir, `${base} (${n})${ext}`);
    if (claimed.has(cand.toLowerCase())) continue;
    // eslint-disable-next-line no-await-in-loop
    try { await fsp.access(cand); } catch { claimed.add(cand.toLowerCase()); return cand; }
  }
  return raw;   // 10k same-named items is not a real card; don't spin
}
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

// Pull the ONE irreplaceable copy of the footage off the card — with progress, STAGED, fsynced and
// VERIFIED. This is the most important copy in the app, and it was the only one not going through a
// verify-before-trust primitive (copyFileVerified / moveFileCrossDevice both do).
//
// Three defects, and they compounded into corruption of the archive:
//
//  1. It wrote straight to the FINAL path, so a partial copy wore the real filename.
//
//  2. Cancelling called `rs.destroy()`, which emits neither 'end' nor 'error'. So `pipe()` never
//     called `ws.end()`, 'finish' never fired, and THE PROMISE NEVER SETTLED. copy:start's `await`
//     hung forever — which meant its own `if (aborted) unlink(destPath)` cleanup was unreachable
//     dead code, the truncated file stayed in intake under its final name, `copyTask.active` stayed
//     true (so every later copy was refused with "A copy is already running"), and the renderer's
//     copyInProgress latch stuck true for the rest of the session. `token.aborted` — checked in two
//     places here — was never assigned anywhere, so both guards were dead too.
//
//  3. It verified nothing. A flaky-card read or a mid-copy ENOSPC left a short file that looked
//     complete; Tdarr then compressed the truncated clip and it was filed into the archive as the
//     good copy — while the delete gate, comparing card↔intake, happily cleared the card.
//
// Now: stage to <dest>.part → datasync → FULL-file fingerprint against the card → and only then
// rename into place. So a file at `dest` is ALWAYS a complete, verified copy; an abandoned copy
// leaves a .part that is cleaned up and can never be mistaken for footage.
async function copyFileWithProgress(src, dest, onBytes, token) {
  await ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  try { await fsp.unlink(part); } catch { /* no leftover from a previous run */ }

  const rs = fs.createReadStream(src);
  const ws = fs.createWriteStream(part);
  let aborted = false;
  if (token) {
    token.destroy = () => {
      aborted = true;
      // Destroy WITH an error: that propagates through the pipeline as a rejection, so the await
      // actually settles. A bare destroy() is what left the promise hanging forever.
      rs.destroy(new Error('aborted'));
      ws.destroy(new Error('aborted'));
    };
  }
  rs.on('data', (chunk) => onBytes(chunk.length));

  try {
    await streamPipeline(rs, ws);
    await flushToDisk(part);   // 'finish' is an OS handoff, not durability — especially on a network intake
    if (!(await fingerprintsMatch(src, part, { full: true }))) {
      throw new Error('the copy did not match the card — refusing to trust it');
    }
    await fsp.rename(part, dest);
  } catch (err) {
    // Never leave a partial behind wearing a name that looks like real footage.
    try { await fsp.unlink(part); } catch { /* already gone */ }
    throw aborted ? new Error('aborted') : err;
  }
}

