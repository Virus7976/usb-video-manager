'use strict';

// Standalone drive-detection diagnostic (no dependencies).
// Run:  node watch-drives.js
// Then insert / remove a card or reader and watch the output.
// Ctrl+C to stop.

const { spawn } = require('node:child_process');

const PS_DRIVE_QUERY =
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | " +
  'Select-Object DeviceID,VolumeName,Size,FileSystem | ConvertTo-Json -Compress';

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function listRemovable() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_DRIVE_QUERY], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.on('error', () => resolve([]));
    ps.on('close', () => {
      const t = out.trim();
      let parsed = [];
      if (t) {
        try { const j = JSON.parse(t); parsed = Array.isArray(j) ? j : [j]; } catch {}
      }
      resolve(parsed.filter((d) => d && d.DeviceID && d.Size));
    });
  });
}

let known = new Map();
let first = true;

async function tick() {
  const drives = await listRemovable();
  const now = new Map(drives.map((d) => [d.DeviceID, d]));

  if (first) {
    console.log('Removable drives with media:');
    if (drives.length === 0) console.log('  (none)');
    drives.forEach((d) => console.log(`  ${d.DeviceID}\\  ${d.VolumeName || '(no label)'}  ${d.FileSystem || ''}  ${fmtBytes(Number(d.Size))}`));
    console.log('\nWatching — insert/remove a card now…\n');
    first = false;
  } else {
    for (const [k, d] of now) {
      if (!known.has(k)) console.log(`+ INSERTED  ${k}\\  ${d.VolumeName || '(no label)'}  ${d.FileSystem || ''}  ${fmtBytes(Number(d.Size))}`);
    }
    for (const [k] of known) {
      if (!now.has(k)) console.log(`- REMOVED   ${k}\\`);
    }
  }
  known = now;
}

console.log('Drive watcher started (WMI / PowerShell). Ctrl+C to stop.\n');
tick();
setInterval(tick, 1500);
