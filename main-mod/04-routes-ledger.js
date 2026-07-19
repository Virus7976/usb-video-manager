// ---------------------------------------------------------------------------
// Pop-out preview window — a small always-handy window that shows the clip
// currently being worked on (handy in the compact/zoomed-out rename view).
// ---------------------------------------------------------------------------
let previewWindow = null;
let lastPreview = null; // mirror mode: { url, name, kind, muted, speed }
let lastList = null;    // grid mode: { clips: [...] }
const DEFAULT_PREVIEW_GRID = { mode: 'mirror', source: 'selected', tile: 200, playVideos: false, muted: true };
function previewGridCfg() { return { ...DEFAULT_PREVIEW_GRID, ...(config.previewGrid || {}) }; }
function previewIsOpen() { return !!(previewWindow && !previewWindow.isDestroyed()); }
// Send the current view config to both windows (preview reacts visually; the main
// window uses it to decide which clips to push for the grid).
function broadcastPreviewConfig() {
  const cfg = previewGridCfg();
  if (previewIsOpen()) previewWindow.webContents.send('preview:config', cfg);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:config', cfg);
}
function createPreviewWindow() {
  previewWindow = new BrowserWindow({
    width: 540, height: 360, minWidth: 280, minHeight: 180,
    title: 'Preview', backgroundColor: '#000',
    icon: nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'app-icon.png')),
    backgroundMaterial: 'auto',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      webSecurity: false // play local file:// clips (same as the main window)
    }
  });
  previewWindow.removeMenu();
  previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  previewWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  previewWindow.loadFile(path.join(__dirname, 'src', 'preview.html'));
  previewWindow.webContents.on('did-finish-load', () => sendPreviewState());
  previewWindow.on('closed', () => {
    previewWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:closed');
  });
}
// Push everything the preview window needs to render its current state.
function sendPreviewState() {
  if (!previewIsOpen()) return;
  const cfg = previewGridCfg();
  previewWindow.webContents.send('preview:config', cfg);
  if (cfg.mode === 'grid') {
    if (lastList) previewWindow.webContents.send('preview:list', lastList);
    // Ask the main window to (re)compute the clip list for the current scope.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:config', cfg);
  } else if (lastPreview) {
    previewWindow.webContents.send('preview:update', lastPreview);
  }
}

ipcMain.handle('preview:toggle', () => {
  if (previewIsOpen()) { previewWindow.close(); previewWindow = null; return { open: false }; }
  createPreviewWindow();
  return { open: true, config: previewGridCfg() };
});
ipcMain.handle('preview:state', () => ({ open: previewIsOpen(), config: previewGridCfg() }));
ipcMain.handle('preview:ready', () => { sendPreviewState(); return true; });
ipcMain.handle('preview:set', (_evt, payload) => {
  if (!payload || !payload.path) return false;
  const ext = path.extname(payload.path).toLowerCase();
  const kind = payload.kind || (IMAGE_EXTS.has(ext) ? 'photo' : 'video');
  lastPreview = {
    url: fileUrl(payload.path),
    name: payload.name || '',
    kind,
    muted: payload.muted !== false,        // default muted, like the in-card previews
    speed: Number(payload.speed) || 1
  };
  if (previewIsOpen() && previewGridCfg().mode !== 'grid') previewWindow.webContents.send('preview:update', lastPreview);
  return true;
});
// Grid wall: the main window sends the clips in scope; we resolve file URLs here.
ipcMain.handle('preview:list', (_evt, payload) => {
  const clips = (payload && Array.isArray(payload.clips) ? payload.clips : [])
    .filter((c) => c && c.path)
    .map((c) => ({
      i: c.i,
      name: c.name || '',
      kind: c.kind === 'photo' ? 'photo' : 'video',
      named: !!c.named,
      url: fileUrl(c.path)
    }));
  lastList = { clips };
  if (previewIsOpen() && previewGridCfg().mode === 'grid') previewWindow.webContents.send('preview:list', lastList);
  return true;
});
// View config change (from either window) → persist + re-broadcast to both.
ipcMain.handle('preview:config', (_evt, patch) => {
  const cur = previewGridCfg();
  const next = { ...cur };
  if (patch && typeof patch === 'object') {
    if (typeof patch.source === 'string') next.source = patch.source;
    if (typeof patch.tile === 'number' && isFinite(patch.tile)) next.tile = Math.max(100, Math.min(600, Math.round(patch.tile)));
    if (typeof patch.playVideos === 'boolean') next.playVideos = patch.playVideos;
    if (typeof patch.muted === 'boolean') next.muted = patch.muted;
    if (patch.mode === 'mirror' || patch.mode === 'grid') next.mode = patch.mode;
  }
  config.previewGrid = next;
  saveConfig();
  broadcastPreviewConfig();
  return next;
});
ipcMain.handle('preview:mode', (_evt, mode) => {
  const m = mode === 'grid' ? 'grid' : 'mirror';
  config.previewGrid = { ...previewGridCfg(), mode: m };
  saveConfig();
  broadcastPreviewConfig();
  // Re-push the right content for the new mode.
  sendPreviewState();
  return config.previewGrid;
});
// A grid tile was clicked in the preview window → focus that clip in the main window.
ipcMain.handle('preview:jump', (_evt, i) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:jump', Number(i));
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
    const ps = killAfter(spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_DRIVE_QUERY],
      { windowsHide: true }
    ), 20000);   // this runs on the 2.5s poll — don't let a WMI stall leak a process each tick
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
      const drives = parsed.map(mapDrive).filter(Boolean);
      // #95 consent: a card is chosen on the HOME SCREEN, not through a dialog, so the picker wrap
      // never sees it. A volume the app itself enumerated and offered is a legitimate root — without
      // this, previews and posters for every clip on the card would be refused.
      for (const d of drives) { try { rememberApprovedRoot(d.mountpoint || d.raw); } catch { /* ignore */ } }
      resolve(drives);
    });
  });
}

// Is `p` on a removable volume (SD card / USB stick) that currently has media in it?
//
// Guards the one operation that can take footage OFF a card without going through the Delete
// step: organizing MOVES files (unlink-after-copy), so pointing the Compressed folder at the
// card would strip it silently. Compares drive letters, which is what Win32_LogicalDisk gives
// us — that is exactly the granularity we need, since removability is a property of the volume.
//
// FAILS CLOSED on Windows: if the volume query errors or returns nothing while we're being
// asked about a path that isn't obviously local, we do NOT get to claim it's safe to move off.
// On non-Windows (dev/test) detection is disabled entirely, so nothing is treated as removable.
// THE decision: is this path on a removable volume? Pure (drives are passed in) so the delete
// gate's most important refusal can be tested without a real card in a slot.
//
// This used to answer `false` for ANY path without a drive letter, which fails OPEN: a
// `\\?\Volume{GUID}\…` card read as "not removable", so the same-card delete guard never fired and
// the gate could delete the original while the only remaining copy sat on the card about to be
// wiped. Unknown-because-no-letter is the same ignorance as unknown-because-the-lookup-threw, and
// that case already fails CLOSED — so they now make the same call.
function classifyRemovable(p, drives) {
  const raw = String(p || '');
  const letterOf = (s) => {
    const m = /^([A-Za-z]):/.exec(String(s).replace(/^\\\\\?\\/, ''));
    return m ? m[1].toUpperCase() : '';
  };
  // Failing closed must NOT be blanket. `\\server\share` is knowably not a local removable volume,
  // and calling it one would refuse organizing onto the NAS with a nonsense "that's a card" error.
  // (`\\?\…` is a Win32 device path, not a UNC share — excluded here and handled by letterOf.)
  if (/^\\\\(?!\?\\)/.test(raw)) return false;
  const target = letterOf(raw);
  // No letter to look up. It may very well BE the card, so assume it is.
  if (!target) return true;
  return (drives || []).some((d) => letterOf(d.mountpoint || d.raw) === target);
}
async function isOnRemovableVolume(p) {
  if (!p || !DETECTION_ENABLED) return false;
  let drives = [];
  try { drives = await listRemovableDrives(); } catch { return true; }   // can't tell → don't move off it
  return classifyRemovable(p, drives);
}

// Is this source still actually there? Asked on demand, because auto-poll is OFF by default in
// this app — so the drive:removed event above cannot be the only way we find out. The analyze /
// copy loops ask this the moment a file fails, so a yanked card is reported ONCE, honestly, instead
// of being mis-reported sixty times as sixty separate model timeouts.
ipcMain.handle('drive:present', async (_evt, mountpoint) => {
  const mp = String(mountpoint || '');
  if (!mp || mp === '__phone__') return true;   // not a removable source — never claim it's gone
  try { await fsp.stat(mp); return true; } catch { return false; }
});

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

  // A card that GOES AWAY is an event too. Nothing told the renderer, so yanking a card mid-flow
  // left the grid full of clips whose files no longer existed — previews, AI and copy then failed
  // one file at a time, and aiCallGuard reported each as "Took too long — skipped this clip",
  // which is a confidently wrong diagnosis of a completely different problem.
  if (primed) {
    for (const mp of knownMountpoints) {
      if (currentMounts.has(mp)) continue;
      console.log(`[detect] removable drive REMOVED: ${mp}`);
      if (mainWindow) { try { mainWindow.webContents.send('drive:removed', { mountpoint: mp }); } catch { /* window gone */ } }
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

