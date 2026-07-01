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
  previewWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  previewWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
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

